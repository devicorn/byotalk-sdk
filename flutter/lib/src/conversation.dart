// One conversation: message window, gapless event application, receipts, typing (docs/09 §3–4,
// docs/08 §7; mirrors src/core/conversation.ts).
import 'dart:async';

import 'chat.dart';
import 'models.dart';
import 'store.dart';
import 'util.dart';

const _typingExpiry = Duration(seconds: 6);
const _typingThrottle = Duration(seconds: 3);

class Conversation {
  final ByoTalkChat _chat;
  final String id;

  /// "direct" or "group".
  final String type;
  String? name;
  Json metadata;
  List<Member> members;
  int unreadCount = 0;
  bool muted;

  /// Last contiguous event applied.
  int lastSeq;
  final messages = MessageStore();

  /// True while the server has messages older than the oldest one loaded; loadOlder() pages through them.
  bool hasOlder = false;
  bool removed = false;

  final _events = StreamController<ConversationEvent>.broadcast();
  final _typingUsers = <String, Timer>{};
  DateTime? _lastTypingSent;
  List<(int, String, Json)> _held = [];
  Future<void>? _catchingUp;
  int _gapFailures = 0;

  Conversation(this._chat, Json c)
      : id = c['id'] as String,
        type = c['type'] as String,
        name = c['name'] as String?,
        metadata = Json.from(c['metadata'] as Map? ?? const {}),
        members = [for (final m in (c['members'] as List? ?? const [])) Member.fromJson(Json.from(m as Map))],
        lastSeq = (c['lastSeq'] as num?)?.toInt() ?? 0,
        muted = c['muted'] as bool? ?? false;

  /// Messages, edits, deletes, failures, typing, receipts, membership and updates for this conversation.
  Stream<ConversationEvent> get events => _events.stream;

  String get _path => '/v1/conversations/${seg(id)}';

  // ------------------------------------------------------------------ loading

  /// Loads the latest page (called once when the conversation object is created). Returns hasOlder.
  Future<bool> loadLatest({int limit = 50}) async {
    final page = await _chat.rest.request('GET', '$_path/messages', query: {'limit': limit}) as Map;
    messages.upsertMany(_parse(page['data']));
    return hasOlder = page['hasMore'] == true;
  }

  /// Older page before the oldest loaded message.
  Future<({List<Message> messages, bool hasMore})> loadOlder({int limit = 50}) async {
    final before = messages.oldestSeq;
    if (before == null || before <= 1) {
      hasOlder = false;
      return (messages: <Message>[], hasMore: false);
    }
    final page = await _chat.rest.request('GET', '$_path/messages', query: {'before': before, 'limit': limit}) as Map;
    final msgs = _parse(page['data']);
    messages.upsertMany(msgs);
    hasOlder = page['hasMore'] == true;
    return (messages: msgs, hasMore: hasOlder);
  }

  static List<Message> _parse(Object? data) => [for (final m in data as List) Message.fromJson(Json.from(m as Map))];

  // ------------------------------------------------------------------ sending

  /// Completes on ack. Network problems do not fail it: the message stays pending in the outbox and is resent
  /// with the same clientMsgId after the next connect.
  Future<Message> send({String? text, String? replyTo, List<String>? attachments, Json? metadata}) {
    final clientMsgId = uuidV4();
    messages.addPending(Message(
      id: null,
      clientMsgId: clientMsgId,
      conversationId: id,
      seq: null,
      senderId: _chat.userId ?? '',
      text: text,
      replyTo: replyTo,
      metadata: metadata ?? const {},
      status: MessageStatus.sending,
      createdAt: DateTime.now().toUtc().toIso8601String(),
    ));
    if (_lastTypingSent != null) stopTyping();
    return _chat.outbox.enqueue(OutboxEntry(
      clientMsgId: clientMsgId,
      cid: id,
      payload: {
        'cid': id,
        'clientMsgId': clientMsgId,
        if (text != null) 'text': text,
        if (replyTo != null) 'replyTo': replyTo,
        if (attachments != null && attachments.isNotEmpty) 'attachments': attachments,
        if (metadata != null) 'metadata': metadata,
      },
      createdAt: DateTime.now().millisecondsSinceEpoch,
    ));
  }

  /// Retries a failed message with the same clientMsgId (server dedup makes this safe).
  Future<Message> retry(String clientMsgId) {
    final m = messages.getByClientId(clientMsgId);
    if (m == null || m.id != null) {
      return Future.error(ChatException('not_found', 'No failed message with that clientMsgId', type: 'not_found'));
    }
    messages.markSending(clientMsgId);
    return _chat.outbox.retry(clientMsgId);
  }

