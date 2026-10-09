import XCTest
@testable import ByoTalk

private func msg(_ id: String?, seq: Int?, version: Int = 1, clientMsgId: String? = nil, text: String? = nil, at: TimeInterval = 0) -> Message {
    Message(id: id, clientMsgId: clientMsgId, conversationId: "c_1", seq: seq, senderId: "alice", text: text ?? id, replyTo: nil,
            attachments: [], metadata: [:], version: version, status: id == nil ? .sending : .sent, createdAt: Date(timeIntervalSince1970: at))
}

@MainActor
final class MessageStoreTests: XCTestCase {
    func testOrdersBySeqWithPendingLast() {
        let s = MessageStore()
        s.addPending(msg(nil, seq: nil, clientMsgId: "p1", text: "pending", at: 1))
        s.upsertMany([msg("m3", seq: 3), msg("m1", seq: 1)])
        s.upsert(msg("m2", seq: 2))
        XCTAssertEqual(s.items.map(\.text), ["m1", "m2", "m3", "pending"])
        XCTAssertEqual(s.oldestSeq, 1)
    }

    func testDedupesByIdAndKeepsNewestVersion() {
        let s = MessageStore()
        s.upsert(msg("m1", seq: 1, version: 2, text: "edited"))
        s.upsert(msg("m1", seq: 1, version: 1, text: "original"))
        s.upsertMany([msg("m1", seq: 1, version: 1, text: "original")])
        XCTAssertEqual(s.items.count, 1)
        XCTAssertEqual(s.items[0].text, "edited")
        s.upsert(msg("m1", seq: 1, version: 3, text: "again"))
        XCTAssertEqual(s.items.map(\.text), ["again"])
    }

    func testReconcileMovesPendingIntoSeqOrder() {
        let s = MessageStore()
        s.addPending(msg(nil, seq: nil, clientMsgId: "p1", text: "mine"))
        s.upsert(msg("m5", seq: 5))
        s.reconcile("p1", id: "m4", seq: 4, createdAt: Date())
        XCTAssertEqual(s.items.map(\.id), ["m4", "m5"])
        XCTAssertEqual(s.items[0].status, .sent)
        XCTAssertEqual(s.items[0].clientMsgId, "p1")
    }

    func testReconcileAfterLiveEventKeepsOneCopy() {
        let s = MessageStore()
        s.addPending(msg(nil, seq: nil, clientMsgId: "p1", text: "mine"))
        s.upsert(msg("m4", seq: 4, text: "mine"))
        s.reconcile("p1", id: "m4", seq: 4, createdAt: Date())
        XCTAssertEqual(s.items.count, 1)
        XCTAssertEqual(s.items[0].clientMsgId, "p1")
        XCTAssertEqual(s.getByClientId("p1")?.id, "m4")
    }

    func testWindowKeepsNewest500AndClearKeepsUnsent() {
        let s = MessageStore()
        s.upsertMany((1...520).map { (i: Int) in msg("m\(i)", seq: i) })
        XCTAssertEqual(s.items.count, 500)
        XCTAssertEqual(s.oldestSeq, 21)
        s.addPending(msg(nil, seq: nil, clientMsgId: "p1"))
        s.clear()
        XCTAssertEqual(s.items.map(\.clientMsgId), ["p1"])
    }

    func testPatchUndo() {
        let s = MessageStore()
        s.upsert(msg("m1", seq: 1, text: "hi"))
        let undo = s.patch("m1") { $0.text = nil }
        XCTAssertNil(s.items[0].text)
        undo?()
        XCTAssertEqual(s.items[0].text, "hi")
    }

    func testUpdatesStreamStartsWithCurrentList() async {
        let s = MessageStore()
        s.upsert(msg("m1", seq: 1))
        var it = s.updates().makeAsyncIterator()
        let first = await it.next()
        XCTAssertEqual(first?.map(\.id), ["m1"])
        s.upsert(msg("m2", seq: 2))
        let second = await it.next()
        XCTAssertEqual(second?.map(\.id), ["m1", "m2"])
    }
}

