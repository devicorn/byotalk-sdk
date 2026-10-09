# byotalk (Dart / Flutter)

ByoTalk chat for Flutter and plain Dart: realtime messages over the `chat.v1` WebSocket protocol, sync after every reconnect, an offline outbox, read receipts, typing and presence. Pure Dart, so it works on Flutter for Android, iOS, web and desktop, and on the Dart VM.

## Install

Once published to pub.dev:

```yaml
dependencies:
  byotalk: ^0.1.0
```

Until then, use a path (or git) dependency:

```yaml
dependencies:
  byotalk:
    path: ../byotalk-sdk/flutter
```

## Quick start (development)

Development environments accept dev tokens (`dev:<userId>`), so you can start without a backend.

```dart
import 'package:byotalk/byotalk.dart';

final chat = ByoTalkChat(env: 'env_dev_2f8k', token: ByoTalkChat.devToken('alice'));
await chat.connect();
final dm = await chat.conversations.direct('bob');
dm.events.listen((e) {
  if (e is MessageNew) print('${e.message.senderId}: ${e.message.text}');
});
await dm.send(text: 'Hello Bob');
```

## Production

Dev tokens are refused in production. Add a token route to your backend (the JS server SDK `byotalk/server` signs tokens with your secret key) and pass a function that fetches a token. It is called before the token expires and again after `token_expired`. Never put a secret key (`sk_…`) in the app; the SDK refuses it.

```dart
final chat = ByoTalkChat(
  env: 'env_2f8k',
  token: () async {
    final res = await http.get(Uri.parse('https://your.app/chat-token'), headers: {'authorization': 'Bearer $session'});
    return jsonDecode(res.body)['token'] as String;
  },
);
```

## Flutter lifecycle

Disconnect when the app goes to the background and connect again when it comes back. The server marks the user offline at once on a clean close, push notifications take over, and `connect()` syncs everything that was missed.

```dart
class _ChatAppState extends State<ChatApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) chat.disconnect();
    if (state == AppLifecycleState.resumed) chat.connect();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}
```

Render a conversation with a `StreamBuilder` over `conversation.messages.changes` (initial data `conversation.messages.items`).

## Keep unsent messages across restarts

By default the outbox and sync cursor live in memory. Implement `Persistence` to keep them, for example with `shared_preferences`:

```dart
import 'package:shared_preferences/shared_preferences.dart';

class PrefsPersistence implements Persistence {
  final SharedPreferences prefs;
  PrefsPersistence(this.prefs);
  @override
  Future<String?> get(String key) async => prefs.getString(key);
  @override
  Future<void> set(String key, String value) => prefs.setString(key, value);
  @override
  Future<void> delete(String key) => prefs.remove(key);
}

final chat = ByoTalkChat(env: 'env_…', token: getToken, persistence: PrefsPersistence(await SharedPreferences.getInstance()));
```

On sign-out call `await chat.clearLocalData()` then `await chat.disconnect()`, and create a new `ByoTalkChat` for the next user.

## API overview

| | |
|---|---|
| `ByoTalkChat(env:, token:, baseUrl:, realtimeUrl:, persistence:)` | `token` is a `String` or `Future<String> Function()` |
| `connect()`, `disconnect()`, `clearLocalData()` | `connect()` completes after hello and sync |
| `connectionState`, `connectionStates` | `disconnected`, `connecting`, `syncing`, `connected`, `reconnecting`, `failed` |
| `errors` | `Stream<ChatException>` (code, message, requestId, retryable) |
| `conversations.direct(userId)`, `.create(members:, name:, metadata:)`, `.get(id)` | return a `Conversation` with its latest page loaded |
| `conversations.list(limit:, cursor:)`, `conversations.watch()` | summaries with `unreadCount`, `lastMessage`, `metadata`; `watch()` is live |
| `conversation.messages.items`, `.changes` | ordered window (≤ 500), deduplicated by id and seq |
| `conversation.loadOlder()`, `hasOlder` | page back through history |
| `conversation.send(text:, replyTo:, attachments:, metadata:)` | completes on ack; stays pending while offline and is resent with the same `clientMsgId` |
| `conversation.retry(clientMsgId)`, `edit(id, text:)`, `delete(id)` | |
| `conversation.markRead()`, `readBy(seq)`, `members` | receipts |
| `conversation.typing()`, `stopTyping()`, `typingUserIds` | typing (throttled to 1 frame per 3 s, expires after 6 s) |
| `conversation.update(name:, metadata:)` | members get `ConversationUpdated` |
| `conversation.events` | sealed `ConversationEvent`: `MessageNew`, `MessageUpdated`, `MessageDeleted`, `MessageFailed`, `TypingChanged`, `ReceiptUpdated`, `MembersAdded`, `MemberRemoved`, `ConversationUpdated`, `ConversationRemoved` |
| `presence.watch(userIds)` | `Stream<Presence>`: snapshot, then changes; cancel to stop |

Reconnects use full-jitter exponential backoff (0.5 s base, 30 s cap). After every `hello` the SDK runs `sync`, catches up open conversations by `seq` (holding live events that arrive meanwhile, reloading on `resync_required`), and flushes the outbox.

## Not included

- Voice and video calls: use the web or React Native SDK (`npm i byotalk`).
- Attachment uploads and push registration: use the REST API from your app for now (`attachments:` on `send` takes uploaded attachment ids).

## Development

```bash
dart pub get
dart analyze
dart test   # integration tests use BYOTALK_API_URL (default http://localhost:3100) and BYOTALK_RT_URL
            # (default ws://localhost:3001) and are skipped when the API is unreachable
```
