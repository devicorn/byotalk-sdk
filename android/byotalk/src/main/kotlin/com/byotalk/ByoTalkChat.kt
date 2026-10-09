// The client: connection machine, sync engine, outbox, receipts, presence (docs/09-SDK-DESIGN.md §3–4).
// All SDK state lives on one single-threaded coroutine "loop" (like the JS event loop), so there are no locks;
// public suspend functions hop onto it and callers may use any dispatcher.
package com.byotalk

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient

@Serializable
internal data class OutboxEntry(val clientMsgId: String, val cid: String, val payload: JsonObject, val createdAt: Long)

private const val OUTBOX_TTL_MS = 24 * 3600_000L

/** Pending sends keyed by clientMsgId; flushed after every hello; persisted through the PersistenceAdapter. */
internal class Outbox(private val chat: ByoTalkChat) {
    private val entries = LinkedHashMap<String, OutboxEntry>()
    private val waiters = HashMap<String, CompletableDeferred<Message>>()
    private val failedEntries = HashMap<String, OutboxEntry>()
    private var flushing = false

    val size get() = entries.size

    suspend fun enqueue(e: OutboxEntry): Deferred<Message> {
        entries[e.clientMsgId] = e
        persist()
        val w = waiters.getOrPut(e.clientMsgId) { CompletableDeferred() }
        if (chat.transport.isOpen) chat.scope.launch { sendOne(e) }
        return w
    }

    suspend fun retry(clientMsgId: String): Deferred<Message> {
        failedEntries.remove(clientMsgId)?.let {
            entries[clientMsgId] = it.copy(createdAt = System.currentTimeMillis())
            persist()
        }
        val e = entries[clientMsgId] ?: throw ChatException("not_found", "Message is not in the outbox", "not_found")
        val w = waiters.getOrPut(clientMsgId) { CompletableDeferred() }
        if (chat.transport.isOpen) chat.scope.launch { sendOne(e) }
        return w
    }

    suspend fun flush() {
        if (flushing) return
        flushing = true
        try {
            for (e in entries.values.sortedBy { it.createdAt }) {
                if (!chat.transport.isOpen) break
                sendOne(e)
            }
        } finally {
            flushing = false
        }
    }

    private suspend fun sendOne(e: OutboxEntry) {
        if (!entries.containsKey(e.clientMsgId)) return // already acked by a parallel send
        if (System.currentTimeMillis() - e.createdAt > OUTBOX_TTL_MS) {
            return failed(e, ChatException("expired", "Message was not sent within 24 hours", "invalid_request"))
        }
        try {
            val ack = chat.transport.request("message.send", e.payload).o()
            val id = ack.str("id")!!
            val seq = ack.long("seq")!!
            val createdAt = ack.str("createdAt") ?: nowIso()
            entries.remove(e.clientMsgId)
            persist()
            val conv = chat.cached(e.cid)
            conv?.messages?.reconcile(e.clientMsgId, id, seq, createdAt)
            val msg = conv?.messages?.get(id) ?: Message(
                id = id, clientMsgId = e.clientMsgId, conversationId = e.cid, seq = seq, senderId = chat.userId ?: "",
                text = e.payload.str("text"), replyTo = e.payload.str("replyTo"), metadata = e.payload.obj("metadata") ?: EMPTY_JSON,
                createdAt = createdAt,
            )
            waiters.remove(e.clientMsgId)?.complete(msg)
        } catch (err: ChatException) {
            // Retryable problems keep the message pending; it is resent after the next hello.
            if (err.retryable || err.code == "network" || err.code == "timeout") {
                val after = err.retryAfterMs
                if (err.code == "rate_limited" && after != null) chat.scope.launch {
                    delay(after)
                    if (chat.transport.isOpen) sendOne(e)
                }
                return
            }
            failed(e, err)
        }
    }

