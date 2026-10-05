// Server SDK (`byotalk/server`): local token signing, REST client, webhook verification. Node 22+ only.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { path } from "../core/util.js";

export interface ChatServerOptions {
  /** sk_live_… or sk_test_… — keep it on your server. */
  secretKey: string;
  /** whsec_… — needed for webhooks.verify (or pass it to verify()). */
  webhookSecret?: string;
  baseUrl?: string;
}

export class ByotalkApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ByotalkApiError";
  }
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

function parseDuration(v: string | number | undefined): number {
  if (v === undefined) return 3600;
  if (typeof v === "number") return v;
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(v.trim());
  if (!m) throw new Error(`Invalid expiresIn: ${v}`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s" | "m" | "h" | "d"];
}

export interface WebhookEvent<T = Record<string, unknown>> {
  id: string;
  type: string;
  createdAt: string;
  env: string;
  data: T;
}

export class ChatServer {
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly webhookSecret?: string;
  /** Key id: "key_" + first 16 chars of base64url(sha256(secret)) — the JWT kid. */
  readonly keyId: string;

  constructor(opts: ChatServerOptions) {
    if (!opts?.secretKey || !/^sk_(live|test)_/.test(opts.secretKey)) throw new Error("secretKey must be an sk_live_ or sk_test_ key");
    this.secret = opts.secretKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.byotalk.com").replace(/\/$/, "");
    this.webhookSecret = opts.webhookSecret;
    this.keyId = `key_${createHash("sha256").update(this.secret).digest("base64url").slice(0, 16)}`;
  }

  /** Signs a user token locally (HS256). No network call. */
  createToken(userId: string, opts: { expiresIn?: string | number } = {}): string {
    if (!/^[A-Za-z0-9_\-@.:]{1,128}$/.test(userId)) throw new Error("Invalid userId");
    const iat = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT", kid: this.keyId }));
    const body = b64url(JSON.stringify({ sub: userId, iat, exp: iat + parseDuration(opts.expiresIn) }));
    const sig = createHmac("sha256", this.secret).update(`${head}.${body}`).digest("base64url");
    return `${head}.${body}.${sig}`;
  }

  // Responses follow docs/07; callers may narrow T.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async request<T = any>(method: string, path: string, body?: unknown, opts: { idempotencyKey?: string; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.secret}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        if ((method === "GET" || opts.idempotencyKey) && attempt < 2) continue;
        throw err;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : null;
      if (res.ok) return json as T;
      const retry = (method === "GET" || opts.idempotencyKey) && attempt < 2 && (res.status >= 500 || res.status === 429);
      if (retry) {
        await new Promise((r) => setTimeout(r, json?.error?.retryAfterMs ?? 300 * 2 ** attempt));
        continue;
      }
      throw new ByotalkApiError(res.status, json?.error?.code ?? "internal", json?.error?.message ?? res.statusText, json?.error?.requestId);
    }
  }

  readonly users = {
    upsert: (u: { id: string; name?: string | null; imageUrl?: string | null; metadata?: Record<string, unknown> }) => {
      const { id, ...rest } = u;
      return this.request("PUT", `/v1/users/${encodeURIComponent(id)}`, rest);
    },
    get: (id: string) => this.request("GET", `/v1/users/${encodeURIComponent(id)}`),
    list: (opts: { limit?: number; cursor?: string } = {}) => this.request("GET", "/v1/users", undefined, { query: opts }),
    deactivate: (id: string) => this.request("POST", `/v1/users/${encodeURIComponent(id)}/deactivate`),
    reactivate: (id: string) => this.request("POST", `/v1/users/${encodeURIComponent(id)}/reactivate`),
    revokeTokens: (id: string) => this.request("POST", `/v1/users/${encodeURIComponent(id)}/revoke-tokens`),
    delete: (id: string, messages: "anonymize" | "delete" = "anonymize") =>
      this.request("DELETE", `/v1/users/${encodeURIComponent(id)}`, undefined, { query: { messages } }),
  };

  readonly conversations = {
    create: (input: { type: "direct" | "group"; members: string[]; name?: string; metadata?: Record<string, unknown>; ownerId?: string }) =>
      this.request("POST", "/v1/conversations", input, { idempotencyKey: crypto.randomUUID() }),
    get: (id: string) => this.request("GET", path`/v1/conversations/${id}`),
    list: (userId: string, opts: { limit?: number; cursor?: string } = {}) => this.request("GET", "/v1/conversations", undefined, { query: { userId, ...opts } }),
    update: (id: string, input: { name?: string; metadata?: Record<string, unknown> }) => this.request("PATCH", path`/v1/conversations/${id}`, input),
    delete: (id: string) => this.request("DELETE", path`/v1/conversations/${id}`),
    addMembers: (id: string, userIds: string[]) => this.request("POST", path`/v1/conversations/${id}/members`, { userIds }),
    removeMember: (id: string, userId: string) => this.request("DELETE", `/v1/conversations/${id}/members/${encodeURIComponent(userId)}`),
  };

  readonly messages = {
    send: (conversationId: string, input: { senderId: string; text?: string; metadata?: Record<string, unknown>; replyTo?: string; clientMsgId?: string }) =>
      this.request("POST", path`/v1/conversations/${conversationId}/messages`, { clientMsgId: crypto.randomUUID(), ...input }),
    list: (conversationId: string, opts: { before?: number; after?: number; limit?: number } = {}) =>
      this.request("GET", path`/v1/conversations/${conversationId}/messages`, undefined, { query: opts }),
    get: (id: string) => this.request("GET", path`/v1/messages/${id}`),
    update: (id: string, input: { text?: string; metadata?: Record<string, unknown>; expectedVersion: number }) => this.request("PATCH", path`/v1/messages/${id}`, input),
    delete: (id: string, opts: { hard?: boolean } = {}) => this.request("DELETE", path`/v1/messages/${id}`, undefined, { query: { hard: opts.hard ? "true" : undefined } }),
  };

  readonly webhooks = {
    /**
     * Verifies a Standard Webhooks signature against the RAW body and returns the parsed event.
     * Throws WebhookVerificationError on a bad signature or a timestamp more than 5 minutes off.
     */
    verify: <T = Record<string, unknown>>(rawBody: string | Buffer, headers: Record<string, string | string[] | undefined> | Headers, secret?: string): WebhookEvent<T> => {
      const key = secret ?? this.webhookSecret;
      if (!key) throw new WebhookVerificationError("No webhook secret configured");
      const h = (name: string) => {
        const v = headers instanceof Headers ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v ?? undefined;
      };
      const id = h("webhook-id");
      const ts = h("webhook-timestamp");
      const sigs = h("webhook-signature");
      if (!id || !ts || !sigs) throw new WebhookVerificationError("Missing webhook headers");
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw new WebhookVerificationError("Timestamp outside the 5 minute tolerance");
      const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
      const expected = createHmac("sha256", Buffer.from(key.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest();
      const ok = sigs.split(" ").some((s) => {
        const [version, value] = s.split(",");
        if (version !== "v1" || !value) return false;
        const got = Buffer.from(value, "base64");
        return got.length === expected.length && timingSafeEqual(got, expected);
      });
      if (!ok) throw new WebhookVerificationError("Invalid signature");
      return JSON.parse(body) as WebhookEvent<T>;
    },
  };

  usage(opts: { from?: string; to?: string; granularity?: "day" | "hour" } = {}) {
    return this.request("GET", "/v1/usage", undefined, { query: opts });
  }
}
