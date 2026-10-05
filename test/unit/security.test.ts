import { describe, expect, it } from "vitest";
import { Chat } from "../../src/core/chat.js";
import { path } from "../../src/core/util.js";

describe("security guards", () => {
  it("keeps every interpolated id inside one path segment", () => {
    expect(path`/v1/messages/${"../conversations/c_1/members/u_2"}`).toBe("/v1/messages/..%2Fconversations%2Fc_1%2Fmembers%2Fu_2");
    for (const bad of ["..", ".", ""]) expect(() => path`/v1/messages/${bad}`).toThrow(/Invalid id/);
    expect(path`/v1/conversations/${"c_1"}/read`).toBe("/v1/conversations/c_1/read");
  });

  it("refuses a secret key in the client", () => {
    class WS {}
    expect(() => new Chat({ env: "env_1", token: "sk_test_abc", WebSocket: WS as never })).toThrow(/secret key/);
  });
});
