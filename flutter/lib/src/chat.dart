// The client: connection machine, sync engine, outbox, receipts, presence (docs/09 §3–4; mirrors
// src/core/chat.ts).
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'conversation.dart';
import 'models.dart';
import 'rest.dart';
import 'transport.dart';
import 'util.dart';

const sdkVersion = '0.1.0';
const _outboxTtl = Duration(hours: 24);

class OutboxEntry {
  final String clientMsgId;
  final String cid;
  final Json payload;
  final int createdAt;
  OutboxEntry({required this.clientMsgId, required this.cid, required this.payload, required this.createdAt});

  Json toJson() => {'clientMsgId': clientMsgId, 'cid': cid, 'payload': payload, 'createdAt': createdAt};
  factory OutboxEntry.fromJson(Json j) => OutboxEntry(
      clientMsgId: j['clientMsgId'] as String,
      cid: j['cid'] as String,
      payload: Json.from(j['payload'] as Map),
      createdAt: (j['createdAt'] as num).toInt());
}

/// Pending sends keyed by clientMsgId; flushed after every hello; persisted through [Persistence].
class Outbox {
  final ByoTalkChat _chat;
  final _entries = <String, OutboxEntry>{};
  final _failed = <String, OutboxEntry>{};
  final _waiters = <String, Completer<Message>>{};
  bool _flushing = false;

  Outbox(this._chat);

  int get size => _entries.length;

  Future<Message> enqueue(OutboxEntry e) {
    _entries[e.clientMsgId] = e;
    _persist();
    final c = _waiters[e.clientMsgId] = Completer<Message>();
    if (_chat.transport.isOpen) _sendOne(e);
    return c.future;
  }

  Future<Message> retry(String clientMsgId) {
    final failed = _failed.remove(clientMsgId);
    if (failed != null) {
      _entries[clientMsgId] = OutboxEntry(
          clientMsgId: clientMsgId,
          cid: failed.cid,
          payload: failed.payload,
          createdAt: DateTime.now().millisecondsSinceEpoch);
      _persist();
    }
    final e = _entries[clientMsgId];
    if (e == null) return Future.error(ChatException('not_found', 'Message is not in the outbox', type: 'not_found'));
    final c = _waiters[clientMsgId] = Completer<Message>();
    if (_chat.transport.isOpen) _sendOne(e);
    return c.future;
  }

  Future<void> flush() async {
    if (_flushing) return;
    _flushing = true;
    try {
      final list = _entries.values.toList()..sort((a, b) => a.createdAt.compareTo(b.createdAt));
      for (final e in list) {
        if (!_chat.transport.isOpen) break;
        await _sendOne(e);
      }
    } finally {
      _flushing = false;
    }
  }

  Future<void> _sendOne(OutboxEntry e) async {
    final conv = _chat.cached(e.cid);
    if (DateTime.now().millisecondsSinceEpoch - e.createdAt > _outboxTtl.inMilliseconds) {
      return _fail(e, ChatException('expired', 'Message was not sent within 24 hours', type: 'invalid_request'));
    }
    try {
      final ack = await _chat.transport.request('message.send', e.payload) as Map;
      final id = ack['id'] as String, seq = (ack['seq'] as num).toInt(), createdAt = ack['createdAt'] as String;
      _entries.remove(e.clientMsgId);
      _persist();
      conv?.messages.reconcile(e.clientMsgId, id: id, seq: seq, createdAt: createdAt);
      final msg = conv?.messages.get(id) ??
          Message(
            id: id,
            clientMsgId: e.clientMsgId,
            conversationId: e.cid,
            seq: seq,
            senderId: _chat.userId ?? '',
            text: e.payload['text'] as String?,
            replyTo: e.payload['replyTo'] as String?,
            metadata: Json.from(e.payload['metadata'] as Map? ?? const {}),
            createdAt: createdAt,
          );
      final w = _waiters.remove(e.clientMsgId);
      if (w != null && !w.isCompleted) w.complete(msg);
    } catch (err) {
      final ce = ChatException.from(err);
      // Retryable problems keep the message pending; it is resent after the next hello.
      if (ce.retryable) {
        if (ce.code == 'rate_limited' && ce.retryAfterMs != null) {
          Timer(Duration(milliseconds: ce.retryAfterMs!), () {
            if (_chat.transport.isOpen && _entries.containsKey(e.clientMsgId)) _sendOne(e);
          });
        }
        return;
      }
      _fail(e, ce);
    }
  }

