package com.byotalk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class MessageStoreTest {
    private fun msg(id: String?, seq: Long?, text: String = "", version: Int = 1, clientMsgId: String? = null, createdAt: String = "2026-01-01T00:00:00.000Z") =
        Message(id = id, seq = seq, text = text, version = version, clientMsgId = clientMsgId, conversationId = "c", senderId = "u", createdAt = createdAt,
            status = if (id == null) MessageStatus.SENDING else MessageStatus.SENT)

    @Test fun ordersBySeqWithPendingLast() {
        val s = MessageStore()
        s.addPending(msg(null, null, "pending", clientMsgId = "x"))
        s.upsertMany(listOf(msg("m3", 3), msg("m1", 1), msg("m2", 2)))
        assertEquals(listOf(1L, 2L, 3L, null), s.items.value.map { it.seq })
        assertEquals(1L, s.oldestSeq)
    }

    @Test fun dedupesByIdAndKeepsNewestVersion() {
        val s = MessageStore()
        s.upsert(msg("m1", 1, "v2", version = 2))
        s.upsert(msg("m1", 1, "v1", version = 1))
        s.upsert(msg("m1", 1, "v2 again", version = 2))
        assertEquals(listOf("v2 again"), s.items.value.map { it.text })
    }

    @Test fun reconcileMovesPendingToSeqPosition() {
        val s = MessageStore()
        s.addPending(msg(null, null, "mine", clientMsgId = "x"))
        s.upsert(msg("m1", 1))
        s.upsert(msg("m3", 3))
        s.reconcile("x", "m2", 2, "2026-01-01T00:00:01.000Z")
        assertEquals(listOf("m1", "m2", "m3"), s.items.value.map { it.id })
        assertEquals(MessageStatus.SENT, s.get("m2")!!.status)
        assertEquals("x", s.get("m2")!!.clientMsgId)
    }

    @Test fun reconcileAfterLiveEventKeepsOneCopy() {
        val s = MessageStore()
        s.addPending(msg(null, null, "mine", clientMsgId = "x"))
        s.upsert(msg("m1", 1, "mine")) // message.new arrived before the ack
        s.reconcile("x", "m1", 1, "t")
        assertEquals(1, s.items.value.size)
        assertEquals("x", s.items.value[0].clientMsgId)
    }

    @Test fun clearKeepsUnsentAndWindowIsBounded() {
        val s = MessageStore()
        s.upsertMany((1L..600L).map { msg("m$it", it) })
        assertEquals(500, s.items.value.size)
        assertEquals(101L, s.oldestSeq)
        s.addPending(msg(null, null, clientMsgId = "x"))
        s.clear()
        assertEquals(listOf("x"), s.items.value.map { it.clientMsgId })
    }

    @Test fun patchUndo() {
        val s = MessageStore()
        s.upsert(msg("m1", 1, "hi"))
        val undo = s.patch("m1") { it.copy(text = null) }!!
        assertEquals(null, s.get("m1")!!.text)
        undo()
        assertEquals("hi", s.get("m1")!!.text)
    }
}

class BackoffTest {
    @Test fun fullJitterWithinCap() {
        assertEquals(0, backoffDelay(5, rand = { 0.0 }))
        assertEquals(499, backoffDelay(0, rand = { 0.999 }))
        assertEquals(3996, backoffDelay(3, rand = { 0.999 }))
        assertEquals(29_970, backoffDelay(10, rand = { 0.999 }))
        assertEquals(29_970, backoffDelay(1_000, rand = { 0.999 })) // no overflow
        repeat(1000) { assertTrue(backoffDelay(it % 12) in 0 until 30_000) }
    }
}

class ChatOptionsTest {
    @Test fun refusesSecretKeys() {
        val e = assertFailsWith<ChatException> { ByoTalkChat("env_1", "sk_live_abc") }
        assertEquals("invalid_request", e.code)
    }

    @Test fun devTokenSetsUser() {
        assertEquals("dev:alice", ByoTalkChat.devToken("alice"))
        assertEquals("alice", ByoTalkChat("env_1", ByoTalkChat.devToken("alice")).userId)
    }

    @Test fun readsJwtExpiry() {
        val payload = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("""{"exp":1700000000}""".toByteArray())
        assertEquals(1_700_000_000_000, tokenExpiry("h.$payload.s"))
        assertEquals(null, tokenExpiry("dev:alice"))
    }

    @Test fun errorFromServerBody() {
        val body = json.parseToJsonElement("""{"error":{"type":"not_found","code":"not_found","message":"Nope","requestId":"req_1"}}""")
        val e = errorFromBody(404, body)
        assertEquals("not_found", e.code)
        assertEquals("req_1", e.requestId)
        assertEquals(false, e.retryable)
        assertTrue(errorFromBody(503, null).retryable)
    }
}
