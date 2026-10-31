# Changelog

## 0.3.1

### Fixed

- A tokenProvider that fails while reconnecting (offline, 5xx) no longer ends the connection: it is retried with backoff. Only an explicit authentication error sets the state to `failed`.
- A failed catch-up of a conversation no longer causes an unhandled rejection; held live events are retried with backoff.
- A `message.send` that times out on an open socket is resent with backoff (same `clientMsgId`) instead of waiting for the next reconnect.
- `unreadCount` is no longer counted twice after a reconnect.
- The state no longer becomes `connected` when the socket dropped during the post-hello sync.
- `reconnectNow()` while a connection attempt is under way no longer opens a second socket; `failed` removes the online/pagehide listeners.
- A `tokenProvider` that returns a secret key (`sk_`) is rejected, like a secret key passed as `token`.
- `exports`: the `require` condition now points at the `.d.cts` typings.

## 0.3.0

### Added

- **Livestreams: `chat.livestreams.create()`, `join(id)`, `leave(id)`, `viewers(id)`.** A livestream has hosts (its members) and any number of viewers who are not members. `join()` returns a conversation whose messages arrive live; viewers can send unless the channel is read-only (`viewersCanSend: false`). The watch is renewed after every reconnect and missed messages are fetched. Server: `chatServer.conversations.create({ type: "livestream", … })` and `update(id, { viewersCanSend })`.
- **Native SDKs in this repository:** Swift (`Package.swift` at the root, sources in `swift/`), Kotlin for Android and the JVM (`android/`) and Dart for Flutter (`flutter/`). Chat only; calls stay in the web and React Native SDKs.
- **Semantic search: `chat.search(query, { conversationId?, limit? })`** returns `SearchHit[]` (`{ message, score }`), best match first, from the conversations the user is a member of (livestreams are excluded). `limit` is 1–50, default 20. Search must be enabled for the environment (Dashboard → Storage → Semantic search); otherwise it throws `ChatError` with code `search_disabled`.
- **`chatServer.search({ query, userId?, conversationId?, limit? })`** for your backend. Pass `userId` to search as that user, `conversationId` for one conversation, or both. One of them is required.
- **CLI: `--search <dimensions>`** creates the semantic search table (pgvector `message_embeddings`, HNSW index) with `db migrate`, PostgreSQL only: `npx byotalk db migrate --print-sql --engine postgres --search 1536`. The writer may read, insert, update and delete that one table. `CREATE EXTENSION vector` needs a superuser or your provider's admin role.

## 0.2.0

### Breaking

- **Database drivers are no longer installed with `byotalk`.** `pg`, `mysql2` and `mongodb` were optional dependencies, so npm installed them in every web and mobile app. They are now optional peer dependencies used only by the CLI. Run the CLI with the driver it needs: `npx -p byotalk -p pg byotalk db migrate --url …` (or `mysql2`, `mongodb`). `--print-sql` needs no driver. If the driver is missing, the CLI says which one to add.
- **`createChat()` and `new Chat()` throw when `crypto.getRandomValues` is missing.** Message ids (`clientMsgId`) are UUIDs, and Hermes has no Web Crypto. Before, the first send crashed. Now construction fails with an error that names the polyfill. Install `react-native-get-random-values` and import it first in your entry file.

### Fixes

- **React Native: `mmkvPersistence()` works with react-native-mmkv v4.** v4 replaced `new MMKV()` with `createMMKV()` and renamed `delete` to `remove`. Both shapes are detected, and v2/v3 keep working. You can also pass your own instance: `mmkvPersistence(storage)`.
- **React Native: `createChat()` no longer leaks AppState and NetInfo listeners.** It now adds them on `connect()` and removes them on `disconnect()`. Before, each sign-out and sign-in left one listener of each behind.
- **`conversations.watch()` summaries follow metadata changes.** `conversation.updated` now updates `metadata` as well as `name` in `ConversationSummary`. Before, metadata was only refreshed on a full reload.

### Added

- **`conversation.hasOlder`** says whether the server has messages older than the oldest one loaded. It is set by the first page and updated by `loadOlder()` and resync. Use it instead of guessing from `oldestSeq > 1`.
- **`chatServer.messages.send()` types `clientMsgId` as a UUID**, the format the server requires (anything else is refused with 400).
- **CLI: a note when `--schema` ends in `_`.** The separator is added for you, so `--schema byotalk` gives `byotalk_messages`. The value is still used as given, so existing installs are unchanged.
