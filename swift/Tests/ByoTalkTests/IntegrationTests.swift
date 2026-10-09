import XCTest
@testable import ByoTalk

// SDK against a running byotalk-server. Set BYOTALK_API_URL and BYOTALK_RT_URL (e.g. http://localhost:3100, ws://localhost:3001).

private let api = ProcessInfo.processInfo.environment["BYOTALK_API_URL"]
private let rt = ProcessInfo.processInfo.environment["BYOTALK_RT_URL"]

private func post(_ url: String, _ body: JSON, headers: [String: String] = [:]) async throws -> (JSON, HTTPURLResponse) {
    try await call(url, method: "POST", body: body, headers: headers)
}

private func call(_ url: String, method: String = "GET", body: JSON? = nil, headers: [String: String] = [:]) async throws -> (JSON, HTTPURLResponse) {
    var req = URLRequest(url: URL(string: url)!)
    req.httpMethod = method
    req.httpShouldHandleCookies = false
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
    if let body { req.httpBody = try JSONEncoder().encode(body) }
    let (data, res) = try await URLSession(configuration: .ephemeral).data(for: req)
    let http = res as! HTTPURLResponse
    guard (200..<300).contains(http.statusCode) else { throw ChatError.fromBody(status: http.statusCode, data: data) }
    return (try JSONDecoder().decode(JSON.self, from: data), http)
}

/// Creates a fresh org + project through the dashboard sign-in flow (dev magic link); returns its development env id.
private func createDevEnv(_ api: String) async throws -> String {
    // An existing development environment with dev tokens (e.g. on a deployment that never returns devLink).
    if let given = ProcessInfo.processInfo.environment["BYOTALK_ENV"], !given.isEmpty { return given }
    let email = "swift-\(UUID().uuidString.prefix(8).lowercased())@example.com"
    let (link, _) = try await post("\(api)/v1/auth/magic-link", ["email": .string(email)])
    let token = URLComponents(string: link["devLink"]!.string!)!.queryItems!.first { $0.name == "token" }!.value!
    let (_, verify) = try await post("\(api)/v1/auth/verify", ["token": .string(token)])
    let cookie = String((verify.value(forHTTPHeaderField: "set-cookie") ?? "").split(separator: ";")[0])
    let h = ["cookie": cookie, "x-byotalk-dashboard": "1"]
    let (me, _) = try await call("\(api)/v1/auth/me", headers: h)
    let org = me["orgs"]!.array![0]["id"]!.string!
    let (project, _) = try await post("\(api)/v1/dashboard/orgs/\(org)/projects", ["name": "Swift SDK tests"], headers: h)
    return project["environments"]!.array!.first { $0["kind"]?.string == "development" }!["id"]!.string!
}

/// The local server may be restarting: retry a few times before giving up.
private func retrying<T>(_ attempts: Int = 10, _ fn: () async throws -> T) async throws -> T {
    for i in 1... {
        do { return try await fn() } catch {
            if i >= attempts { throw error }
            await sleep(ms: 2_000)
        }
    }
    fatalError()
}

@MainActor
private func waitFor(_ what: String, timeout: TimeInterval = 10, _ check: () -> Bool) async throws {
    let end = Date().addingTimeInterval(timeout)
    while !check() {
        if Date() > end { throw ChatError(code: "timeout", message: "never happened: \(what)") }
        await sleep(ms: 25)
    }
}

/// Collects a conversation's events for later assertions.
@MainActor
private final class Recorder {
    var events: [ConversationEvent] = []
    private var task: Task<Void, Never>?

    init(_ conv: Conversation) {
        let stream = conv.events()
        task = Task { [weak self] in for await e in stream { self?.events.append(e) } }
    }

    deinit { task?.cancel() }
}

@MainActor
final class IntegrationTests: XCTestCase {
    private var chats: [ByoTalkChat] = []

    override func tearDown() async throws {
        for c in chats { c.disconnect() }
        chats = []
    }

    // Unique per test: with BYOTALK_ENV several runs (and SDKs) share one environment and must not see each other's chats.
    private let run = UUID().uuidString.prefix(8).lowercased()
    private var idA: String { "alice-\(run)" }
    private var idB: String { "bob-\(run)" }

