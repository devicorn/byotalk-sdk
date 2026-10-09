// Against a running byotalk-server (BYOTALK_API_URL / BYOTALK_RT_URL); skipped when the API is unreachable.
@Timeout(Duration(minutes: 2))
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:byotalk/byotalk.dart';
import 'package:http/http.dart' as http;
import 'package:test/test.dart';

final api = Platform.environment['BYOTALK_API_URL'] ?? 'http://localhost:3100';
final rt = Platform.environment['BYOTALK_RT_URL'] ?? 'ws://localhost:3001';

Future<Map<String, dynamic>> _json(Future<http.Response> f) async {
  final r = await f;
  if (r.statusCode >= 300) throw StateError('${r.request?.url} ${r.statusCode} ${r.body}');
  return jsonDecode(r.body) as Map<String, dynamic>;
}

/// Fresh org + project through the dashboard sign-in flow (dev magic link); returns the development env id.
Future<String> createDevEnv() async {
  // An existing development environment with dev tokens (e.g. on a deployment that never returns devLink).
  final given = Platform.environment['BYOTALK_ENV'];
  if (given != null && given.isNotEmpty) return given;
  const jsonH = {'content-type': 'application/json'};
  final email = 'dart-${DateTime.now().millisecondsSinceEpoch}@example.com';
  final link =
      await _json(http.post(Uri.parse('$api/v1/auth/magic-link'), headers: jsonH, body: jsonEncode({'email': email})));
  final token = Uri.parse(link['devLink'] as String).queryParameters['token'];
  final verify = await http.post(Uri.parse('$api/v1/auth/verify'), headers: jsonH, body: jsonEncode({'token': token}));
  final cookie = verify.headers['set-cookie']!.split(';').first;
  final h = {'cookie': cookie, 'x-byotalk-dashboard': '1', ...jsonH};
  final me = await _json(http.get(Uri.parse('$api/v1/auth/me'), headers: h));
  final orgId = (me['orgs'] as List).first['id'];
  final project = await _json(http.post(Uri.parse('$api/v1/dashboard/orgs/$orgId/projects'),
      headers: h, body: jsonEncode({'name': 'Dart SDK tests'})));
  return (project['environments'] as List).firstWhere((e) => e['kind'] == 'development')['id'] as String;
}

Future<bool> reachable() async {
  try {
    await http.get(Uri.parse('$api/v1/health')).timeout(const Duration(seconds: 3));
    return true;
  } catch (_) {
    return false;
  }
}

Future<T> waitFor<T>(T? Function() fn, {Duration timeout = const Duration(seconds: 8)}) async {
  final end = DateTime.now().add(timeout);
  while (true) {
    final v = fn();
    if (v != null && v != false) return v;
    if (DateTime.now().isAfter(end)) throw TimeoutException('waitFor');
    await Future<void>.delayed(const Duration(milliseconds: 25));
  }
}

