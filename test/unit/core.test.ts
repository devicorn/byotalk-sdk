import { describe, expect, it } from "vitest";
import { MessageStore } from "../../src/core/store.js";
import { backoffDelay, tokenExpiry, uuidv7 } from "../../src/core/util.js";
import { ChatError, HistoryUnavailableError } from "../../src/core/errors.js";
import { errorFromBody } from "../../src/core/errors.js";
import type { Message } from "../../src/core/types.js";

const msg = (p: Partial<Message>): Message => ({
  id: null, clientMsgId: null, conversationId: "c", seq: null, senderId: "a", text: "x", replyTo: null, attachments: [],
  metadata: {}, version: 1, status: "sent", createdAt: new Date().toISOString(), editedAt: null, deletedAt: null, ...p,
});

describe("MessageStore ordering (docs/09 §4.3)", () => {
  it("confirmed by seq, pending after, reconciled into position on ack", () => {
    const s = new MessageStore();
    s.upsert(msg({ id: "m2", seq: 2 }));
    s.upsert(msg({ id: "m1", seq: 1 }));
    s.addPending(msg({ clientMsgId: "p1", status: "sending", createdAt: "2026-01-01T00:00:00Z" }));
    s.upsert(msg({ id: "m3", seq: 3 }));
    expect(s.items.map((m) => m.id ?? m.clientMsgId)).toEqual(["m1", "m2", "m3", "p1"]);
    s.reconcile("p1", { id: "m4", seq: 4, createdAt: "2026-01-01T00:00:01Z" });
    expect(s.items.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(s.get("m4")).toMatchObject({ status: "sent", clientMsgId: "p1" });
  });

  it("an event that arrives before the ack is not duplicated", () => {
    const s = new MessageStore();
    s.addPending(msg({ clientMsgId: "p1", status: "sending" }));
    s.upsert(msg({ id: "m1", seq: 1 }));
    s.reconcile("p1", { id: "m1", seq: 1, createdAt: "x" });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ id: "m1", clientMsgId: "p1" });
  });

  it("older versions never replace newer ones; patch can be undone", () => {
    const s = new MessageStore();
    s.upsert(msg({ id: "m1", seq: 1, text: "v2", version: 2 }));
    s.upsert(msg({ id: "m1", seq: 1, text: "v1", version: 1 }));
    expect(s.get("m1")!.text).toBe("v2");
    const undo = s.patch("m1", { text: "optimistic" })!;
    expect(s.get("m1")!.text).toBe("optimistic");
    undo();
    expect(s.get("m1")!.text).toBe("v2");
  });

  it("keeps at most 500 messages", () => {
    const s = new MessageStore();
    s.upsertMany(Array.from({ length: 600 }, (_, i) => msg({ id: `m${i + 1}`, seq: i + 1 })));
    expect(s.items).toHaveLength(500);
    expect(s.oldestSeq).toBe(101);
  });

  it("subscribers get one notification per tick", async () => {
    const s = new MessageStore();
    let calls = 0;
    s.subscribe(() => calls++);
    s.upsert(msg({ id: "a", seq: 1 }));
    s.upsert(msg({ id: "b", seq: 2 }));
    await Promise.resolve();
    expect(calls).toBe(2); // initial call + one batched change
  });
});

describe("utilities", () => {
  it("uuidv7 is a valid, time-ordered UUID", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_500);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it("backoff is full jitter capped at 30 s", () => {
    expect(backoffDelay(0, 500, 30_000, () => 0.999)).toBeLessThan(500);
    expect(backoffDelay(20, 500, 30_000, () => 0.999)).toBeLessThanOrEqual(30_000);
    expect(backoffDelay(3, 500, 30_000, () => 0)).toBe(0);
  });

  it("reads exp from JWTs; dev tokens have none", () => {
    const body = btoa(JSON.stringify({ exp: 2_000_000_000 })).replace(/=+$/, "");
    expect(tokenExpiry(`h.${body}.s`)).toBe(2_000_000_000_000);
    expect(tokenExpiry("dev:alice")).toBeNull();
  });

  it("maps API errors to ChatError subclasses", () => {
    const e = errorFromBody(503, { error: { code: "history_unavailable", message: "x", retryAfterMs: 30000, requestId: "req_1" } });
    expect(e).toBeInstanceOf(HistoryUnavailableError);
    expect(e).toMatchObject({ retryable: true, retryAfterMs: 30000, requestId: "req_1" });
    expect(new ChatError({ code: "not_member", message: "x" }).retryable).toBe(false);
  });
});
