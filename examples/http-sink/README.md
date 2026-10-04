# Example: bring any database through an HTTP endpoint

ByoTalk replicates natively into PostgreSQL, MySQL/MariaDB and MongoDB. For anything else (SQL Server, Oracle,
DynamoDB, Firestore, Cassandra, a data lake…) point ByoTalk at an HTTPS endpoint you run. This example stores
everything in SQLite with no dependencies.

## Run it

```bash
cd byotalk-sdk && pnpm build
# 1. Dashboard → Storage → Database → type "HTTP endpoint", URL http://localhost:8787/  → Save
#    The signing secret (whsec_…) is shown once.
BYOTALK_SINK_SECRET=whsec_... node examples/http-sink/server.mjs
# 2. Dashboard → Storage → Test connection → Enable "Your own database"
# 3. Send messages; then:
sqlite3 byotalk.sqlite "select seq, sender_id, text from messages order by created_at desc limit 5"
```

## The contract

Every request is `POST` with a JSON body and Standard Webhooks headers (`webhook-id`, `webhook-timestamp`,
`webhook-signature`), signed with your endpoint secret. Verify with `chatServer.webhooks.verify(rawBody, headers)`
or any Standard Webhooks library.

| `type` | Body | Answer |
|---|---|---|
| `ping` | `{}` | `200 {"ok": true, "schemaVersion": 1}` |
| `batch` | `{schemaVersion, batchId, users[], conversations[], members[], messages[]}` | any `2xx` once stored |
| `read` | `{conversationId, seqs[]}` | `200 {"messages": [...]}` (messages you stored) |

Rules:

- **Idempotent and version-guarded.** Batches can be delivered more than once. Store a row only if it is new or
  its `version` is higher (members: `updatedAt` not older). Never let an older version replace a newer one.
- **Answer only after storing.** A non-2xx (or timeout) makes ByoTalk keep the data and retry with backoff; the
  dashboard shows the sink as lagging/failing and your chat keeps working.
- **401/403** pause the sink until you fix the endpoint and press "Test connection".

Message shape: `{id, conversationId, seq, senderId, text, replyTo, attachments, metadata, version, createdAt, editedAt, deletedAt}`.
