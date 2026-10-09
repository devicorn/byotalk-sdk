// Message window per conversation: confirmed messages ordered by seq, pending sends after them in local
// order; at most 500 kept (mirrors src/core/store.ts).
import 'dart:async';

import 'models.dart';
import 'util.dart';

const _window = 500;

class MessageStore {
  List<Message> _list = [];
  final _changes = StreamController<List<Message>>.broadcast();
  bool _scheduled = false;

  /// Current window (unmodifiable; a new list after every change).
  List<Message> get items => _list;

  /// Emits the new window at most once per microtask (fits StreamBuilder / setState).
  Stream<List<Message>> get changes => _changes.stream;

  void _changed() {
    _list = List.unmodifiable(_list);
    if (_scheduled) return;
    _scheduled = true;
    scheduleMicrotask(() {
      _scheduled = false;
      _changes.add(_list);
    });
  }

  void _sort(List<Message> l) {
    l.sort((a, b) {
      if (a.seq != null && b.seq != null) return a.seq!.compareTo(b.seq!);
      if (a.seq != null) return -1;
      if (b.seq != null) return 1;
      return a.createdAt.compareTo(b.createdAt);
    });
    if (l.length > _window) l.removeRange(0, l.length - _window);
  }

  /// Copies the list, applies [f], sorts, notifies.
  void _edit(void Function(List<Message> l) f, {bool sort = true}) {
    final l = [..._list];
    f(l);
    if (sort) _sort(l);
    _list = l;
    _changed();
  }

  Message? get(String id) => _find((m) => m.id == id);
  Message? getByClientId(String clientMsgId) => _find((m) => m.clientMsgId == clientMsgId);
  Message? _find(bool Function(Message) t) {
    for (final m in _list) {
      if (t(m)) return m;
    }
    return null;
  }

  /// Inserts or replaces confirmed messages; an older version never replaces a newer one.
  void upsertMany(Iterable<Message> ms) => _edit((l) {
        for (final m in ms) {
          final i = l.indexWhere((x) => x.id != null && x.id == m.id);
          if (i < 0) {
            l.add(m);
          } else if (l[i].version <= m.version) {
            l[i] = m.copyWith(clientMsgId: l[i].clientMsgId ?? m.clientMsgId);
          }
        }
      });

  void upsert(Message m) => upsertMany([m]);

  void addPending(Message m) => _edit((l) => l.add(m));

  /// Ack: the pending message gets its id/seq/server time and moves to its seq position.
  void reconcile(String clientMsgId, {required String id, required int seq, required String createdAt}) {
    final i = _list.indexWhere((m) => m.clientMsgId == clientMsgId && m.id == null);
    if (i < 0) return;
    _edit((l) {
      final dupe = l.indexWhere((m) => m.id == id);
      if (dupe >= 0) {
        // The live event arrived before the ack: keep the confirmed copy, mark it as ours.
        l[dupe] = l[dupe].copyWith(clientMsgId: clientMsgId);
        l.removeAt(i);
      } else {
        l[i] = l[i].copyWith(id: id, seq: seq, createdAt: createdAt, status: MessageStatus.sent, error: null);
      }
    });
  }

  void _patchPending(String clientMsgId, Message Function(Message) f) {
    final i = _list.indexWhere((m) => m.clientMsgId == clientMsgId && m.id == null);
    if (i >= 0) _edit((l) => l[i] = f(l[i]), sort: false);
  }

  void markFailed(String clientMsgId, ChatException error) =>
      _patchPending(clientMsgId, (m) => m.copyWith(status: MessageStatus.failed, error: error));

  void markSending(String clientMsgId) =>
      _patchPending(clientMsgId, (m) => m.copyWith(status: MessageStatus.sending, error: null));

  /// Optimistic edit/delete; returns an undo function (null if the message is not loaded).
  void Function()? patch(String id, Message Function(Message) f) {
    final i = _list.indexWhere((m) => m.id == id);
    if (i < 0) return null;
    final before = _list[i];
    _edit((l) => l[i] = f(before), sort: false);
    return () {
      final j = _list.indexWhere((m) => m.id == id);
      if (j >= 0) _edit((l) => l[j] = before, sort: false);
    };
  }

  /// Drops confirmed messages, keeps unsent ones (resync).
  void clear() => _edit((l) => l.removeWhere((m) => m.id != null), sort: false);

  int? get oldestSeq => _find((m) => m.seq != null)?.seq;
}
