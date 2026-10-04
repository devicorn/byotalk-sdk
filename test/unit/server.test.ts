import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ChatServer, WebhookVerificationError } from "../../src/server/index.js";
import { detectEngine, migrationSql, mysqlStatements } from "../../src/cli/index.js";

const secret = "sk_test_abcdefghijklmnopqrstuvwxyz012345";

describe("ChatServer", () => {
  it("createToken signs HS256 with the kid derived from the secret", () => {
    const s = new ChatServer({ secretKey: secret });
    const t = s.createToken("user_1", { expiresIn: "1h" });
    const [h, b, sig] = t.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT", kid: s.keyId });
    const claims = JSON.parse(Buffer.from(b!, "base64url").toString());
    expect(claims.sub).toBe("user_1");
    expect(claims.exp - claims.iat).toBe(3600);
    expect(createHmac("sha256", secret).update(`${h}.${b}`).digest("base64url")).toBe(sig);
    expect(() => s.createToken("bad id!")).toThrow();
    expect(() => new ChatServer({ secretKey: "nope" })).toThrow();
  });

  it("webhooks.verify accepts valid signatures and rejects tampering and stale timestamps", () => {
    const whsec = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const s = new ChatServer({ secretKey: secret, webhookSecret: whsec });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ id: "evt_1", type: "message.created", createdAt: "x", env: "env_1", data: { a: 1 } });
    const sign = (t: number, b: string) => `v1,${createHmac("sha256", Buffer.from(whsec.slice(6), "base64")).update(`evt_1.${t}.${b}`).digest("base64")}`;
    const headers = { "webhook-id": "evt_1", "webhook-timestamp": String(ts), "webhook-signature": `v1,bogus ${sign(ts, body)}` };
    expect(s.webhooks.verify(body, headers).type).toBe("message.created");
    expect(() => s.webhooks.verify(body.replace("1}", "2}"), headers)).toThrow(WebhookVerificationError);
    const old = ts - 600;
    expect(() => s.webhooks.verify(body, { ...headers, "webhook-timestamp": String(old), "webhook-signature": sign(old, body) })).toThrow(/tolerance/);
  });
});

describe("CLI migration SQL", () => {
  it("creates the schema and a writer role without DELETE", () => {
    const sql = migrationSql("byotalk", "byotalk_writer", "pw");
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "byotalk"');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "byotalk" TO "byotalk_writer"');
    expect(sql).not.toMatch(/GRANT[^;]*DELETE/);
    expect(migrationSql("chat", null, null)).not.toContain("ROLE");
  });
});

describe("CLI engines", () => {
  it("detects the engine from the URL", () => {
    expect(detectEngine("postgres://u@h/db")).toBe("postgres");
    expect(detectEngine("mysql://u@h/db")).toBe("mysql");
    expect(detectEngine("mariadb://u@h/db")).toBe("mysql");
    expect(detectEngine("mongodb+srv://u@cluster.example.net/db")).toBe("mongodb");
    expect(detectEngine("sqlserver://x")).toBeNull();
  });

  it("MySQL statements use the prefix and never grant DELETE", () => {
    const stmts = mysqlStatements("chat");
    expect(stmts).toHaveLength(6);
    expect(stmts.join("\n")).toContain("CREATE TABLE IF NOT EXISTS chat_messages");
    expect(stmts.join("\n")).not.toMatch(/__P__|DELETE/);
  });
});
