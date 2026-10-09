# Changelog

## 0.1.0

First release of the Dart / Flutter SDK (chat only).

- `ByoTalkChat` with a token string or token function; secret keys (`sk_…`) are refused; dev tokens via `ByoTalkChat.devToken()`.
- `chat.v1` WebSocket transport (`web_socket_channel`): auth handshake, heartbeats, liveness timeout, full-jitter exponential backoff, close-code handling, `token_expiring` refresh, connection state stream.
- Sync after every hello: cursor, per-conversation catch-up by `seq`, gap detection, `resync_required`.
- Conversations: list, live summaries (`unreadCount`, `lastMessage`, `metadata`), `direct`, group `create`, `get`, `loadLatest`/`loadOlder` with `hasOlder`, `conversation.updated`.
- Messages: send (UUID v4 `clientMsgId` from `Random.secure()`), edit, delete, ordered and deduplicated store.
- Read and delivered receipts, typing, presence.
- Offline outbox resent with the same `clientMsgId` after reconnect; `Persistence` interface with an in-memory default.
- `ChatException` with `code`, `message`, `requestId`.
