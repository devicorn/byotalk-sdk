import Foundation

struct OutboxEntry: Codable, Sendable {
    let clientMsgId: String
    let cid: String
    let payload: JSON
    /// ms since 1970, same as the TS SDK so persisted outboxes read the same.
    var createdAt: Double
}

private let outboxTTLms: Double = 24 * 3600_000

private struct SendAck: Decodable {
    let id: String
    let seq: Int
    let createdAt: Date
}

/// Pending sends keyed by clientMsgId; flushed after every hello; persisted through the chat's adapter.
@MainActor
final class Outbox {
    private unowned let chat: ByoTalkChat
    private var entries: [String: OutboxEntry] = [:]
    private var waiters: [String: [CheckedContinuation<Message, Error>]] = [:]
    private var failedEntries: [String: OutboxEntry] = [:]
    private var flushing = false
    private var persisting: Task<Void, Never>?

    init(chat: ByoTalkChat) {
        self.chat = chat
    }

    var size: Int { entries.count }

    func enqueue(_ e: OutboxEntry) async throws -> Message {
        entries[e.clientMsgId] = e
        persist()
        return try await wait(e)
    }

    func retry(_ clientMsgId: String) async throws -> Message {
        if var failed = failedEntries.removeValue(forKey: clientMsgId) {
            failed.createdAt = Date().timeIntervalSince1970 * 1000
            entries[clientMsgId] = failed
            persist()
        }
        guard let e = entries[clientMsgId] else {
            throw ChatError(code: "not_found", type: "not_found", message: "Message is not in the outbox")
        }
        return try await wait(e)
    }

    private func wait(_ e: OutboxEntry) async throws -> Message {
        try await withCheckedThrowingContinuation { c in
            waiters[e.clientMsgId, default: []].append(c)
            if chat.transport.isOpen { Task { await sendOne(e) } }
        }
    }

    func flush() async {
        if flushing { return }
        flushing = true
        defer { flushing = false }
        for e in entries.values.sorted(by: { $0.createdAt < $1.createdAt }) {
            if !chat.transport.isOpen { break }
            await sendOne(e)
        }
    }

    private func sendOne(_ e: OutboxEntry) async {
        if Date().timeIntervalSince1970 * 1000 - e.createdAt > outboxTTLms {
            return failed(e, ChatError(code: "expired", type: "invalid_request", message: "Message was not sent within 24 hours"))
        }
        do {
            let ack = try await chat.transport.request("message.send", e.payload).decode(SendAck.self)
            entries[e.clientMsgId] = nil
            persist()
            let conv = chat.cached(e.cid)
            conv?.messages.reconcile(e.clientMsgId, id: ack.id, seq: ack.seq, createdAt: ack.createdAt)
            let msg = conv?.messages.get(ack.id) ?? Message(
                id: ack.id, clientMsgId: e.clientMsgId, conversationId: e.cid, seq: ack.seq, senderId: chat.userId ?? "",
                text: e.payload["text"]?.string, replyTo: e.payload["replyTo"]?.string, attachments: [],
                metadata: e.payload["metadata"]?.object ?? [:], version: 1, status: .sent, createdAt: ack.createdAt)
            for w in waiters.removeValue(forKey: e.clientMsgId) ?? [] { w.resume(returning: msg) }
        } catch {
            let ce = ChatError.from(error)
            // Retryable problems keep the message pending; it is resent after the next hello.
            if ce.retryable {
                if ce.code == "rate_limited", let ms = ce.retryAfterMs {
                    Task {
                        await sleep(ms: ms)
                        if chat.transport.isOpen, entries[e.clientMsgId] != nil { await sendOne(e) }
                    }
                }
                return
            }
            failed(e, ce)
        }
    }

    private func failed(_ e: OutboxEntry, _ err: ChatError) {
        entries[e.clientMsgId] = nil
        persist()
        if let conv = chat.cached(e.cid) {
            conv.messages.markFailed(e.clientMsgId, err)
            if let m = conv.messages.getByClientId(e.clientMsgId) { conv.emitFailed(m) }
        }
        for w in waiters.removeValue(forKey: e.clientMsgId) ?? [] { w.resume(throwing: err) }
        failedEntries[e.clientMsgId] = e // retry() can resend it with the same clientMsgId
    }

    func load() async {
        guard let raw = await chat.persistence.get(chat.key("outbox")),
              let saved = try? JSONDecoder().decode([OutboxEntry].self, from: Data(raw.utf8)) else { return }
        for e in saved where entries[e.clientMsgId] == nil { entries[e.clientMsgId] = e }
    }

    /// Writes are chained so an older snapshot never lands after a newer one.
    private func persist() {
        guard chat.userId != nil, let data = try? JSONEncoder().encode(Array(entries.values)) else { return }
        let key = chat.key("outbox"), value = String(decoding: data, as: UTF8.self), store = chat.persistence
        let previous = persisting
        persisting = Task {
            await previous?.value
            await store.set(key, value)
        }
    }
}

/// Delivered acks batched to at most one frame per second (docs/08 §10).
@MainActor
final class ReceiptBatcher {
    private unowned let chat: ByoTalkChat
    private var pending: [String: Int] = [:]
    private var timer: Task<Void, Never>?

    init(chat: ByoTalkChat) {
        self.chat = chat
    }

    func delivered(_ cid: String, _ seq: Int) {
        pending[cid] = max(pending[cid] ?? 0, seq)
        if timer == nil {
            timer = Task { [weak self] in
                await sleep(ms: 1_000)
                self?.flush()
            }
        }
    }

    func flush() {
        timer?.cancel()
        timer = nil
        guard !pending.isEmpty, chat.transport.isOpen else { return }
        let items = pending.map { JSON.object(["cid": .string($0.key), "seq": .number(Double($0.value))]) }
        pending = [:]
        chat.transport.send("delivered", ["items": .array(items)])
    }
}
