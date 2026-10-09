// One conversation: message window, gapless event application, receipts, typing (docs/09 §3–4, docs/08 §7).
package com.byotalk

import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

private const val TYPING_EXPIRY_MS = 6_000L
private const val TYPING_THROTTLE_MS = 3_000L

sealed class ConversationEvent {
    data class MessageNew(val message: Message) : ConversationEvent()
    data class MessageUpdated(val message: Message) : ConversationEvent()
    data class MessageDeleted(val message: Message) : ConversationEvent()
    data class MessageFailed(val message: Message) : ConversationEvent()
    data class Typing(val userIds: List<String>) : ConversationEvent()
    data class Receipt(val userId: String, val lastReadSeq: Long, val lastDeliveredSeq: Long) : ConversationEvent()
    data class MemberAdded(val userIds: List<String>, val actorId: String?) : ConversationEvent()
    data class MemberRemoved(val userId: String, val actorId: String?, val reason: String?) : ConversationEvent()
    object Updated : ConversationEvent()
    object Removed : ConversationEvent()
}

data class OlderPage(val messages: List<Message>, val hasMore: Boolean)

private class Held(val seq: Long, val e: String, val d: JsonObject)

class Conversation internal constructor(private val chat: ByoTalkChat, c: ServerConversation) {
    val id: String = c.id
    val type: String = c.type
    @Volatile var name: String? = c.name
        private set
    @Volatile var metadata: JsonObject = c.metadata
        private set
    @Volatile var members: List<Member> = c.members.orEmpty()
        internal set
    @Volatile var unreadCount = 0
        internal set
    @Volatile var muted = c.muted ?: false
        private set
    /** Last contiguous event applied. */
    @Volatile var lastSeq: Long = c.lastSeq
        private set
    @Volatile var removed = false
        private set
    /** True while the server has messages older than the oldest one loaded; loadOlder() pages through them. */
    @Volatile var hasOlder = false
        private set

    val messages = MessageStore()

