// Message window per conversation: confirmed messages ordered by seq, pending sends after them in local
// order; at most 500 messages kept (docs/09-SDK-DESIGN.md §4.3).
import type { ChatError } from "./errors.js";
import type { Message, Unsubscribe } from "./types.js";

const WINDOW = 500;

export class MessageStore {
  private list: Message[] = [];
  private subs = new Set<(items: readonly Message[]) => void>();
  private scheduled = false;

  get items(): readonly Message[] {
    return this.list;
  }

  subscribe(cb: (items: readonly Message[]) => void): Unsubscribe {
    this.subs.add(cb);
    cb(this.list);
    return () => this.subs.delete(cb);
  }

  /** Notify subscribers once per tick with a new array (React/Vue/Svelte friendly). */
  private changed() {
    this.list = [...this.list];
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (const cb of [...this.subs]) cb(this.list);
    });
  }

  private sort() {
    this.list.sort((a, b) => {
      if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
      if (a.seq !== null) return -1;
      if (b.seq !== null) return 1;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
    if (this.list.length > WINDOW) this.list.splice(0, this.list.length - WINDOW);
  }

  get(id: string) {
    return this.list.find((m) => m.id === id);
  }

  getByClientId(clientMsgId: string) {
    return this.list.find((m) => m.clientMsgId === clientMsgId);
  }

  /** Inserts or replaces a confirmed message; an older version never replaces a newer one. */
  upsert(m: Message) {
    const i = this.list.findIndex((x) => x.id === m.id && x.id !== null);
    if (i >= 0) {
      const cur = this.list[i]!;
      if (cur.version > m.version) return;
      this.list[i] = { ...m, clientMsgId: cur.clientMsgId ?? m.clientMsgId };
    } else {
      this.list.push(m);
    }
    this.sort();
    this.changed();
  }

  upsertMany(ms: Message[]) {
    for (const m of ms) {
      const i = this.list.findIndex((x) => x.id === m.id && x.id !== null);
      if (i < 0) this.list.push(m);
      else if (this.list[i]!.version <= m.version) this.list[i] = { ...m, clientMsgId: this.list[i]!.clientMsgId ?? m.clientMsgId };
    }
    this.sort();
    this.changed();
  }

  addPending(m: Message) {
    this.list.push(m);
    this.sort();
    this.changed();
  }

  /** Ack: the pending message gets its id/seq/server time and moves to its seq position. */
  reconcile(clientMsgId: string, ack: { id: string; seq: number; createdAt: string }) {
    const i = this.list.findIndex((m) => m.clientMsgId === clientMsgId && m.id === null);
    const dupe = this.list.findIndex((m) => m.id === ack.id);
    if (i < 0) return;
    if (dupe >= 0) {
      // The live event arrived before the ack: keep the confirmed copy, mark it as ours.
      this.list[dupe] = { ...this.list[dupe]!, clientMsgId };
      this.list.splice(i, 1);
    } else {
      this.list[i] = { ...this.list[i]!, id: ack.id, seq: ack.seq, createdAt: ack.createdAt, status: "sent", error: undefined };
    }
    this.sort();
    this.changed();
  }

  markFailed(clientMsgId: string, error: ChatError) {
    const i = this.list.findIndex((m) => m.clientMsgId === clientMsgId && m.id === null);
    if (i < 0) return;
    this.list[i] = { ...this.list[i]!, status: "failed", error };
    this.changed();
  }

  markSending(clientMsgId: string) {
    const i = this.list.findIndex((m) => m.clientMsgId === clientMsgId && m.id === null);
    if (i < 0) return;
    this.list[i] = { ...this.list[i]!, status: "sending", error: undefined };
    this.changed();
  }

  /** Optimistic edit/delete: returns an undo function. */
  patch(id: string, p: Partial<Message>): (() => void) | null {
    const i = this.list.findIndex((m) => m.id === id);
    if (i < 0) return null;
    const before = this.list[i]!;
    this.list[i] = { ...before, ...p };
    this.changed();
    return () => {
      const j = this.list.findIndex((m) => m.id === id);
      if (j >= 0) {
        this.list[j] = before;
        this.changed();
      }
    };
  }

  clear() {
    this.list = this.list.filter((m) => m.id === null); // keep unsent messages
    this.changed();
  }

  get oldestSeq(): number | null {
    return this.list.find((m) => m.seq !== null)?.seq ?? null;
  }
}
