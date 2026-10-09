# ByoTalk for Swift

Native realtime chat for iOS 15+ and macOS 12+. Same protocol and behaviour as the JavaScript SDK in this repository (`src/core/`): reconnect with full-jitter backoff, sync of missed events by `seq` after every connect, an offline outbox, receipts, typing and presence. `async`/`await` for calls, `AsyncStream` for events. No dependencies beyond Foundation and Network.

Chat only: voice and video calls are in the web and React Native SDKs.

## Install

Swift Package Manager, from the byotalk-sdk repository (the manifest is at its root; sources are in `swift/`):

```swift
dependencies: [
    .package(url: "https://github.com/devicorn/byotalk-sdk.git", branch: "main"),
],
targets: [
    .target(name: "MyApp", dependencies: [.product(name: "ByoTalk", package: "byotalk-sdk")]),
]
```

## Quick start (development)

Development environments accept dev tokens `dev:<userId>`; users are created on first connect.

```swift
import ByoTalk

let chat = try ByoTalkChat(env: "env_dev_2f8k", token: .token(ByoTalkChat.devToken("alice")))
try await chat.connect()
let dm = try await chat.conversations.direct("bob")

Task {
    for await event in dm.events() {
        if case .messageNew(let m) = event { print(m.senderId, m.text ?? "") }
    }
}
try await dm.send(text: "Hello Bob")
```

`connect()` returns once the socket is up and missed events are synced. `dm.messages.updates()` streams the message list (current list first), ordered by `seq`, deduplicated, pending sends last. `message.key` is a stable row id.

## Production

Dev tokens are refused in production. Add a token route to your backend (`byotalk/server` `createToken`) and pass a provider; it is called before the token expires and again after `token_expired` / close `4001`:

```swift
let chat = try ByoTalkChat(
    env: "env_2f8k",
    token: .provider { try await api.fetchChatToken() },
    persistence: UserDefaultsPersistence() // unsent messages survive a restart
)
```

Secret keys (`sk_...`) are refused by the initializer. On sign-out: `await chat.clearLocalData()`, then `chat.disconnect()`.

## API overview

- `ByoTalkChat(env:token:baseURL:realtimeURL:persistence:)`; `connect()`, `disconnect()`, `reconnectNow()`, `connectionState`, `connectionStates()`, `errors()`, `userId`.
- `chat.conversations`: `list(limit:cursor:)`, `watch()`, `direct(_:)`, `create(name:members:metadata:)`, `get(_:)`.
- `Conversation`: `events()`, `messages` (`items`, `updates()`), `send(text:replyTo:attachments:metadata:)`, `retry(_:)`, `edit(_:text:metadata:)`, `delete(_:)`, `loadLatest(limit:)`, `loadOlder(limit:)`, `hasOlder`, `markRead(_:)`, `readBy(_:)`, `typing()`, `stopTyping()`, `typingUserIds`, `update(name:metadata:)`, `addMembers`, `removeMember`, `leave`, `mute`, `unmute`.
- `ConversationEvent`: `messageNew`, `messageUpdated`, `messageDeleted`, `messageFailed`, `typing`, `receipt`, `memberAdded`, `memberRemoved`, `updated`, `removed`.
- `chat.presence.watch(_:)` → `AsyncStream<Presence>`; `chat.push.register(token:)`.
- `ChatError`: `code`, `type`, `message`, `requestId`, `retryAfterMs`, `status`, `retryable`, `isHistoryUnavailable`.
- `PersistenceAdapter` with `MemoryPersistence` (default) and `UserDefaultsPersistence`.

Not included: calls, attachment uploads.

## Tests

Run from the repository root (where `Package.swift` is):

```bash
swift test                                   # unit tests; integration tests skip
BYOTALK_API_URL=http://localhost:3100 BYOTALK_RT_URL=ws://localhost:3001 swift test   # plus a local server
```