    private val _events = MutableSharedFlow<ConversationEvent>(extraBufferCapacity = 256, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    /** message.new / updated / deleted / failed, typing, receipt, member and conversation changes. */
    val events: SharedFlow<ConversationEvent> = _events

    private val _typing = MutableStateFlow<List<String>>(emptyList())
    val typingUserIds: StateFlow<List<String>> = _typing

    private val typingJobs = LinkedHashMap<String, Job>()
    private var lastTypingSent = 0L
    private var held = mutableListOf<Held>()
    private var catchingUp: Deferred<Unit>? = null
    private var gapFailures = 0

    private fun emit(e: ConversationEvent) {
        _events.tryEmit(e)
    }

    private fun path(vararg rest: String) = listOf("v1", "conversations", id, *rest)

    // ------------------------------------------------------------------ loading

    /** Loads the latest page (called once when the conversation object is created). Returns hasMore. */
    suspend fun loadLatest(limit: Int = 50): Boolean = chat.onLoop {
        val page = chat.rest.request("GET", path("messages"), mapOf("limit" to limit)).o()
        messages.upsertMany(page.list("data").map { toMessage(it) })
        hasOlder = page.bool("hasMore")
        hasOlder
    }

    /** Older page before the oldest loaded message; code history_unavailable when the customer DB is down. */
    suspend fun loadOlder(limit: Int = 50): OlderPage = chat.onLoop {
        val before = messages.oldestSeq
        if (before == null || before <= 1) {
            hasOlder = false
            return@onLoop OlderPage(emptyList(), false)
        }
        val page = chat.rest.request("GET", path("messages"), mapOf("before" to before, "limit" to limit)).o()
        val msgs = page.list("data").map { toMessage(it) }
        messages.upsertMany(msgs)
        hasOlder = page.bool("hasMore")
        OlderPage(msgs, hasOlder)
    }

    // ------------------------------------------------------------------ sending

    /**
     * Resolves on ack. Network problems do not throw: the message stays pending in the outbox and is resent
     * with the same clientMsgId after the next connect.
     */
    suspend fun send(text: String? = null, replyTo: String? = null, attachments: List<String> = emptyList(), metadata: JsonObject? = null): Message {
        val clientMsgId = UUID.randomUUID().toString()
        val ack = chat.onLoop {
            messages.addPending(
                Message(
                    clientMsgId = clientMsgId, conversationId = id, senderId = chat.userId ?: "", text = text, replyTo = replyTo,
                    metadata = metadata ?: EMPTY_JSON, status = MessageStatus.SENDING, createdAt = nowIso(),
                ),
            )
            if (lastTypingSent != 0L) sendTyping("stop")
            chat.outbox.enqueue(
                OutboxEntry(
                    clientMsgId, id,
                    buildJsonObject {
                        put("cid", id)
                        put("clientMsgId", clientMsgId)
                        if (text != null) put("text", text)
                        if (replyTo != null) put("replyTo", replyTo)
                        if (attachments.isNotEmpty()) put("attachments", JsonArray(attachments.map(::JsonPrimitive)))
                        if (metadata != null) put("metadata", metadata)
                    },
                    System.currentTimeMillis(),
                ),
            )
        }
        return ack.await()
    }

    /** Retries a failed message with the same clientMsgId (dedup makes this safe). */
    suspend fun retry(clientMsgId: String): Message = chat.onLoop {
        val m = messages.getByClientId(clientMsgId)
        if (m == null || m.id != null) throw ChatException("not_found", "No failed message with that clientMsgId", "not_found")
        messages.markSending(clientMsgId)
        chat.outbox.retry(clientMsgId)
    }.await()

    suspend fun edit(messageId: String, text: String? = null, metadata: JsonObject? = null): Message = chat.onLoop {
        val cur = messages.get(messageId)
        val undo = messages.patch(messageId) { it.copy(text = text ?: it.text, metadata = metadata ?: it.metadata, editedAt = nowIso()) }
        try {
            val expectedVersion = cur?.version ?: chat.rest.request("GET", listOf("v1", "messages", messageId)).o().long("version")
            val body = buildJsonObject {
                if (text != null) put("text", text)
                if (metadata != null) put("metadata", metadata)
                put("expectedVersion", expectedVersion)
            }
            val msg = toMessage(chat.rest.request("PATCH", listOf("v1", "messages", messageId), body = body), cur?.clientMsgId)
            messages.upsert(msg)
            msg
        } catch (e: Exception) {
            undo?.invoke()
            throw e
        }
    }

    suspend fun delete(messageId: String): Unit = chat.onLoop {
        val undo = messages.patch(messageId) { it.copy(text = null, attachments = emptyList(), metadata = EMPTY_JSON, deletedAt = nowIso()) }
        try {
            chat.rest.request("DELETE", listOf("v1", "messages", messageId))
        } catch (e: Exception) {
            undo?.invoke()
            throw e
        }
    }

    /** Marks everything up to `seq` (default: latest) as read. Monotonic on the server. */
    suspend fun markRead(seq: Long? = null): Unit = chat.onLoop {
        val target = seq ?: latestSeq()
        if (target == 0L) return@onLoop
        unreadCount = 0
        val body = buildJsonObject { put("cid", id); put("seq", target) }
        if (chat.transport.isOpen) chat.transport.request("read", body)
        else chat.rest.request("POST", path("read"), body = buildJsonObject { put("seq", target) })
        chat.noteRead(id, target)
    }

    /** Call on every keystroke; sends at most one `typing start` per 3 s. */
    fun typing() {
        chat.scope.launch {
            val now = System.currentTimeMillis()
            if (now - lastTypingSent < TYPING_THROTTLE_MS) return@launch
            lastTypingSent = now
            chat.transport.send("typing", buildJsonObject { put("cid", id); put("state", "start") })
        }
    }

    /** Stops the typing indicator (e.g. on blur). */
    fun stopTyping() {
        chat.scope.launch { if (lastTypingSent != 0L) sendTyping("stop") }
    }

    private fun sendTyping(state: String) {
        lastTypingSent = 0
        chat.transport.send("typing", buildJsonObject { put("cid", id); put("state", state) })
    }

    suspend fun addMembers(userIds: List<String>) {
        chat.rest.request("POST", path("members"), body = buildJsonObject { put("userIds", JsonArray(userIds.map(::JsonPrimitive))) })
    }

    suspend fun removeMember(userId: String) {
        chat.rest.request("DELETE", path("members", userId))
    }

    suspend fun leave() = removeMember(chat.userId ?: throw ChatException("invalid_request", "Not connected yet", "invalid_request"))

    suspend fun mute() {
        chat.rest.request("PUT", path("mute"))
        muted = true
    }

    suspend fun unmute() {
        chat.rest.request("DELETE", path("mute"))
        muted = false
    }

    suspend fun update(name: String? = null, metadata: JsonObject? = null) {
        chat.rest.request("PATCH", path(), body = buildJsonObject {
            if (name != null) put("name", name)
            if (metadata != null) put("metadata", metadata)
        })
    }

    /** Members whose read watermark is at or past `seq` (excluding the sender of that message). */
    fun readBy(seq: Long): List<String> {
        val sender = messages.items.value.find { it.seq == seq }?.senderId
        return members.filter { (it.lastReadSeq ?: 0) >= seq && it.userId != sender }.map { it.userId }
    }

    private fun latestSeq(): Long = maxOf(messages.items.value.maxOfOrNull { it.seq ?: 0 } ?: 0, lastSeq)

    // ------------------------------------------------------------------ incoming (called by the chat loop)

    /** Applies one stream event in seq order; holds it and catches up when there is a gap. Duplicates are dropped. */
    internal fun applyEvent(seq: Long, e: String, d: JsonObject) {
        if (seq <= lastSeq) return
        if (catchingUp != null || seq > lastSeq + 1) {
            held.add(Held(seq, e, d))
            if (catchingUp == null) startCatchUp()
            return
        }
        apply(seq, e, d)
    }

    private fun apply(seq: Long, e: String, d: JsonObject) {
        lastSeq = seq
        when (e) {
            "message.new" -> {
                val m = toMessage(d["message"] ?: return)
                messages.upsert(m)
                if (m.senderId != chat.userId) {
                    unreadCount++
                    chat.receipts.delivered(id, seq)
                    clearTyping(m.senderId)
                }
                emit(ConversationEvent.MessageNew(messages.get(m.id!!) ?: m))
            }
            "message.updated" -> {
                val m = toMessage(d["message"] ?: return)
                messages.upsert(m)
                emit(ConversationEvent.MessageUpdated(messages.get(m.id!!) ?: m))
            }
            "message.deleted" -> {
                val mid = d.str("id") ?: return
                messages.patch(mid) { it.copy(text = null, attachments = emptyList(), metadata = EMPTY_JSON, deletedAt = d.str("deletedAt")) }
                messages.get(mid)?.let { emit(ConversationEvent.MessageDeleted(it)) }
            }
            "member.added" -> {
                val ids = (d["userIds"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }.orEmpty()
                members = members + ids.filter { u -> members.none { it.userId == u } }.map { Member(it) }
                emit(ConversationEvent.MemberAdded(ids, d.str("actorId")))
            }
            "member.removed" -> {
                val u = d.str("userId") ?: return
                members = members.filter { it.userId != u }
                emit(ConversationEvent.MemberRemoved(u, d.str("actorId"), d.str("reason")))
                if (u == chat.userId) markRemoved()
            }
            "conversation.created" -> d.obj("conversation")?.get("members")?.let {
                members = json.decodeFromJsonElement(kotlinx.serialization.builtins.ListSerializer(Member.serializer()), it)
            }
            "conversation.updated" -> {
                val changes = d.obj("changes")
                if (changes?.containsKey("name") == true) name = changes.str("name")
                if (changes?.containsKey("metadata") == true) metadata = changes.obj("metadata") ?: EMPTY_JSON
                emit(ConversationEvent.Updated)
            }
        }
    }

    /** Fetches events after lastSeq (and applies held live events); resync_required → reload the latest page. */
    internal suspend fun catchUp() = startCatchUp().await()

    private fun startCatchUp(): Deferred<Unit> = catchingUp ?: chat.scope.async {
        try {
            while (true) {
                val before = lastSeq
                val page = chat.rest.request("GET", path("events"), mapOf("after" to lastSeq, "limit" to 200)).o()
                for (ev in page.list("data")) {
                    val o = ev.o()
                    val seq = o.long("seq") ?: continue
                    if (seq == lastSeq + 1) apply(seq, o.str("type") ?: "", JsonObject(o - "seq" - "type"))
                }
                if (!page.bool("hasMore") || lastSeq == before) break // no progress: never spin
            }
            gapFailures = 0
        } catch (e: ChatException) {
            if (e.code == "resync_required" || ++gapFailures >= 3) resync() else throw e
        } finally {
            catchingUp = null
        }
        val h = held.sortedBy { it.seq }
        held = mutableListOf()
        for (x in h) applyEvent(x.seq, x.e, x.d)
    }.also { catchingUp = it }

    /** resync_required: drop the window, reload the latest page, continue from the server's lastSeq. */
    internal suspend fun resync() {
        val c = chat.rest.call<ServerConversation>("GET", path())
        messages.clear()
        lastSeq = c.lastSeq
        members = c.members.orEmpty().map { m -> members.find { it.userId == m.userId }?.copy(role = m.role) ?: m }
        loadLatest()
        held = held.filter { it.seq > lastSeq }.toMutableList()
        gapFailures = 0
    }

    internal fun onReceipt(d: JsonObject) {
        val userId = d.str("userId") ?: return
        val cur = members.find { it.userId == userId } ?: Member(userId)
        var read = cur.lastReadSeq
        var delivered = cur.lastDeliveredSeq
        d.long("lastReadSeq")?.let { read = maxOf(read ?: 0, it) }
        d.long("lastDeliveredSeq")?.let { delivered = maxOf(delivered ?: 0, it) }
        if (read != null && (delivered ?: 0) < read) delivered = read
        val next = cur.copy(lastReadSeq = read, lastDeliveredSeq = delivered)
        members = if (members.any { it.userId == userId }) members.map { if (it.userId == userId) next else it } else members + next
        emit(ConversationEvent.Receipt(userId, read ?: 0, delivered ?: 0))
    }

    internal fun onTyping(userId: String, state: String) {
        if (userId == chat.userId) return
        if (state == "stop") return clearTyping(userId)
        typingJobs.remove(userId)?.cancel()
        typingJobs[userId] = chat.scope.launch {
            delay(TYPING_EXPIRY_MS)
            clearTyping(userId)
        }
        publishTyping()
    }

    private fun clearTyping(userId: String) {
        val job = typingJobs.remove(userId) ?: return
        job.cancel()
        publishTyping()
    }

    private fun publishTyping() {
        _typing.value = typingJobs.keys.toList()
        emit(ConversationEvent.Typing(_typing.value))
    }

    internal fun emitFailed(m: Message) = emit(ConversationEvent.MessageFailed(m))

    internal fun markRemoved() {
        if (removed) return
        removed = true
        emit(ConversationEvent.Removed)
        chat.dropConversation(id)
    }
}

internal fun JsonObject.list(k: String): List<JsonElement> = (this[k] as? JsonArray).orEmpty()
internal fun JsonObject.bool(k: String): Boolean = (this[k] as? JsonPrimitive)?.contentOrNull == "true"
