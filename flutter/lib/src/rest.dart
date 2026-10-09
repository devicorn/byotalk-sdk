// Token cache + provider calls (auth.ts) and the REST client with Request-Id capture, idempotency keys and
// bounded retries for 5xx/429/network (rest.ts).
import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'util.dart';

typedef TokenProvider = Future<String> Function();

class AuthManager {
  final TokenProvider? _provider;
  String? _token;
  DateTime? _expiresAt;
  Future<String>? _inflight;

  /// [source] is a token String or a [TokenProvider].
  AuthManager(Object source) : _provider = source is TokenProvider ? source : null {
    if (source is String) {
      _set(source);
    } else if (source is! TokenProvider) {
      throw ChatException('invalid_request', 'token must be a String or Future<String> Function()',
          type: 'invalid_request');
    }
  }

  bool get canRefresh => _provider != null;

  void _set(String t) {
    _token = t;
    _expiresAt = tokenExpiry(t);
  }

  /// A token valid for at least 60 s more (refreshing through the provider when needed).
  Future<String> get() async {
    final t = _token;
    if (t != null && (_expiresAt == null || _expiresAt!.difference(DateTime.now()) > const Duration(seconds: 60))) {
      return t;
    }
    if (!canRefresh) {
      if (t != null) return t; // static token: let the server answer token_expired
      throw ChatException('token_invalid', 'No token', type: 'authentication');
    }
    return refresh();
  }

  /// Calls the provider once even if many callers ask at the same time.
  Future<String> refresh() {
    if (!canRefresh) {
      return Future.error(
          ChatException('token_expired', 'Token expired and no token provider was given', type: 'authentication'));
    }
    return _inflight ??= () async {
      try {
        final t = await _provider!();
        if (t.isEmpty) throw ChatException('token_invalid', 'Token provider returned no token', type: 'authentication');
        _set(t);
        return t;
      } finally {
        _inflight = null;
      }
    }();
  }
}

class RestClient {
  final String baseUrl;
  final String env;
  final AuthManager auth;
  final http.Client _http;

  RestClient(String baseUrl, this.env, this.auth, [http.Client? client])
      : baseUrl = baseUrl.replaceAll(RegExp(r'/$'), ''),
        _http = client ?? http.Client();

  Future<dynamic> request(String method, String path,
      {Object? body, Map<String, Object?> query = const {}, bool idempotent = false}) async {
    final uri = Uri.parse(baseUrl + path).replace(queryParameters: {
      'env': env,
      for (final e in query.entries)
        if (e.value != null) e.key: '${e.value}',
    });
    final retrySafe = method == 'GET' || idempotent;
    final idemKey = idempotent && method != 'GET' ? uuidV4() : null;
    var refreshed = false;

    for (var attempt = 0;; attempt++) {
      final token = await auth.get();
      final req = http.Request(method, uri)
        ..headers.addAll({
          'authorization': 'Bearer $token',
          'byotalk-env': env,
          if (body != null) 'content-type': 'application/json',
          if (idemKey != null) 'idempotency-key': idemKey,
        });
      if (body != null) req.body = jsonEncode(body);
      http.Response res;
      try {
        res = await http.Response.fromStream(await _http.send(req).timeout(const Duration(seconds: 30)));
      } catch (_) {
        if (retrySafe && attempt < 3) {
          await _sleep(backoffDelay(attempt, base: 300, cap: 5000));
          continue;
        }
        throw ChatException('network', 'Network request failed', type: 'network');
      }
      final parsed = res.body.isEmpty ? null : _safeJson(res.body);
      if (res.statusCode >= 200 && res.statusCode < 300) return parsed;
      final err = ChatException.fromBody(res.statusCode, parsed);
      if (err.code == 'token_expired' && !refreshed && auth.canRefresh) {
        refreshed = true;
        await auth.refresh();
        attempt--;
        continue;
      }
      if (retrySafe && attempt < 3 && (res.statusCode >= 500 || res.statusCode == 429)) {
        await _sleep(err.retryAfterMs ?? backoffDelay(attempt, base: 300, cap: 5000));
        continue;
      }
      throw err;
    }
  }

  void close() => _http.close();
}

Future<void> _sleep(int ms) => Future.delayed(Duration(milliseconds: ms));

Object? _safeJson(String text) {
  try {
    return jsonDecode(text);
  } catch (_) {
    return {
      'error': {'code': 'internal', 'message': text.length > 200 ? text.substring(0, 200) : text}
    };
  }
}