  void _fail(OutboxEntry e, ChatException err) {
    _entries.remove(e.clientMsgId);
    _persist();
    final conv = _chat.cached(e.cid);
    conv?.messages.markFailed(e.clientMsgId, err);
    final m = conv?.messages.getByClientId(e.clientMsgId);
    if (m != null) conv!.emitFailed(m);
    final w = _waiters.remove(e.clientMsgId);
    if (w != null && !w.isCompleted) w.completeError(err);
    _failed[e.clientMsgId] = e; // retry() can resend it with the same clientMsgId
  }

  Future<void> load() async {
    final raw = await _chat.persistence.get(_chat.key('outbox'));
    if (raw == null) return;
    try {
      for (final j in jsonDecode(raw) as List) {
        final e = OutboxEntry.fromJson(Json.from(j as Map));
        _entries.putIfAbsent(e.clientMsgId, () => e);
      }
    } catch (_) {
      // corrupt entry: ignore
    }
  }

  void _persist() {
    if (_chat.userId == null) return;
    _chat.persistence
        .set(_chat.key('outbox'), jsonEncode([for (final e in _entries.values) e.toJson()]))
        .catchError((_) {});
  }
}

/// Delivered acks batched to at most one frame per second (docs/08 §10).
class ReceiptBatcher {
  final ByoTalkChat _chat;
  final _pending = <String, int>{};
  Timer? _timer;
  ReceiptBatcher(this._chat);

  void delivered(String cid, int seq) {
    final cur = _pending[cid];
    _pending[cid] = cur == null || seq > cur ? seq : cur;
    _timer ??= Timer(const Duration(seconds: 1), flush);
  }

  void flush() {
    _timer?.cancel();
    _timer = null;
    if (_pending.isEmpty || !_chat.transport.isOpen) return;
    final items = [
      for (final e in _pending.entries) {'cid': e.key, 'seq': e.value}
    ];
    _pending.clear();
    _chat.transport.send('delivered', {'items': items});
  }
}

class ByoTalkChat {
  /// `dev:<userId>`; accepted only by development environments with dev tokens enabled.
  static String devToken(String userId) => 'dev:$userId';

  final String env;
  late final RestClient rest;
  late final Transport transport;
  final Persistence persistence;
  late final Outbox outbox = Outbox(this);
  late final ReceiptBatcher receipts = ReceiptBatcher(this);
  late final Conversations conversations = Conversations._(this);
  late final PresenceApi presence = PresenceApi._(this);

  final _states = StreamController<ChatConnectionState>.broadcast();
  final _errors = StreamController<ChatException>.broadcast();
  final _convs = <String, Conversation>{};
  final _loading = <String, Future<Conversation>>{};
  final _summaries = <String, ConversationSummary>{};
  String? _syncCursor;
  final _connectWaiters = <Completer<void>>[];
  String? _userId;

  /// [token] is a user token String, or a `Future<String> Function()` that fetches one from your backend
  /// (called before the token expires and after `token_expired`). Never pass a secret key (`sk_…`).
  ByoTalkChat({
    required this.env,
    required Object token,
    String baseUrl = 'https://api.byotalk.com',
    String realtimeUrl = 'wss://rt.byotalk.com',
    Persistence? persistence,
    String sdkName = 'dart',
    http.Client? httpClient,
    SocketConnector? connector,
  }) : persistence = persistence ?? MemoryPersistence() {
    if (env.isEmpty) throw ChatException('invalid_request', 'env is required', type: 'invalid_request');
    if (token is String && token.startsWith('sk_')) {
      throw ChatException('invalid_request',
          'That is a secret key: it belongs on your server. Pass a user token from your token route instead',
          type: 'invalid_request');
    }
    final auth = AuthManager(token);
    rest = RestClient(baseUrl, env, auth, httpClient);
    transport =
        Transport(realtimeUrl: realtimeUrl, env: env, sdk: '$sdkName/$sdkVersion', auth: auth, connector: connector);
    if (token is String && token.startsWith('dev:')) _userId = token.substring(4);

    transport
      ..onState = (s) {
        _states.add(s);
        if (s == ChatConnectionState.failed) {
          _rejectConnect(ChatException('failed', 'Connection failed', type: 'authentication'));
        }
      }
      ..onError = (e) {
        _errors.add(e);
        if (transport.state == ChatConnectionState.failed) _rejectConnect(e);
      }
      ..onHello = _afterHello
      ..onFrame = _onFrame;
  }

