import 'dart:math';

import 'package:byotalk/byotalk.dart';
import 'package:byotalk/src/util.dart' show tokenExpiry;
import 'package:test/test.dart';

Message confirmed(String id, int seq, {int version = 1, String? text}) => Message(
    id: id,
    clientMsgId: null,
    conversationId: 'c',
    seq: seq,
    senderId: 'u',
    text: text ?? id,
    version: version,
    createdAt: '2026-01-01T00:00:0${seq % 10}Z');

Message pending(String cmid, String at) => Message(
    id: null,
    clientMsgId: cmid,
    conversationId: 'c',
    seq: null,
    senderId: 'me',
    text: cmid,
    status: MessageStatus.sending,
    createdAt: at);

void main() {
  group('MessageStore', () {
    test('orders by seq, pending after confirmed in local order', () {
      final s = MessageStore()
        ..addPending(pending('p2', '2026-01-01T00:00:02Z'))
        ..upsertMany([confirmed('m3', 3), confirmed('m1', 1)])
        ..addPending(pending('p1', '2026-01-01T00:00:01Z'))
        ..upsert(confirmed('m2', 2));
      expect(s.items.map((m) => m.text), ['m1', 'm2', 'm3', 'p1', 'p2']);
      expect(s.oldestSeq, 1);
    });

    test('dedupes by id and never downgrades a version', () {
      final s = MessageStore()
        ..upsert(confirmed('m1', 1, version: 2, text: 'new'))
        ..upsert(confirmed('m1', 1, version: 1, text: 'old'))
        ..upsertMany([confirmed('m1', 1, version: 2, text: 'new')]);
      expect(s.items, hasLength(1));
      expect(s.items.single.text, 'new');
    });

    test('ack moves a pending message to its seq; event-before-ack keeps one copy', () {
      final s = MessageStore()
        ..upsert(confirmed('m1', 1))
        ..addPending(pending('a', '2026-01-01T00:00:05Z'))
        ..addPending(pending('b', '2026-01-01T00:00:06Z'))
        ..upsert(confirmed('m3', 3));
      s.reconcile('a', id: 'm2', seq: 2, createdAt: '2026-01-01T00:00:02Z');
      expect(s.items.map((m) => m.id), ['m1', 'm2', 'm3', null]);
      expect(s.get('m2')!.status, MessageStatus.sent);
      s.upsert(confirmed('m4', 4)); // live event for "b" arrives first
      s.reconcile('b', id: 'm4', seq: 4, createdAt: '2026-01-01T00:00:04Z');
      expect(s.items.map((m) => m.id), ['m1', 'm2', 'm3', 'm4']);
      expect(s.get('m4')!.clientMsgId, 'b');
    });

    test('patch returns undo; clear keeps unsent; changes are batched', () async {
      final s = MessageStore();
      final emitted = <List<Message>>[];
      s.changes.listen(emitted.add);
      s.upsertMany([confirmed('m1', 1), confirmed('m2', 2)]);
      s.addPending(pending('p', '2026-01-01T00:00:09Z'));
      final undo = s.patch('m1', (m) => m.copyWith(text: null, deletedAt: 'now'))!;
      expect(s.get('m1')!.text, isNull);
      undo();
      expect(s.get('m1')!.text, 'm1');
      await Future<void>.delayed(Duration.zero);
      expect(emitted, hasLength(1));
      s.clear();
      expect(s.items.map((m) => m.clientMsgId), ['p']);
    });

    test('keeps at most 500 messages', () {
      final s = MessageStore()..upsertMany([for (var i = 1; i <= 520; i++) confirmed('m$i', i)]);
      expect(s.items, hasLength(500));
      expect(s.oldestSeq, 21);
    });
  });

  test('backoff is full jitter, doubling, capped at 30 s', () {
    expect(backoffDelay(0, random: _Fixed(0.999)), 499);
    expect(backoffDelay(3, random: _Fixed(0.999)), 3996);
    expect(backoffDelay(10, random: _Fixed(0.999)), 29970);
    expect(backoffDelay(1000, random: _Fixed(0.999)), 29970);
    expect(backoffDelay(5, random: _Fixed(0)), 0);
    for (var a = 0; a < 20; a++) {
      expect(backoffDelay(a), inInclusiveRange(0, min(30000, 500 * pow(2, a))));
    }
  });

  test('uuidV4 has the v4 format and does not repeat', () {
    final re = RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
    final ids = {for (var i = 0; i < 1000; i++) uuidV4()};
    expect(ids, hasLength(1000));
    expect(ids.every(re.hasMatch), isTrue);
  });

  test('tokenExpiry reads JWT exp; dev tokens have none', () {
    // {"exp":2000000000}
    expect(tokenExpiry('h.eyJleHAiOjIwMDAwMDAwMDB9.s')!.millisecondsSinceEpoch, 2000000000000);
    expect(tokenExpiry('dev:alice'), isNull);
  });

  test('refuses secret keys and bad token types', () {
    expect(() => ByoTalkChat(env: 'env_1', token: 'sk_live_x'), throwsA(isA<ChatException>()));
    expect(() => ByoTalkChat(env: 'env_1', token: 42), throwsA(isA<ChatException>()));
    expect(ByoTalkChat(env: 'env_1', token: () async => 't').userId, isNull);
    expect(ByoTalkChat(env: 'env_1', token: ByoTalkChat.devToken('alice')).userId, 'alice');
  });
}

class _Fixed implements Random {
  final double v;
  _Fixed(this.v);
  @override
  double nextDouble() => v;
  @override
  int nextInt(int max) => 0;
  @override
  bool nextBool() => false;
}