    private func chat(_ env: String, _ user: String) throws -> ByoTalkChat {
        let c = try ByoTalkChat(env: env, token: .token(ByoTalkChat.devToken(user)), baseURL: URL(string: api!)!, realtimeURL: URL(string: rt!)!)
        chats.append(c)
        return c
    }

    func testAliceAndBobChat() async throws {
        guard let api, rt != nil else { throw XCTSkip("BYOTALK_API_URL / BYOTALK_RT_URL not set") }
        let env: String
        do { env = try await retrying { try await createDevEnv(api) } } catch { throw XCTSkip("server unreachable at \(api): \(error)") }

        let alice = try chat(env, idA)
        try await retrying { try await alice.connect() }
        XCTAssertEqual(alice.connectionState, .connected)
        let dm = try await alice.conversations.direct(idB)

        let bob = try chat(env, idB)
        try await retrying { try await bob.connect() }
        let bobDm = try await bob.conversations.direct(idA)
        XCTAssertEqual(bobDm.id, dm.id)
        let bobSaw = Recorder(bobDm)
        let aliceSaw = Recorder(dm)

        // send → bob receives
        let sent = try await dm.send(text: "Hello Bob")
        XCTAssertEqual(sent.status, .sent)
        XCTAssertEqual(sent.senderId, idA)
        let seq = try XCTUnwrap(sent.seq)
        XCTAssertGreaterThan(seq, 0)
        try await waitFor("bob gets message.new") {
            bobSaw.events.contains { if case .messageNew(let m) = $0 { return m.text == "Hello Bob" }; return false }
        }
        XCTAssertEqual(bobDm.messages.items.last?.text, "Hello Bob")
        XCTAssertEqual(bobDm.unreadCount, 1)

        // summaries carry unread count and last message
        let summary = try await bob.conversations.list().data.first { $0.id == dm.id }
        XCTAssertEqual(summary?.unreadCount, 1)
        XCTAssertEqual(summary?.lastMessage?.text, "Hello Bob")

        // read receipt
        try await bobDm.markRead()
        try await waitFor("alice sees bob's receipt") {
            aliceSaw.events.contains { if case .receipt(let r) = $0 { return r.userId == idB && r.lastReadSeq >= seq }; return false }
        }
        XCTAssertEqual(dm.readBy(seq), [idB])

        // typing
        bobDm.typing()
        try await waitFor("alice sees bob typing") { dm.typingUserIds == [idB] }

        // presence
        var presence = alice.presence.watch([idB]).makeAsyncIterator()
        let p = await presence.next()
        XCTAssertEqual(p?.userId, idB)
        XCTAssertEqual(p?.online, true)

        // edit and delete reach bob
        let msgId = try XCTUnwrap(sent.id)
        _ = try await dm.edit(msgId, text: "Hello Bob!")
        try await waitFor("bob sees the edit") { bobDm.messages.get(msgId)?.text == "Hello Bob!" }
        try await dm.delete(msgId)
        try await waitFor("bob sees the delete") { bobDm.messages.get(msgId)?.deletedAt != nil }

        // bob's socket drops: the transport reconnects by itself and syncs
        var bobStates: [ConnectionState] = []
        let watching = Task { for await s in bob.connectionStates() { bobStates.append(s) } }
        bob.transport.ws?.cancel(with: .goingAway, reason: nil)
        try await dm.send(text: "During the drop")
        try await waitFor("bob reconnects") { bobStates.contains(.reconnecting) && bob.connectionState == .connected }
        try await waitFor("bob has the message sent during the drop") { bobDm.messages.items.contains { $0.text == "During the drop" } }
        watching.cancel()

        // bob offline: a message sent meanwhile arrives by sync after reconnect
        bob.disconnect()
        XCTAssertEqual(bob.connectionState, .disconnected)
        try await dm.send(text: "While you were away")
        try await retrying { try await bob.connect() }
        try await waitFor("bob syncs the missed message") { bobDm.messages.items.contains { $0.text == "While you were away" } }
        XCTAssertEqual(bobDm.messages.items.compactMap(\.seq), bobDm.messages.items.compactMap(\.seq).sorted())

        // alice offline: the send waits in the outbox and goes out after reconnect with the same clientMsgId
        alice.disconnect()
        let queued = Task { try await dm.send(text: "Queued offline") }
        try await waitFor("pending message shows") { dm.messages.items.contains { $0.text == "Queued offline" && $0.status == .sending } }
        let clientMsgId = dm.messages.items.first { $0.text == "Queued offline" }?.clientMsgId
        try await retrying { try await alice.connect() }
        let delivered = try await queued.value
        XCTAssertEqual(delivered.status, .sent)
        XCTAssertEqual(delivered.clientMsgId, clientMsgId)
        XCTAssertEqual(dm.messages.items.filter { $0.text == "Queued offline" }.count, 1)
        try await waitFor("bob gets the queued message") { bobDm.messages.items.contains { $0.text == "Queued offline" } }
    }

