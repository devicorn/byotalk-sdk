// chat.search() and chatServer.search() against a running byotalk-server (local dev stack: api + worker), a local
// PostgreSQL with pgvector as the customer database and a fake OpenAI-compatible embeddings endpoint.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Chat, ChatError } from "../../src/core/index.js";
import { ByotalkApiError, ChatServer } from "../../src/server/index.js";

const API = process.env.BYOTALK_API_URL ?? "http://localhost:3000";
const RT = process.env.BYOTALK_RT_URL ?? "ws://localhost:3001";
// The customer database is created here; the dev server must reach it (EGRESS_ALLOW_PRIVATE=true in development).
const PG_ADMIN = process.env.SEARCH_PG_ADMIN_URL ?? "postgres://localhost:5432/postgres";
const DB = "byotalk_sdk_search";
const DIMS = 16;

function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 9973;
    v[h % DIMS]! += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

async function json(res: Response) {
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body)}`);
  return body;
}

const adminUrl = () => {
  const u = new URL(PG_ADMIN);
  u.pathname = `/${DB}`;
  u.searchParams.set("sslmode", "disable");
  return u.toString();
};

/** pgvector available locally? Recreates the customer database when it is. */
async function prepareCustomerDb(): Promise<boolean> {
  const c = new pg.Client({ connectionString: PG_ADMIN });
  try {
    await c.connect();
    if (!(await c.query(`SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).rowCount) return false;
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]);
    await c.query(`DROP DATABASE IF EXISTS ${DB}`);
    await c.query(`CREATE DATABASE ${DB}`);
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

const ready = await prepareCustomerDb();
if (!ready) console.warn(`search.test: skipped — no local PostgreSQL with pgvector at ${PG_ADMIN}`);

let fake: Server;
let devEnv: string;
let devKey: string;
let h: Record<string, string>;
const chats: Chat[] = [];
const dash = (method: string, path: string, body?: unknown) =>
  fetch(`${API}${path}`, { method, headers: { ...h, "byotalk-env": devEnv }, body: body === undefined ? undefined : JSON.stringify(body) }).then(json);
const chat = (user: string) => {
  const c = new Chat({ env: devEnv, token: Chat.devToken(user), baseUrl: API, realtimeUrl: RT });
  chats.push(c);
  return c;
};
const waitFor = async <T>(fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 250));
  }
};

beforeAll(async () => {
  if (!ready) return;
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { input: string[] };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: body.input.map((t, index) => ({ index, embedding: fakeEmbedding(t) })) }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));

  const email = `sdk-search-${Date.now()}@example.com`;
  const link = await json(await fetch(`${API}/v1/auth/magic-link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }));
  const verify = await fetch(`${API}/v1/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(link.devLink).searchParams.get("token") }) });
  h = { cookie: verify.headers.get("set-cookie")!.split(";")[0]!, "x-byotalk-dashboard": "1", "content-type": "application/json" };
  const me = await json(await fetch(`${API}/v1/auth/me`, { headers: h }));
  const project = await json(await fetch(`${API}/v1/dashboard/orgs/${me.orgs[0].id}/projects`, { method: "POST", headers: h, body: JSON.stringify({ name: "SDK search" }) }));
  devEnv = project.environments.find((e: { kind: string }) => e.kind === "development").id;
  const keys = await json(await fetch(`${API}/v1/dashboard/envs/${devEnv}/keys`, { headers: h }));
  devKey = (await json(await fetch(`${API}/v1/dashboard/envs/${devEnv}/keys/${keys.data[0].id}/reveal`, { method: "POST", headers: h }))).secret;

  await dash("POST", "/v1/storage/database/migrate", { adminUrl: adminUrl(), schema: "byotalk" });
  await dash("PATCH", "/v1/storage", { mode: "byo_db" });
  const st = await dash("PUT", "/v1/storage/search", { embeddingUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1/embeddings`, model: "fake", dimensions: DIMS });
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  await c.query(st.sql);
  await c.end();
  expect((await dash("POST", "/v1/storage/search/test")).ok).toBe(true);
});

afterAll(async () => {
  await Promise.all(chats.map((c) => c.disconnect()));
  if (fake) await new Promise((r) => fake.close(r));
});

describe.skipIf(!ready)("semantic search", () => {
  it("chat.search finds the closest message in the user's conversations only", async () => {
    const alice = chat("alice");
    await alice.connect();
    const group = await alice.conversations.create({ name: "Billing", members: ["bob"] });
    const sent = await group.send({ text: "The invoice payment for March is overdue" });
    await group.send({ text: "Lunch at noon tomorrow?" });

    const hits = await waitFor(async () => {
      const r = await alice.search("overdue invoice payment");
      return r.length === 2 && r;
    });
    expect(hits[0]!.message).toMatchObject({ id: sent.id, conversationId: group.id, text: "The invoice payment for March is overdue", status: "sent" });
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    expect(await alice.search("overdue invoice payment", { conversationId: group.id, limit: 1 })).toHaveLength(1);
    expect(await chat("carol").search("overdue invoice payment")).toEqual([]);
  });

  it("chatServer.search needs userId or conversationId", async () => {
    const server = new ChatServer({ secretKey: devKey, baseUrl: API });
    const r = await server.search({ query: "invoice", userId: "bob" });
    expect(r.data[0]!.message.text).toBe("The invoice payment for March is overdue");
    expect(() => server.search({ query: "invoice" })).toThrow(/userId or conversationId/);
  });

  it("search_disabled once switched off", async () => {
    await dash("DELETE", "/v1/storage/search");
    const err = await chat("alice").search("invoice").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatError);
    expect((err as ChatError).code).toBe("search_disabled");
    const server = await new ChatServer({ secretKey: devKey, baseUrl: API }).search({ query: "invoice", userId: "alice" }).catch((e: unknown) => e);
    expect(server).toBeInstanceOf(ByotalkApiError);
  });
});
