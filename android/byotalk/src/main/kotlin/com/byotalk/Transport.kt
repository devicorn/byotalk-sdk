// WebSocket lifecycle for chat.v1: auth-first, request/ack correlation, heartbeats, reconnect with
// full-jitter backoff, close-code handling (docs/08-REALTIME-PROTOCOL.md §1, §4–6).
// Everything here runs on the chat's single-threaded loop; OkHttp callbacks hop onto it.
package com.byotalk

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URLEncoder
import kotlin.random.Random

data class Hello(val sessionId: String, val userId: String, val heartbeatMs: Long, val tokenExpiresAt: String?)

private const val LIVENESS_MS = 60_000L

internal class Transport(
    private val realtimeUrl: String,
    private val env: String,
    private val sdk: String,
    private val auth: AuthManager,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
) {
    var onHello: () -> Unit = {}
    var onFrame: (JsonObject) -> Unit = {}
    var onError: (ChatException) -> Unit = {}

    private val _state = MutableStateFlow(ConnectionState.DISCONNECTED)
    val state: StateFlow<ConnectionState> = _state
    var hello: Hello? = null
        private set
    private var ws: WebSocket? = null
    private var wanted = false
    private var attempt = 0
    // Backoff restarts only after a connection that stayed up: a server that says hello and closes at once
    // must not get an instant reconnect loop.
    private var helloAt = 0L
    private var reqId = 0
    private val pending = HashMap<String, CompletableDeferred<JsonElement>>()
    private var reconnectJob: Job? = null
    private var livenessJob: Job? = null
    private var lastFrameAt = 0L
    private var authRefreshed = false

    fun setState(s: ConnectionState) {
        _state.value = s
    }

    val isOpen get() = ws != null && hello != null

    fun start() {
        if (wanted) return
        wanted = true
        attempt = 0
        scope.launch { open() }
    }

    /** Normal close (1000); no reconnect. */
    fun stop() {
        wanted = false
        clearTimers()
        val w = ws
        ws = null
        hello = null
        w?.close(1000, "client disconnect")
        failPending(ChatException("network", "Disconnected", "network"))
        setState(ConnectionState.DISCONNECTED)
    }

    /** Reconnect now (app foreground, network back): resets backoff. */
    fun reconnectNow() {
        if (!wanted || state.value == ConnectionState.FAILED) return
        if (state.value in setOf(ConnectionState.CONNECTED, ConnectionState.SYNCING, ConnectionState.CONNECTING)) return
        attempt = 0
        reconnectJob?.cancel()
        reconnectJob = null
        scope.launch { open() }
    }

    suspend fun request(t: String, d: JsonElement, timeoutMs: Long = 5_000): JsonElement {
        val w = ws
        if (w == null || hello == null) throw ChatException("network", "Not connected", "network")
        val id = (++reqId).toString()
        val reply = CompletableDeferred<JsonElement>()
        pending[id] = reply
        w.send(buildJsonObject { put("t", t); put("id", id); put("d", d) }.toString())
        return try {
            withTimeout(timeoutMs) { reply.await() }
        } catch (_: TimeoutCancellationException) {
            throw ChatException("timeout", "$t timed out", "network")
        } finally {
            pending.remove(id)
        }
    }

    fun send(t: String, d: JsonElement) {
        if (isOpen) ws?.send(buildJsonObject { put("t", t); put("d", d) }.toString())
    }

    private suspend fun open() {
        if (!wanted) return
        setState(if (attempt == 0 && state.value != ConnectionState.RECONNECTING) ConnectionState.CONNECTING else ConnectionState.RECONNECTING)
        val token = try {
            auth.get()
        } catch (e: ChatException) {
            return fail(e)
        } catch (e: Exception) {
            return fail(ChatException("token_invalid", e.message ?: "Token provider failed", "authentication"))
        }
        if (!wanted || ws != null) return
        val url = "${realtimeUrl.trimEnd('/')}/v1?env=${enc(env)}&sdk=${enc(sdk)}"
        val req = try {
            Request.Builder().url(url).header("Sec-WebSocket-Protocol", "chat.v1").build()
        } catch (_: IllegalArgumentException) {
            return fail(ChatException("invalid_request", "Bad realtimeUrl $realtimeUrl", "invalid_request"))
        }
        hello = null
        // The liveness clock starts with the attempt: a socket still in its TLS/upgrade handshake is not a dead one.
        lastFrameAt = System.currentTimeMillis()
        // Callbacks are posted to the loop, so they run after `ws` is assigned below.
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = post(webSocket) {
                lastFrameAt = System.currentTimeMillis()
                webSocket.send(buildJsonObject { put("t", "auth"); put("d", buildJsonObject { put("token", token) }) }.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) = post(webSocket) {
                lastFrameAt = System.currentTimeMillis()
                val f = try { json.parseToJsonElement(text) as? JsonObject } catch (_: Exception) { null }
                if (f != null) handleFrame(f)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                post(webSocket) { onClose(code, reason) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = post(webSocket) { onClose(1006, "") }
        })
        startLiveness()
    }

    private fun post(socket: WebSocket, block: () -> Unit) {
        scope.launch { if (ws === socket) block() }
    }

    private fun handleFrame(f: JsonObject) {
        val d = f.obj("d")
        when (f.str("t")) {
            "hello" -> {
                hello = Hello(d.str("sessionId") ?: "", d.str("userId") ?: "", d.long("heartbeatMs") ?: 25_000, d.str("tokenExpiresAt"))
                helloAt = System.currentTimeMillis()
                authRefreshed = false
                onHello()
            }
            "ack", "error" -> {
                val p = f.str("re")?.let { pending.remove(it) }
                if (p != null) {
                    if (f.str("t") == "ack") p.complete(f["d"] ?: EMPTY_JSON)
                    else p.completeExceptionally(ChatException(f.str("code") ?: "internal", f.str("message") ?: "Request failed", retryAfterMs = f.long("retryAfterMs")))
                } else if (f.str("t") == "error") {
                    onError(ChatException(f.str("code") ?: "internal", f.str("message") ?: "Server error"))
                }
            }
            "hb" -> send("hb", EMPTY_JSON)
            "goaway" -> {
                ws?.close(1000, "goaway")
                dropSocket()
                scheduleReconnect(d.long("reconnectAfterMs") ?: 0)
            }
            "token_expiring" -> scope.launch { refreshToken() }
            else -> onFrame(f)
        }
    }

    private suspend fun refreshToken() {
        if (!auth.canRefresh) return
        try {
            val token = auth.refresh()
            request("token.refresh", buildJsonObject { put("token", token) })
        } catch (e: ChatException) {
            onError(e)
        }
    }

    private fun onClose(code: Int, reason: String) {
        dropSocket()
        if (!wanted) return
        val info = try { json.parseToJsonElement(reason) as? JsonObject } catch (_: Exception) { null }
        fun err(c: String, type: String) = ChatException(
            info.str("code") ?: c, info.str("message") ?: reason.ifEmpty { "Connection closed ($code)" }, type, retryAfterMs = info.long("retryAfterMs"),
        )
        when (code) {
            4001 -> {
                // Token problem: refresh once through the provider, else give up.
                if (auth.canRefresh && !authRefreshed) {
                    authRefreshed = true
                    scope.launch {
                        try {
                            auth.refresh()
                            scheduleReconnect(0)
                        } catch (e: Exception) {
                            fail(e as? ChatException ?: err("token_invalid", "authentication"))
                        }
                    }
                } else fail(err("token_invalid", "authentication"))
            }
            4003 -> fail(err("forbidden", "permission"))
            4009 -> fail(err("too_many_connections", "rate_limited"))
            4008 -> scheduleReconnect(info.long("retryAfterMs") ?: backoffDelay(attempt++))
            1009 -> {
                onError(err("body_too_large", "payload_too_large"))
                scheduleReconnect()
            }
            1012 -> scheduleReconnect(Random.nextLong(5_000))
            else -> scheduleReconnect()
        }
    }

    private fun dropSocket() {
        ws = null
        hello = null
        livenessJob?.cancel()
        livenessJob = null
        failPending(ChatException("network", "Connection lost", "network"))
    }

    private fun scheduleReconnect(delayMs: Long? = null) {
        if (!wanted) return
        setState(ConnectionState.RECONNECTING)
        if (helloAt != 0L && System.currentTimeMillis() - helloAt > 30_000) attempt = 0
        helloAt = 0
        val ms = delayMs ?: backoffDelay(attempt++)
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(ms)
            reconnectJob = null
            open()
        }
    }

    private fun fail(e: ChatException) {
        wanted = false
        clearTimers()
        onError(e) // before the state change, so connect() can report this error
        setState(ConnectionState.FAILED)
    }

    private fun startLiveness() {
        livenessJob?.cancel()
        livenessJob = scope.launch {
            while (isActive) {
                delay(5_000)
                val w = ws
                if (w != null && System.currentTimeMillis() - lastFrameAt > LIVENESS_MS) {
                    dropSocket()
                    w.cancel()
                    scheduleReconnect()
                    return@launch
                }
            }
        }
    }

    private fun clearTimers() {
        reconnectJob?.cancel()
        livenessJob?.cancel()
        reconnectJob = null
        livenessJob = null
    }

    private fun failPending(e: ChatException) {
        for (p in pending.values) p.completeExceptionally(e)
        pending.clear()
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}
