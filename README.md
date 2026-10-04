# byotalk

Chat SDK for [ByoTalk](https://byotalk.com): we run realtime delivery; your own database (PostgreSQL, MySQL/MariaDB, MongoDB, or any store behind an HTTPS endpoint) keeps the permanent record.

```bash
npm i byotalk
```

| Import | Runs in | What it is |
|---|---|---|
| `byotalk` | Browser, React Native, Node 22+ | Realtime client (≈ 9 KB gzip, zero dependencies) |
| `byotalk/react-native` | React Native (bare + Expo) | App lifecycle, network changes, MMKV/AsyncStorage persistence |
| `byotalk/server` | Node 22+ | Token signing, REST client, webhook verification |
| `npx byotalk db migrate` | Node 22+ | Creates the ByoTalk tables in your PostgreSQL, MySQL/MariaDB or MongoDB |

## Quick start (development environment)

```ts
import { Chat } from "byotalk";

const chat = new Chat({ env: "env_dev_…", token: Chat.devToken("alice") });
await chat.connect();
const dm = await chat.conversations.direct("bob");
dm.on("message.new", (m) => console.log(m.senderId, m.text));
await dm.send({ text: "Hello Bob" });
```

## Production

```ts
// server
import { ChatServer } from "byotalk/server";
const chatServer = new ChatServer({ secretKey: process.env.BYOTALK_SECRET_KEY! });

app.get("/chat-token", requireLogin, async (req, res) => {
  await chatServer.users.upsert({ id: req.user.id, name: req.user.name });
  res.json({ token: chatServer.createToken(req.user.id, { expiresIn: "1h" }) });
});

// client
const chat = new Chat({
  env: "env_…",
  token: () => fetch("/chat-token").then((r) => r.json()).then((d) => d.token),
});
```

Never put a secret key in client code.

## Guarantees

- Delivery is **at least once**; the SDK de-duplicates by message id and `seq`.
- `send()` resolves when the server has stored the message. Network problems do not reject: the message stays
  `sending` and is retried after reconnect (with the same `clientMsgId`, so it is stored once). After 24 h it fails.
- After any interruption the SDK syncs: missed events are fetched by `seq`, in order.

## Attachments

```ts
const att = await dm.upload(file, { onProgress: (p) => console.log(p) }); // straight to storage, then verified
await dm.send({ text: "Invoice", attachments: [att] });
const { url, expiresAt } = await chat.attachments.url(att.id); // short-lived link (default 5 min, 60–3600 s)
```

Uploads go straight from the client to the environment's storage — ByoTalk's Cloudinary (Managed) or your own
Cloudinary account, S3-compatible bucket (AWS S3, Cloudflare R2, Google Cloud Storage, DigitalOcean Spaces, Wasabi,
Backblaze B2, MinIO) or Azure Blob container. The uploader follows the ticket from the server (multipart `POST` or
`PUT` with headers), so your code is the same for every provider. Browser uploads to your own bucket need a CORS
rule allowing `PUT` from your app's origin.

## Bring your own database

```bash
npx byotalk db migrate --url "$ADMIN_DATABASE_URL" --schema byotalk   # postgres://, mysql://, mariadb://, mongodb://, mongodb+srv://
npx byotalk db migrate --print-sql --engine postgres|mysql             # review or run the SQL yourself
```

| Engine | Creates | Writer |
|---|---|---|
| PostgreSQL 14+ | Schema `byotalk` | Role with `SELECT, INSERT, UPDATE` on the schema |
| MySQL 8.0+ / MariaDB 10.6+ | `byotalk_*` tables in the URL's database | User with `SELECT, INSERT, UPDATE` on those tables |
| MongoDB 6.0+ | `byotalk_*` collections + indexes in the URL's database | User with `find, insert, update` on those collections (on Atlas, create it in Database Access) |

No delete, no DDL. The admin URL never leaves your machine; the command prints a runtime connection string to
paste into the dashboard. The driver for your engine is an optional dependency (`npm i -D pg`, `mysql2` or
`mongodb` if it is missing).

Any other store (SQL Server, DynamoDB, Firestore, …): run an HTTPS endpoint that answers signed `ping`, `batch`
and `read` requests. See [`examples/http-sink/`](examples/http-sink/) for the contract and a working SQLite
version.

## Development

```bash
pnpm install
pnpm test               # unit
pnpm test:integration   # needs byotalk-server running (BYOTALK_API_URL / BYOTALK_RT_URL)
pnpm build && pnpm size # bundle budget: core ≤ 25 KB gzip
pnpm sync-schema        # refresh the CLI's copy of byotalk-server/customer-schema
```

Releases: `pnpm changeset` for every user-visible change; merging the Changesets PR publishes to npm from CI.

MIT licence.
