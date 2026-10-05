// call.v1 signaling socket to the media server: request/ack correlation plus notifications.
import { ChatError } from "../core/errors.js";
import type { WebSocketCtor, WebSocketLike } from "../core/transport.js";

type Pending = { resolve: (d: Record<string, unknown>) => void; reject: (e: ChatError) => void; timer: ReturnType<typeof setTimeout> };

export class Signaling {
  private ws: WebSocketLike | null = null;
  private n = 0;
  private pending = new Map<string, Pending>();
  private hbTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly WS: WebSocketCtor,
    private readonly onNotify: (t: string, d: Record<string, unknown>) => void,
    private readonly onClose: (code: number, reason: { code?: string; message?: string }) => void,
  ) {}

  open(url: string, timeoutMs = 10_000): Promise<void> {
    // The join frame carries the call token: never over cleartext except to a local development server.
    const u = new URL(url);
    if (u.protocol !== "wss:" && !(u.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) {
      return Promise.reject(new ChatError({ code: "invalid_request", type: "invalid_request", message: `Refusing insecure media server URL ${u.origin}` }));
    }
    return new Promise((resolve, reject) => {
      const ws = new this.WS(`${url.replace(/\/$/, "")}/v1/call`, ["call.v1"]);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close(4000, "connect timeout");
        reject(new ChatError({ code: "timeout", type: "network", message: "Media server did not answer" }));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        // Keeps NAT/proxy mappings alive; the server pings too.
        this.hbTimer = setInterval(() => this.notify("hb", {}), 15_000);
        resolve();
      };
      ws.onerror = () => {};
      ws.onmessage = (ev) => this.onMessage(String(ev.data));
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (this.ws !== ws) return;
        this.cleanup();
        let info: { code?: string; message?: string };
        try {
          info = ev.reason ? JSON.parse(ev.reason) : {};
        } catch {
          info = { message: ev.reason };
        }
        this.failPending(new ChatError({ code: info.code ?? "network", type: "network", message: info.message ?? `Media connection closed (${ev.code})` }));
        reject(new ChatError({ code: "network", type: "network", message: "Media connection failed" }));
        this.onClose(ev.code, info);
      };
    });
  }

  request<T = Record<string, unknown>>(t: string, d: unknown = {}, timeoutMs = 10_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new ChatError({ code: "network", type: "network", message: "Media connection is not open" }));
    const id = String(++this.n);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ChatError({ code: "timeout", type: "network", message: `${t} timed out` }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as Pending["resolve"], reject, timer });
      ws.send(JSON.stringify({ t, id, d }));
    });
  }

  notify(t: string, d: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t, d }));
  }

  /** Closes without reporting it through onClose. */
  close(code = 1000) {
    const ws = this.ws;
    this.ws = null;
    this.cleanup();
    this.failPending(new ChatError({ code: "network", type: "network", message: "Media connection closed" }));
    if (ws && ws.readyState <= 1) ws.close(code, "client");
  }

  private onMessage(raw: string) {
    let f: { t: string; re?: string; d?: Record<string, unknown>; code?: string; message?: string };
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if ((f.t === "ack" || f.t === "error") && f.re) {
      const p = this.pending.get(f.re);
      if (!p) return;
      this.pending.delete(f.re);
      clearTimeout(p.timer);
      if (f.t === "ack") p.resolve(f.d ?? {});
      else p.reject(new ChatError({ code: f.code ?? "internal", message: f.message ?? "Media request failed" }));
      return;
    }
    this.onNotify(f.t, f.d ?? {});
  }

  private cleanup() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
  }

  private failPending(e: ChatError) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }
}
