// Public data types (mirrors src/core/types.ts). Named ChatConnectionState so it does not clash with
// Flutter's ConnectionState.
import 'util.dart';

typedef Json = Map<String, dynamic>;

enum ChatConnectionState { disconnected, connecting, syncing, connected, reconnecting, failed }

enum MessageStatus { sending, sent, failed }

const _keep = Object();

class Message {
  /// null while sending.
  final String? id;

  /// Set on your own messages.
  final String? clientMsgId;
  final String conversationId;
  final int? seq;
  final String senderId;
  final String? text;
  final String? replyTo;
  final List<Json> attachments;
  final Json metadata;
  final int version;
  final MessageStatus status;
  final ChatException? error;

  /// Server time once sent; local time while sending (ISO 8601).
  final String createdAt;
  final String? editedAt;
  final String? deletedAt;

  const Message({
    required this.id,
    required this.clientMsgId,
    required this.conversationId,
    required this.seq,
    required this.senderId,
    required this.text,
    this.replyTo,
    this.attachments = const [],
    this.metadata = const {},
    this.version = 1,
    this.status = MessageStatus.sent,
    this.error,
    required this.createdAt,
    this.editedAt,
    this.deletedAt,
  });

  factory Message.fromJson(Json m, [String? clientMsgId]) => Message(
        id: m['id'] as String,
        clientMsgId: clientMsgId,
        conversationId: m['conversationId'] as String,
        seq: (m['seq'] as num).toInt(),
        senderId: m['senderId'] as String,
        text: m['text'] as String?,
        replyTo: m['replyTo'] as String?,
        attachments: [for (final a in (m['attachments'] as List? ?? const [])) Json.from(a as Map)],
        metadata: Json.from(m['metadata'] as Map? ?? const {}),
        version: (m['version'] as num?)?.toInt() ?? 1,
        createdAt: m['createdAt'] as String,
        editedAt: m['editedAt'] as String?,
        deletedAt: m['deletedAt'] as String?,
      );

  /// Nullable fields can be set to null explicitly (`copyWith(error: null)`).
  Message copyWith({
    Object? id = _keep,
    Object? clientMsgId = _keep,
    Object? seq = _keep,
    Object? text = _keep,
    List<Json>? attachments,
    Json? metadata,
    MessageStatus? status,
    Object? error = _keep,
    String? createdAt,
    Object? editedAt = _keep,
    Object? deletedAt = _keep,
  }) =>
      Message(
        id: identical(id, _keep) ? this.id : id as String?,
        clientMsgId: identical(clientMsgId, _keep) ? this.clientMsgId : clientMsgId as String?,
        conversationId: conversationId,
        seq: identical(seq, _keep) ? this.seq : seq as int?,
        senderId: senderId,
        text: identical(text, _keep) ? this.text : text as String?,
        replyTo: replyTo,
        attachments: attachments ?? this.attachments,
        metadata: metadata ?? this.metadata,
        version: version,
        status: status ?? this.status,
        error: identical(error, _keep) ? this.error : error as ChatException?,
        createdAt: createdAt ?? this.createdAt,
        editedAt: identical(editedAt, _keep) ? this.editedAt : editedAt as String?,
        deletedAt: identical(deletedAt, _keep) ? this.deletedAt : deletedAt as String?,
      );

  @override
  String toString() => 'Message($id, seq=$seq, $senderId: $text, ${status.name})';
}

class Member {
  final String userId;
  final String role;
  int lastReadSeq;
  int lastDeliveredSeq;
  Member(this.userId, {this.role = 'member', this.lastReadSeq = 0, this.lastDeliveredSeq = 0});

  factory Member.fromJson(Json m) => Member(
        m['userId'] as String,
        role: m['role'] as String? ?? 'member',
        lastReadSeq: (m['lastReadSeq'] as num?)?.toInt() ?? 0,
        lastDeliveredSeq: (m['lastDeliveredSeq'] as num?)?.toInt() ?? 0,
      );
}

/// One row of the conversation list. Kept up to date by events and sync in `conversations.watch()`.
class ConversationSummary {
  final String id;
  final String type;
  String? name;
  Json metadata;
  int lastSeq;
  int unreadCount;
  int lastReadSeq;
  bool muted;
  String lastActivityAt;
  Message? lastMessage;

  ConversationSummary.fromJson(Json j)
      : id = j['id'] as String,
        type = j['type'] as String,
        name = j['name'] as String?,
        metadata = Json.from(j['metadata'] as Map? ?? const {}),
        lastSeq = (j['lastSeq'] as num?)?.toInt() ?? 0,
        unreadCount = (j['unreadCount'] as num?)?.toInt() ?? 0,
        lastReadSeq = (j['lastReadSeq'] as num?)?.toInt() ?? 0,
        muted = j['muted'] as bool? ?? false,
        lastActivityAt = j['lastActivityAt'] as String? ?? '',
        lastMessage = j['lastMessage'] is Map ? Message.fromJson(Json.from(j['lastMessage'] as Map)) : null;
}

class Presence {
  final String userId;
  final bool online;
  final String? lastSeenAt;
  const Presence(this.userId, this.online, this.lastSeenAt);
  factory Presence.fromJson(Json j) => Presence(j['userId'] as String, j['online'] == true, j['lastSeenAt'] as String?);
}

class Page<T> {
  final List<T> data;
  final String? nextCursor;
  const Page(this.data, this.nextCursor);
}

/// Everything a [Conversation] reports on its `events` stream.
sealed class ConversationEvent {
  const ConversationEvent();
}

class MessageNew extends ConversationEvent {
  final Message message;
  const MessageNew(this.message);
}

class MessageUpdated extends ConversationEvent {
  final Message message;
  const MessageUpdated(this.message);
}

class MessageDeleted extends ConversationEvent {
  final Message message;
  const MessageDeleted(this.message);
}

/// A send was refused for good (not a network problem); `retry(clientMsgId)` resends it.
class MessageFailed extends ConversationEvent {
  final Message message;
  const MessageFailed(this.message);
}

class TypingChanged extends ConversationEvent {
  final List<String> userIds;
  const TypingChanged(this.userIds);
}

class ReceiptUpdated extends ConversationEvent {
  final String userId;
  final int lastReadSeq;
  final int lastDeliveredSeq;
  const ReceiptUpdated(this.userId, this.lastReadSeq, this.lastDeliveredSeq);
}

class MembersAdded extends ConversationEvent {
  final List<String> userIds;
  final String? actorId;
  const MembersAdded(this.userIds, this.actorId);
}

class MemberRemoved extends ConversationEvent {
  final String userId;
  final String? actorId;
  final String? reason;
  const MemberRemoved(this.userId, this.actorId, this.reason);
}

/// Name or metadata changed (`conversation.updated`).
class ConversationUpdated extends ConversationEvent {
  const ConversationUpdated();
}

/// You left or were removed; the conversation is dropped from the client.
class ConversationRemoved extends ConversationEvent {
  const ConversationRemoved();
}