  String? get userId => _userId;
  ChatConnectionState get connectionState => transport.state;

  /// disconnected → connecting → syncing → connected ↔ reconnecting; failed.
  Stream<ChatConnectionState> get connectionStates => _states.stream;

  /// Connection and server errors that are not tied to a call you made.
  Stream<ChatException> get errors => _errors.stream;

  /// Namespaced persistence key for this environment and user.
  String key(String name) => 'byotalk:$env:${_userId ?? 'anon'}:$name';

  /// Completes once connected (hello received and sync finished).
  Future<void> connect() {
    if (transport.state == ChatConnectionState.connected) return Future.value();
    final c = Completer<void>();
    _connectWaiters.add(c);
    if (transport.state == ChatConnectionState.failed) transport.state = ChatConnectionState.disconnected;
    transport.start();
    return c.future;
  }

  /// Deletes what this user left in persistence (unsent messages, sync cursor). Call on sign-out, before
  /// disconnect.
  Future<void> clearLocalData() => Future.wait([persistence.delete(key('outbox')), persistence.delete(key('cursor'))]);

  /// Closes the socket (code 1000); call [connect] again to come back (e.g. on app resume).
  Future<void> disconnect() async {
    receipts.flush();
    transport.stop();
  }

  void _rejectConnect(ChatException e) {
    for (final w in _connectWaiters) {
      if (!w.isCompleted) w.completeError(e);
    }
    _connectWaiters.clear();
  }

  void _resolveConnect() {
    for (final w in _connectWaiters) {
      if (!w.isCompleted) w.complete();
    }
    _connectWaiters.clear();
  }

  // ------------------------------------------------------------------ sync after hello (docs/08 §7.2)

  Future<void> _afterHello() async {
    final hello = transport.hello!;
    final helloUser = hello['userId'] as String;
    final firstUser = _userId == null || _userId != helloUser;
    _userId = helloUser;
    if (firstUser || _syncCursor == null) {
      _syncCursor = await persistence.get(key('cursor'));
      await outbox.load();
    }
    transport.setState(ChatConnectionState.syncing);
    try {
      await Future.wait([_runSync(), outbox.flush(), _rewatchPresence()]);
    } catch (_) {
      // The socket is up; serve live events and let the next hello retry the sync.
    }
    if (transport.isOpen) transport.setState(ChatConnectionState.connected);
    _resolveConnect();
  }

  Future<void> _runSync() async {
    final r = await transport.request('sync', {'cursor': _syncCursor}, timeout: const Duration(seconds: 10)) as Map;
    final convs = [for (final c in r['conversations'] as List) Json.from(c as Map)];
    for (final c in convs) {
      final id = c['id'] as String, lastSeq = (c['lastSeq'] as num).toInt();
      final unread = (c['unreadCount'] as num?)?.toInt() ?? 0;
      _summaries[id]
        ?..lastSeq = lastSeq
        ..unreadCount = unread;
      final conv = _convs[id];
      if (conv != null) {
        conv.unreadCount = unread;
        if (lastSeq > conv.lastSeq) await conv.catchUp().catchError((_) {});
      }
    }
    for (final id in r['removed'] as List? ?? const []) {
      _convs[id]?.markRemoved();
    }
    if (r['fullReload'] == true || convs.any((c) => !_summaries.containsKey(c['id']))) {
      await _refreshSummaries().catchError((_) {});
    } else {
      _notifySummaries();
    }
    _syncCursor = r['cursor'] as String?;
    if (_syncCursor != null) await persistence.set(key('cursor'), _syncCursor!);
  }

