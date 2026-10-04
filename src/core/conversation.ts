// One conversation: message window, gapless event application, receipts, typing (docs/09 §3–4, docs/08 §7).
import type { Chat } from "./chat.js";
import { ChatError } from "./errors.js";
import { MessageStore } from "./store.js";
import type { Attachment, Json, Member, MemberEvent, Message, UploadInput, Unsubscribe, WireData } from "./types.js";
import { Emitter, uuidv7 } from "./util.js";

export interface ServerMessage {
  id: string;
  conversationId: string;
  seq: number;
  senderId: string;
  text: string | null;
  replyTo: string | null;
  attachments: Attachment[];
  metadata: Json;
  version: number;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface ServerConversation {
  id: string;
  type: "direct" | "group";
  name: string | null;
  metadata: Json;
  lastSeq: number;
  members?: { userId: string; role: "owner" | "member" }[];
  lastReadSeq?: number;
  muted?: boolean;
}

export const toMessage = (m: ServerMessage, clientMsgId: string | null = null): Message => ({
  ...m,
  clientMsgId,
  status: "sent",
});

const TYPING_EXPIRY_MS = 6_000;
const TYPING_THROTTLE_MS = 3_000;

export class Conversation {
  readonly id: string;
  readonly type: "direct" | "group";
  name: string | null;
  metadata: Json;
  members: Member[];
  unreadCount = 0;
  muted = false;
  /** Last contiguous event applied. */
  lastSeq: number;
  readonly messages = new MessageStore();

  private emitter = new Emitter();
  private typingUsers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastTypingSent = 0;
  private held: { seq: number; e: string; d: WireData }[] = [];
  private catchingUp: Promise<void> | null = null;
  private gapFailures = 0;
  removed = false;

  constructor(
    private readonly chat: Chat,
    c: ServerConversation,
  ) {
    this.id = c.id;
    this.type = c.type;
    this.name = c.name;
    this.metadata = c.metadata ?? {};
    this.members = (c.members ?? []).map((m) => ({ ...m }));
    this.lastSeq = c.lastSeq;
    this.muted = c.muted ?? false;
  }

