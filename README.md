# byotalk

Chat SDK for [ByoTalk](https://byotalk.com): we run realtime delivery; your own Postgres keeps the permanent record.

```bash
npm i byotalk
```

| Import | Runs in | What it is |
|---|---|---|
| `byotalk` | Browser, React Native, Node 22+ | Realtime client (≈ 9 KB gzip, zero dependencies) |
| `byotalk/react-native` | React Native (bare + Expo) | App lifecycle, network changes, MMKV/AsyncStorage persistence |
| `byotalk/server` | Node 22+ | Token signing, REST client, webhook verification |
| `npx byotalk db migrate` | Node 22+ | Creates the ByoTalk schema in your Postgres |

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

## Bring your own Postgres

```bash
npx byotalk db migrate --url "$ADMIN_DATABASE_URL" --schema byotalk
```

Creates schema `byotalk` and a role with `SELECT, INSERT, UPDATE` on it (no `DELETE`, no DDL). The admin URL
never leaves your machine; the command prints a runtime connection string to paste into the dashboard.

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