Future<void> main() async {
  final up = await reachable();
  late String env;
  final chats = <ByoTalkChat>[];
  // Unique per run: with BYOTALK_ENV several runs (and SDKs) share one environment and must not see each other's chats.
  final run = uuidV4().substring(0, 8);
  final idA = 'alice-$run', idB = 'bob-$run';

  ByoTalkChat chat(String user) {
    final c = ByoTalkChat(env: env, token: ByoTalkChat.devToken(user), baseUrl: api, realtimeUrl: rt);
    chats.add(c);
    return c;
  }

  List<String?> texts(Conversation c) => c.messages.items.map((m) => m.text).toList();

  group('against $api', skip: up ? false : 'server not reachable at $api', () {
    setUpAll(() async {
      // The local server may be restarting: retry setup a few times.
      for (var i = 0;; i++) {
        try {
          env = await createDevEnv();
          return;
        } catch (_) {
          if (i == 4) rethrow;
          await Future<void>.delayed(const Duration(seconds: 2));
        }
      }
    });
    tearDownAll(() => Future.wait(chats.map((c) => c.disconnect())));

    test('direct message, read receipt, typing, offline catch-up', () async {
      final alice = chat(idA), bob = chat(idB);
      final states = <ChatConnectionState>[];
      alice.connectionStates.listen(states.add);
      await Future.wait([alice.connect(), bob.connect()]);
      expect(alice.connectionState, ChatConnectionState.connected);
      expect(
          states,
          containsAllInOrder(
              [ChatConnectionState.connecting, ChatConnectionState.syncing, ChatConnectionState.connected]));

      final dm = await alice.conversations.direct(idB);
      final bobDm = await bob.conversations.direct(idA);
      expect(bobDm.id, dm.id);
      final bobEvents = <ConversationEvent>[];
      bobDm.events.listen(bobEvents.add);
      final aliceEvents = <ConversationEvent>[];
      dm.events.listen(aliceEvents.add);

      // Message alice → bob.
      final sent = await dm.send(text: 'Hello Bob');
      expect(sent.status, MessageStatus.sent);
      expect(sent.senderId, idA);
      expect(sent.seq, greaterThan(0));
      expect(sent.clientMsgId, matches(RegExp(r'^[0-9a-f-]{36}$')));
      await waitFor(() => bobEvents.whereType<MessageNew>().any((e) => e.message.id == sent.id));
      expect(texts(bobDm), contains('Hello Bob'));

      // Read receipt reaches alice.
      await bobDm.markRead();
      await waitFor(
          () => aliceEvents.whereType<ReceiptUpdated>().any((r) => r.userId == idB && r.lastReadSeq >= sent.seq!));
      expect(dm.readBy(sent.seq!), contains(idB));

      // Typing reaches bob.
      dm.typing();
      await waitFor(() => bobEvents.whereType<TypingChanged>().any((t) => t.userIds.contains(idA)));
      expect(bobDm.typingUserIds, [idA]);

      // Bob goes offline; alice sends; bob catches up on reconnect.
      await bob.disconnect();
      expect(bob.connectionState, ChatConnectionState.disconnected);
      for (final t in ['missed 1', 'missed 2']) {
        await dm.send(text: t);
      }
      await bob.connect();
      await waitFor(() => ['missed 1', 'missed 2'].every(texts(bobDm).contains));
      final seqs = bobDm.messages.items.map((m) => m.seq!).toList();
      expect(seqs, [...seqs]..sort());
    });

    test('a send made while disconnected flushes once after reconnect', () async {
      final alice = chat(idA), bob = chat(idB);
      await Future.wait([alice.connect(), bob.connect()]);
      final dm = await alice.conversations.direct(idB);
      final bobDm = await bob.conversations.direct(idA);
      await alice.disconnect();
      final p = dm.send(text: 'queued while offline');
      expect(dm.messages.items.last.status, MessageStatus.sending);
      final cmid = dm.messages.items.last.clientMsgId;
      await alice.connect();
      final m = await p;
      expect(m.clientMsgId, cmid);
      await waitFor(() => texts(bobDm).contains('queued while offline'));
      await Future<void>.delayed(const Duration(milliseconds: 300));
      expect(texts(bobDm).where((t) => t == 'queued while offline'), hasLength(1));
    });

    test('edit, delete, conversation.updated, summaries', () async {
      final alice = chat(idA), bob = chat(idB);
      await Future.wait([alice.connect(), bob.connect()]);
      final group = await alice.conversations.create(members: [idB], name: 'Team');
      final bobGroup = await bob.conversations.get(group.id);
      final m = await group.send(text: 'typo');
      await waitFor(() => bobGroup.messages.get(m.id!));
      await group.edit(m.id!, text: 'fixed');
      await waitFor(() => bobGroup.messages.get(m.id!)?.text == 'fixed');
      await group.delete(m.id!);
      await waitFor(() => bobGroup.messages.get(m.id!)?.deletedAt != null);

      final summaries = <List<ConversationSummary>>[];
      final sub = bob.conversations.watch().listen(summaries.add);
      await group.update(name: 'Team 2', metadata: {'topic': 'dart'});
      await waitFor(() => bobGroup.name == 'Team 2');
      expect(bobGroup.metadata, {'topic': 'dart'});
      await waitFor(() => summaries.isNotEmpty && summaries.last.any((s) => s.id == group.id && s.name == 'Team 2'));
      await sub.cancel();

      final page = await bob.conversations.list(limit: 10);
      expect(page.data.map((s) => s.id), contains(group.id));
    });

    test('presence of a watched user', () async {
      final alice = chat(idA), carol = chat('carol');
      await Future.wait([alice.connect(), carol.connect()]);
      await alice.conversations.direct('carol');
      final seen = <Presence>[];
      final sub = alice.presence.watch(['carol']).listen(seen.add);
      await waitFor(() => seen.any((p) => p.userId == 'carol' && p.online));
      await carol.disconnect();
      await waitFor(() => seen.any((p) => p.userId == 'carol' && !p.online));
      await sub.cancel();
    });
  });
}
