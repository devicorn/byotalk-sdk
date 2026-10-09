/// ByoTalk chat SDK for Flutter and Dart (chat.v1 realtime protocol).
library;

export 'src/chat.dart' show ByoTalkChat, Conversations, PresenceApi, sdkVersion;
export 'src/conversation.dart' show Conversation;
export 'src/models.dart';
export 'src/store.dart' show MessageStore;
export 'src/rest.dart' show TokenProvider;
export 'src/transport.dart' show SocketConnector;
export 'src/util.dart' show ChatException, Persistence, MemoryPersistence, backoffDelay, uuidV4;