  // ------------------------------------------------------------------ incoming frames

  void _onFrame(Frame f) {
    final d = f['d'] is Map ? Json.from(f['d'] as Map) : <String, dynamic>{};
    switch (f['t']) {
      case 'event':
        final cid = f['cid'] as String?, seq = (f['seq'] as num?)?.toInt(), e = f['e'] as String?;
        if (cid == null || seq == null || e == null) return;
        final conv = _convs[cid];
        conv?.applyEvent(seq, e, d);
        _updateSummary(e, cid, seq, d);
        if (e == 'conversation.created' && conv == null) _notifySummaries();
      case 'receipt':
        _convs[d['cid']]?.onReceipt(d);
      case 'typing':
        _convs[d['cid']]?.onTyping(d['userId'] as String, d['state'] as String);
      case 'presence':
        final p = Presence.fromJson(d);
        for (final w in _presenceWatchers) {
          if (w.userIds.contains(p.userId)) w.controller.add(p);
        }
      case 'resync_required':
        _convs[d['cid']]?.resync().catchError((_) {});
      case 'resync_hint':
        _runSync().catchError((_) {});
    }
  }

  void _updateSummary(String e, String cid, int seq, Json d) {
    final s = _summaries[cid];
    if (e == 'member.removed' && d['userId'] == _userId) {
      _summaries.remove(cid);
      return _notifySummaries();
    }
    if (s == null) {
      if (e == 'conversation.created' || e == 'message.new') _refreshSummaries().catchError((_) {});
      return;
    }
    if (seq > s.lastSeq) s.lastSeq = seq;
    s.lastActivityAt = DateTime.now().toUtc().toIso8601String();
    if (e == 'message.new') {
      final m = Message.fromJson(Json.from(d['message'] as Map));
      s.lastMessage = m;
      if (m.senderId != _userId && s.unreadCount < 99) s.unreadCount++;
    }
    if (e == 'conversation.updated') {
      final changes = d['changes'] as Map? ?? const {};
      if (changes.containsKey('name')) s.name = changes['name'] as String?;
      if (changes['metadata'] is Map) s.metadata = Json.from(changes['metadata'] as Map);
    }
    _notifySummaries();
  }

  /// Internal: the user read a conversation up to [seq]; clears its badge in `conversations.watch()`.
  void noteRead(String cid, int seq) {
    final s = _summaries[cid];
    if (s == null) return;
    if (seq >= s.lastSeq) s.unreadCount = 0;
    if (seq > s.lastReadSeq) s.lastReadSeq = seq;
    _notifySummaries();
  }

  late final _summaryCtl = StreamController<List<ConversationSummary>>.broadcast(
    onListen: () => _refreshSummaries().catchError((Object e) => _errors.add(ChatException.from(e))),
  );

  void _notifySummaries() {
    if (!_summaryCtl.hasListener) return;
    _summaryCtl.add(_summaries.values.toList()..sort((a, b) => b.lastActivityAt.compareTo(a.lastActivityAt)));
  }

  Future<void> _refreshSummaries() async {
    if (!_summaryCtl.hasListener) return;
    final page = await rest.request('GET', '/v1/conversations', query: {'limit': 100}) as Map;
    _summaries.clear();
    for (final s in page['data'] as List) {
      final sum = ConversationSummary.fromJson(Json.from(s as Map));
      _summaries[sum.id] = sum;
    }
    _notifySummaries();
  }

  // ------------------------------------------------------------------ conversations

  /// Internal: a conversation object already in memory.
  Conversation? cached(String id) => _convs[id];

  void dropConversation(String id) {
    _convs.remove(id);
    _summaries.remove(id);
    _notifySummaries();
  }

