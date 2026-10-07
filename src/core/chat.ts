// The client: connection machine, sync engine, outbox, receipts, presence (docs/09-SDK-DESIGN.md §3–4).
import { AuthManager, type TokenSource } from "./auth.js";
import { Conversation, toMessage, type ServerConversation, type ServerMessage } from "./conversation.js";
import { ChatError } from "./errors.js";
import { memoryPersistence } from "./persistence.js";
import { RestClient } from "./rest.js";
import { Transport, type WebSocketCtor } from "./transport.js";
import type { ConnectionState, ConversationSummary, Json, Message, Page, PersistenceAdapter, Presence, Unsubscribe, WireData, WireFrame } from "./types.js";
import { Emitter, path } from "./util.js";
import { Uploader } from "./uploader.js";

export const SDK_VERSION = "0.2.0";

export interface ChatOptions {
  env: string;
  /** A token, or a function that returns one (called before expiry and after token_expired). */
  token: TokenSource;
  baseUrl?: string;
  realtimeUrl?: string;
  persistence?: PersistenceAdapter;
  logLevel?: "silent" | "error" | "warn" | "info" | "debug";
  /** Override for environments without a global WebSocket. */
  WebSocket?: WebSocketCtor;
  /** Identifies the platform in the connect URL (react-native sets "react-native"). */
  sdkName?: string;
}

interface OutboxEntry {
  clientMsgId: string;
  cid: string;
  payload: Json;
  createdAt: number;
}

const OUTBOX_TTL_MS = 24 * 3600_000;

/** Pending sends keyed by clientMsgId; flushed after every hello; persisted when an adapter is given. */
class Outbox {
  private entries = new Map<string, OutboxEntry>();
  private waiters = new Map<string, { resolve: (m: Message) => void; reject: (e: ChatError) => void }>();
  private failedEntries = new Map<string, OutboxEntry>();
  private flushing = false;

  constructor(private readonly chat: Chat) {}

  enqueue(e: OutboxEntry): Promise<Message> {
    this.entries.set(e.clientMsgId, e);
    void this.persist();
    const p = new Promise<Message>((resolve, reject) => this.waiters.set(e.clientMsgId, { resolve, reject }));
    if (this.chat.transport.isOpen) void this.sendOne(e);
    return p;
  }

  retry(clientMsgId: string): Promise<Message> {
    const failed = this.failedEntries.get(clientMsgId);
    if (failed) {
      this.failedEntries.delete(clientMsgId);
      this.entries.set(clientMsgId, { ...failed, createdAt: Date.now() });
      void this.persist();
    }
    const e = this.entries.get(clientMsgId);
    if (!e) return Promise.reject(new ChatError({ code: "not_found", type: "not_found", message: "Message is not in the outbox" }));
    const p = new Promise<Message>((resolve, reject) => this.waiters.set(clientMsgId, { resolve, reject }));
    if (this.chat.transport.isOpen) void this.sendOne(e);
    return p;
  }

