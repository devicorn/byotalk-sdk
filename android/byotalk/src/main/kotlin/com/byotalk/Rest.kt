// REST client: idempotency keys, bounded retries for 5xx/429/network, one refresh on token_expired (docs/09 §4).
package com.byotalk

import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private val JSON_TYPE = "application/json".toMediaType()

internal class RestClient(baseUrl: String, private val env: String, private val auth: AuthManager, private val http: OkHttpClient) {
    private val base = baseUrl.trimEnd('/').toHttpUrl()

    /** `path` segments are percent-encoded one by one: an id taken from a deep link can never reach another endpoint. */
    suspend fun request(
        method: String,
        path: List<String>,
        query: Map<String, Any?> = emptyMap(),
        body: JsonElement? = null,
        idempotent: Boolean = false,
    ): JsonElement {
        val url = base.newBuilder().apply {
            for (p in path) {
                if (p.isEmpty() || p == "." || p == "..") throw IllegalArgumentException("Invalid id \"$p\"")
                addPathSegment(p)
            }
            addQueryParameter("env", env)
            for ((k, v) in query) if (v != null) addQueryParameter(k, v.toString())
        }.build()
        val retrySafe = method == "GET" || idempotent
        val idemKey = if (idempotent && method != "GET") UUID.randomUUID().toString() else null
        val reqBody = body?.toString()?.toRequestBody(JSON_TYPE)
            ?: if (method == "GET" || method == "DELETE") null else ByteArray(0).toRequestBody(null)
        var refreshed = false
        var attempt = 0
        while (true) {
            val req = Request.Builder().url(url).method(method, reqBody)
                .header("authorization", "Bearer ${auth.get()}")
                .header("byotalk-env", env)
                .apply { if (idemKey != null) header("idempotency-key", idemKey) }
                .build()
            val (status, text) = try {
                http.newCall(req).await()
            } catch (e: IOException) {
                if (retrySafe && attempt < 3) {
                    delay(backoffDelay(attempt++, 300, 5_000))
                    continue
                }
                throw ChatException("network", "Network request failed", "network")
            }
            val parsed = if (text.isEmpty()) JsonNull else try {
                json.parseToJsonElement(text)
            } catch (_: Exception) {
                buildJsonObject { put("error", buildJsonObject { put("code", "internal"); put("message", text.take(200)) }) }
            }
            if (status in 200..299) return parsed
            val err = errorFromBody(status, parsed)
            if (err.code == "token_expired" && !refreshed && auth.canRefresh) {
                refreshed = true
                auth.refresh()
                continue
            }
            if (retrySafe && attempt < 3 && (status >= 500 || status == 429)) {
                delay(err.retryAfterMs ?: backoffDelay(attempt, 300, 5_000))
                attempt++
                continue
            }
            throw err
        }
    }

    suspend inline fun <reified T> call(
        method: String,
        path: List<String>,
        query: Map<String, Any?> = emptyMap(),
        body: JsonElement? = null,
        idempotent: Boolean = false,
    ): T = json.decodeFromJsonElement(request(method, path, query, body, idempotent))
}

/** Status and body text; the body is read on OkHttp's thread so the SDK loop never blocks on I/O. */
private suspend fun Call.await(): Pair<Int, String> = suspendCancellableCoroutine { c ->
    c.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = c.resumeWithException(e)
        override fun onResponse(call: Call, response: Response) {
            try {
                response.use { c.resume(it.code to (it.body?.string() ?: "")) }
            } catch (e: IOException) {
                c.resumeWithException(e)
            }
        }
    })
}
