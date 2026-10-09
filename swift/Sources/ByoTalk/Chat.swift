import Foundation

// The client: connection machine, sync engine, outbox, receipts, presence (docs/09-SDK-DESIGN.md §3–4).

private struct SyncResult: Decodable {
    struct Item: Decodable {
        let id: String
        let lastSeq: Int
        let unreadCount: Int
    }

    let conversations: [Item]
    let removed: [String]
    let cursor: String
    let fullReload: Bool
}

@MainActor
public final class ByoTalkChat {
    public nonisolated static let sdkVersion = "0.1.0"

    /// `dev:<userId>`; accepted only by development environments with dev tokens enabled.
    public nonisolated static func devToken(_ userId: String) -> String {
        "dev:\(userId)"
    }

    public let env: String
    let rest: RestClient
    let transport: Transport
    let persistence: PersistenceAdapter
    private(set) lazy var outbox = Outbox(chat: self)
    private(set) lazy var receipts = ReceiptBatcher(chat: self)
    private let states = Broadcaster<ConnectionState>()
    private let errorStream = Broadcaster<ChatError>()
    private var convs: [String: Conversation] = [:]
    private var loading: [String: Task<Conversation, Error>] = [:]
    private var summaries: [String: ConversationSummary] = [:]
    private let summaryWatchers = Broadcaster<[ConversationSummary]>()
    private var presenceWatchers: [Int: (userIds: Set<String>, cont: AsyncStream<Presence>.Continuation)] = [:]
    private var presenceSeq = 0
    private var syncCursor: String?
    private var connectWaiters: [CheckedContinuation<Void, Error>] = []
    public private(set) var userId: String?

    /// - Parameters:
    ///   - token: a user token, or a function returning one (called before expiry and after token_expired). Never a secret key.
    public init(
        env: String,
        token: TokenSource,
        baseURL: URL = URL(string: "https://api.byotalk.com")!,
        realtimeURL: URL = URL(string: "wss://rt.byotalk.com")!,
        persistence: PersistenceAdapter = MemoryPersistence()
    ) throws {
        if env.isEmpty { throw ChatError(code: "invalid_request", type: "invalid_request", message: "env is required") }
        if case .token(let t) = token {
            if t.isEmpty { throw ChatError(code: "invalid_request", type: "invalid_request", message: "token is required") }
            if t.hasPrefix("sk_") {
                throw ChatError(code: "invalid_request", type: "invalid_request",
                                message: "That is a secret key: it belongs on your server. Pass a user token (ChatServer.createToken) instead")
            }
            if t.hasPrefix("dev:") { userId = String(t.dropFirst(4)) }
        }
        self.env = env
        let auth = AuthManager(token)
        rest = RestClient(baseURL: baseURL, env: env, auth: auth)
        transport = Transport(realtimeURL: realtimeURL, env: env, sdk: "swift/\(Self.sdkVersion)", auth: auth)
        self.persistence = persistence

        transport.onState = { [weak self] s in
            guard let self else { return }
            self.states.yield(s)
            if s == .failed { self.rejectConnect(ChatError(code: "failed", type: "authentication", message: "Connection failed")) }
        }
        transport.onError = { [weak self] e in
            guard let self else { return }
            self.errorStream.yield(e)
            if self.transport.state == .failed { self.rejectConnect(e) }
        }
        transport.onHello = { [weak self] in
            Task { await self?.afterHello() }
        }
        transport.onFrame = { [weak self] f in self?.onFrame(f) }
    }

    public var connectionState: ConnectionState { transport.state }

    /// Current state now, then every change.
    public func connectionStates() -> AsyncStream<ConnectionState> {
        states.stream(initial: transport.state)
    }

    /// Errors not tied to a call you made (server errors, token refresh failures, connection failures).
    public func errors() -> AsyncStream<ChatError> {
        errorStream.stream()
    }

    /// Namespaced persistence key for this environment and user.
    func key(_ name: String) -> String {
        "byotalk:\(env):\(userId ?? "anon"):\(name)"
    }

