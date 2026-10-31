// Token cache + tokenProvider calls (docs/09-SDK-DESIGN.md §4 AuthManager).
import { ChatError } from "./errors.js";
import { tokenExpiry } from "./util.js";

export const SECRET_KEY_MESSAGE = "That is a secret key: it belongs on your server. Pass a user token (ChatServer.createToken) instead";

export type TokenSource = string | (() => Promise<string>);

export class AuthManager {
  private token: string | null = null;
  private expiresAt: number | null = null;
  private inflight: Promise<string> | null = null;

  constructor(private readonly source: TokenSource) {
    if (typeof source === "string") this.set(source);
  }

  get canRefresh() {
    return typeof this.source === "function";
  }

  private set(token: string) {
    this.token = token;
    this.expiresAt = tokenExpiry(token);
  }

  /** A token valid for at least 60 s more (refreshing through the provider when needed). */
  async get(): Promise<string> {
    if (this.token && (this.expiresAt === null || this.expiresAt - Date.now() > 60_000)) return this.token;
    if (!this.canRefresh) {
      if (this.token) return this.token; // static token: let the server answer token_expired
      throw new ChatError({ code: "token_invalid", type: "authentication", message: "No token" });
    }
    return this.refresh();
  }

  /** Calls the provider once even if many callers ask at the same time. */
  refresh(): Promise<string> {
    if (!this.canRefresh) return Promise.reject(new ChatError({ code: "token_expired", type: "authentication", message: "Token expired and no token provider was given" }));
    this.inflight ??= (this.source as () => Promise<string>)()
      .then((t) => {
        if (typeof t !== "string" || !t) throw new ChatError({ code: "token_invalid", type: "authentication", message: "tokenProvider returned no token" });
        // A tokenProvider that hands out a secret key would ship it to the browser or the app.
        if (t.startsWith("sk_")) throw new ChatError({ code: "invalid_request", type: "authentication", message: SECRET_KEY_MESSAGE });
        this.set(t);
        return t;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  get expiry() {
    return this.expiresAt;
  }
}