    private suspend fun failed(e: OutboxEntry, err: ChatException) {
        entries.remove(e.clientMsgId)
        persist()
        val conv = chat.cached(e.cid)
        conv?.messages?.markFailed(e.clientMsgId, err)
        conv?.messages?.getByClientId(e.clientMsgId)?.let { conv.emitFailed(it) }
        waiters.remove(e.clientMsgId)?.completeExceptionally(err)
        failedEntries[e.clientMsgId] = e // retry() can resend it with the same clientMsgId
    }

    suspend fun load() {
        val raw = chat.persistence.get(chat.key("outbox")) ?: return
        try {
            for (e in json.decodeFromString(ListSerializer(OutboxEntry.serializer()), raw)) entries.putIfAbsent(e.clientMsgId, e)
        } catch (_: Exception) {
            // corrupt entry: ignore
        }
    }

    private suspend fun persist() {
        if (chat.userId == null) return
        chat.persistence.set(chat.key("outbox"), json.encodeToString(ListSerializer(OutboxEntry.serializer()), entries.values.toList()))
    }
}

/** Delivered acks batched to at most one frame per second (docs/08 §10). */
internal class ReceiptBatcher(private val chat: ByoTalkChat) {
    private val pending = LinkedHashMap<String, Long>()
    private var timer: Job? = null

    fun delivered(cid: String, seq: Long) {
        pending[cid] = maxOf(pending[cid] ?: 0, seq)
        if (timer == null) timer = chat.scope.launch {
            delay(1_000)
            flush()
        }
    }

    fun flush() {
        timer = null
        if (pending.isEmpty() || !chat.transport.isOpen) return
        val items = JsonArray(pending.map { (cid, seq) -> buildJsonObject { put("cid", cid); put("seq", seq) } })
        pending.clear()
        chat.transport.send("delivered", buildJsonObject { put("items", items) })
    }
}

/**
 * ByoTalk chat client for Android and the JVM.
 *
 * @param token a user token, or `TokenSource.Provider { fetchFromYourBackend() }`; `devToken("alice")` in development.
 */