    /// Returns once connected (hello received and sync finished).
    public func connect() async throws {
        if transport.state == .connected { return }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            connectWaiters.append(c)
            transport.start()
        }
    }

    /// Deletes what this user left in persistence (unsent messages, sync cursor). Call on sign-out, before disconnect.
    public func clearLocalData() async {
        for k in ["outbox", "cursor"] { await persistence.delete(key(k)) }
    }

    /// Closes the socket; unsent messages stay in the outbox until the next connect.
    public func disconnect() {
        receipts.flush()
        transport.stop()
        rejectConnect(ChatError.network("Disconnected"))
    }

    /// Reconnect now (the SDK already does this on network return and app foreground).
    public func reconnectNow() {
        transport.reconnectNow()
    }

    private func rejectConnect(_ e: ChatError) {
        let waiters = connectWaiters
        connectWaiters = []
        for w in waiters { w.resume(throwing: e) }
    }

    // MARK: sync after hello (docs/08 §7.2)

    private func afterHello() async {
        guard let hello = transport.hello else { return }
        let firstUser = userId != hello.userId
        userId = hello.userId
        if firstUser || syncCursor == nil {
            syncCursor = await persistence.get(key("cursor"))
            await outbox.load()
        }
        transport.setState(.syncing)
        async let synced: Void = runSync()
        async let flushed: Void = outbox.flush()
        async let watched: Void = rewatchPresence()
        // A failed sync still leaves the socket up: serve live events and let the next hello retry.
        try? await synced
        await flushed
        await watched
        guard transport.isOpen else { return }
        transport.setState(.connected)
        let waiters = connectWaiters
        connectWaiters = []
        for w in waiters { w.resume() }
    }

    private func runSync() async throws {
        let r = try await transport.request("sync", ["cursor": syncCursor.map { .string($0) } ?? .null], timeoutMs: 10_000).decode(SyncResult.self)
        for c in r.conversations {
            summaries[c.id]?.lastSeq = c.lastSeq
            summaries[c.id]?.unreadCount = c.unreadCount
            if let conv = convs[c.id] {
                conv.unreadCount = c.unreadCount
                if c.lastSeq > conv.lastSeq { try? await conv.catchUp() }
            }
        }
        for id in r.removed { convs[id]?.markRemoved() }
        if r.fullReload || r.conversations.contains(where: { summaries[$0.id] == nil }) { try? await refreshSummaries() } else { notifySummaries() }
        syncCursor = r.cursor
        await persistence.set(key("cursor"), r.cursor)
    }

    // MARK: incoming frames

    private func onFrame(_ f: WireFrame) {
        let d = f.d ?? .null
        switch f.t {
        case "event":
            guard let cid = f.cid, let seq = f.seq, let e = f.e else { return }
            let conv = convs[cid]
            conv?.applyEvent(seq, e, d)
            updateSummary(e, cid, seq, d)
            if e == "conversation.created" && conv == nil { notifySummaries() }
        case "receipt":
            guard let cid = d["cid"]?.string, let user = d["userId"]?.string else { return }
            convs[cid]?.onReceipt(userId: user, lastReadSeq: d["lastReadSeq"]?.int, lastDeliveredSeq: d["lastDeliveredSeq"]?.int)
        case "typing":
            guard let cid = d["cid"]?.string, let user = d["userId"]?.string, let state = d["state"]?.string else { return }
            convs[cid]?.onTyping(userId: user, state: state)
        case "presence":
            guard let p = try? d.decode(Presence.self) else { return }
            for w in presenceWatchers.values where w.userIds.contains(p.userId) { w.cont.yield(p) }
        case "resync_required":
            if let cid = d["cid"]?.string, let conv = convs[cid] { Task { try? await conv.resync() } }
        case "resync_hint":
            Task { try? await runSync() }
        default:
            return
        }
    }

    private func updateSummary(_ e: String, _ cid: String, _ seq: Int, _ d: JSON) {
        if e == "member.removed" && d["userId"]?.string == userId {
            summaries[cid] = nil
            return notifySummaries()
        }
        guard var next = summaries[cid] else {
            if e == "conversation.created" || e == "message.new" { Task { try? await refreshSummaries() } }
            return
        }
        next.lastSeq = max(next.lastSeq, seq)
        next.lastActivityAt = Date()
        if e == "message.new", let m = try? d["message"]?.decode(Message.self) {
            next.lastMessage = m
            if m.senderId != userId { next.unreadCount = min(99, next.unreadCount + 1) }
        }
        if e == "conversation.updated" {
            if let n = d["changes"]?["name"] { next.name = n.string }
            if let md = d["changes"]?["metadata"] { next.metadata = md.object ?? [:] }
        }
        summaries[cid] = next
        notifySummaries()
    }

    /// The user read a conversation up to `seq`: clear its badge in conversations.watch().
    func noteRead(_ cid: String, _ seq: Int) {
        guard var s = summaries[cid] else { return }
        if seq >= s.lastSeq { s.unreadCount = 0 }
        s.lastReadSeq = max(s.lastReadSeq, seq)
        summaries[cid] = s
        notifySummaries()
    }

    private func notifySummaries() {
        if summaryWatchers.isEmpty { return }
        summaryWatchers.yield(summaries.values.sorted { $0.lastActivityAt > $1.lastActivityAt })
    }

    private func refreshSummaries() async throws {
        if summaryWatchers.isEmpty { return }
        let page: Page<ConversationSummary> = try await rest.request("GET", "/v1/conversations", query: ["limit": "100"])
        summaries = Dictionary(page.data.map { ($0.id, $0) }, uniquingKeysWith: { $1 })
        notifySummaries()
    }

    // MARK: conversations

    /// A conversation object already in memory.
    func cached(_ id: String) -> Conversation? {
        convs[id]
    }

    func dropConversation(_ id: String) {
        convs[id] = nil
        summaries[id] = nil
        notifySummaries()
    }

    private struct MembersPage: Decodable {
        let data: [Member]
    }

    fileprivate func materialize(_ c: ServerConversation) async throws -> Conversation {
        if let existing = convs[c.id] { return existing }
        if let inflight = loading[c.id] { return try await inflight.value }
        let task = Task<Conversation, Error> {
            let conv = Conversation(chat: self, c)
            convs[c.id] = conv
            defer { loading[c.id] = nil }
            do {
                try await conv.loadLatest()
                let members: MembersPage = try await rest.request("GET", "/v1/conversations/\(try seg(c.id))/members")
                conv.members = members.data
                if let lastReadSeq = c.lastReadSeq, let me = conv.members.firstIndex(where: { $0.userId == userId }) {
                    conv.members[me].lastReadSeq = max(conv.members[me].lastReadSeq ?? 0, lastReadSeq)
                }
                conv.unreadCount = summaries[c.id]?.unreadCount ?? 0
                if transport.isOpen { try? await conv.catchUp() }
                return conv
            } catch {
                convs[c.id] = nil
                throw error
            }
        }
        loading[c.id] = task
        return try await task.value
    }

    public var conversations: Conversations { Conversations(chat: self) }

    @MainActor
    public struct Conversations {
        let chat: ByoTalkChat

        /// The one-to-one conversation with `userId` (created on first use).
        public func direct(_ userId: String) async throws -> Conversation {
            let c: ServerConversation = try await chat.rest.request("POST", "/v1/conversations",
                                                                    body: ["type": "direct", "members": [.string(userId)]], idempotent: true)
            return try await chat.materialize(c)
        }

        /// A group conversation; you are its owner.
        public func create(name: String? = nil, members: [String], metadata: Json? = nil) async throws -> Conversation {
            var body: Json = ["type": "group", "members": .array(members.map { .string($0) })]
            if let name { body["name"] = .string(name) }
            if let metadata { body["metadata"] = .object(metadata) }
            let c: ServerConversation = try await chat.rest.request("POST", "/v1/conversations", body: .object(body), idempotent: true)
            return try await chat.materialize(c)
        }

        public func get(_ id: String) async throws -> Conversation {
            if let hit = chat.convs[id] { return hit }
            let c: ServerConversation = try await chat.rest.request("GET", "/v1/conversations/\(try seg(id))")
            return try await chat.materialize(c)
        }

        /// One page of summaries (unreadCount, lastMessage, metadata), most recent activity first.
        public func list(limit: Int? = nil, cursor: String? = nil) async throws -> Page<ConversationSummary> {
            let page: Page<ConversationSummary> = try await chat.rest.request("GET", "/v1/conversations",
                                                                              query: ["limit": limit.map(String.init), "cursor": cursor])
            for s in page.data { chat.summaries[s.id] = s }
            return page
        }

        /// Live list sorted by activity; updated by events and sync.
        public func watch() -> AsyncStream<[ConversationSummary]> {
            let stream = chat.summaryWatchers.stream(.bufferingNewest(1))
            Task { [chat] in
                do { try await chat.refreshSummaries() } catch { chat.errorStream.yield(ChatError.from(error)) }
            }
            return stream
        }
    }

    // MARK: presence

    public var presence: PresenceWatch { PresenceWatch(chat: self) }

    @MainActor
    public struct PresenceWatch {
        let chat: ByoTalkChat

        /// Online/offline for these users: a snapshot, then changes (union of all watches ≤ 200 per connection).
        public func watch(_ userIds: [String]) -> AsyncStream<Presence> {
            chat.presenceSeq += 1
            let id = chat.presenceSeq
            let (stream, cont) = AsyncStream.makeStream(of: Presence.self)
            chat.presenceWatchers[id] = (Set(userIds), cont)
            cont.onTermination = { [weak chat] _ in
                Task { @MainActor in
                    chat?.presenceWatchers[id] = nil
                    await chat?.rewatchPresence()
                }
            }
            Task { [chat] in await chat.rewatchPresence(snapshotFor: id) }
            return stream
        }
    }

    private func rewatchPresence(snapshotFor: Int? = nil) async {
        guard transport.isOpen else { return }
        let union = Array(Set(presenceWatchers.values.flatMap(\.userIds)).prefix(200))
        guard let r = try? await transport.request("presence.watch", ["userIds": .array(union.map { .string($0) })]),
              let list = try? r["presence"]?.decode([Presence].self) else { return }
        if union.isEmpty { return }
        for (id, w) in presenceWatchers where snapshotFor == nil || id == snapshotFor {
            for p in list where w.userIds.contains(p.userId) { w.cont.yield(p) }
        }
    }

    // MARK: push

    public var push: Push { Push(chat: self) }

    @MainActor
    public struct Push {
        let chat: ByoTalkChat

        /// Registers this device's APNs (or FCM) token for offline notifications.
        public func register(provider: String = "apns", token: String) async throws {
            let _: JSON = try await chat.rest.request("POST", "/v1/push/devices", body: ["provider": .string(provider), "token": .string(token)], idempotent: true)
        }

        public func unregister(token: String) async throws {
            let _: JSON = try await chat.rest.request("DELETE", "/v1/push/devices/\(try seg(token))")
        }
    }
}
