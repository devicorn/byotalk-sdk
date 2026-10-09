# ByoTalk Kotlin SDK (Android and JVM)

Native chat client for ByoTalk's `chat.v1` realtime protocol. Same behaviour and names as the TypeScript SDK
(`byotalk`): auth-first WebSocket, heartbeats, full-jitter reconnect, sync by `seq` after every connect, an offline
outbox, receipts, typing and presence. Coroutines everywhere: `StateFlow` for connection state and message lists,
`SharedFlow` for events.

| Module | What | Runs on |
|---|---|---|
| `byotalk` | Core client (OkHttp WebSocket, kotlinx.serialization, coroutines) | Android minSdk 24 and any JVM 8+ |
| `byotalk-android` | `SharedPreferencesPersistence`, `chat.attachLifecycle(app)` (reconnect on foreground / network back) | Android minSdk 24 |

Calls (audio/video) are not included: use the web or React Native SDK for calls.

## Install

Not on Maven Central yet. Build from this folder and publish to your local Maven repository:

```bash
cd byotalk-sdk/android
./gradlew :byotalk:publishToMavenLocal
```

```kotlin
// settings.gradle.kts: repositories { mavenLocal(); mavenCentral() }
dependencies {
    implementation("com.byotalk:byotalk:0.1.0")
}
```

For the Android helpers, include the `byotalk-android` module as a project dependency (or copy its single file).
The app needs `android.permission.INTERNET` (the helper module declares it, plus `ACCESS_NETWORK_STATE`).

## Quick start (development)

Development environments accept dev tokens (`dev:<userId>`), so you can start without a backend.

```kotlin
val chat = ByoTalkChat(env = "env_dev_2f8k", token = ByoTalkChat.devToken("alice"))
chat.connect()                                  // suspends until connected and synced
val dm = chat.conversations.direct("bob")

scope.launch {
    dm.events.collect { e ->
        if (e is ConversationEvent.MessageNew) println("${e.message.senderId}: ${e.message.text}")
    }
}
dm.send(text = "Hello Bob")                     // returns the acked Message
```

Local stack: `ByoTalkChat(env, token, baseUrl = "http://10.0.2.2:3100", realtimeUrl = "ws://10.0.2.2:3001")`
(`10.0.2.2` is the host machine from the Android emulator).

## Production

Dev tokens are disabled in production. Add a token route to your backend (`ChatServer.createToken` in
`byotalk/server`, signed with your secret key) and give the SDK a provider. It is called before the token expires
and after `token_expired`. Never ship an `sk_` secret key in an app: the constructor refuses it.

```kotlin
val chat = ByoTalkChat(
    env = "env_prod_...",
    tokenProvider = { api.fetchChatToken() },       // suspend () -> String
    persistence = SharedPreferencesPersistence(context),
)
val detach = chat.attachLifecycle(application)      // reconnect on foreground / network back
```

## API overview

| | |
|---|---|
| `ByoTalkChat(env, token: TokenSource, baseUrl, realtimeUrl, persistence)` | Also overloads taking a `String` token or a `suspend () -> String` provider |
| `connect()` / `disconnect()` / `reconnectNow()` | `connection: StateFlow<ConnectionState>`: DISCONNECTED, CONNECTING, SYNCING, CONNECTED, RECONNECTING, FAILED |
| `errors: SharedFlow<ChatException>` | `ChatException(code, message, type, requestId, retryAfterMs, status)`, `retryable` |
| `conversations.list(limit, cursor)` | `Page<ConversationSummary>` with `unreadCount`, `lastMessage`, `metadata` |
| `conversations.watch()` | `StateFlow<List<ConversationSummary>>` kept current by events and sync |
| `conversations.direct(userId)` / `create(members, name, metadata)` / `get(id)` | `Conversation` with its latest page loaded |
| `conversation.messages.items` | `StateFlow<List<Message>>`: ordered by `seq`, deduped, pending sends last, 500 kept |
| `conversation.events` | `SharedFlow<ConversationEvent>`: `MessageNew/Updated/Deleted/Failed`, `Typing`, `Receipt`, `MemberAdded/Removed`, `Updated`, `Removed` |
| `loadLatest()` / `loadOlder(limit)` / `hasOlder` | History paging |
| `send(text, replyTo, attachments, metadata)` | `clientMsgId` = random UUID; stays in the outbox while offline and is resent with the same id |
| `retry(clientMsgId)` / `edit(id, text, metadata)` / `delete(id)` | |
| `markRead(seq?)` / `readBy(seq)` | Read receipts; delivered receipts are sent automatically (batched ≤ 1/s) |
| `typing()` / `stopTyping()` / `typingUserIds: StateFlow<List<String>>` | Throttled to one `start` per 3 s; expires after 6 s |
| `presence.watch(userIds): Flow<Presence>` | Snapshot first, then changes |
| `addMembers`, `removeMember`, `leave`, `mute`, `unmute`, `update(name, metadata)` | |
| `PersistenceAdapter` | `MemoryPersistence` (default) or `SharedPreferencesPersistence`; call `clearLocalData()` on sign-out |

Threading: the SDK keeps its state on one internal coroutine loop. Call the suspend functions from any dispatcher;
collect flows wherever you like (`lifecycleScope`, `viewModelScope`).

## Not included

Calls, attachment uploads, push device registration and the server SDK. Push tokens can be registered through
`POST /v1/push/devices` (see the REST reference).

## Tests

```bash
./gradlew test                                   # unit tests + integration tests
BYOTALK_API_URL=http://localhost:3100 BYOTALK_RT_URL=ws://localhost:3001 ./gradlew :byotalk:test
```

Integration tests create a fresh project through the development magic-link flow and are skipped when the
server is unreachable. `byotalk-android` is only built when `local.properties` (with `sdk.dir`) or `ANDROID_HOME`
is present.
