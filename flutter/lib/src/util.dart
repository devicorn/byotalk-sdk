// Errors, ids, backoff, token expiry and persistence (mirrors src/core/errors.ts, util.ts, persistence.ts).
import 'dart:convert';
import 'dart:math';

const _retryable = {
  'rate_limited',
  'plan_limit_reached',
  'history_unavailable',
  'storage_unavailable',
  'internal',
  'network',
  'timeout',
  'resync_required',
};

/// Every SDK failure. [code] follows the server catalogue (docs/07 §1.7).
class ChatException implements Exception {
  final String code;
  final String type;
  final String message;
  final String? requestId;
  final int? retryAfterMs;
  final int? status;

  ChatException(this.code, this.message, {String? type, this.requestId, this.retryAfterMs, this.status})
      : type = type ?? (code == 'network' ? 'network' : 'internal');

  bool get retryable => _retryable.contains(code) || (status != null && status! >= 500);

  /// Builds the error from a REST error body `{error: {code, type, message, requestId, retryAfterMs}}`.
  factory ChatException.fromBody(int status, Object? body) {
    final e = body is Map && body['error'] is Map ? body['error'] as Map : const {};
    return ChatException(
      e['code'] as String? ?? (status >= 500 ? 'internal' : 'invalid_request'),
      e['message'] as String? ?? 'Request failed with status $status',
      type: e['type'] as String?,
      requestId: e['requestId'] as String?,
      retryAfterMs: (e['retryAfterMs'] as num?)?.toInt(),
      status: status,
    );
  }

  static ChatException from(Object err) => err is ChatException ? err : ChatException('internal', err.toString());

  @override
  String toString() => 'ChatException($code): $message${requestId != null ? ' [$requestId]' : ''}';
}

final _rng = Random.secure();

/// Random UUID v4 from a cryptographically secure source (used for clientMsgId and Idempotency-Key).
String uuidV4() {
  final b = List<int>.generate(16, (_) => _rng.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// Full-jitter exponential backoff (docs/08 §6): random(0, min(cap, base * 2^attempt)) in ms.
int backoffDelay(int attempt, {int base = 500, int cap = 30000, Random? random}) {
  final ceiling = min(cap, base * pow(2, min(attempt, 30)).toInt());
  return ((random ?? _rng).nextDouble() * ceiling).floor();
}

/// Reads `exp` from a JWT without verifying it (the server verifies). Dev tokens have no expiry.
DateTime? tokenExpiry(String token) {
  final parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    final json = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
    final exp = json is Map ? json['exp'] : null;
    return exp is num ? DateTime.fromMillisecondsSinceEpoch((exp * 1000).toInt()) : null;
  } catch (_) {
    return null;
  }
}

/// Percent-encodes one path segment; rejects ids that would walk the URL ("", ".", "..").
String seg(String v) {
  if (v.isEmpty || v == '.' || v == '..') throw ArgumentError.value(v, 'id', 'Invalid id');
  return Uri.encodeComponent(v);
}

/// Key/value storage for the outbox and sync cursor. Keys are namespaced per environment and user.
abstract interface class Persistence {
  Future<String?> get(String key);
  Future<void> set(String key, String value);
  Future<void> delete(String key);
}

/// Default: nothing survives an app restart (unsent messages are lost when the app is killed).
class MemoryPersistence implements Persistence {
  final _m = <String, String>{};
  @override
  Future<String?> get(String key) async => _m[key];
  @override
  Future<void> set(String key, String value) async => _m[key] = value;
  @override
  Future<void> delete(String key) async => _m.remove(key);
}
