import type { Unsubscribe } from "./types.js";

/** UUIDv7 (time-ordered) for clientMsgId; uses only Web Crypto. */
export function uuidv7(now = Date.now()): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Full-jitter exponential backoff (docs/08 §6): random(0, min(cap, base * 2^attempt)). */
export const backoffDelay = (attempt: number, base = 500, cap = 30_000, rand = Math.random) =>
  Math.floor(rand() * Math.min(cap, base * 2 ** attempt));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => void;

export class Emitter {
  private handlers = new Map<string, Set<Handler>>();

  on(event: string, cb: Handler): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  }

  emit(event: string, ...args: unknown[]) {
    for (const cb of [...(this.handlers.get(event) ?? [])]) {
      try {
        cb(...args);
      } catch (err) {
        // A listener error must never break the SDK loop.
        setTimeout(() => {
          throw err;
        });
      }
    }
  }

  listenerCount(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }
}

/** Reads `exp` from a JWT without verifying (the server verifies). Dev tokens have no expiry. */
export function tokenExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
