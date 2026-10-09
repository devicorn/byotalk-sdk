// SDK against a running byotalk-server (local dev stack or the server Docker image in CI).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Chat, ChatError, memoryPersistence, type Conversation, type Message } from "../../src/core/index.js";
import { ChatServer } from "../../src/server/index.js";

const API = process.env.BYOTALK_API_URL ?? "http://localhost:3000";
const RT = process.env.BYOTALK_RT_URL ?? "ws://localhost:3001";

let devEnv: string;
let prodEnv: string;
let prodKey: string;
let dashHeaders: Record<string, string>;
const chats: Chat[] = [];

async function json(res: Response) {
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

/** Creates a fresh org + project through the dashboard sign-in flow (dev magic link). */
async function setup() {
  const email = `sdk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const link = await json(await fetch(`${API}/v1/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }));
  const token = new URL(link.devLink).searchParams.get("token");
  const verify = await fetch(`${API}/v1/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = verify.headers.get("set-cookie")!.split(";")[0]!;
  const h = { cookie, "x-byotalk-dashboard": "1", "content-type": "application/json" };
  dashHeaders = { cookie, "x-byotalk-dashboard": "1" };
  const me = await json(await fetch(`${API}/v1/auth/me`, { headers: h }));
  const project = await json(await fetch(`${API}/v1/dashboard/orgs/${me.orgs[0].id}/projects`, { method: "POST", headers: h, body: JSON.stringify({ name: "SDK tests" }) }));
  devEnv = project.environments.find((e: { kind: string }) => e.kind === "development").id;
  prodEnv = project.environments.find((e: { kind: string }) => e.kind === "production").id;
  const keys = await json(await fetch(`${API}/v1/dashboard/envs/${prodEnv}/keys`, { headers: h }));
  prodKey = (await json(await fetch(`${API}/v1/dashboard/envs/${prodEnv}/keys/${keys.data[0].id}/reveal`, { method: "POST", headers: h }))).secret;
}

function chat(user: string, extra: Partial<ConstructorParameters<typeof Chat>[0]> = {}) {
  const c = new Chat({ env: devEnv, token: Chat.devToken(user), baseUrl: API, realtimeUrl: RT, ...extra });
  chats.push(c);
  return c;
}

function waitFor<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() > end) return reject(new Error("timeout"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const texts = (c: Conversation) => c.messages.items.map((m) => m.text);

beforeAll(setup);
afterAll(async () => {
  await Promise.all(chats.map((c) => c.disconnect()));
});

describe("quick start (docs/09 §2)", () => {
  it("alice and bob exchange messages in six lines", async () => {
    const alice = chat("alice");
    await alice.connect();
    expect(alice.connectionState).toBe("connected");
    const dm = await alice.conversations.direct("bob");

    const bob = chat("bob");
    await bob.connect();
    const bobDm = await bob.conversations.direct("alice");
    expect(bobDm.id).toBe(dm.id);
    const received: Message[] = [];
    bobDm.on("message.new", (m) => received.push(m));

    const sent = await dm.send({ text: "Hello Bob" });
    expect(sent).toMatchObject({ status: "sent", text: "Hello Bob", senderId: "alice" });
    expect(sent.seq).toBeGreaterThan(0);
    await waitFor(() => received.find((m) => m.id === sent.id));
    expect(texts(bobDm)).toContain("Hello Bob");
    expect(texts(dm)).toContain("Hello Bob");
  });
});

describe("livestreams", () => {
  it("a host streams, viewers join without membership, chat, and keep watching after a reconnect", async () => {
    const host = chat("ls-host");
    await host.connect();
    const live = await host.livestreams.create({ name: "Launch" });
    expect(live.type).toBe("livestream");

    const viewer = chat("ls-viewer");
    await viewer.connect();
    const watched = await viewer.livestreams.join(live.id);
    expect(await viewer.livestreams.viewers(live.id)).toBe(1);

    await live.send({ text: "We are live" });
    await waitFor(() => texts(watched).includes("We are live"));
    await watched.send({ text: "hi from the crowd" });
    await waitFor(() => texts(live).includes("hi from the crowd"));

    // Missed while disconnected, then delivered after the automatic rejoin.
    viewer.transport.stop();
    await live.send({ text: "while you were away" });
    viewer.transport.start();
    await waitFor(() => texts(watched).includes("while you were away"), 10_000);
    await live.send({ text: "and live again" });
    await waitFor(() => texts(watched).includes("and live again"), 10_000);

    await viewer.livestreams.leave(live.id);
    expect(await viewer.livestreams.viewers(live.id)).toBe(0);
  });
});

describe("delivery guarantees", () => {
  it("sends made while disconnected stay pending and flush exactly once on reconnect", async () => {
    const alice = chat("alice");
    const bob = chat("bob");
    await Promise.all([alice.connect(), bob.connect()]);
    const dm = await alice.conversations.direct("bob");
    const bobDm = await bob.conversations.direct("alice");
    await alice.disconnect();
    const p = dm.send({ text: "queued while offline" });
    expect(dm.messages.items.at(-1)).toMatchObject({ status: "sending", id: null });
    await alice.connect();
    const m = await p;
    expect(m.status).toBe("sent");
    await waitFor(() => texts(bobDm).includes("queued while offline"));
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(bobDm).filter((t) => t === "queued while offline")).toHaveLength(1);
  });

  it("a client that was offline catches up on reconnect (sync + events)", async () => {
    const alice = chat("alice");
    const bob = chat("bob");
    await Promise.all([alice.connect(), bob.connect()]);
    const dm = await alice.conversations.direct("bob");
    const bobDm = await bob.conversations.direct("alice");
    await bob.disconnect();
    for (const t of ["missed 1", "missed 2", "missed 3"]) await dm.send({ text: t });
    await bob.connect();
    await waitFor(() => ["missed 1", "missed 2", "missed 3"].every((t) => texts(bobDm).includes(t)));
    const seqs = bobDm.messages.items.map((m) => m.seq!);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("unsent messages survive an app kill with a persistence adapter", async () => {
    const storage = memoryPersistence();
    const bob = chat("bob");
    await bob.connect();
    const bobDm = await bob.conversations.direct("carol");
    // App 1: connects once (so the user is known), goes offline, queues a message, then is killed.
    const app1 = chat("carol", { persistence: storage });
    await app1.connect();
    const dm1 = await app1.conversations.direct("bob");
    await app1.disconnect();
    void dm1.send({ text: "sent after restart" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    // App 2: same storage, new process.
    const app2 = chat("carol", { persistence: storage });
    await app2.connect();
    await waitFor(() => texts(bobDm).includes("sent after restart"));
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(bobDm).filter((t) => t === "sent after restart")).toHaveLength(1);
  });

  it("edits and deletes reach the other side", async () => {
    const alice = chat("alice");
    const bob = chat("bob");
    await Promise.all([alice.connect(), bob.connect()]);
    const dm = await alice.conversations.direct("bob");
    const bobDm = await bob.conversations.direct("alice");
    const m = await dm.send({ text: "tpyo" });
    await dm.edit(m.id!, { text: "typo fixed" });
    await waitFor(() => bobDm.messages.get(m.id!)?.text === "typo fixed");
    await dm.delete(m.id!);
    await waitFor(() => bobDm.messages.get(m.id!)?.deletedAt);
    expect(bobDm.messages.get(m.id!)!.text).toBeNull();
  });

  it("loadOlder pages backwards through history", async () => {
    const alice = chat("alice");
    await alice.connect();
    const g = await alice.conversations.create({ name: "History", members: ["bob"] });
    for (let i = 0; i < 60; i++) await g.send({ text: `h${i}` });
    const fresh = chat("bob");
    await fresh.connect();
    const conv = await fresh.conversations.get(g.id);
    expect(conv.messages.items.length).toBe(50);
    const older = await conv.loadOlder({ limit: 50 });
    expect(older.hasMore).toBe(false);
    expect(conv.messages.items[0]!.text).toBe("h0");
  });
});

describe("ephemeral signals", () => {
  it("typing, read receipts and presence", async () => {
    const alice = chat("alice");
    const bob = chat("bob");
    await Promise.all([alice.connect(), bob.connect()]);
    const dm = await alice.conversations.direct("bob");
    const bobDm = await bob.conversations.direct("alice");

    const typing: string[][] = [];
    dm.on("typing", (ids) => typing.push(ids));
    bobDm.typing();
    await waitFor(() => typing.some((t) => t.includes("bob")));

    const m = await dm.send({ text: "did you read this?" });
    await waitFor(() => bobDm.messages.get(m.id!));
    await bobDm.markRead();
    await waitFor(() => dm.readBy(m.seq!).includes("bob"));

    // Presence is only shared between users who have a conversation together: dora has one with alice, zed doesn't.
    await alice.conversations.direct("dora");
    const seen: { userId: string; online: boolean }[] = [];
    const stop = alice.presence.watch(["dora", "zed"], (p) => seen.push(p));
    await waitFor(() => seen.find((p) => p.userId === "dora" && !p.online));
    const [dora, zed] = [chat("dora"), chat("zed")];
    await Promise.all([dora.connect(), zed.connect()]);
    await waitFor(() => seen.find((p) => p.userId === "dora" && p.online));
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.some((p) => p.userId === "zed")).toBe(false);
    stop();
  });

  it("conversations.watch keeps a live list with unread counts", async () => {
    const erin = chat("erin");
    await erin.connect();
    let latest: { id: string; unreadCount: number }[] = [];
    erin.conversations.watch((list) => (latest = list));
    const alice = chat("alice");
    await alice.connect();
    const dm = await alice.conversations.direct("erin");
    await dm.send({ text: "ping erin" });
    await waitFor(() => latest.find((c) => c.id === dm.id && c.unreadCount >= 1));
    // Reading the conversation clears the badge in the live list.
    const opened = await erin.conversations.get(dm.id);
    await opened.markRead();
    await waitFor(() => latest.find((c) => c.id === dm.id && c.unreadCount === 0));
  });
});

describe("production auth with the server SDK", () => {
  it("token route + tokenProvider; server-side sends reach the client", async () => {
    const server = new ChatServer({ secretKey: prodKey, baseUrl: API });
    await server.users.upsert({ id: "buyer_1", name: "Buyer" });
    let calls = 0;
    const client = new Chat({
      env: prodEnv,
      token: async () => {
        calls++;
        return server.createToken("buyer_1", { expiresIn: "1h" });
      },
      baseUrl: API,
      realtimeUrl: RT,
    });
    chats.push(client);
    await client.connect();
    expect(client.userId).toBe("buyer_1");
    expect(calls).toBe(1);
    const conv = (await server.conversations.create({ type: "group", name: "Order 9", members: ["buyer_1", "seller_1"], metadata: { orderId: "9" } })) as { id: string };
    const c = await client.conversations.get(conv.id);
    await server.messages.send(conv.id, { senderId: "system", text: "Order shipped" });
    await waitFor(() => texts(c).includes("Order shipped"));
  });

  it("a rejected token is refreshed once through the provider", async () => {
    const server = new ChatServer({ secretKey: prodKey, baseUrl: API });
    let calls = 0;
    const client = new Chat({
      env: prodEnv,
      token: async () => (++calls === 1 ? "not-a-valid-token" : server.createToken("buyer_2")),
      baseUrl: API,
      realtimeUrl: RT,
    });
    chats.push(client);
    await client.connect();
    expect(calls).toBe(2);
    expect(client.connectionState).toBe("connected");
  });

  it("dev tokens are refused in production: connect fails, state is failed", async () => {
    const client = new Chat({ env: prodEnv, token: Chat.devToken("x"), baseUrl: API, realtimeUrl: RT });
    chats.push(client);
    const errors: ChatError[] = [];
    client.on("error", (e) => errors.push(e));
    await expect(client.connect()).rejects.toBeInstanceOf(ChatError);
    expect(client.connectionState).toBe("failed");
    expect(errors[0]!.code).toBe("dev_tokens_disabled");
  });
});

describe("attachments on the customer's own storage (S3-compatible via MinIO)", () => {
  it("conversation.upload → send → chat.attachments.url → download", async (t) => {
    const endpoint = process.env.TEST_S3_ENDPOINT ?? "http://127.0.0.1:9000";
    try {
      await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1500) });
    } catch {
      return t.skip();
    }
    const server = new ChatServer({ secretKey: prodKey, baseUrl: API });
    const conv = (await server.conversations.create({ type: "group", name: "Files", members: ["uploader", "viewer"] })) as { id: string };
    // Point production media at the local S3 (the server tests create the bucket).
    const res = await fetch(`${API}/v1/storage/media`, {
      method: "PUT",
      headers: { ...dashHeaders, "byotalk-env": prodEnv, "content-type": "application/json" },
      body: JSON.stringify({ provider: "s3", preset: "minio", endpoint, region: "us-east-1", bucket: "byotalk-test", accessKeyId: "minioadmin", secretAccessKey: "minioadmin", prefix: "sdk" }),
    });
    const media = await res.json();
    if (!media.ok) return t.skip(); // bucket missing: run the server media tests first
    const client = new Chat({ env: prodEnv, token: async () => server.createToken("uploader"), baseUrl: API, realtimeUrl: RT });
    chats.push(client);
    await client.connect();
    const c = await client.conversations.get(conv.id);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const progress: number[] = [];
    const att = await c.upload(new File([png], "pixel.png", { type: "image/png" }), { onProgress: (p) => progress.push(p) });
    expect(att).toMatchObject({ name: "pixel.png", size: png.length, mimeType: "image/png" });
    const sent = await c.send({ text: "file", attachments: [att] });
    expect(sent.status).toBe("sent");
    const link = await client.attachments.url(att.id, 120);
    const file = new Uint8Array(await (await fetch(link.url)).arrayBuffer());
    expect(Array.from(file)).toEqual(Array.from(png));
    expect(progress.at(-1)).toBe(1);
  });
});