class ByoTalkChat(
    val env: String,
    token: TokenSource,
    baseUrl: String = "https://api.byotalk.com",
    realtimeUrl: String = "wss://rt.byotalk.com",
    val persistence: PersistenceAdapter = MemoryPersistence(),
    httpClient: OkHttpClient = OkHttpClient(),
    sdkName: String = "kotlin",
) {
    constructor(
        env: String,
        token: String,
        baseUrl: String = "https://api.byotalk.com",
        realtimeUrl: String = "wss://rt.byotalk.com",
        persistence: PersistenceAdapter = MemoryPersistence(),
    ) : this(env, TokenSource.Static(token), baseUrl, realtimeUrl, persistence)

    constructor(
        env: String,
        tokenProvider: suspend () -> String,
        baseUrl: String = "https://api.byotalk.com",
        realtimeUrl: String = "wss://rt.byotalk.com",
        persistence: PersistenceAdapter = MemoryPersistence(),
    ) : this(env, TokenSource.Provider(tokenProvider), baseUrl, realtimeUrl, persistence)

    companion object {
        const val SDK_VERSION = "0.1.0"

        /** `dev:<userId>`; accepted only by development environments with dev tokens enabled. */
        @JvmStatic
        fun devToken(userId: String) = "dev:$userId"
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    internal val loop = Dispatchers.Default.limitedParallelism(1)
    private val _errors = MutableSharedFlow<ChatException>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    internal val scope = CoroutineScope(SupervisorJob() + loop + CoroutineExceptionHandler { _, e ->
        _errors.tryEmit(e as? ChatException ?: ChatException("internal", e.toString()))
    })
    internal val rest: RestClient
    internal val transport: Transport
    internal val outbox = Outbox(this)
    internal val receipts = ReceiptBatcher(this)

    private val convs = HashMap<String, Conversation>()
    private val loading = HashMap<String, Deferred<Conversation>>()
    private val summaryMap = LinkedHashMap<String, ConversationSummary>()
    private val _summaries = MutableStateFlow<List<ConversationSummary>>(emptyList())
    private var watchingSummaries = false
    private class PresenceWatcher(val userIds: List<String>, val cb: (Presence) -> Unit)
    private val presenceWatchers = LinkedHashMap<Int, PresenceWatcher>()
    private var presenceSeq = 0
    private var syncCursor: String? = null
    private var lastError: ChatException? = null

    @Volatile var userId: String? = null
        private set

    init {
        if (env.isEmpty()) throw ChatException("invalid_request", "env is required", "invalid_request")
        if (token is TokenSource.Static) {
            if (token.token.isEmpty()) throw ChatException("invalid_request", "token is required", "invalid_request")
            if (token.token.startsWith("sk_")) throw ChatException(
                "invalid_request", "That is a secret key: it belongs on your server. Pass a user token instead", "invalid_request",
            )
            if (token.token.startsWith("dev:")) userId = token.token.removePrefix("dev:")
        }
        val auth = AuthManager(token)
        rest = RestClient(baseUrl, env, auth, httpClient)
        transport = Transport(realtimeUrl, env, "$sdkName/$SDK_VERSION", auth, httpClient, scope)
        transport.onError = { e ->
            lastError = e
            _errors.tryEmit(e)
        }
        transport.onHello = { scope.launch { afterHello() } }
        transport.onFrame = ::onFrame
    }

    /** disconnected → connecting → syncing → connected; reconnecting after drops; failed on auth/permission errors. */
    val connection: StateFlow<ConnectionState> get() = transport.state
    val connectionState: ConnectionState get() = transport.state.value
    val errors: SharedFlow<ChatException> = _errors

    internal suspend fun <T> onLoop(block: suspend () -> T): T = withContext(loop) { block() }

    /** Namespaced persistence key for this environment and user. */
    internal fun key(name: String) = "byotalk:$env:${userId ?: "anon"}:$name"

    /** Returns once connected (hello received and sync finished); throws ChatException if the connection failed. */
    suspend fun connect() {
        onLoop {
            if (transport.state.value == ConnectionState.FAILED) transport.setState(ConnectionState.DISCONNECTED)
            lastError = null
            transport.start()
        }
        val s = transport.state.first { it == ConnectionState.CONNECTED || it == ConnectionState.FAILED }
        if (s == ConnectionState.FAILED) throw lastError ?: ChatException("failed", "Connection failed", "authentication")
    }

    suspend fun disconnect() = onLoop {
        receipts.flush()
        transport.stop()
    }

    /** Reconnect now, resetting backoff (app came to the foreground, network came back). */
    fun reconnectNow() {
        scope.launch { transport.reconnectNow() }
    }

    /** Deletes what this user left in persistence (unsent messages, sync cursor). Call on sign-out, before disconnect. */
    suspend fun clearLocalData() {
        for (k in listOf("outbox", "cursor")) persistence.delete(key(k))
    }

    // ------------------------------------------------------------------ sync after hello (docs/08 §7.2)

    private suspend fun afterHello() {
        val hello = transport.hello ?: return
        val firstUser = userId == null || userId != hello.userId
        userId = hello.userId
        if (firstUser || syncCursor == null) {
            syncCursor = persistence.get(key("cursor"))
            outbox.load()
        }
        transport.setState(ConnectionState.SYNCING)
        try {
            coroutineScope {
                listOf(async { runSync() }, async { outbox.flush() }, async { rewatchPresence(null) }).awaitAll()
            }
        } catch (e: ChatException) {
            // The socket is up; serve live events and let the next hello retry the sync.
            _errors.tryEmit(e)
        }
        if (transport.isOpen) transport.setState(ConnectionState.CONNECTED)
    }

    private suspend fun runSync() {
        val r = transport.request("sync", buildJsonObject { put("cursor", syncCursor?.let(::JsonPrimitive) ?: JsonNull) }, 10_000).o()
        val list = r.list("conversations").map { it.o() }
        for (c in list) {
            val id = c.str("id") ?: continue
            val lastSeq = c.long("lastSeq") ?: 0
            val unread = c.long("unreadCount")?.toInt() ?: 0
            summaryMap[id]?.let { summaryMap[id] = it.copy(lastSeq = lastSeq, unreadCount = unread) }
            val conv = convs[id] ?: continue
            conv.unreadCount = unread
            if (lastSeq > conv.lastSeq) runCatching { conv.catchUp() }
        }
        for (id in r.list("removed")) convs[(id as JsonPrimitive).content]?.markRemoved()
        if (r.bool("fullReload") || list.any { !summaryMap.containsKey(it.str("id")) }) runCatching { refreshSummaries() }
        else notifySummaries()
        val cursor = r.str("cursor")
        syncCursor = cursor
        if (cursor != null) persistence.set(key("cursor"), cursor)
    }

    // ------------------------------------------------------------------ incoming frames

    private fun onFrame(f: JsonObject) {
        val d = f.obj("d") ?: EMPTY_JSON
        when (f.str("t")) {
            "event" -> {
                val cid = f.str("cid") ?: return
                val seq = f.long("seq") ?: return
                val e = f.str("e") ?: return
                val conv = convs[cid]
                conv?.applyEvent(seq, e, d)
                updateSummary(e, cid, seq, d)
                if (e == "conversation.created" && conv == null) notifySummaries()
            }
            "receipt" -> convs[d.str("cid")]?.onReceipt(d)
            "typing" -> convs[d.str("cid")]?.onTyping(d.str("userId") ?: return, d.str("state") ?: return)
            "presence" -> {
                val p = json.decodeFromJsonElement(Presence.serializer(), d)
                for (w in presenceWatchers.values.toList()) if (p.userId in w.userIds) w.cb(p)
            }
            "resync_required" -> convs[d.str("cid")]?.let { c -> scope.launch { c.resync() } }
            "resync_hint" -> scope.launch { runCatching { runSync() } }
        }
    }

    private fun updateSummary(e: String, cid: String, seq: Long, d: JsonObject) {
        if (e == "member.removed" && d.str("userId") == userId) {
            summaryMap.remove(cid)
            return notifySummaries()
        }
        val s = summaryMap[cid]
        if (s == null) {
            if (e == "conversation.created" || e == "message.new") scope.launch { runCatching { refreshSummaries() } }
            return
        }
        var next = s.copy(lastSeq = maxOf(s.lastSeq, seq), lastActivityAt = nowIso())
        if (e == "message.new") {
            val m = d["message"]?.let { toMessage(it) }
            next = next.copy(lastMessage = m, unreadCount = if (m != null && m.senderId != userId) minOf(99, s.unreadCount + 1) else s.unreadCount)
        }
        if (e == "conversation.updated") {
            val ch = d.obj("changes")
            if (ch?.containsKey("name") == true) next = next.copy(name = ch.str("name"))
            if (ch?.containsKey("metadata") == true) next = next.copy(metadata = ch.obj("metadata") ?: EMPTY_JSON)
        }
        summaryMap[cid] = next
        notifySummaries()
    }

    /** The user read a conversation up to `seq`: clear its badge in the summaries. */
    internal fun noteRead(cid: String, seq: Long) {
        val s = summaryMap[cid] ?: return
        summaryMap[cid] = s.copy(unreadCount = if (seq >= s.lastSeq) 0 else s.unreadCount, lastReadSeq = maxOf(s.lastReadSeq, seq))
        notifySummaries()
    }

    private fun notifySummaries() {
        _summaries.value = summaryMap.values.sortedByDescending { it.lastActivityAt }
    }

    private suspend fun refreshSummaries() {
        if (!watchingSummaries) return
        val page = rest.call<Page<ConversationSummary>>("GET", listOf("v1", "conversations"), mapOf("limit" to 100))
        summaryMap.clear()
        for (s in page.data) summaryMap[s.id] = s
        notifySummaries()
    }

    // ------------------------------------------------------------------ conversations

    internal fun cached(id: String) = convs[id]

    internal fun dropConversation(id: String) {
        convs.remove(id)
        summaryMap.remove(id)
        notifySummaries()
    }

    private suspend fun materialize(c: ServerConversation): Conversation {
        convs[c.id]?.let { return it }
        loading[c.id]?.let { return it.await() }
        val p = scope.async {
            val conv = Conversation(this@ByoTalkChat, c)
            convs[c.id] = conv
            try {
                conv.loadLatest()
                val members = rest.request("GET", listOf("v1", "conversations", c.id, "members")).o()
                conv.members = json.decodeFromJsonElement(ListSerializer(Member.serializer()), members["data"] ?: JsonArray(emptyList()))
                conv.unreadCount = summaryMap[c.id]?.unreadCount ?: 0
                if (transport.isOpen) runCatching { conv.catchUp() }
                conv
            } catch (e: Exception) {
                convs.remove(c.id)
                throw e
            } finally {
                loading.remove(c.id)
            }
        }
        loading[c.id] = p
        return p.await()
    }

    /** `chat.conversations.direct(...)`, `.create(...)`, `.get(...)`, `.list()`, `.watch()`. */
    val conversations = Conversations()

    inner class Conversations internal constructor() {
        /** The one-to-one conversation with `userId` (created on first use). */
        suspend fun direct(userId: String): Conversation = onLoop {
            val body = buildJsonObject {
                put("type", "direct")
                put("members", JsonArray(listOf(JsonPrimitive(userId))))
            }
            materialize(rest.call("POST", listOf("v1", "conversations"), body = body, idempotent = true))
        }

        suspend fun create(members: List<String>, name: String? = null, metadata: JsonObject? = null): Conversation = onLoop {
            val body = buildJsonObject {
                put("type", "group")
                put("members", JsonArray(members.map(::JsonPrimitive)))
                if (name != null) put("name", name)
                if (metadata != null) put("metadata", metadata)
            }
            materialize(rest.call("POST", listOf("v1", "conversations"), body = body, idempotent = true))
        }

        suspend fun get(id: String): Conversation = onLoop {
            convs[id] ?: materialize(rest.call("GET", listOf("v1", "conversations", id)))
        }

        /** One page of summaries (unreadCount, lastMessage, metadata), most recent activity first. */
        suspend fun list(limit: Int? = null, cursor: String? = null): Page<ConversationSummary> = onLoop {
            val page = rest.call<Page<ConversationSummary>>("GET", listOf("v1", "conversations"), mapOf("limit" to limit, "cursor" to cursor))
            for (s in page.data) summaryMap[s.id] = s
            notifySummaries()
            page
        }

        /** Live list sorted by activity; kept up to date by events and sync. */
        fun watch(): StateFlow<List<ConversationSummary>> {
            scope.launch {
                watchingSummaries = true
                refreshSummaries()
            }
            return _summaries
        }
    }

    // ------------------------------------------------------------------ presence

    val presence = PresenceApi()

    inner class PresenceApi internal constructor() {
        /** Online/offline for these users (union of all watches ≤ 200 per connection); the snapshot comes first. */
        fun watch(userIds: List<String>): Flow<Presence> = callbackFlow {
            val id = onLoop {
                val id = ++presenceSeq
                presenceWatchers[id] = PresenceWatcher(userIds.distinct()) { trySend(it) }
                rewatchPresence(id)
                id
            }
            awaitClose {
                scope.launch {
                    presenceWatchers.remove(id)
                    rewatchPresence(null)
                }
            }
        }
    }

    private suspend fun rewatchPresence(snapshotFor: Int?) {
        if (!transport.isOpen) return
        val union = presenceWatchers.values.flatMap { it.userIds }.distinct().take(200)
        val r = try {
            transport.request("presence.watch", buildJsonObject { put("userIds", JsonArray(union.map(::JsonPrimitive))) }).o()
        } catch (_: ChatException) {
            return
        }
        val snapshot = json.decodeFromJsonElement(ListSerializer(Presence.serializer()), r["presence"] ?: JsonArray(emptyList()))
        for ((id, w) in presenceWatchers) {
            if (snapshotFor != null && id != snapshotFor) continue
            for (p in snapshot) if (p.userId in w.userIds) w.cb(p)
        }
    }
}
