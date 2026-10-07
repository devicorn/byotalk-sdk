// Chat and Conversation state with the REST client stubbed: summaries follow metadata changes, hasOlder follows
// the server's hasMore, and a runtime without crypto.getRandomValues fails at construction.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../src/core/chat.js";
import { Conversation } from "../../src/core/conversation.js";
import type { ConversationSummary } from "../../src/core/types.js";

class WS {}
const newChat = () => new Chat({ env: "env_1", token: "dev:alice", WebSocket: WS as never });
const msg = (seq: number) => ({ id: `m_${seq}`, seq, senderId: "bob", text: "hi", createdAt: new Date(0).toISOString() });

afterEach(() => vi.unstubAllGlobals());

describe("Chat", () => {
  it("applies conversation.updated name and metadata to summaries", () => {
    const chat = newChat();
    const summary: ConversationSummary = {
      id: "c_1", type: "group", name: "Old", metadata: { queue: "new" }, lastSeq: 1, unreadCount: 0, lastReadSeq: 1,
      muted: false, lastActivityAt: new Date(0).toISOString(), lastMessage: null,
    };
    const internals = chat as unknown as { summaries: Map<string, ConversationSummary>; updateSummary(f: unknown): void };
    internals.summaries.set("c_1", summary);
    internals.updateSummary({ e: "conversation.updated", cid: "c_1", seq: 2, d: { changes: { metadata: { queue: "assigned" } } } });
    expect(internals.summaries.get("c_1")).toMatchObject({ name: "Old", metadata: { queue: "assigned" }, lastSeq: 2 });
    internals.updateSummary({ e: "conversation.updated", cid: "c_1", seq: 3, d: { changes: { name: "New" } } });
    expect(internals.summaries.get("c_1")).toMatchObject({ name: "New", metadata: { queue: "assigned" } });
  });

  it("fails at construction, naming the polyfill, when crypto.getRandomValues is missing (Hermes)", () => {
    vi.stubGlobal("crypto", {});
    expect(newChat).toThrow(/react-native-get-random-values/);
  });
});

describe("Conversation.hasOlder", () => {
  it("is set by the first page, then by loadOlder() and resync()", async () => {
    const chat = newChat();
    const pages = [
      { data: [msg(51), msg(52)], hasMore: true }, // loadLatest
      { data: [msg(49), msg(50)], hasMore: false }, // loadOlder
      { id: "c_1", type: "group", lastSeq: 80, members: [] }, // resync: the conversation
      { data: [msg(79), msg(80)], hasMore: true }, // resync: latest page
    ];
    vi.spyOn(chat.rest, "request").mockImplementation(async () => pages.shift() as never);
    const conv = new Conversation(chat, { id: "c_1", type: "group", name: null, lastSeq: 52 } as never);
    expect(conv.hasOlder).toBe(false);
    await conv.loadLatest();
    expect(conv.hasOlder).toBe(true);
    await conv.loadOlder();
    expect(conv.hasOlder).toBe(false);
    await conv.resync();
    expect(conv.hasOlder).toBe(true);
  });
});
