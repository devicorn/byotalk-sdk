import Foundation

// One conversation: message window, gapless event application, receipts, typing (docs/09 §3–4, docs/08 §7).

private let typingExpiryMs = 6_000
private let typingThrottle: TimeInterval = 3

private struct MessagePage: Decodable {
    let data: [Message]
    let hasMore: Bool
}

@MainActor
public final class Conversation {
    public let id: String
    /// "direct" or "group"
    public let type: String
    public internal(set) var name: String?
    public internal(set) var metadata: Json
    public internal(set) var members: [Member]
    public internal(set) var unreadCount = 0
    public internal(set) var muted: Bool
    /// Last contiguous event applied.
    public internal(set) var lastSeq: Int
    public internal(set) var removed = false
    /// True while the server has messages older than the oldest one loaded; loadOlder() pages through them.
    public internal(set) var hasOlder = false
    public let messages = MessageStore()

    // Conversations live only as long as their chat; the chat owns them.
    private unowned let chat: ByoTalkChat
    private let emitter = Broadcaster<ConversationEvent>()
    private var typingUsers: [String: Task<Void, Never>] = [:]
    private var lastTypingSent: Date?
    private var held: [(seq: Int, e: String, d: JSON)] = []
    private var catchingUp: Task<Void, Error>?
    private var gapFailures = 0

    init(chat: ByoTalkChat, _ c: ServerConversation) {
        self.chat = chat
        id = c.id
        type = c.type
        name = c.name
        metadata = c.metadata ?? [:]
        members = c.members ?? []
        lastSeq = c.lastSeq
        muted = c.muted ?? false
    }

    /// Live events for this conversation; end the loop (or cancel its task) to stop listening.
    public func events() -> AsyncStream<ConversationEvent> {
        emitter.stream()
    }

    private var base: String { "/v1/conversations/\((try? seg(id)) ?? "_")" }

    // MARK: loading

    /// Loads the latest page (called once when the conversation object is created).
    @discardableResult
    public func loadLatest(limit: Int = 50) async throws -> Bool {
        let page: MessagePage = try await chat.rest.request("GET", "\(base)/messages", query: ["limit": String(limit)])
        messages.upsertMany(page.data)
        hasOlder = page.hasMore
        return page.hasMore
    }

    /// Older page before the oldest loaded message. Throws a ChatError with `isHistoryUnavailable` when the customer DB is down.
    public func loadOlder(limit: Int = 50) async throws -> (messages: [Message], hasMore: Bool) {
        guard let before = messages.oldestSeq, before > 1 else {
            hasOlder = false
            return ([], false)
        }
        let page: MessagePage = try await chat.rest.request("GET", "\(base)/messages", query: ["before": String(before), "limit": String(limit)])
        messages.upsertMany(page.data)
        hasOlder = page.hasMore
        return (page.data, page.hasMore)
    }

    // MARK: sending

    /// Returns on ack. Network problems do not throw: the message stays pending and is resent after reconnect.
    @discardableResult
    public func send(text: String? = nil, replyTo: String? = nil, attachments: [String] = [], metadata: Json? = nil) async throws -> Message {
        let clientMsgId = UUID().uuidString.lowercased()
        let pending = Message(id: nil, clientMsgId: clientMsgId, conversationId: id, seq: nil, senderId: chat.userId ?? "", text: text, replyTo: replyTo,
                              attachments: [], metadata: metadata ?? [:], version: 1, status: .sending, createdAt: Date())
        messages.addPending(pending)
        stopTyping()
        var payload: Json = ["cid": .string(id), "clientMsgId": .string(clientMsgId)]
        if let text { payload["text"] = .string(text) }
        if let replyTo { payload["replyTo"] = .string(replyTo) }
        if !attachments.isEmpty { payload["attachments"] = .array(attachments.map { .string($0) }) }
        if let metadata { payload["metadata"] = .object(metadata) }
        return try await chat.outbox.enqueue(OutboxEntry(clientMsgId: clientMsgId, cid: id, payload: .object(payload), createdAt: Date().timeIntervalSince1970 * 1000))
    }

    /// Retries a failed message with the same clientMsgId (dedup makes this safe).
    @discardableResult
    public func retry(_ clientMsgId: String) async throws -> Message {
        guard let m = messages.getByClientId(clientMsgId), m.id == nil else {
            throw ChatError(code: "not_found", type: "not_found", message: "No failed message with that clientMsgId")
        }
        messages.markSending(clientMsgId)
        return try await chat.outbox.retry(clientMsgId)
    }