  get size() {
    return this.entries.size;
  }

  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const e of [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt)) {
        if (!this.chat.transport.isOpen) break;
        await this.sendOne(e);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async sendOne(e: OutboxEntry) {
    const conv = this.chat.cached(e.cid);
    if (Date.now() - e.createdAt > OUTBOX_TTL_MS) {
      return this.failed(e, new ChatError({ code: "expired", type: "invalid_request", message: "Message was not sent within 24 hours" }));
    }
    try {
      const ack = await this.chat.transport.request<{ clientMsgId: string; id: string; seq: number; createdAt: string }>("message.send", e.payload);
      this.entries.delete(e.clientMsgId);
      void this.persist();
      conv?.messages.reconcile(e.clientMsgId, ack);
      const msg = conv?.messages.get(ack.id) ?? {
        ...(e.payload as object),
        id: ack.id,
        seq: ack.seq,
        createdAt: ack.createdAt,
        conversationId: e.cid,
        senderId: this.chat.userId ?? "",
        clientMsgId: e.clientMsgId,
        status: "sent" as const,
        version: 1,
        text: (e.payload.text as string) ?? null,
        replyTo: (e.payload.replyTo as string) ?? null,
        attachments: [],
        metadata: (e.payload.metadata as Json) ?? {},
        editedAt: null,
        deletedAt: null,
      };
      this.waiters.get(e.clientMsgId)?.resolve(msg);
      this.waiters.delete(e.clientMsgId);
    } catch (err) {
      const ce = err instanceof ChatError ? err : new ChatError({ code: "internal", message: String(err) });
      // Retryable problems keep the message pending; it is resent after the next hello.
      if (ce.retryable || ce.code === "network" || ce.code === "timeout") {
        if (ce.code === "rate_limited" && ce.retryAfterMs) setTimeout(() => this.chat.transport.isOpen && void this.sendOne(e), ce.retryAfterMs);
        return;
      }
      this.failed(e, ce);
    }
  }

  private failed(e: OutboxEntry, err: ChatError) {
    this.entries.delete(e.clientMsgId);
    void this.persist();
    const conv = this.chat.cached(e.cid);
    conv?.messages.markFailed(e.clientMsgId, err);
    const m = conv?.messages.getByClientId(e.clientMsgId);
    if (m) conv!.emitFailed(m);
    this.waiters.get(e.clientMsgId)?.reject(err);
    this.waiters.delete(e.clientMsgId);
    this.failedEntries.set(e.clientMsgId, e); // retry() can resend it with the same clientMsgId
  }

  async load() {
    const raw = await this.chat.persistence.get(this.chat.key("outbox"));
    if (!raw) return;
    try {
      for (const e of JSON.parse(raw) as OutboxEntry[]) if (!this.entries.has(e.clientMsgId)) this.entries.set(e.clientMsgId, e);
    } catch {
      /* corrupt entry: ignore */
    }
  }

  private async persist() {
    if (!this.chat.userId) return;
    await this.chat.persistence.set(this.chat.key("outbox"), JSON.stringify([...this.entries.values()]));
  }
}

/** Delivered acks batched to at most one frame per second (docs/08 §10). */
class ReceiptBatcher {
  private pending = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly chat: Chat) {}

  delivered(cid: string, seq: number) {
    this.pending.set(cid, Math.max(this.pending.get(cid) ?? 0, seq));
    this.timer ??= setTimeout(() => this.flush(), 1_000);
  }

  flush() {
    this.timer = null;
    if (!this.pending.size || !this.chat.transport.isOpen) return;
    const items = [...this.pending].map(([cid, seq]) => ({ cid, seq }));
    this.pending.clear();
    this.chat.transport.send("delivered", { items });
  }
}

export class Chat {
  /** `dev:<userId>`; accepted only by development environments with dev tokens enabled. */
  static devToken(userId: string): string {
    return `dev:${userId}`;
  }

  readonly env: string;
  readonly rest: RestClient;
  readonly transport: Transport;
  readonly persistence: PersistenceAdapter;
  readonly outbox: Outbox;
  readonly receipts: ReceiptBatcher;
  readonly uploader: Uploader;
  private emitter = new Emitter();
  private convs = new Map<string, Conversation>();
  private loading = new Map<string, Promise<Conversation>>();
  private summaries = new Map<string, ConversationSummary>();
  private summaryWatchers = new Set<(list: ConversationSummary[]) => void>();
  private presenceWatchers = new Map<number, { userIds: string[]; cb: (p: Presence) => void }>();
  private presenceSeq = 0;
  private syncCursor: string | null = null;
  private connectWaiters: { resolve: () => void; reject: (e: ChatError) => void }[] = [];
  private _userId: string | null = null;
  private readonly level: number;

