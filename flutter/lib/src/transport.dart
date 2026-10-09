// WebSocket lifecycle for chat.v1: auth-first, request/ack correlation, heartbeats, reconnect with
// full-jitter backoff, close-code handling (docs/08 §1, §4–6; mirrors src/core/transport.ts).
import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'models.dart';
import 'rest.dart';
import 'util.dart';

typedef Frame = Map<String, dynamic>;

/// Opens a socket; injectable for tests.
typedef SocketConnector = WebSocketChannel Function(Uri uri, Iterable<String> protocols);

WebSocketChannel _defaultConnector(Uri uri, Iterable<String> protocols) =>
    WebSocketChannel.connect(uri, protocols: protocols);

const _liveness = Duration(seconds: 60);

class Transport {
  final String realtimeUrl;
  final String env;
  final String sdk;
  final AuthManager auth;
  final SocketConnector connector;

  // Set by ByoTalkChat.
  void Function(ChatConnectionState s) onState = (_) {};
  void Function() onHello = () {};
  void Function(Frame f) onFrame = (_) {};
  void Function(ChatException e) onError = (_) {};

  ChatConnectionState state = ChatConnectionState.disconnected;
  Frame? hello;
  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  bool _wanted = false;
  int _attempt = 0;
  // Backoff restarts only after a connection that stayed up: a server that says hello and closes at once
  // must not get an instant reconnect loop.
  DateTime? _helloAt;
  int _reqId = 0;
  final _pending = <String, (Completer<dynamic>, Timer)>{};
  Timer? _reconnectTimer;
  Timer? _livenessTimer;
  DateTime _lastFrameAt = DateTime.now();
  bool _authRefreshed = false;

  Transport({
    required this.realtimeUrl,
    required this.env,
    required this.sdk,
    required this.auth,
    SocketConnector? connector,
  }) : connector = connector ?? _defaultConnector;

  void setState(ChatConnectionState s) {
    if (state == s) return;
    state = s;
    onState(s);
  }

  bool get isOpen => _ch != null && hello != null;

  void start() {
    if (_wanted) return;
    _wanted = true;
    _attempt = 0;
    _open();
  }

  /// Normal close (1000); no reconnect.
  void stop() {
    _wanted = false;
    _clearTimers();
    final ch = _ch;
    _dropSocket(ChatException('network', 'Disconnected', type: 'network'));
    ch?.sink.close(1000, 'client disconnect');
    setState(ChatConnectionState.disconnected);
  }

  /// Reconnect now (app foreground, network back): resets backoff.
  void reconnectNow() {
    if (!_wanted || state == ChatConnectionState.failed) return;
    if (state == ChatConnectionState.connected ||
        state == ChatConnectionState.syncing ||
        state == ChatConnectionState.connecting) {
      return;
    }
    _attempt = 0;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _open();
  }

  /// Sends a request frame and completes with the ack's `d` (or a [ChatException]).
  Future<dynamic> request(String t, Object? d, {Duration timeout = const Duration(seconds: 5)}) {
    if (!isOpen) return Future.error(ChatException('network', 'Not connected', type: 'network'));
    final id = '${++_reqId}';
    final c = Completer<dynamic>();
    final timer = Timer(timeout, () {
      if (_pending.remove(id) != null) c.completeError(ChatException('timeout', '$t timed out', type: 'network'));
    });
    _pending[id] = (c, timer);
    _ch!.sink.add(jsonEncode({'t': t, 'id': id, 'd': d}));
    return c.future;
  }

  /// Fire-and-forget frame (typing, delivered, hb); dropped when not connected.
  void send(String t, Object? d) {
    if (isOpen) _ch!.sink.add(jsonEncode({'t': t, 'd': d}));
  }

  Future<void> _open() async {
    if (!_wanted) return;
    setState(_attempt == 0 && state != ChatConnectionState.reconnecting
        ? ChatConnectionState.connecting
        : ChatConnectionState.reconnecting);
    String token;
    try {
      token = await auth.get();
    } catch (err) {
      return _fail(err is ChatException ? err : ChatException('token_invalid', '$err', type: 'authentication'));
    }
    if (!_wanted) return;
    final base = realtimeUrl.replaceAll(RegExp(r'/$'), '');
    final uri = Uri.parse('$base/v1').replace(queryParameters: {'env': env, 'sdk': sdk});
    final WebSocketChannel ch;
    try {
      ch = connector(uri, const ['chat.v1']);
    } catch (_) {
      return _scheduleReconnect();
    }
    _ch = ch;
    hello = null;
    _sub = ch.stream.listen(
      (data) {
        if (_ch != ch) return;
        _lastFrameAt = DateTime.now();
        Object? f;
        try {
          f = jsonDecode(data is String ? data : utf8.decode(data as List<int>));
        } catch (_) {
          return;
        }
        if (f is Map<String, dynamic>) _onFrame(f);
      },
      onError: (_) {},
      onDone: () {
        if (_ch == ch) _onClose(ch.closeCode ?? 1006, ch.closeReason ?? '');
      },
    );
    try {
      await ch.ready;
    } catch (_) {
      if (_ch == ch) {
        _dropSocket(ChatException('network', 'Connection lost', type: 'network'));
        _scheduleReconnect();
      }
      return;
    }
    if (_ch != ch) return;
    _lastFrameAt = DateTime.now();
    ch.sink.add(jsonEncode({
      't': 'auth',
      'd': {'token': token}
    }));
    _startLiveness();
  }