    @discardableResult
    public func edit(_ messageId: String, text: String? = nil, metadata: Json? = nil) async throws -> Message {
        let cur = messages.get(messageId)
        let undo = messages.patch(messageId) { m in
            if let text { m.text = text }
            if let metadata { m.metadata = metadata }
            m.editedAt = Date()
        }
        do {
            let path = "/v1/messages/\(try seg(messageId))"
            let expectedVersion: Int
            if let cur { expectedVersion = cur.version } else { expectedVersion = (try await chat.rest.request("GET", path) as Message).version }
            var body: Json = ["expectedVersion": .number(Double(expectedVersion))]
            if let text { body["text"] = .string(text) }
            if let metadata { body["metadata"] = .object(metadata) }
            var m: Message = try await chat.rest.request("PATCH", path, body: .object(body))
            m.clientMsgId = cur?.clientMsgId
            messages.upsert(m)
            return m
        } catch {
            undo?()
            throw error
        }
    }

    public func delete(_ messageId: String) async throws {
        let undo = messages.patch(messageId) { m in
            m.text = nil
            m.attachments = []
            m.metadata = [:]
            m.deletedAt = Date()
        }
        do {
            let _: JSON = try await chat.rest.request("DELETE", "/v1/messages/\(try seg(messageId))")
        } catch {
            undo?()
            throw error
        }
    }

    /// Marks everything up to `seq` (default: latest) as read. Monotonic on the server.
    public func markRead(_ seq: Int? = nil) async throws {
        let target = seq ?? latestSeq
        guard target > 0 else { return }
        unreadCount = 0
        if chat.transport.isOpen {
            _ = try await chat.transport.request("read", ["cid": .string(id), "seq": .number(Double(target))])
        } else {
            let _: JSON = try await chat.rest.request("POST", "\(base)/read", body: ["seq": .number(Double(target))])
        }
        chat.noteRead(id, target)
    }

    /// Call on every keystroke; sends at most one `typing start` per 3 s.
    public func typing() {
        if let last = lastTypingSent, Date().timeIntervalSince(last) < typingThrottle { return }
        lastTypingSent = Date()
        chat.transport.send("typing", ["cid": .string(id), "state": "start"])
    }

    /// Stops the typing indicator (e.g. on blur).
    public func stopTyping() {
        guard lastTypingSent != nil else { return }
        lastTypingSent = nil
        chat.transport.send("typing", ["cid": .string(id), "state": "stop"])
    }

    public func addMembers(_ userIds: [String]) async throws {
        let _: JSON = try await chat.rest.request("POST", "\(base)/members", body: ["userIds": .array(userIds.map { .string($0) })])
    }

    public func removeMember(_ userId: String) async throws {
        let _: JSON = try await chat.rest.request("DELETE", "\(base)/members/\(try seg(userId))")
    }

    public func leave() async throws {
        try await removeMember(chat.userId ?? "")
    }

    public func mute() async throws {
        let _: JSON = try await chat.rest.request("PUT", "\(base)/mute")
        muted = true
    }

    public func unmute() async throws {
        let _: JSON = try await chat.rest.request("DELETE", "\(base)/mute")
        muted = false
    }

    /// Renames or replaces metadata; everyone (including this object) picks it up from `conversation.updated`.
    public func update(name: String? = nil, metadata: Json? = nil) async throws {
        var body: Json = [:]
        if let name { body["name"] = .string(name) }
        if let metadata { body["metadata"] = .object(metadata) }
        let _: JSON = try await chat.rest.request("PATCH", base, body: .object(body))
    }

    /// Members whose read watermark is at or past `seq` (excluding the sender of that message).
    public func readBy(_ seq: Int) -> [String] {
        let sender = messages.items.first { $0.seq == seq }?.senderId
        return members.filter { ($0.lastReadSeq ?? 0) >= seq && $0.userId != sender }.map(\.userId)
    }

    public var typingUserIds: [String] { typingUsers.keys.sorted() }

    private var latestSeq: Int {
        max(messages.items.compactMap(\.seq).max() ?? 0, lastSeq)
    }

    // MARK: incoming (called by the chat)

    /// Applies one stream event in seq order; holds it and catches up when there is a gap.
    func applyEvent(_ seq: Int, _ e: String, _ d: JSON) {
        if seq <= lastSeq { return }
        if catchingUp != nil || seq > lastSeq + 1 {
            held.append((seq, e, d))
            if catchingUp == nil { Task { try? await catchUp() } }
            return
        }
        apply(seq, e, d)
    }