  on(event: "message.new" | "message.updated" | "message.deleted" | "message.failed", cb: (m: Message) => void): Unsubscribe;
  on(event: "typing", cb: (userIds: string[]) => void): Unsubscribe;
  on(event: "receipt", cb: (r: { userId: string; lastReadSeq: number; lastDeliveredSeq: number }) => void): Unsubscribe;
  on(event: "member.added" | "member.removed", cb: (e: MemberEvent) => void): Unsubscribe;
  on(event: "updated" | "removed", cb: () => void): Unsubscribe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...a: any[]) => void): Unsubscribe {
    return this.emitter.on(event, cb);
  }

  // ------------------------------------------------------------------ loading

  /** Loads the latest page (called once when the conversation object is created). */
  async loadLatest(limit = 50) {
    const page = await this.chat.rest.request<{ data: ServerMessage[]; hasMore: boolean }>("GET", `/v1/conversations/${this.id}/messages`, { query: { limit } });
    this.messages.upsertMany(page.data.map((m) => toMessage(m)));
    return page.hasMore;
  }

  /** Older page before the oldest loaded message. Rejects with HistoryUnavailableError when the customer DB is down. */
  async loadOlder(opts: { limit?: number } = {}): Promise<{ messages: Message[]; hasMore: boolean }> {
    const before = this.messages.oldestSeq;
    if (before === null || before <= 1) return { messages: [], hasMore: false };
    const page = await this.chat.rest.request<{ data: ServerMessage[]; hasMore: boolean }>("GET", `/v1/conversations/${this.id}/messages`, {
      query: { before, limit: opts.limit ?? 50 },
    });
    const msgs = page.data.map((m) => toMessage(m));
    this.messages.upsertMany(msgs);
    return { messages: msgs, hasMore: page.hasMore };
  }

  // ------------------------------------------------------------------ sending

  /** Resolves on ack. Network problems do not reject: the message stays pending and is retried. */
  send(input: { text?: string; replyTo?: string; attachments?: (string | Attachment)[]; metadata?: Json }): Promise<Message> {
    const clientMsgId = uuidv7();
    const attachments = (input.attachments ?? []).map((a) => (typeof a === "string" ? a : a.id));
    const pending: Message = {
      id: null,
      clientMsgId,
      conversationId: this.id,
      seq: null,
      senderId: this.chat.userId ?? "",
      text: input.text ?? null,
      replyTo: input.replyTo ?? null,
      attachments: (input.attachments ?? []).filter((a): a is Attachment => typeof a !== "string"),
      metadata: input.metadata ?? {},
      version: 1,
      status: "sending",
      createdAt: new Date().toISOString(),
      editedAt: null,
      deletedAt: null,
    };
    this.messages.addPending(pending);
    if (this.lastTypingSent) {
      this.chat.transport.send("typing", { cid: this.id, state: "stop" });
      this.lastTypingSent = 0;
    }
    return this.chat.outbox.enqueue({
      clientMsgId,
      cid: this.id,
      payload: {
        cid: this.id,
        clientMsgId,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      createdAt: Date.now(),
    });
  }

  /** Retries a failed message with the same clientMsgId (dedup makes this safe). */
  retry(clientMsgId: string): Promise<Message> {
    const m = this.messages.getByClientId(clientMsgId);
    if (!m || m.id !== null) return Promise.reject(new ChatError({ code: "not_found", type: "not_found", message: "No failed message with that clientMsgId" }));
    this.messages.markSending(clientMsgId);
    return this.chat.outbox.retry(clientMsgId);
  }

  async edit(messageId: string, input: { text?: string; metadata?: Json }): Promise<Message> {
    const cur = this.messages.get(messageId);
    const undo = this.messages.patch(messageId, { ...input, editedAt: new Date().toISOString() });
    try {
      const expectedVersion = cur?.version ?? (await this.chat.rest.request<ServerMessage>("GET", `/v1/messages/${messageId}`)).version;
      const m = await this.chat.rest.request<ServerMessage>("PATCH", `/v1/messages/${messageId}`, { body: { ...input, expectedVersion } });
      const msg = toMessage(m, cur?.clientMsgId ?? null);
      this.messages.upsert(msg);
      return msg;
    } catch (err) {
      undo?.();
      throw err;
    }
  }

  async delete(messageId: string): Promise<void> {
    const undo = this.messages.patch(messageId, { text: null, attachments: [], metadata: {}, deletedAt: new Date().toISOString() });
    try {
      await this.chat.rest.request("DELETE", `/v1/messages/${messageId}`);
    } catch (err) {
      undo?.();
      throw err;
    }
  }

  /** Marks everything up to `seq` (default: latest) as read. Monotonic on the server. */
  async markRead(seq?: number): Promise<void> {
    const target = seq ?? this.latestSeq();
    if (!target) return;
    this.unreadCount = 0;
    if (this.chat.transport.isOpen) await this.chat.transport.request("read", { cid: this.id, seq: target });
    else await this.chat.rest.request("POST", `/v1/conversations/${this.id}/read`, { body: { seq: target } });
  }

  /** Call on every keystroke; sends at most one `typing start` per 3 s. */
  typing(): void {
    const now = Date.now();
    if (now - this.lastTypingSent < TYPING_THROTTLE_MS) return;
    this.lastTypingSent = now;
    this.chat.transport.send("typing", { cid: this.id, state: "start" });
  }

  /** Stops the typing indicator (e.g. on blur). */
  stopTyping(): void {
    if (!this.lastTypingSent) return;
    this.lastTypingSent = 0;
    this.chat.transport.send("typing", { cid: this.id, state: "stop" });
  }

  upload(file: UploadInput, opts: { onProgress?: (p: number) => void; signal?: AbortSignal } = {}): Promise<Attachment> {
    return this.chat.uploader.upload(this.id, file, opts);
  }

  async addMembers(userIds: string[]) {
    await this.chat.rest.request("POST", `/v1/conversations/${this.id}/members`, { body: { userIds } });
  }

  async removeMember(userId: string) {
    await this.chat.rest.request("DELETE", `/v1/conversations/${this.id}/members/${encodeURIComponent(userId)}`);
  }

  async leave() {
    await this.removeMember(this.chat.userId!);
  }

  async mute() {
    await this.chat.rest.request("PUT", `/v1/conversations/${this.id}/mute`);
    this.muted = true;
  }

  async unmute() {
    await this.chat.rest.request("DELETE", `/v1/conversations/${this.id}/mute`);
    this.muted = false;
  }

  async update(input: { name?: string; metadata?: Json }) {
    await this.chat.rest.request("PATCH", `/v1/conversations/${this.id}`, { body: input });
  }

  /** Members whose read watermark is at or past `seq` (excluding the sender of that message). */
  readBy(seq: number): string[] {
    const sender = this.messages.items.find((m) => m.seq === seq)?.senderId;
    return this.members.filter((m) => (m.lastReadSeq ?? 0) >= seq && m.userId !== sender).map((m) => m.userId);
  }

  get typingUserIds(): string[] {
    return [...this.typingUsers.keys()];
  }

  private latestSeq(): number {
    let max = 0;
    for (const m of this.messages.items) if (m.seq !== null && m.seq > max) max = m.seq;
    return Math.max(max, this.lastSeq);
  }

  // ------------------------------------------------------------------ incoming (called by Chat)

  /** Applies one stream event in seq order; holds it and catches up when there is a gap. */
  applyEvent(seq: number, e: string, d: WireData) {
    if (seq <= this.lastSeq) return;
    if (this.catchingUp || seq > this.lastSeq + 1) {
      this.held.push({ seq, e, d });
      if (!this.catchingUp) void this.catchUp();
      return;
    }
    this.apply(seq, e, d);
  }

  private apply(seq: number, e: string, d: WireData) {
    this.lastSeq = seq;
    switch (e) {
      case "message.new": {
        const m = toMessage(d.message);
        this.messages.upsert(m);
        const mine = m.senderId === this.chat.userId;
        if (!mine) {
          this.unreadCount++;
          this.chat.receipts.delivered(this.id, seq);
          this.clearTyping(m.senderId);
        }
        this.emitter.emit("message.new", this.messages.get(m.id!) ?? m);
        return;
      }
      case "message.updated": {
        const m = toMessage(d.message);
        this.messages.upsert(m);
        this.emitter.emit("message.updated", this.messages.get(m.id!) ?? m);
        return;
      }
      case "message.deleted": {
        this.messages.patch(d.id, { text: null, attachments: [], metadata: {}, deletedAt: d.deletedAt });
        const m = this.messages.get(d.id);
        if (m) this.emitter.emit("message.deleted", m);
        return;
      }
      case "member.added":
        for (const u of d.userIds as string[]) if (!this.members.some((m) => m.userId === u)) this.members.push({ userId: u, role: "member" });
        this.emitter.emit("member.added", d);
        return;
      case "member.removed":
        this.members = this.members.filter((m) => m.userId !== d.userId);
        this.emitter.emit("member.removed", d);
        if (d.userId === this.chat.userId) this.markRemoved();
        return;
      case "conversation.created":
        if (d.conversation?.members) this.members = d.conversation.members.map((m: Member) => ({ ...m }));
        return;
      case "conversation.updated":
        if (d.changes?.name !== undefined) this.name = d.changes.name;
        if (d.changes?.metadata !== undefined) this.metadata = d.changes.metadata;
        this.emitter.emit("updated");
        return;
    }
  }

  /** Fetches events after lastSeq (and applies held live events); 410 → reload the latest page. */
  catchUp(): Promise<void> {
    if (this.catchingUp) return this.catchingUp;
    this.catchingUp = (async () => {
      try {
        for (;;) {
          const page = await this.chat.rest.request<{ data: { seq: number; type: string; [k: string]: unknown }[]; hasMore: boolean }>(
            "GET",
            `/v1/conversations/${this.id}/events`,
            { query: { after: this.lastSeq, limit: 200 } },
          );
          for (const ev of page.data) {
            const { seq, type, ...d } = ev;
            if (seq === this.lastSeq + 1) this.apply(seq, type, d);
          }
          if (!page.hasMore) break;
        }
        this.gapFailures = 0;
      } catch (err) {
        if (err instanceof ChatError && err.code === "resync_required") await this.resync();
        else if (++this.gapFailures >= 3) await this.resync();
        else throw err;
      } finally {
        this.catchingUp = null;
      }
      const held = this.held.sort((a, b) => a.seq - b.seq);
      this.held = [];
      for (const h of held) this.applyEvent(h.seq, h.e, h.d);
    })();
    return this.catchingUp;
  }

  /** resync_required: drop the window, reload the latest page, continue from the server's lastSeq. */
  async resync() {
    const c = await this.chat.rest.request<ServerConversation>("GET", `/v1/conversations/${this.id}`);
    this.messages.clear();
    this.lastSeq = c.lastSeq;
    this.members = (c.members ?? []).map((m) => ({ ...m, ...this.members.find((x) => x.userId === m.userId) }));
    await this.loadLatest();
    this.held = this.held.filter((h) => h.seq > this.lastSeq);
    this.gapFailures = 0;
  }

  onReceipt(r: { userId: string; lastReadSeq?: number; lastDeliveredSeq?: number }) {
    let m = this.members.find((x) => x.userId === r.userId);
    if (!m) this.members.push((m = { userId: r.userId, role: "member" }));
    if (r.lastReadSeq !== undefined) m.lastReadSeq = Math.max(m.lastReadSeq ?? 0, r.lastReadSeq);
    if (r.lastDeliveredSeq !== undefined) m.lastDeliveredSeq = Math.max(m.lastDeliveredSeq ?? 0, r.lastDeliveredSeq);
    if (m.lastReadSeq !== undefined && (m.lastDeliveredSeq ?? 0) < m.lastReadSeq) m.lastDeliveredSeq = m.lastReadSeq;
    this.emitter.emit("receipt", { userId: r.userId, lastReadSeq: m.lastReadSeq ?? 0, lastDeliveredSeq: m.lastDeliveredSeq ?? 0 });
  }

  onTyping(userId: string, state: "start" | "stop") {
    if (userId === this.chat.userId) return;
    if (state === "stop") return this.clearTyping(userId);
    clearTimeout(this.typingUsers.get(userId));
    this.typingUsers.set(userId, setTimeout(() => this.clearTyping(userId), TYPING_EXPIRY_MS));
    this.emitter.emit("typing", this.typingUserIds);
  }

  private clearTyping(userId: string) {
    const t = this.typingUsers.get(userId);
    if (!t) return;
    clearTimeout(t);
    this.typingUsers.delete(userId);
    this.emitter.emit("typing", this.typingUserIds);
  }

  emitFailed(m: Message) {
    this.emitter.emit("message.failed", m);
  }

  markRemoved() {
    if (this.removed) return;
    this.removed = true;
    this.emitter.emit("removed");
    this.chat.dropConversation(this.id);
  }
}