  constructor(opts: ChatOptions) {
    if (!opts?.env) throw new ChatError({ code: "invalid_request", type: "invalid_request", message: "env is required" });
    if (!opts.token) throw new ChatError({ code: "invalid_request", type: "invalid_request", message: "token is required" });
    // Message ids are UUIDs made with Web Crypto; Hermes (React Native) has no crypto.getRandomValues.
    if (typeof globalThis.crypto?.getRandomValues !== "function") {
      throw new ChatError({
        code: "invalid_request",
        type: "invalid_request",
        message: "crypto.getRandomValues is missing. On React Native install react-native-get-random-values and import it first in your entry file",
      });
    }
    if (typeof opts.token === "string" && opts.token.startsWith("sk_")) {
      throw new ChatError({ code: "invalid_request", type: "invalid_request", message: "That is a secret key: it belongs on your server. Pass a user token (ChatServer.createToken) instead" });
    }
    this.env = opts.env;
    const auth = new AuthManager(opts.token);
    this.rest = new RestClient(opts.baseUrl ?? "https://api.byotalk.com", opts.env, auth);
    const WS = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!WS) throw new ChatError({ code: "invalid_request", type: "invalid_request", message: "No WebSocket implementation available; pass options.WebSocket" });
    this.transport = new Transport({
      realtimeUrl: opts.realtimeUrl ?? "wss://rt.byotalk.com",
      env: opts.env,
      sdk: `${opts.sdkName ?? "js"}/${SDK_VERSION}`,
      auth,
      WebSocket: WS,
    });
    this.persistence = opts.persistence ?? memoryPersistence();
    this.outbox = new Outbox(this);
    this.receipts = new ReceiptBatcher(this);
    this.uploader = new Uploader(this.rest);
    this.level = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }[opts.logLevel ?? "warn"];
    if (typeof opts.token === "string" && opts.token.startsWith("dev:")) this._userId = opts.token.slice(4);

    this.transport.on("state", (s: ConnectionState) => {
      this.emitter.emit("connection", s);
      if (s === "failed") this.rejectConnect(new ChatError({ code: "failed", type: "authentication", message: "Connection failed" }));
    });
    this.transport.on("error", (e: ChatError) => {
      this.log(1, "error", e.code);
      this.emitter.emit("error", e);
      if (this.transport.state === "failed") this.rejectConnect(e);
    });
    this.transport.on("hello", () => void this.afterHello());
    this.transport.on("frame", (f: WireFrame) => this.onFrame(f));
  }

  get userId(): string | null {
    return this._userId;
  }

  get connectionState(): ConnectionState {
    return this.transport.state;
  }

  /** Namespaced persistence key for this environment and user. */
  key(name: string) {
    return `byotalk:${this.env}:${this._userId ?? "anon"}:${name}`;
  }

  /** Resolves once connected (hello received and sync finished). */
  connect(): Promise<void> {
    if (this.transport.state === "connected") return Promise.resolve();
    const p = new Promise<void>((resolve, reject) => this.connectWaiters.push({ resolve, reject }));
    if (this.transport.state === "failed") this.transport.state = "disconnected";
    this.transport.start();
    return p;
  }

  /** Deletes what this user left in persistence (unsent messages, sync cursor). Call on sign-out, before disconnect. */
  async clearLocalData(): Promise<void> {
    await Promise.all(["outbox", "cursor"].map((k) => this.persistence.delete(this.key(k))));
  }

  async disconnect(): Promise<void> {
    this.receipts.flush();
    this.transport.stop();
  }

  on(event: "connection", cb: (s: ConnectionState) => void): Unsubscribe;
  on(event: "error", cb: (e: ChatError) => void): Unsubscribe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...a: any[]) => void): Unsubscribe {
    return this.emitter.on(event, cb);
  }

  private log(level: number, ...args: unknown[]) {
    // Never log message text or tokens: only codes and ids are passed here.
    if (level <= this.level) console.warn("[byotalk]", ...args);
  }

  private rejectConnect(e: ChatError) {
    for (const w of this.connectWaiters.splice(0)) w.reject(e);
  }

  // ------------------------------------------------------------------ sync after hello (docs/08 §7.2)

  private async afterHello() {
    const hello = this.transport.hello!;
    const firstUser = this._userId === null || this._userId !== hello.userId;
    this._userId = hello.userId;
    if (firstUser || this.syncCursor === null) {
      this.syncCursor = await this.persistence.get(this.key("cursor"));
      await this.outbox.load();
    }
    this.transport.setState("syncing");
    try {
      await Promise.all([this.runSync(), this.outbox.flush(), this.rewatchPresence()]);
      this.transport.setState("connected");
      for (const w of this.connectWaiters.splice(0)) w.resolve();
    } catch (err) {
      this.log(2, "sync failed", err instanceof ChatError ? err.code : String(err));
      // The socket is up; serve live events and let the next hello retry the sync.
      this.transport.setState("connected");
      for (const w of this.connectWaiters.splice(0)) w.resolve();
    }
  }

  private async runSync() {
    const r = await this.transport.request<{ conversations: { id: string; lastSeq: number; unreadCount: number }[]; removed: string[]; cursor: string; fullReload: boolean }>(
      "sync",
      { cursor: this.syncCursor },
      10_000,
    );
    for (const c of r.conversations) {
      const s = this.summaries.get(c.id);
      if (s) this.summaries.set(c.id, { ...s, lastSeq: c.lastSeq, unreadCount: c.unreadCount });
      const conv = this.convs.get(c.id);
      if (conv) {
        conv.unreadCount = c.unreadCount;
        if (c.lastSeq > conv.lastSeq) await conv.catchUp().catch(() => {});
      }
    }
    for (const id of r.removed) this.convs.get(id)?.markRemoved();
    if (r.fullReload || r.conversations.some((c) => !this.summaries.has(c.id))) await this.refreshSummaries().catch(() => {});
    else this.notifySummaries();
    this.syncCursor = r.cursor;
    await this.persistence.set(this.key("cursor"), r.cursor);
  }

  // ------------------------------------------------------------------ incoming frames

  private onFrame(f: WireFrame) {
    switch (f.t) {
      case "event": {
        if (!f.cid || f.seq === undefined || !f.e) return;
        const conv = this.convs.get(f.cid);
        if (conv) conv.applyEvent(f.seq, f.e, f.d);
        this.updateSummary({ e: f.e, cid: f.cid, seq: f.seq, d: f.d });
        if (f.e === "conversation.created" && !conv) this.notifySummaries();
        return;
      }
      case "receipt":
        this.convs.get(f.d.cid)?.onReceipt(f.d);
        return;
      case "typing":
        this.convs.get(f.d.cid)?.onTyping(f.d.userId, f.d.state);
        return;
      case "presence":
        for (const w of this.presenceWatchers.values()) if (w.userIds.includes(f.d.userId)) w.cb(f.d);
        return;
      case "resync_required":
        void this.convs.get(f.d.cid)?.resync();
        return;
      case "resync_hint":
        void this.runSync().catch(() => {});
        return;
    }
  }

  private updateSummary(f: { e: string; cid: string; seq: number; d: WireData }) {
    const s = this.summaries.get(f.cid);
    if (f.e === "member.removed" && f.d.userId === this._userId) {
      this.summaries.delete(f.cid);
      return this.notifySummaries();
    }
    if (!s) {
      if (f.e === "conversation.created" || f.e === "message.new") void this.refreshSummaries().catch(() => {});
      return;
    }
    const next: ConversationSummary = { ...s, lastSeq: Math.max(s.lastSeq, f.seq), lastActivityAt: new Date().toISOString() };
    if (f.e === "message.new") {
      next.lastMessage = f.d.message;
      if (f.d.message.senderId !== this._userId) next.unreadCount = Math.min(99, s.unreadCount + 1);
    }
    if (f.e === "conversation.updated") {
      if (f.d.changes?.name !== undefined) next.name = f.d.changes.name;
      if (f.d.changes?.metadata !== undefined) next.metadata = f.d.changes.metadata;
    }
    this.summaries.set(f.cid, next);
    this.notifySummaries();
  }

  /** Internal: the user read a conversation up to `seq`; clear its badge in conversations.watch(). */
  noteRead(cid: string, seq: number) {
    const s = this.summaries.get(cid);
    if (!s) return;
    this.summaries.set(cid, { ...s, unreadCount: seq >= s.lastSeq ? 0 : s.unreadCount, lastReadSeq: Math.max(s.lastReadSeq, seq) });
    this.notifySummaries();
  }

  private notifySummaries() {
    if (!this.summaryWatchers.size) return;
    const list = [...this.summaries.values()].sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
    for (const cb of this.summaryWatchers) cb(list);
  }

  private async refreshSummaries() {
    if (!this.summaryWatchers.size) return;
    const page = await this.rest.request<Page<ConversationSummary>>("GET", "/v1/conversations", { query: { limit: 100 } });
    this.summaries.clear();
    for (const s of page.data) this.summaries.set(s.id, s);
    this.notifySummaries();
  }

  // ------------------------------------------------------------------ conversations

  /** Internal: a conversation object already in memory. */
  cached(id: string) {
    return this.convs.get(id);
  }

  dropConversation(id: string) {
    this.convs.delete(id);
    this.summaries.delete(id);
    this.notifySummaries();
  }

  private async materialize(c: ServerConversation): Promise<Conversation> {
    const existing = this.convs.get(c.id);
    if (existing) return existing;
    const inflight = this.loading.get(c.id);
    if (inflight) return inflight;
    const p = (async () => {
      const conv = new Conversation(this, c);
      this.convs.set(c.id, conv);
      try {
        await conv.loadLatest();
        if (c.lastReadSeq !== undefined) {
          const me = conv.members.find((m) => m.userId === this._userId);
          if (me) me.lastReadSeq = c.lastReadSeq;
        }
        const members = await this.rest.request<{ data: { userId: string; role: "owner" | "member"; lastReadSeq: number; lastDeliveredSeq: number }[] }>(
          "GET",
          path`/v1/conversations/${c.id}/members`,
        );
        conv.members = members.data.map((m) => ({ userId: m.userId, role: m.role, lastReadSeq: m.lastReadSeq, lastDeliveredSeq: m.lastDeliveredSeq }));
        conv.unreadCount = this.summaries.get(c.id)?.unreadCount ?? 0;
        if (this.transport.isOpen) await conv.catchUp().catch(() => {});
        return conv;
      } catch (err) {
        this.convs.delete(c.id);
        throw err;
      } finally {
        this.loading.delete(c.id);
      }
    })();
    this.loading.set(c.id, p);
    return p;
  }

  readonly conversations = {
    /** The one-to-one conversation with `userId` (created on first use). */
    direct: async (userId: string): Promise<Conversation> => {
      const c = await this.rest.request<ServerConversation>("POST", "/v1/conversations", { body: { type: "direct", members: [userId] }, idempotent: true });
      return this.materialize(c);
    },
    create: async (input: { name?: string; members: string[]; metadata?: Json }): Promise<Conversation> => {
      const c = await this.rest.request<ServerConversation>("POST", "/v1/conversations", { body: { type: "group", ...input }, idempotent: true });
      return this.materialize(c);
    },
    get: async (id: string): Promise<Conversation> => {
      const hit = this.convs.get(id);
      if (hit) return hit;
      return this.materialize(await this.rest.request<ServerConversation>("GET", path`/v1/conversations/${id}`));
    },
    list: async (opts: { limit?: number; cursor?: string } = {}): Promise<Page<ConversationSummary>> => {
      const page = await this.rest.request<Page<ConversationSummary>>("GET", "/v1/conversations", { query: { limit: opts.limit, cursor: opts.cursor } });
      for (const s of page.data) this.summaries.set(s.id, s);
      return page;
    },
    /** Live list sorted by activity; updated by events and sync. */
    watch: (cb: (list: ConversationSummary[]) => void): Unsubscribe => {
      this.summaryWatchers.add(cb);
      void this.refreshSummaries().catch((e) => this.emitter.emit("error", e));
      return () => this.summaryWatchers.delete(cb);
    },
  };

  // ------------------------------------------------------------------ presence

  readonly presence = {
    /** Online/offline for these users (union of all watches ≤ 200 per connection). */
    watch: (userIds: string[], cb: (p: Presence) => void): Unsubscribe => {
      const id = ++this.presenceSeq;
      this.presenceWatchers.set(id, { userIds: [...new Set(userIds)], cb });
      void this.rewatchPresence(id);
      return () => {
        this.presenceWatchers.delete(id);
        void this.rewatchPresence();
      };
    },
  };

  private async rewatchPresence(snapshotFor?: number) {
    if (!this.transport.isOpen) return;
    const union = [...new Set([...this.presenceWatchers.values()].flatMap((w) => w.userIds))].slice(0, 200);
    if (!union.length && !snapshotFor) {
      await this.transport.request("presence.watch", { userIds: [] }).catch(() => {});
      return;
    }
    const r = await this.transport.request<{ presence: Presence[] }>("presence.watch", { userIds: union }).catch(() => null);
    if (!r) return;
    for (const [id, w] of this.presenceWatchers) {
      if (snapshotFor !== undefined && id !== snapshotFor) continue;
      for (const p of r.presence) if (w.userIds.includes(p.userId)) w.cb(p);
    }
  }

  // ------------------------------------------------------------------ attachments

  readonly attachments = {
    /** Short-lived download link for an attachment you can see (default 5 minutes, 60–3600 s). */
    url: (attachmentId: string, expiresIn?: number): Promise<{ url: string; expiresAt: string }> =>
      this.rest.request("GET", `/v1/attachments/${encodeURIComponent(attachmentId)}/url`, { query: { expiresIn } }),
  };

  // ------------------------------------------------------------------ push

  readonly push = {
    register: async (input: { provider: "fcm" | "apns" | "expo"; token: string }) => {
      await this.rest.request("POST", "/v1/push/devices", { body: input, idempotent: true });
    },
    unregister: async (token: string) => {
      await this.rest.request("DELETE", `/v1/push/devices/${encodeURIComponent(token)}`);
    },
  };
}

export { toMessage };
export type { ServerMessage };
