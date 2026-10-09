// SDK against a running byotalk-server (BYOTALK_API_URL / BYOTALK_RT_URL); skipped when the server is unreachable.
package com.byotalk

import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.jupiter.api.Assumptions.assumeTrue
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class IntegrationTest {
    private val api = System.getenv("BYOTALK_API_URL") ?: "http://localhost:3100"
    private val rt = System.getenv("BYOTALK_RT_URL") ?: "ws://localhost:3001"
    private val http = OkHttpClient()
    private val chats = mutableListOf<ByoTalkChat>()

    private fun post(path: String, body: String, headers: Map<String, String> = emptyMap()) =
        http.newCall(Request.Builder().url(api + path).post(body.toRequestBody(null)).header("content-type", "application/json")
            .apply { headers.forEach { (k, v) -> header(k, v) } }.build()).execute()

    private fun get(path: String, headers: Map<String, String>) =
        http.newCall(Request.Builder().url(api + path).apply { headers.forEach { (k, v) -> header(k, v) } }.build()).execute()

    private fun obj(text: String) = json.parseToJsonElement(text).o()

    /** Fresh org + project through the dashboard sign-in flow (dev magic link); returns its development env id. */
    private fun createDevEnv(): String {
        // An existing development environment with dev tokens (e.g. on a deployment that never returns devLink).
        System.getenv("BYOTALK_ENV")?.takeIf { it.isNotEmpty() }?.let { return it }
        val email = "sdk-kt-${System.currentTimeMillis()}-${(1000..9999).random()}@example.com"
        val link = post("/v1/auth/magic-link", """{"email":"$email"}""").use { obj(it.body!!.string()) }
        val token = link.str("devLink")!!.substringAfter("token=").substringBefore("&")
        val cookie = post("/v1/auth/verify", """{"token":"$token"}""").use { it.header("set-cookie")!!.substringBefore(";") }
        val h = mapOf("cookie" to cookie, "x-byotalk-dashboard" to "1")
        val me = get("/v1/auth/me", h).use { obj(it.body!!.string()) }
        val orgId = me.list("orgs")[0].o().str("id")!!
        val project = post("/v1/dashboard/orgs/$orgId/projects", """{"name":"Kotlin SDK tests"}""", h).use {
            val text = it.body!!.string()
            check(it.isSuccessful) { "${it.code} $text" }
            obj(text)
        }
        return project.list("environments").map { it.o() }.first { it.str("kind") == "development" }.str("id")!!
    }

    private fun reachable() = try {
        http.newCall(Request.Builder().url("$api/v1/health").build()).execute().use { true }
    } catch (_: Exception) {
        false
    }

    /** The local server may be restarting (another session develops it): retry setup a few times. */
    private fun setupEnv(): String {
        var last: Exception? = null
        repeat(5) {
            try {
                return createDevEnv()
            } catch (e: Exception) {
                last = e
                Thread.sleep(2_000)
            }
        }
        throw last!!
    }

    // Unique per test: with BYOTALK_ENV several runs (and SDKs) share one environment and must not see each other's chats.
    private val run = java.util.UUID.randomUUID().toString().take(8)
    private val A = "alice-$run"
    private val B = "bob-$run"

    private fun chat(env: String, user: String) = ByoTalkChat(env, ByoTalkChat.devToken(user), api, rt).also { chats += it }

    @AfterTest fun tearDown() = runBlocking { chats.forEach { it.disconnect() } }

    private suspend fun Conversation.awaitText(text: String) = withTimeout(10_000) { messages.items.first { l -> l.any { it.text == text } } }

    @Test fun aliceAndBobChat() = runBlocking {
        assumeTrue(reachable(), "byotalk-server not reachable at $api")
        val env = setupEnv()

        val alice = chat(env, A)
        alice.connect()
        assertEquals(ConnectionState.CONNECTED, alice.connectionState)
        val dm = alice.conversations.direct(B)

        val bob = chat(env, B)
        bob.connect()
        val bobDm = bob.conversations.direct(A)
        assertEquals(dm.id, bobDm.id)

        // direct message alice → bob
        val bobNew = async { withTimeout(10_000) { bobDm.events.filterIsInstance<ConversationEvent.MessageNew>().first() } }
        delay(50) // let the collector subscribe
        val sent = dm.send(text = "Hello Bob")
        assertEquals(MessageStatus.SENT, sent.status)
        assertEquals(A, sent.senderId)
        assertTrue((sent.seq ?: 0) > 0)
        assertEquals("Hello Bob", bobNew.await().message.text)
        bobDm.awaitText("Hello Bob")

        // read receipt bob → alice
        val receipt = async {
            withTimeout(10_000) { dm.events.filterIsInstance<ConversationEvent.Receipt>().first { it.userId == B && it.lastReadSeq >= sent.seq!! } }
        }
        delay(50)
        bobDm.markRead()
        receipt.await()
        assertEquals(listOf(B), dm.readBy(sent.seq!!))

        // typing alice → bob
        dm.typing()
        withTimeout(10_000) { bobDm.typingUserIds.first { A in it } }

        // summaries
        val summary = alice.conversations.list().data.first { it.id == dm.id }
        assertEquals("Hello Bob", summary.lastMessage?.text)

        // bob offline: a message sent meanwhile arrives through sync after reconnect
        bob.disconnect()
        assertEquals(ConnectionState.DISCONNECTED, bob.connectionState)
        dm.send(text = "While you were away")
        bob.connect()
        bobDm.awaitText("While you were away")

        // alice offline: the send waits in the outbox and is flushed after reconnect with the same clientMsgId
        alice.disconnect()
        val queued = async { dm.send(text = "Queued offline") }
        val pending = withTimeout(5_000) { dm.messages.items.first { l -> l.any { it.text == "Queued offline" } } }.first { it.text == "Queued offline" }
        assertEquals(MessageStatus.SENDING, pending.status)
        delay(300)
        assertEquals(MessageStatus.SENDING, dm.messages.getByClientId(pending.clientMsgId!!)!!.status)
        alice.connect()
        val acked = withTimeout(10_000) { queued.await() }
        assertEquals(pending.clientMsgId, acked.clientMsgId)
        assertEquals(MessageStatus.SENT, acked.status)
        bobDm.awaitText("Queued offline")
        assertEquals(1, bobDm.messages.items.value.count { it.text == "Queued offline" })
        // ordered and deduped on both sides
        for (c in listOf(dm, bobDm)) {
            val seqs = c.messages.items.value.mapNotNull { it.seq }
            assertEquals(seqs.sorted().distinct(), seqs)
        }
    }

    @Test fun groupUpdatesAndEdits() = runBlocking {
        assumeTrue(reachable(), "byotalk-server not reachable at $api")
        val env = setupEnv()
        val alice = chat(env, A)
        val bob = chat(env, B)
        alice.connect()
        bob.connect()
        val group = alice.conversations.create(listOf(B), name = "Team")
        val bobGroup = bob.conversations.get(group.id)
        val m = group.send(text = "first")
        bobGroup.awaitText("first")

        group.edit(m.id!!, text = "first (edited)")
        bobGroup.awaitText("first (edited)")

        group.update(name = "Renamed")
        withTimeout(10_000) { while (bobGroup.name != "Renamed") delay(25) }

        group.delete(m.id!!)
        withTimeout(10_000) { bobGroup.messages.items.first { l -> l.any { it.id == m.id && it.deletedAt != null } } }

        // history paging
        repeat(3) { group.send(text = "p$it") }
        val older = alice.conversations.get(group.id).loadOlder(limit = 2)
        assertTrue(older.messages.size <= 2)
    }
}
