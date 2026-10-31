// Connection and sync reliability: token-provider failures, duplicate sockets, listener cleanup, catch-up retries,
// send timeouts, unread counts and the connected state (audit fixes for 0.3.1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthManager } from "../../src/core/auth.js";
import { Chat } from "../../src/core/chat.js";
import { Conversation } from "../../src/core/conversation.js";
import { ChatError } from "../../src/core/errors.js";
import { Transport } from "../../src/core/transport.js";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor() {
    FakeWS.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const newTransport = (source: ConstructorParameters<typeof AuthManager>[0]) =>
  new Transport({ realtimeUrl: "wss://rt.test", env: "env_1", sdk: "js/test", auth: new AuthManager(source), WebSocket: FakeWS as never });

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Transport token provider", () => {
  it("retries a provider that throws a plain error instead of failing", async () => {
    const provider = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue("tok");
    const t = newTransport(provider);
    const errors: ChatError[] = [];
    t.on("error", (e: ChatError) => errors.push(e));
    t.start();
    await flush();
    expect(t.state).toBe("reconnecting");
    expect(errors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(FakeWS.instances).toHaveLength(1);
    t.stop();
  });

  it("fails on an explicit authentication error and removes the online listeners", async () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal("addEventListener", add);
    vi.stubGlobal("removeEventListener", remove);
    const t = newTransport(() => Promise.reject(new ChatError({ code: "token_invalid", type: "authentication", message: "no" })));
    t.on("error", () => {});
    t.start();
    await flush();
    expect(t.state).toBe("failed");
    expect(add).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it("reconnectNow() while a token fetch is in flight does not open a second socket", async () => {
    let release!: (t: string) => void;
    const provider = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise<string>((r) => (release = r)));
    const t = newTransport(provider);
    t.on("error", () => {});
    t.start();
    await flush();
    await vi.advanceTimersByTimeAsync(600); // backoff timer fired: open() waits for the token
    expect(provider).toHaveBeenCalledTimes(2);
    t.reconnectNow();
    t.reconnectNow();
    release("tok");
    await flush();
    expect(FakeWS.instances).toHaveLength(1);
    t.reconnectNow(); // handshake under way
    expect(FakeWS.instances).toHaveLength(1);
    t.stop();
  });
});

describe("AuthManager", () => {
  it("rejects a secret key returned by the token provider", async () => {
    const auth = new AuthManager(() => Promise.resolve("sk_live_abc"));
    await expect(auth.get()).rejects.toMatchObject({ code: "invalid_request", type: "authentication" });
    await expect(auth.get()).rejects.not.toHaveProperty("message", "sk_live_abc");
  });
});

const newChat = () => new Chat({ env: "env_1", token: "dev:alice", WebSocket: FakeWS as never });
type Internals = {
  convs: Map<string, Conversation>;
  runSync(): Promise<void>;
  afterHello(): Promise<void>;
  outbox: { enqueue(e: unknown): Promise<unknown> };
};
const ev = (seq: number) => ({ seq, type: "message.new", message: { id: `m_${seq}`, seq, senderId: "bob", text: "hi", createdAt: new Date(0).toISOString() } });

describe("Conversation catch-up", () => {
  it("does not reject unhandled and retries held events on a timer", async () => {
    const chat = newChat();
    const rest = vi
      .spyOn(chat.rest, "request")
      .mockRejectedValueOnce(new ChatError({ code: "network", message: "down" }))
      .mockResolvedValue({ data: [ev(1)], hasMore: false } as never);
    const conv = new Conversation(chat, { id: "c_1", type: "group", name: null, lastSeq: 0 } as never);
    conv.applyEvent(2, "message.new", ev(2));
    await flush();
    expect(conv.lastSeq).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rest).toHaveBeenCalledTimes(2);
    expect(conv.lastSeq).toBe(2);
  });
});

describe("Chat sync", () => {
  it("does not double count unread after a reconnect replay", async () => {
    const chat = newChat();
    const conv = new Conversation(chat, { id: "c_1", type: "group", name: null, lastSeq: 0 } as never);
    (chat as unknown as Internals).convs.set("c_1", conv);
    vi.spyOn(chat.transport, "request").mockResolvedValue({ conversations: [{ id: "c_1", lastSeq: 1, unreadCount: 1 }], removed: [], cursor: "x", fullReload: false } as never);
    vi.spyOn(chat.rest, "request").mockImplementation(async (_m, p) =>
      (String(p).includes("/events") ? { data: [ev(1)], hasMore: false } : { data: [], hasMore: false }) as never,
    );
    await (chat as unknown as Internals).runSync();
    expect(conv.lastSeq).toBe(1);
    expect(conv.unreadCount).toBe(1);
  });

  it("stays out of 'connected' when the socket dropped during the sync", async () => {
    const chat = newChat();
    const i = chat as unknown as Internals & Record<string, unknown>;
    i.runSync = async () => {};
    i.rewatchPresence = async () => {};
    i.rejoinLive = async () => {};
    vi.spyOn(chat.outbox, "flush").mockResolvedValue();
    const open = vi.spyOn(chat.transport, "isOpen", "get").mockReturnValue(false);
    let resolved = false;
    void chat.connect().then(() => (resolved = true));
    chat.transport.stop(); // connect() started the transport; keep it from reaching the network
    chat.transport.hello = { userId: "alice" } as never;
    await i.afterHello();
    expect(chat.transport.state).not.toBe("connected");
    expect(resolved).toBe(false);
    open.mockReturnValue(true);
    await i.afterHello();
    expect(chat.transport.state).toBe("connected");
    await flush();
    expect(resolved).toBe(true);
  });
});

describe("Outbox", () => {
  it("resends with the same clientMsgId after a send timeout on an open socket", async () => {
    const chat = newChat();
    vi.spyOn(chat.transport, "isOpen", "get").mockReturnValue(true);
    const request = vi
      .spyOn(chat.transport, "request")
      .mockRejectedValueOnce(new ChatError({ code: "timeout", type: "network", message: "message.send timed out" }))
      .mockResolvedValue({ clientMsgId: "p1", id: "m1", seq: 1, createdAt: new Date(0).toISOString() } as never);
    const sent = (chat as unknown as Internals).outbox.enqueue({ clientMsgId: "p1", cid: "c_1", payload: { clientMsgId: "p1", text: "x" }, createdAt: Date.now() });
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1]).toMatchObject({ clientMsgId: "p1" });
    await expect(sent).resolves.toMatchObject({ id: "m1", clientMsgId: "p1" });
  });
});