  void _onFrame(Frame f) {
    switch (f['t']) {
      case 'hello':
        hello = Frame.from(f['d'] as Map);
        _helloAt = DateTime.now();
        _authRefreshed = false;
        onHello();
      case 'ack' || 'error':
        final p = _pending.remove(f['re']);
        if (p != null) {
          p.$2.cancel();
          if (f['t'] == 'ack') {
            p.$1.complete(f['d']);
          } else {
            p.$1.completeError(ChatException(
                f['code'] as String? ?? 'internal', f['message'] as String? ?? 'Request failed',
                retryAfterMs: (f['retryAfterMs'] as num?)?.toInt()));
          }
        } else if (f['t'] == 'error') {
          onError(ChatException(f['code'] as String? ?? 'internal', f['message'] as String? ?? 'Server error'));
        }
      case 'hb':
        send('hb', {});
      case 'goaway':
        final ch = _ch;
        _dropSocket(ChatException('network', 'Connection lost', type: 'network'));
        ch?.sink.close(1000, 'goaway');
        _scheduleReconnect(((f['d'] as Map?)?['reconnectAfterMs'] as num?)?.toInt() ?? 0);
      case 'token_expiring':
        _refreshToken();
      default:
        onFrame(f);
    }
  }

  Future<void> _refreshToken() async {
    if (!auth.canRefresh) return;
    try {
      final token = await auth.refresh();
      await request('token.refresh', {'token': token});
    } catch (err) {
      onError(ChatException.from(err));
    }
  }

  void _onClose(int code, String reason) {
    _dropSocket(ChatException('network', 'Connection lost', type: 'network'));
    if (!_wanted) return;
    Map info = const {};
    try {
      if (reason.isNotEmpty) info = jsonDecode(reason) as Map;
    } catch (_) {
      info = {'message': reason};
    }
    ChatException err(String c, String type) => ChatException(
          info['code'] as String? ?? c,
          info['message'] as String? ?? 'Connection closed ($code)',
          type: type,
          retryAfterMs: (info['retryAfterMs'] as num?)?.toInt(),
        );
    switch (code) {
      case 4001:
        // Token problem: refresh once through the provider, else give up.
        if (auth.canRefresh && !_authRefreshed) {
          _authRefreshed = true;
          auth.refresh().then((_) => _scheduleReconnect(0),
              onError: (Object e) => _fail(e is ChatException ? e : err('token_invalid', 'authentication')));
          return;
        }
        return _fail(err('token_invalid', 'authentication'));
      case 4003:
        return _fail(err('forbidden', 'permission'));
      case 4009:
        return _fail(err('too_many_connections', 'rate_limited'));
      case 4008:
        return _scheduleReconnect((info['retryAfterMs'] as num?)?.toInt() ?? backoffDelay(_attempt++));
      case 1009:
        onError(err('body_too_large', 'payload_too_large'));
        return _scheduleReconnect();
      case 1012:
        return _scheduleReconnect(Random().nextInt(5000));
      default:
        return _scheduleReconnect();
    }
  }

  void _dropSocket(ChatException reason) {
    _ch = null;
    hello = null;
    _sub?.cancel();
    _sub = null;
    _livenessTimer?.cancel();
    _livenessTimer = null;
    for (final p in _pending.values) {
      p.$2.cancel();
      p.$1.completeError(reason);
    }
    _pending.clear();
  }

  void _scheduleReconnect([int? delayMs]) {
    if (!_wanted) return;
    setState(ChatConnectionState.reconnecting);
    if (_helloAt != null && DateTime.now().difference(_helloAt!) > const Duration(seconds: 30)) _attempt = 0;
    _helloAt = null;
    final ms = delayMs ?? backoffDelay(_attempt++);
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(milliseconds: ms), () {
      _reconnectTimer = null;
      _open();
    });
  }

  void _fail(ChatException err) {
    _wanted = false;
    _clearTimers();
    setState(ChatConnectionState.failed);
    onError(err);
  }

  void _startLiveness() {
    _livenessTimer?.cancel();
    _livenessTimer = Timer.periodic(const Duration(seconds: 5), (_) {
      final ch = _ch;
      if (ch != null && DateTime.now().difference(_lastFrameAt) > _liveness) {
        _dropSocket(ChatException('network', 'Connection lost', type: 'network'));
        ch.sink.close(4000, 'liveness timeout');
        _scheduleReconnect();
      }
    });
  }

  void _clearTimers() {
    _reconnectTimer?.cancel();
    _livenessTimer?.cancel();
    _reconnectTimer = null;
    _livenessTimer = null;
  }
}
