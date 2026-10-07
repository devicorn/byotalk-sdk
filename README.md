# byotalk

Chat SDK for [ByoTalk](https://byotalk.com): we run realtime delivery; your own database (PostgreSQL, MySQL/MariaDB, MongoDB, or any store behind an HTTPS endpoint) keeps the permanent record.

```bash
npm i byotalk
```

| Import | Runs in | What it is |
|---|---|---|
| `byotalk` | Browser, React Native, Node 22+ | Realtime client (≈ 9 KB gzip, zero dependencies) |
| `byotalk/react-native` | React Native (bare + Expo) | App lifecycle, network changes, MMKV/AsyncStorage persistence |
| `byotalk/calls` | Browser, React Native (with `react-native-webrtc`) | Voice and video calls (1:1 and group, screen share) on mediasoup-client |
| `byotalk/server` | Node 22+ | Token signing, REST client, webhook verification |
| `npx -p byotalk -p pg byotalk db migrate` | Node 22+ | Creates the ByoTalk tables in your PostgreSQL, MySQL/MariaDB or MongoDB (the driver, `pg`, `mysql2` or `mongodb`, is not installed with `byotalk`) |

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

## React Native

```bash
npm i byotalk react-native-get-random-values
# optional: @react-native-community/netinfo (reconnect when the network returns), react-native-mmkv or
# @react-native-async-storage/async-storage (unsent messages survive a restart)
```

```ts
import "react-native-get-random-values"; // first, in your entry file: Hermes has no crypto.getRandomValues
import { createChat, mmkvPersistence } from "byotalk/react-native";

const chat = createChat({ env: "env_…", token: getToken, persistence: mmkvPersistence() });
await chat.connect(); // also starts the AppState/NetInfo listeners; disconnect() removes them
```

Message ids are UUIDs made with `crypto.getRandomValues`. Without the polyfill `createChat()` throws an error naming it (on Expo you can instead set `globalThis.crypto = { getRandomValues }` with `getRandomValues` from `expo-crypto`). `mmkvPersistence()` works with react-native-mmkv v2, v3 and v4, or pass your own instance: `mmkvPersistence(storage)`. On sign-out call `await chat.clearLocalData()` then `await chat.disconnect()`; create a new chat for the next user.

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

## Calls

```bash
npm i byotalk mediasoup-client   # mediasoup-client is an optional peer dependency, needed only for byotalk/calls
```

```ts
import { CallClient } from "byotalk/calls";

const calls = new CallClient(chat); // chat: a connected Chat

// Callee: every device of the user rings
calls.on("incoming", async (call) => {
  call.on("ended", () => hideRinging()); // cancelled, missed, or answered on another device
  if (await askUser(`${call.info.createdBy} is calling`)) await call.accept();
  else await call.decline();
});

// Caller
const call = await calls.start(dm.id, { video: true }); // asks for camera + microphone first
call.on("participants", (people) => render(people));   // audioTrack, videoTrack, screenTrack, audioMuted, speaking, …
call.on("ended", (info) => console.log(info.endReason, info.durationSeconds));
await call.setMicrophoneEnabled(false);
await call.startScreenShare();
await call.leave(); // a 1:1 call ends for both
```

Media goes through ByoTalk's own media server (an SFU) and TURN server, encrypted in transit (DTLS-SRTP); calls are not end-to-end encrypted and are never recorded. Reconnection after network changes is automatic. `mediasoup-client` is used only by `byotalk/calls` (install it yourself); importing `byotalk` does not load it.

React Native: install `react-native-webrtc`, call its `registerGlobals()` first, and pass its `mediaDevices` (`new CallClient(chat, { mediaDevices })`); Expo needs a development build. Not yet tested on devices; no CallKit / ConnectionService yet.

Tested: integration tests against the server, and real-Chromium tests (`pnpm test:browser`) including TURN relay. Not yet verified: Firefox, Safari, React Native devices, the hosted service.

Types: `CallClient`, `Call`, `CallInfo`, `Participant`, `CallState`, `CallStats` (exported from `byotalk/calls`); source in [`src/calls/`](src/calls/). Maintainers: the full API, states, events and errors are in `docs/09-SDK-DESIGN.md` §9 and the architecture and media protocol in `docs/19-CALLS.md` of the `byotalk-server` repository.

## Bring your own database

The database drivers are optional peer dependencies, so web and mobile installs don't carry them; `npx -p` fetches the one the CLI needs. `--schema` is the Postgres schema, or the MySQL table / MongoDB collection prefix; the `_` separator is added for you (`--schema byotalk` gives `byotalk_messages`).

```bash
npx -p byotalk -p pg byotalk db migrate --url "$ADMIN_DATABASE_URL" --schema byotalk  # PostgreSQL
npx -p byotalk -p mysql2 byotalk db migrate --url "$ADMIN_DATABASE_URL"                # MySQL / MariaDB
npx -p byotalk -p mongodb byotalk db migrate --url "$ADMIN_DATABASE_URL"               # MongoDB (mongodb:// or mongodb+srv://)
npx byotalk db migrate --print-sql --engine postgres|mysql                             # review or run the SQL yourself (no driver)
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
pnpm test:browser       # real-browser call tests: server with media node + local coturn running
pnpm build && pnpm size # bundle budget: core ≤ 25 KB gzip
pnpm sync-schema        # refresh the CLI's copy of byotalk-server/customer-schema
```

Releases: `pnpm changeset` for every user-visible change; merging the Changesets PR publishes to npm from CI.

MIT licence.