  Future<Message> edit(String messageId, {String? text, Json? metadata}) async {
    final cur = messages.get(messageId);
    final undo = messages.patch(
        messageId,
        (m) =>
            m.copyWith(text: text ?? m.text, metadata: metadata, editedAt: DateTime.now().toUtc().toIso8601String()));
    try {
      final expectedVersion = cur?.version ??
          ((await _chat.rest.request('GET', '/v1/messages/${seg(messageId)}') as Map)['version'] as num).toInt();
      final m = await _chat.rest.request('PATCH', '/v1/messages/${seg(messageId)}', body: {
        if (text != null) 'text': text,
        if (metadata != null) 'metadata': metadata,
        'expectedVersion': expectedVersion,
      });
      final msg = Message.fromJson(Json.from(m as Map), cur?.clientMsgId);
      messages.upsert(msg);
      return msg;
    } catch (_) {
      undo?.call();
      rethrow;
    }
  }

  Future<void> delete(String messageId) async {
    final undo = messages.patch(messageId, _deleted(DateTime.now().toUtc().toIso8601String()));
    try {
      await _chat.rest.request('DELETE', '/v1/messages/${seg(messageId)}');
    } catch (_) {
      undo?.call();
      rethrow;
    }
  }

  static Message Function(Message) _deleted(String? at) =>
      (m) => m.copyWith(text: null, attachments: const [], metadata: const {}, deletedAt: at);

  /// Marks everything up to [seq] (default: latest) as read. Monotonic on the server.
  Future<void> markRead([int? seq]) async {
    final target = seq ?? _latestSeq();
    if (target == 0) return;
    unreadCount = 0;
    if (_chat.transport.isOpen) {
      await _chat.transport.request('read', {'cid': id, 'seq': target});
    } else {
      await _chat.rest.request('POST', '$_path/read', body: {'seq': target});
    }
    _chat.noteRead(id, target);
  }

  /// Call on every keystroke; sends at most one `typing start` per 3 s.
  void typing() {
    final now = DateTime.now();
    if (_lastTypingSent != null && now.difference(_lastTypingSent!) < _typingThrottle) return;
    _lastTypingSent = now;
    _chat.transport.send('typing', {'cid': id, 'state': 'start'});
  }

  /// Stops the typing indicator (e.g. on blur). Sending a message stops it too.
  void stopTyping() {
    if (_lastTypingSent == null) return;
    _lastTypingSent = null;
    _chat.transport.send('typing', {'cid': id, 'state': 'stop'});
  }

  /// Renames or changes metadata; every member gets `ConversationUpdated`.
  Future<void> update({String? name, Json? metadata}) => _chat.rest.request('PATCH', _path, body: {
        if (name != null) 'name': name,
        if (metadata != null) 'metadata': metadata,
      });

  /// Members whose read watermark is at or past [seq] (excluding the sender of that message).
  List<String> readBy(int seq) {
    String? sender;
    for (final m in messages.items) {
      if (m.seq == seq) sender = m.senderId;
    }
    return [
      for (final m in members)
        if (m.lastReadSeq >= seq && m.userId != sender) m.userId
    ];
  }

  List<String> get typingUserIds => _typingUsers.keys.toList();

  int _latestSeq() {
    var max = lastSeq;
    for (final m in messages.items) {
      if (m.seq != null && m.seq! > max) max = m.seq!;
    }
    return max;
  }

  // ------------------------------------------------------------------ incoming (called by ByoTalkChat)

  /// Applies one stream event in seq order; holds it and catches up when there is a gap.
  void applyEvent(int seq, String e, Json d) {
    if (seq <= lastSeq) return; // duplicate
    if (_catchingUp != null || seq > lastSeq + 1) {
      _held.add((seq, e, d));
      if (_catchingUp == null) catchUp().catchError((_) {});
      return;
    }
    _apply(seq, e, d);
  }