@MainActor
final class ConversationSeqTests: XCTestCase {
    func testDropsDuplicateSeqAndAppliesNext() throws {
        let chat = try ByoTalkChat(env: "env_test", token: "dev:bob", baseURL: URL(string: "http://127.0.0.1:1")!)
        let conv = Conversation(chat: chat, ServerConversation(id: "c_1", type: "direct", name: nil, metadata: nil, lastSeq: 1, members: nil, lastReadSeq: nil, muted: nil))
        let m: JSON = ["message": ["id": "m2", "conversationId": "c_1", "seq": 2, "senderId": "alice", "text": "hi", "version": 1,
                                   "createdAt": "2026-10-04T10:00:00.000Z"]]
        conv.applyEvent(2, "message.new", m)
        conv.applyEvent(2, "message.new", m)
        conv.applyEvent(1, "message.new", m)
        XCTAssertEqual(conv.lastSeq, 2)
        XCTAssertEqual(conv.messages.items.map(\.id), ["m2"])
        XCTAssertEqual(conv.unreadCount, 1)
        conv.applyEvent(3, "conversation.updated", ["changes": ["name": "Renamed", "metadata": ["topic": "x"]]])
        XCTAssertEqual(conv.name, "Renamed")
        XCTAssertEqual(conv.metadata, ["topic": "x"])
    }
}

final class UtilTests: XCTestCase {
    func testBackoffIsFullJitterWithCap() {
        XCTAssertEqual(backoffDelay(0, rand: { 0 }), 0)
        XCTAssertEqual(backoffDelay(0, rand: { 0.999 }), 499)
        XCTAssertEqual(backoffDelay(3, rand: { 0.5 }), 2_000)
        XCTAssertEqual(backoffDelay(20, rand: { 0.5 }), 15_000) // capped at 30 s
        XCTAssertEqual(backoffDelay(200, rand: { 0.999 }), 29_970)
        for attempt in 0..<12 {
            let d = backoffDelay(attempt)
            XCTAssertTrue(d >= 0 && d < min(30_000, 500 << attempt))
        }
    }

    func testTokenExpiry() {
        let payload = Data(#"{"sub":"u","exp":2000000000}"#.utf8).base64EncodedString()
            .replacingOccurrences(of: "=", with: "").replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        XCTAssertEqual(tokenExpiry("h.\(payload).s")?.timeIntervalSince1970, 2_000_000_000)
        XCTAssertNil(tokenExpiry("dev:alice"))
    }

    func testPathSegmentsAreEncoded() throws {
        XCTAssertEqual(try seg("c_1/../../members/u_2"), "c_1%2F..%2F..%2Fmembers%2Fu_2")
        XCTAssertThrowsError(try seg(".."))
        XCTAssertThrowsError(try seg(""))
    }

    @MainActor
    func testRefusesSecretKeys() {
        XCTAssertThrowsError(try ByoTalkChat(env: "env_1", token: "sk_live_abc")) { err in
            XCTAssertEqual((err as? ChatError)?.code, "invalid_request")
        }
        XCTAssertEqual(try ByoTalkChat(env: "env_1", token: .token(ByoTalkChat.devToken("alice"))).userId, "alice")
    }

    func testErrorFromBody() {
        let e = ChatError.fromBody(status: 503, data: Data(#"{"error":{"code":"history_unavailable","message":"down","requestId":"req_1"}}"#.utf8))
        XCTAssertEqual(e.code, "history_unavailable")
        XCTAssertEqual(e.requestId, "req_1")
        XCTAssertTrue(e.isHistoryUnavailable)
        XCTAssertTrue(e.retryable)
        XCTAssertFalse(ChatError.fromBody(status: 404, data: Data()).retryable)
    }
}