    func testTokenRejectedThenRefreshed() async throws {
        guard let api, rt != nil else { throw XCTSkip("BYOTALK_API_URL / BYOTALK_RT_URL not set") }
        let env: String
        do { env = try await retrying { try await createDevEnv(api) } } catch { throw XCTSkip("server unreachable at \(api): \(error)") }

        // A static token the server refuses (close 4001): no provider to ask, so the connection fails.
        let bad = try ByoTalkChat(env: env, token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad", baseURL: URL(string: api)!, realtimeURL: URL(string: rt!)!)
        chats.append(bad)
        do {
            try await bad.connect()
            XCTFail("connected with a bad token")
        } catch let e as ChatError {
            XCTAssertEqual(e.type, "authentication")
            XCTAssertEqual(bad.connectionState, .failed)
        }

        // A provider is asked again after 4001 and the second token works.
        final class Calls: @unchecked Sendable { var n = 0 }
        let calls = Calls()
        let good = try ByoTalkChat(env: env, token: .provider {
            calls.n += 1
            return calls.n == 1 ? "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad" : ByoTalkChat.devToken("carol")
        }, baseURL: URL(string: api)!, realtimeURL: URL(string: rt!)!)
        chats.append(good)
        try await good.connect()
        XCTAssertEqual(good.userId, "carol")
        XCTAssertEqual(calls.n, 2)
    }

    func testGroupMetadataAndPaging() async throws {
        guard let api, rt != nil else { throw XCTSkip("BYOTALK_API_URL / BYOTALK_RT_URL not set") }
        let env: String
        do { env = try await retrying { try await createDevEnv(api) } } catch { throw XCTSkip("server unreachable at \(api): \(error)") }

        let alice = try chat(env, idA)
        let bob = try chat(env, idB)
        try await retrying { try await alice.connect() }
        try await retrying { try await bob.connect() }
        let group = try await alice.conversations.create(name: "Team", members: [idB], metadata: ["topic": "launch"])
        for i in 1...3 { try await group.send(text: "m\(i)") }

        let bobGroup = try await bob.conversations.get(group.id)
        XCTAssertEqual(bobGroup.name, "Team")
        XCTAssertEqual(bobGroup.metadata["topic"], "launch")
        XCTAssertEqual(bobGroup.messages.items.compactMap(\.text), ["m1", "m2", "m3"])

        try await group.update(name: "Launch team", metadata: ["topic": "ship"])
        try await waitFor("bob gets conversation.updated") { bobGroup.name == "Launch team" && bobGroup.metadata["topic"] == "ship" }

        let fresh = try chat(env, idB)
        let page = try await fresh.conversations.get(group.id)
        page.messages.clear()
        let hasOlder = try await page.loadLatest(limit: 1)
        XCTAssertTrue(hasOlder)
        XCTAssertTrue(page.hasOlder)
        let older = try await page.loadOlder(limit: 10)
        XCTAssertEqual(Set(older.messages.compactMap(\.text)), ["m1", "m2"])
        XCTAssertEqual(page.messages.items.compactMap(\.text), ["m1", "m2", "m3"])
        XCTAssertFalse(page.hasOlder)
    }
}