  Future<Conversation> _materialize(Json c) {
    final id = c['id'] as String;
    final existing = _convs[id];
    if (existing != null) return Future.value(existing);
    return _loading[id] ??= () async {
      final conv = Conversation(this, c);
      _convs[id] = conv;
      try {
        await conv.loadLatest();
        final members = await rest.request('GET', '/v1/conversations/${seg(id)}/members') as Map;
        conv.members = [for (final m in members['data'] as List) Member.fromJson(Json.from(m as Map))];
        conv.unreadCount = _summaries[id]?.unreadCount ?? 0;
        if (transport.isOpen) await conv.catchUp().catchError((_) {});
        return conv;
      } catch (_) {
        _convs.remove(id);
        rethrow;
      } finally {
        _loading.remove(id);
      }
    }();
  }

  // ------------------------------------------------------------------ presence

  final _presenceWatchers = <_PresenceWatch>[];

  Future<void> _rewatchPresence([_PresenceWatch? snapshotFor]) async {
    if (!transport.isOpen) return;
    final union = {for (final w in _presenceWatchers) ...w.userIds}.take(200).toList();
    try {
      final r = await transport.request('presence.watch', {'userIds': union}) as Map;
      for (final w in _presenceWatchers) {
        if (snapshotFor != null && w != snapshotFor) continue;
        for (final p in r['presence'] as List) {
          final pr = Presence.fromJson(Json.from(p as Map));
          if (w.userIds.contains(pr.userId)) w.controller.add(pr);
        }
      }
    } catch (_) {
      // retried after the next hello
    }
  }
}

/// `chat.conversations`.
class Conversations {
  final ByoTalkChat _chat;
  Conversations._(this._chat);

  /// The one-to-one conversation with [userId] (created on first use).
  Future<Conversation> direct(String userId) async =>
      _chat._materialize(Json.from(await _chat.rest.request('POST', '/v1/conversations',
          body: {
            'type': 'direct',
            'members': [userId]
          },
          idempotent: true) as Map));

  /// A group conversation; you become its owner.
  Future<Conversation> create({required List<String> members, String? name, Json? metadata}) async =>
      _chat._materialize(Json.from(await _chat.rest.request('POST', '/v1/conversations',
          body: {
            'type': 'group',
            'members': members,
            if (name != null) 'name': name,
            if (metadata != null) 'metadata': metadata,
          },
          idempotent: true) as Map));

  Future<Conversation> get(String id) async {
    final hit = _chat._convs[id];
    if (hit != null) return hit;
    return _chat._materialize(Json.from(await _chat.rest.request('GET', '/v1/conversations/${seg(id)}') as Map));
  }

  /// One page of your conversations, most recent activity first.
  Future<Page<ConversationSummary>> list({int? limit, String? cursor}) async {
    final page = await _chat.rest.request('GET', '/v1/conversations', query: {'limit': limit, 'cursor': cursor}) as Map;
    final data = [for (final s in page['data'] as List) ConversationSummary.fromJson(Json.from(s as Map))];
    for (final s in data) {
      _chat._summaries[s.id] = s;
    }
    return Page(data, page['nextCursor'] as String?);
  }

  /// Live list sorted by activity; updated by events and sync. Loads the list when first listened to.
  Stream<List<ConversationSummary>> watch() => _chat._summaryCtl.stream;
}

class _PresenceWatch {
  final List<String> userIds;
  final controller = StreamController<Presence>();
  _PresenceWatch(this.userIds);
}

/// `chat.presence`.
class PresenceApi {
  final ByoTalkChat _chat;
  PresenceApi._(this._chat);

  /// Online/offline for these users: a snapshot first, then changes. Cancel the subscription to stop
  /// (union of all watches ≤ 200 per connection).
  Stream<Presence> watch(List<String> userIds) {
    final w = _PresenceWatch(userIds.toSet().toList());
    w.controller
      ..onListen = () {
        _chat._presenceWatchers.add(w);
        _chat._rewatchPresence(w);
      }
      ..onCancel = () {
        _chat._presenceWatchers.remove(w);
        _chat._rewatchPresence();
      };
    return w.controller.stream;
  }
}