  void _apply(int seq, String e, Json d) {
    lastSeq = seq;
    switch (e) {
      case 'message.new':
        final m = Message.fromJson(Json.from(d['message'] as Map));
        messages.upsert(m);
        if (m.senderId != _chat.userId) {
          unreadCount++;
          _chat.receipts.delivered(id, seq);
          _clearTyping(m.senderId);
        }
        _events.add(MessageNew(messages.get(m.id!) ?? m));
      case 'message.updated':
        final m = Message.fromJson(Json.from(d['message'] as Map));
        messages.upsert(m);
        _events.add(MessageUpdated(messages.get(m.id!) ?? m));
      case 'message.deleted':
        messages.patch(d['id'] as String, _deleted(d['deletedAt'] as String?));
        final m = messages.get(d['id'] as String);
        if (m != null) _events.add(MessageDeleted(m));
      case 'member.added':
        final ids = [for (final u in d['userIds'] as List) u as String];
        for (final u in ids) {
          if (!members.any((m) => m.userId == u)) members.add(Member(u));
        }
        _events.add(MembersAdded(ids, d['actorId'] as String?));
      case 'member.removed':
        final u = d['userId'] as String;
        members.removeWhere((m) => m.userId == u);
        _events.add(MemberRemoved(u, d['actorId'] as String?, d['reason'] as String?));
        if (u == _chat.userId) markRemoved();
      case 'conversation.created':
        final ms = (d['conversation'] as Map?)?['members'] as List?;
        if (ms != null) members = [for (final m in ms) Member.fromJson(Json.from(m as Map))];
      case 'conversation.updated':
        final changes = d['changes'] as Map? ?? const {};
        if (changes.containsKey('name')) name = changes['name'] as String?;
        if (changes['metadata'] is Map) metadata = Json.from(changes['metadata'] as Map);
        _events.add(const ConversationUpdated());
    }
  }

  /// Fetches events after lastSeq (and applies held live events); resync_required → reload the latest page.
  Future<void> catchUp() => _catchingUp ??= () async {
        try {
          for (;;) {
            final before = lastSeq;
            final page =
                await _chat.rest.request('GET', '$_path/events', query: {'after': lastSeq, 'limit': 200}) as Map;
            for (final raw in page['data'] as List) {
              final ev = Json.from(raw as Map);
              final seq = (ev.remove('seq') as num).toInt();
              final type = ev.remove('type') as String;
              if (seq == lastSeq + 1) _apply(seq, type, ev);
            }
            if (page['hasMore'] != true || lastSeq == before) break; // no progress: never spin
          }
          _gapFailures = 0;
        } catch (err) {
          if (err is ChatException && err.code == 'resync_required' || ++_gapFailures >= 3) {
            await resync();
          } else {
            rethrow;
          }
        } finally {
          _catchingUp = null;
        }
        final held = _held..sort((a, b) => a.$1.compareTo(b.$1));
        _held = [];
        for (final h in held) {
          applyEvent(h.$1, h.$2, h.$3);
        }
      }();

  /// resync_required: drop the window, reload the latest page, continue from the server's lastSeq.
  Future<void> resync() async {
    final c = await _chat.rest.request('GET', _path) as Map;
    messages.clear();
    lastSeq = (c['lastSeq'] as num).toInt();
    final known = {for (final m in members) m.userId: m};
    members = [
      for (final m in (c['members'] as List? ?? const [])) known[(m as Map)['userId']] ?? Member.fromJson(Json.from(m))
    ];
    await loadLatest();
    _held = _held.where((h) => h.$1 > lastSeq).toList();
    _gapFailures = 0;
  }

  void onReceipt(Json r) {
    final userId = r['userId'] as String;
    final m = members.firstWhere((x) => x.userId == userId, orElse: () {
      final n = Member(userId);
      members.add(n);
      return n;
    });
    final read = (r['lastReadSeq'] as num?)?.toInt();
    final delivered = (r['lastDeliveredSeq'] as num?)?.toInt();
    if (read != null && read > m.lastReadSeq) m.lastReadSeq = read;
    if (delivered != null && delivered > m.lastDeliveredSeq) m.lastDeliveredSeq = delivered;
    if (m.lastDeliveredSeq < m.lastReadSeq) m.lastDeliveredSeq = m.lastReadSeq;
    _events.add(ReceiptUpdated(userId, m.lastReadSeq, m.lastDeliveredSeq));
  }

  void onTyping(String userId, String state) {
    if (userId == _chat.userId) return;
    if (state == 'stop') return _clearTyping(userId);
    _typingUsers[userId]?.cancel();
    _typingUsers[userId] = Timer(_typingExpiry, () => _clearTyping(userId));
    _events.add(TypingChanged(typingUserIds));
  }

  void _clearTyping(String userId) {
    final t = _typingUsers.remove(userId);
    if (t == null) return;
    t.cancel();
    _events.add(TypingChanged(typingUserIds));
  }

  void emitFailed(Message m) => _events.add(MessageFailed(m));

  void markRemoved() {
    if (removed) return;
    removed = true;
    _events.add(const ConversationRemoved());
    _chat.dropConversation(id);
  }
}
