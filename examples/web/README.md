# Example: web chat on ByoTalk

A small chat app built the way a customer would build one:

- `server.mjs` — **your backend**. Holds the secret key, upserts the user and mints a user token with
  `byotalk/server` (`GET /api/token`). Also serves the page.
- `public/` — **your web app**. Uses the `byotalk` SDK in the browser: conversation list with unread counts,
  direct chats and groups, send/edit/delete, offline sending with retry, typing, read receipts, presence,
  older history.

No build step and no extra dependencies: the page imports the SDK from `../../dist`.

## Run it locally

1. Start ByoTalk locally (`byotalk-server`: `pnpm dev`) and the dashboard (`byotalk-web`: `pnpm dev`).
2. In the dashboard (http://localhost:3002): create a project → Development environment →
   **API keys** → Reveal, and **Quick start** → copy the environment id.
3. Build the SDK and configure the example:

   ```bash
   cd byotalk-sdk
   pnpm build
   cp examples/web/.env.example examples/web/.env   # paste BYOTALK_SECRET_KEY and BYOTALK_ENV
   node --env-file=examples/web/.env examples/web/server.mjs
   ```

4. Open http://localhost:5173, sign in as `alice`. Open a second window (private/incognito) as `bob`.
   Alice: type `bob` in "Chat with user id" → Chat → send a message.

What to check:

| Feature | How |
|---|---|
| Realtime | Bob's list shows the new chat and the message instantly |
| Typing | Type in Bob's window → Alice sees "Bob is typing…" |
| Read receipts | When Bob opens the chat, Alice's message shows "✓✓ read" |
| Presence | Alice's header shows "online"; close Bob's window → "last seen …" after ~30 s |
| Offline sending | DevTools → Network → Offline, send a message (stays "sending"), go Online → it is sent once |
| Edit / delete | Hover your own message |
| Groups | "New group" with `bob, carol` |
| Data ownership | With BYO-PG enabled (dashboard → Storage), the messages appear in your Postgres `byotalk.messages` |

> The `/api/token` route signs in whoever asks — fine for a local demo only. In your app, mint a token only
> for the user of your own authenticated session. Never put the secret key in browser code.