    private func apply(_ seq: Int, _ e: String, _ d: JSON) {
        lastSeq = seq
        switch e {
        case "message.new":
            guard let m = try? d["message"]?.decode(Message.self) else { return }
            messages.upsert(m)
            if m.senderId != chat.userId {
                unreadCount += 1
                chat.receipts.delivered(id, seq)
                clearTyping(m.senderId)
            }
            emitter.yield(.messageNew(messages.get(m.id!) ?? m))
        case "message.updated":
            guard let m = try? d["message"]?.decode(Message.self) else { return }
            messages.upsert(m)
            emitter.yield(.messageUpdated(messages.get(m.id!) ?? m))
        case "message.deleted":
            guard let mid = d["id"]?.string else { return }
            _ = messages.patch(mid) { m in
                m.text = nil
                m.attachments = []
                m.metadata = [:]
                m.deletedAt = d["deletedAt"]?.string.flatMap(parseDate) ?? Date()
            }
            if let m = messages.get(mid) { emitter.yield(.messageDeleted(m)) }
        case "member.added":
            guard let ev = try? d.decode(MemberEvent.self) else { return }
            for u in ev.userIds ?? [] where !members.contains(where: { $0.userId == u }) {
                members.append(Member(userId: u, role: "member"))
            }
            emitter.yield(.memberAdded(ev))
        case "member.removed":
            guard let ev = try? d.decode(MemberEvent.self) else { return }
            members.removeAll { $0.userId == ev.userId }
            emitter.yield(.memberRemoved(ev))
            if ev.userId == chat.userId { markRemoved() }
        case "conversation.created":
            if let ms = try? d["conversation"]?["members"]?.decode([Member].self) { members = ms }
        case "conversation.updated":
            if let n = d["changes"]?["name"] { name = n.string }
            if let md = d["changes"]?["metadata"] { metadata = md.object ?? [:] }
            emitter.yield(.updated)
        default:
            return
        }
    }

    /// Fetches events after lastSeq (and applies held live events); 410 → reload the latest page.
    func catchUp() async throws {
        if let catchingUp { return try await catchingUp.value }
        let task = Task { try await runCatchUp() }
        catchingUp = task
        try await task.value
    }

    private func runCatchUp() async throws {
        do {
            try await fetchMissedEvents()
        } catch {
            catchingUp = nil
            throw error
        }
        catchingUp = nil
        let pending = held.sorted { $0.seq < $1.seq }
        held = []
        for h in pending { applyEvent(h.seq, h.e, h.d) }
    }

    private struct EventPage: Decodable {
        let data: [JSON]
        let hasMore: Bool
    }

    private func fetchMissedEvents() async throws {
        do {
            while true {
                let before = lastSeq
                let page: EventPage = try await chat.rest.request("GET", "\(base)/events", query: ["after": String(lastSeq), "limit": "200"])
                for ev in page.data {
                    guard var d = ev.object, let seq = d["seq"]?.int, let type = d["type"]?.string else { continue }
                    d["seq"] = nil
                    d["type"] = nil
                    if seq == lastSeq + 1 { apply(seq, type, .object(d)) }
                }
                if !page.hasMore || lastSeq == before { break } // no progress: never spin
            }
            gapFailures = 0
        } catch let e as ChatError where e.code == "resync_required" {
            try await resync()
        } catch {
            gapFailures += 1
            if gapFailures >= 3 { try await resync() } else { throw error }
        }
    }

    /// resync_required: drop the window, reload the latest page, continue from the server's lastSeq.
    func resync() async throws {
        let c: ServerConversation = try await chat.rest.request("GET", base)
        messages.clear()
        lastSeq = c.lastSeq
        members = (c.members ?? []).map { m in
            var merged = m
            if let known = members.first(where: { $0.userId == m.userId }) {
                merged.lastReadSeq = known.lastReadSeq
                merged.lastDeliveredSeq = known.lastDeliveredSeq
            }
            return merged
        }
        try await loadLatest()
        held.removeAll { $0.seq <= lastSeq }
        gapFailures = 0
    }

    func onReceipt(userId: String, lastReadSeq: Int?, lastDeliveredSeq: Int?) {
        var i = members.firstIndex { $0.userId == userId }
        if i == nil {
            members.append(Member(userId: userId, role: "member"))
            i = members.count - 1
        }
        var m = members[i!]
        if let r = lastReadSeq { m.lastReadSeq = max(m.lastReadSeq ?? 0, r) }
        if let dl = lastDeliveredSeq { m.lastDeliveredSeq = max(m.lastDeliveredSeq ?? 0, dl) }
        if let r = m.lastReadSeq, (m.lastDeliveredSeq ?? 0) < r { m.lastDeliveredSeq = r }
        members[i!] = m
        emitter.yield(.receipt(Receipt(userId: userId, lastReadSeq: m.lastReadSeq ?? 0, lastDeliveredSeq: m.lastDeliveredSeq ?? 0)))
    }

    func onTyping(userId: String, state: String) {
        if userId == chat.userId { return }
        if state == "stop" { return clearTyping(userId) }
        typingUsers[userId]?.cancel()
        typingUsers[userId] = Task { [weak self] in
            await sleep(ms: typingExpiryMs)
            if !Task.isCancelled { self?.clearTyping(userId) }
        }
        emitter.yield(.typing(typingUserIds))
    }

    private func clearTyping(_ userId: String) {
        guard let t = typingUsers.removeValue(forKey: userId) else { return }
        t.cancel()
        emitter.yield(.typing(typingUserIds))
    }

    func emitFailed(_ m: Message) {
        emitter.yield(.messageFailed(m))
    }

    func markRemoved() {
        if removed { return }
        removed = true
        emitter.yield(.removed)
        chat.dropConversation(id)
    }
}

extension Member {
    init(userId: String, role: String) {
        self.userId = userId
        self.role = role
    }
}
