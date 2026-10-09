// Public models, errors and small helpers (mirrors byotalk-sdk/src/core/types.ts, errors.ts, util.ts).
package com.byotalk

import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.min
import kotlin.random.Random

internal val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
}

internal val EMPTY_JSON = JsonObject(emptyMap())

enum class ConnectionState { DISCONNECTED, CONNECTING, SYNCING, CONNECTED, RECONNECTING, FAILED }

enum class MessageStatus { SENDING, SENT, FAILED }

@Serializable
data class Attachment(
    val id: String,
    val name: String = "",
    val size: Long = 0,
    val mimeType: String = "",
    val width: Int? = null,
    val height: Int? = null,
)

@Serializable
data class Message(
    /** null while sending */
    val id: String? = null,
    /** own messages only */
    val clientMsgId: String? = null,
    val conversationId: String,
    val seq: Long? = null,
    val senderId: String,
    val text: String? = null,
    val replyTo: String? = null,
    val attachments: List<Attachment> = emptyList(),
    val metadata: JsonObject = EMPTY_JSON,
    val version: Int = 1,
    @Transient val status: MessageStatus = MessageStatus.SENT,
    @Transient val error: ChatException? = null,
    /** server time once sent; local time while sending */
    val createdAt: String,
    val editedAt: String? = null,
    val deletedAt: String? = null,
)

@Serializable
data class Member(
    val userId: String,
    val role: String = "member",
    val lastReadSeq: Long? = null,
    val lastDeliveredSeq: Long? = null,
)

@Serializable
data class ConversationSummary(
    val id: String,
    val type: String,
    val name: String? = null,
    val metadata: JsonObject = EMPTY_JSON,
    val lastSeq: Long = 0,
    val unreadCount: Int = 0,
    val lastReadSeq: Long = 0,
    val muted: Boolean = false,
    val lastActivityAt: String = "",
    val lastMessage: Message? = null,
)

@Serializable
data class Page<T>(val data: List<T>, val nextCursor: String? = null)

@Serializable
data class Presence(val userId: String, val online: Boolean, val lastSeenAt: String? = null)

@Serializable
internal data class ServerConversation(
    val id: String,
    val type: String,
    val name: String? = null,
    val metadata: JsonObject = EMPTY_JSON,
    val lastSeq: Long = 0,
    val members: List<Member>? = null,
    val lastReadSeq: Long? = null,
    val muted: Boolean? = null,
)

/** Server message → store message (the server's clientMsgId is ignored, as in the TS SDK). */
internal fun toMessage(m: JsonElement, clientMsgId: String? = null): Message =
    json.decodeFromJsonElement(Message.serializer(), m).copy(clientMsgId = clientMsgId, status = MessageStatus.SENT)

/** Where unsent messages and the sync cursor live between app starts. */
interface PersistenceAdapter {
    suspend fun get(key: String): String?
    suspend fun set(key: String, value: String)
    suspend fun delete(key: String)
}

/** Default adapter: nothing survives a restart (unsent messages are lost when the app is killed). */
class MemoryPersistence : PersistenceAdapter {
    private val m = ConcurrentHashMap<String, String>()
    override suspend fun get(key: String) = m[key]
    override suspend fun set(key: String, value: String) { m[key] = value }
    override suspend fun delete(key: String) { m.remove(key) }
}

private val RETRYABLE = setOf("rate_limited", "plan_limit_reached", "history_unavailable", "storage_unavailable", "internal", "network", "timeout", "resync_required")

/** Errors mirror the server catalogue (docs/07-API-REFERENCE.md §1.7). */
class ChatException(
    val code: String,
    message: String,
    val type: String = if (code == "network") "network" else "internal",
    val requestId: String? = null,
    val retryAfterMs: Long? = null,
    val status: Int? = null,
) : Exception(message) {
    val retryable: Boolean get() = code in RETRYABLE || (status != null && status >= 500)
    override fun toString() = "ChatException($code: $message${requestId?.let { ", requestId=$it" } ?: ""})"
}

internal fun errorFromBody(status: Int, body: JsonElement?): ChatException {
    val e = (body as? JsonObject)?.get("error") as? JsonObject
    return ChatException(
        code = e.str("code") ?: if (status >= 500) "internal" else "invalid_request",
        message = e.str("message") ?: "Request failed with status $status",
        type = e.str("type") ?: if (status >= 500) "internal" else "invalid_request",
        requestId = e.str("requestId"),
        retryAfterMs = e.long("retryAfterMs"),
        status = status,
    )
}

/** Full-jitter exponential backoff (docs/08 §6): random(0, min(cap, base * 2^attempt)). */
fun backoffDelay(attempt: Int, base: Long = 500, cap: Long = 30_000, rand: () -> Double = { Random.nextDouble() }): Long =
    (rand() * min(cap, base shl min(attempt, 20))).toLong()

internal fun JsonObject?.str(k: String): String? = (this?.get(k) as? JsonPrimitive)?.contentOrNull
internal fun JsonObject?.long(k: String): Long? = (this?.get(k) as? JsonPrimitive)?.longOrNull
internal fun JsonObject?.obj(k: String): JsonObject? = this?.get(k) as? JsonObject
internal val JsonElement.objOrNull: JsonObject? get() = this as? JsonObject
internal fun JsonElement.o(): JsonObject = jsonObject

/** ISO-8601 UTC timestamp (java.time needs API 26; minSdk is 24). */
internal fun nowIso(): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
