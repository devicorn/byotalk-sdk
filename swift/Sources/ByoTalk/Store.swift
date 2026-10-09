import Foundation

// Message window per conversation: confirmed messages ordered by seq, pending sends after them in local
// order; at most 500 messages kept (docs/09-SDK-DESIGN.md §4.3).

private let window = 500

@MainActor
public final class MessageStore {
    public private(set) var items: [Message] = []
    private let changes = Broadcaster<[Message]>()

    /// Current list now, then the new list after every change (only the latest is buffered: slow readers skip frames).
    public func updates() -> AsyncStream<[Message]> {
        changes.stream(.bufferingNewest(1), initial: items)
    }

    private func changed() {
        changes.yield(items)
    }

    private func sort() {
        items.sort { a, b in
            switch (a.seq, b.seq) {
            case let (x?, y?): return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            case (nil, nil): return a.createdAt < b.createdAt
            }
        }
        if items.count > window { items.removeFirst(items.count - window) }
    }

    public func get(_ id: String) -> Message? {
        items.first { $0.id == id }
    }

    public func getByClientId(_ clientMsgId: String) -> Message? {
        items.first { $0.clientMsgId == clientMsgId }
    }

    /// Inserts or replaces a confirmed message; an older version never replaces a newer one.
    func upsert(_ m: Message) {
        merge(m)
        sort()
        changed()
    }

    func upsertMany(_ ms: [Message]) {
        for m in ms { merge(m) }
        sort()
        changed()
    }

    private func merge(_ m: Message) {
        guard let i = items.firstIndex(where: { $0.id != nil && $0.id == m.id }) else { return items.append(m) }
        guard items[i].version <= m.version else { return }
        var next = m
        next.clientMsgId = items[i].clientMsgId ?? m.clientMsgId
        items[i] = next
    }

    func addPending(_ m: Message) {
        items.append(m)
        sort()
        changed()
    }

    /// Ack: the pending message gets its id/seq/server time and moves to its seq position.
    func reconcile(_ clientMsgId: String, id: String, seq: Int, createdAt: Date) {
        guard let i = items.firstIndex(where: { $0.clientMsgId == clientMsgId && $0.id == nil }) else { return }
        if let dupe = items.firstIndex(where: { $0.id == id }) {
            // The live event arrived before the ack: keep the confirmed copy, mark it as ours.
            items[dupe].clientMsgId = clientMsgId
            items.remove(at: i)
        } else {
            items[i].id = id
            items[i].seq = seq
            items[i].createdAt = createdAt
            items[i].status = .sent
            items[i].error = nil
        }
        sort()
        changed()
    }

    func markFailed(_ clientMsgId: String, _ error: ChatError) {
        setPending(clientMsgId) { $0.status = .failed; $0.error = error }
    }

    func markSending(_ clientMsgId: String) {
        setPending(clientMsgId) { $0.status = .sending; $0.error = nil }
    }

    private func setPending(_ clientMsgId: String, _ change: (inout Message) -> Void) {
        guard let i = items.firstIndex(where: { $0.clientMsgId == clientMsgId && $0.id == nil }) else { return }
        change(&items[i])
        changed()
    }

    /// Optimistic edit/delete: returns an undo function.
    func patch(_ id: String, _ change: (inout Message) -> Void) -> (() -> Void)? {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return nil }
        let before = items[i]
        change(&items[i])
        changed()
        return { [weak self] in
            guard let self, let j = self.items.firstIndex(where: { $0.id == id }) else { return }
            self.items[j] = before
            self.changed()
        }
    }

    func clear() {
        items.removeAll { $0.id != nil } // keep unsent messages
        changed()
    }

    var oldestSeq: Int? {
        items.first { $0.seq != nil }?.seq
    }
}
