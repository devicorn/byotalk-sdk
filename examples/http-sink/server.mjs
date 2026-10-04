// Example "HTTP endpoint" customer database: ByoTalk POSTs signed batches, this server stores them in SQLite.
// Swap SQLite for anything (SQL Server, DynamoDB, Firestore, a data lake…): keep the three rules below.
//   1. Verify the signature on the RAW body (Standard Webhooks, same as webhooks).
//   2. Writes are idempotent and version-guarded: never let an older version overwrite a newer one.
//   3. Answer {type:"ping"} and {type:"read"} so the dashboard test and cold history work.
// Run: BYOTALK_SINK_SECRET=whsec_... node server.mjs   (Node 22.13+; uses the built-in node:sqlite)
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ChatServer } from "../../dist/server.js";

const SECRET = process.env.BYOTALK_SINK_SECRET;
const PORT = Number(process.env.PORT ?? 8787);
if (!SECRET) {
  console.error("Set BYOTALK_SINK_SECRET (shown once in Dashboard → Storage → Database when you save the endpoint)");
  process.exit(1);
}

// Only webhooks.verify is used here, so any well-formed secret key value works for the constructor.
const verifier = new ChatServer({ secretKey: "sk_test_unused_for_verification_only", webhookSecret: SECRET });
const db = new DatabaseSync(process.env.SQLITE_FILE ?? "byotalk.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, image_url TEXT, metadata TEXT, deleted_at TEXT, version INT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, type TEXT, name TEXT, metadata TEXT, created_by TEXT, created_at TEXT, deleted_at TEXT, version INT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS conversation_members (conversation_id TEXT, user_id TEXT, role TEXT, joined_at TEXT, left_at TEXT, last_read_seq INT, updated_at TEXT, PRIMARY KEY (conversation_id, user_id));
  CREATE TABLE IF NOT EXISTS messages (conversation_id TEXT, seq INT, id TEXT UNIQUE, sender_id TEXT, parent_id TEXT, text TEXT, attachments TEXT, metadata TEXT, version INT, created_at TEXT, edited_at TEXT, deleted_at TEXT, PRIMARY KEY (conversation_id, seq));
`);

const upsertUser = db.prepare(`INSERT INTO users VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, image_url=excluded.image_url, metadata=excluded.metadata,
  deleted_at=excluded.deleted_at, version=excluded.version, updated_at=excluded.updated_at WHERE users.version < excluded.version`);
const upsertConversation = db.prepare(`INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, metadata=excluded.metadata, deleted_at=excluded.deleted_at,
  version=excluded.version, updated_at=excluded.updated_at WHERE conversations.version < excluded.version`);
const upsertMember = db.prepare(`INSERT INTO conversation_members VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(conversation_id, user_id) DO UPDATE SET role=excluded.role, left_at=excluded.left_at,
  last_read_seq=MAX(conversation_members.last_read_seq, excluded.last_read_seq), updated_at=excluded.updated_at
  WHERE conversation_members.updated_at <= excluded.updated_at`);
const upsertMessage = db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(conversation_id, seq) DO UPDATE SET text=excluded.text, attachments=excluded.attachments,
  metadata=excluded.metadata, version=excluded.version, edited_at=excluded.edited_at, deleted_at=excluded.deleted_at
  WHERE messages.version < excluded.version`);
const readMessage = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND seq = ?`);

const j = (v) => JSON.stringify(v ?? {});
function storeBatch(b) {
  db.exec("BEGIN");
  try {
    for (const u of b.users) upsertUser.run(u.id, u.name, u.imageUrl, j(u.metadata), u.deletedAt, u.version, u.updatedAt);
    for (const c of b.conversations) upsertConversation.run(c.id, c.type, c.name, j(c.metadata), c.createdBy, c.createdAt, c.deletedAt, c.version, c.updatedAt);
    for (const m of b.members) upsertMember.run(m.conversationId, m.userId, m.role, m.joinedAt, m.leftAt, m.lastReadSeq, m.updatedAt);
    for (const m of b.messages) {
      upsertMessage.run(m.conversationId, m.seq, m.id, m.senderId, m.replyTo, m.text, j(m.attachments), j(m.metadata), m.version, m.createdAt, m.editedAt, m.deletedAt);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const toMessage = (r) => ({
  id: r.id, conversationId: r.conversation_id, seq: r.seq, senderId: r.sender_id, replyTo: r.parent_id,
  text: r.deleted_at ? null : r.text, attachments: r.deleted_at ? [] : JSON.parse(r.attachments), metadata: r.deleted_at ? {} : JSON.parse(r.metadata),
  version: r.version, createdAt: r.created_at, editedAt: r.edited_at, deletedAt: r.deleted_at,
});

createServer((req, res) => {
  if (req.method !== "POST") return res.writeHead(405).end();
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body;
    try {
      body = verifier.webhooks.verify(raw, req.headers); // throws on a bad signature or a stale timestamp
    } catch {
      return res.writeHead(401).end("invalid signature");
    }
    const reply = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    try {
      if (body.type === "ping") return reply({ ok: true, schemaVersion: 1, database: "SQLite example" });
      if (body.type === "batch") {
        storeBatch(body);
        return reply({ ok: true });
      }
      if (body.type === "read") {
        return reply({ messages: body.seqs.map((s) => readMessage.get(body.conversationId, s)).filter(Boolean).map(toMessage) });
      }
      res.writeHead(400).end("unknown type");
    } catch (err) {
      console.error(err);
      res.writeHead(500).end("storage error"); // ByoTalk keeps the data in its buffer and retries
    }
  });
}).listen(PORT, () => console.log(`HTTP sink on http://localhost:${PORT}/  (SQLite file: ${process.env.SQLITE_FILE ?? "byotalk.sqlite"})`));
