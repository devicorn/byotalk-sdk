// REST client: Request-Id capture, idempotency keys, bounded retries for 5xx/429/network (docs/09 §4).
import type { AuthManager } from "./auth.js";
import { ChatError, errorFromBody, networkError } from "./errors.js";
import { backoffDelay, sleep, uuidv7 } from "./util.js";

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Retry POST/PATCH/DELETE safely by sending an Idempotency-Key. */
  idempotent?: boolean;
  signal?: AbortSignal;
}

export class RestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly env: string,
    private readonly auth: AuthManager,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl.replace(/\/$/, "") + path);
    url.searchParams.set("env", this.env);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const retrySafe = method === "GET" || opts.idempotent === true;
    const idemKey = opts.idempotent && method !== "GET" ? uuidv7() : undefined;
    let refreshed = false;

    for (let attempt = 0; ; attempt++) {
      const token = await this.auth.get();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "byotalk-env": this.env,
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(idemKey ? { "idempotency-key": idemKey } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: opts.signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        if (retrySafe && attempt < 3) {
          await sleep(backoffDelay(attempt, 300, 5_000));
          continue;
        }
        throw networkError();
      }
      const text = await res.text();
      const body = text ? safeJson(text) : null;
      if (res.ok) return body as T;
      const err = errorFromBody(res.status, body);
      if (err.code === "token_expired" && !refreshed && this.auth.canRefresh) {
        refreshed = true;
        await this.auth.refresh();
        attempt--;
        continue;
      }
      if (retrySafe && attempt < 3 && (res.status >= 500 || res.status === 429)) {
        await sleep(err.retryAfterMs ?? backoffDelay(attempt, 300, 5_000));
        continue;
      }
      throw err;
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { code: "internal", message: text.slice(0, 200) } };
  }
}

export { ChatError };
