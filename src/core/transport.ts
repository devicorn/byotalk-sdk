// WebSocket lifecycle for chat.v1: auth-first, request/ack correlation, heartbeats, reconnect with
// full-jitter backoff, close-code handling (docs/08-REALTIME-PROTOCOL.md §1, §4–6).
import type { AuthManager } from "./auth.js";
import { ChatError } from "./errors.js";
import type { ConnectionState, WireData, WireFrame } from "./types.js";
import { backoffDelay, Emitter } from "./util.js";

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface Hello {
  sessionId: string;
  userId: string;
  serverTime: string;
  heartbeatMs: number;
  tokenExpiresAt: string | null;
  limits: { maxFrameBytes: number; sendsPerSecond: number };
}

interface Pending {
  resolve: (d: WireData) => void;
  reject: (e: ChatError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;
const LIVENESS_MS = 60_000;

export class Transport extends Emitter {
  state: ConnectionState = "disconnected";
  hello: Hello | null = null;
  private ws: WebSocketLike | null = null;
  private wanted = false;
  private attempt = 0;
  private reqId = 0;
  private pending = new Map<string, Pending>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private lastFrameAt = 0;
  private authRefreshed = false;
  private detachOnline: (() => void) | null = null;

  constructor(
    private readonly opts: { realtimeUrl: string; env: string; sdk: string; auth: AuthManager; WebSocket: WebSocketCtor },
  ) {
    super();
  }

  setState(s: ConnectionState) {
    if (this.state === s) return;
    this.state = s;
    this.emit("state", s);
  }

  get isOpen() {
    return !!this.ws && this.ws.readyState === OPEN && !!this.hello;
  }

  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.attempt = 0;
    this.watchOnline();
    this.open();
  }

  /** Normal close (1000); no reconnect. */
  stop() {
    this.wanted = false;
    this.clearTimers();
    this.detachOnline?.();
    this.detachOnline = null;
    const ws = this.ws;
    this.ws = null;
    this.hello = null;
    if (ws && ws.readyState <= OPEN) ws.close(1000, "client disconnect");
    this.failPending(new ChatError({ code: "network", type: "network", message: "Disconnected" }));
    this.setState("disconnected");
  }

  /** Reconnect now (app foreground, network back): resets backoff. */
  reconnectNow() {
    if (!this.wanted || this.state === "failed") return;
    if (this.state === "connected" || this.state === "syncing" || this.state === "connecting") return;
    this.attempt = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.open();
  }

  request<T = WireData>(t: string, d: unknown, timeoutMs = 5_000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new ChatError({ code: "network", type: "network", message: "Not connected" }));
    const id = String(++this.reqId);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ChatError({ code: "timeout", type: "network", message: `${t} timed out` }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ t, id, d }));
    });
  }

  send(t: string, d: unknown) {
    if (this.isOpen) this.ws!.send(JSON.stringify({ t, d }));
  }

  private watchOnline() {
    const g = globalThis as { addEventListener?: (e: string, cb: (ev?: { persisted?: boolean }) => void) => void; removeEventListener?: (e: string, cb: () => void) => void };
    if (typeof g.addEventListener !== "function") return;
    const online = () => this.reconnectNow();
    // Leaving the page: close cleanly so the server marks the user offline at once instead of after a grace period.
    const pagehide = () => {
      const ws = this.ws;
      if (ws && ws.readyState === OPEN) ws.close(1000, "page closed");
    };
    // Back from the back/forward cache: the socket was closed on pagehide, reconnect now.
    const pageshow = (ev?: { persisted?: boolean }) => ev?.persisted && this.reconnectNow();
    g.addEventListener("online", online);
    g.addEventListener("pagehide", pagehide);
    g.addEventListener("pageshow", pageshow);
    this.detachOnline = () => {
      g.removeEventListener?.("online", online);
      g.removeEventListener?.("pagehide", pagehide);
      g.removeEventListener?.("pageshow", pageshow as () => void);
    };
  }

  private async open() {
    if (!this.wanted) return;
    this.setState(this.attempt === 0 && this.state !== "reconnecting" ? "connecting" : "reconnecting");
    let token: string;
    try {
      token = await this.opts.auth.get();
    } catch (err) {
      return this.fail(err instanceof ChatError ? err : new ChatError({ code: "token_invalid", type: "authentication", message: String(err) }));
    }
    if (!this.wanted) return;
    const url = `${this.opts.realtimeUrl.replace(/\/$/, "")}/v1?env=${encodeURIComponent(this.opts.env)}&sdk=${encodeURIComponent(this.opts.sdk)}`;
    let ws: WebSocketLike;
    try {
      ws = new this.opts.WebSocket(url, ["chat.v1"]);
    } catch {
      return this.scheduleReconnect();
    }
    this.ws = ws;
    this.hello = null;
    ws.onopen = () => {
      this.lastFrameAt = Date.now();
      ws.send(JSON.stringify({ t: "auth", d: { token } }));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastFrameAt = Date.now();
      let f: WireFrame;
      try {
        f = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.onFrame(f);
    };
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.onClose(ev.code, ev.reason);
    };
    this.startLiveness();
  }

  private onFrame(f: WireFrame) {
    switch (f.t) {
      case "hello":
        this.hello = f.d;
        this.attempt = 0;
        this.authRefreshed = false;
        this.emit("hello", f.d);
        return;
      case "ack":
      case "error": {
        const p = f.re ? this.pending.get(f.re) : undefined;
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(f.re!);
          if (f.t === "ack") p.resolve(f.d);
          else p.reject(new ChatError({ code: f.code ?? "internal", message: f.message ?? "Request failed", retryAfterMs: f.retryAfterMs }));
        } else if (f.t === "error") {
          this.emit("error", new ChatError({ code: f.code ?? "internal", message: f.message ?? "Server error" }));
        }
        return;
      }
      case "hb":
        this.send("hb", {});
        return;
      case "goaway":
        this.ws?.close(1000, "goaway");
        this.dropSocket();
        this.scheduleReconnect(f.d?.reconnectAfterMs ?? 0);
        return;
      case "token_expiring":
        this.refreshToken();
        return;
      default:
        this.emit("frame", f);
    }
  }

  private async refreshToken() {
    if (!this.opts.auth.canRefresh) return;
    try {
      const token = await this.opts.auth.refresh();
      await this.request("token.refresh", { token });
    } catch (err) {
      this.emit("error", err);
    }
  }

  private onClose(code: number, reason: string) {
    this.dropSocket();
    if (!this.wanted) return;
    let info: { code?: string; message?: string; retryAfterMs?: number } = {};
    try {
      info = reason ? JSON.parse(reason) : {};
    } catch {
      info = { message: reason };
    }
    const err = (c: string, type: string) => new ChatError({ code: info.code ?? c, type, message: info.message ?? `Connection closed (${code})`, retryAfterMs: info.retryAfterMs });
    switch (code) {
      case 4001:
        // Token problem: refresh once through the provider, else give up.
        if (this.opts.auth.canRefresh && !this.authRefreshed) {
          this.authRefreshed = true;
          this.opts.auth.refresh().then(
            () => this.scheduleReconnect(0),
            (e) => this.fail(e instanceof ChatError ? e : err("token_invalid", "authentication")),
          );
          return;
        }
        return this.fail(err("token_invalid", "authentication"));
      case 4003:
        return this.fail(err("forbidden", "permission"));
      case 4009:
        return this.fail(err("too_many_connections", "rate_limited"));
      case 4008:
        return this.scheduleReconnect(info.retryAfterMs ?? backoffDelay(this.attempt++));
      case 1009:
        this.emit("error", err("body_too_large", "payload_too_large"));
        return this.scheduleReconnect();
      case 1012:
        return this.scheduleReconnect(Math.floor(Math.random() * 5_000));
      default:
        return this.scheduleReconnect();
    }
  }

  private dropSocket() {
    this.ws = null;
    this.hello = null;
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.failPending(new ChatError({ code: "network", type: "network", message: "Connection lost" }));
  }

  private scheduleReconnect(delay?: number) {
    if (!this.wanted) return;
    this.setState("reconnecting");
    const ms = delay ?? backoffDelay(this.attempt++);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, ms);
  }

  private fail(err: ChatError) {
    this.wanted = false;
    this.clearTimers();
    this.setState("failed");
    this.emit("error", err);
  }

  private startLiveness() {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = setInterval(() => {
      if (this.ws && Date.now() - this.lastFrameAt > LIVENESS_MS) {
        const ws = this.ws;
        this.dropSocket();
        try {
          ws.close(4000, "liveness timeout");
        } catch {
          /* already closed */
        }
        this.scheduleReconnect();
      }
    }, 5_000);
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.reconnectTimer = null;
    this.livenessTimer = null;
  }

  private failPending(err: ChatError) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}
