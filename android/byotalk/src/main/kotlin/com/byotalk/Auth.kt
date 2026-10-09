// Token cache + token provider calls (docs/09-SDK-DESIGN.md §4 AuthManager).
package com.byotalk

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okio.ByteString.Companion.decodeBase64

/** A fixed token, or a suspend function called before expiry and after token_expired. */
sealed class TokenSource {
    class Static(val token: String) : TokenSource()
    class Provider(val fetch: suspend () -> String) : TokenSource()
}

internal class AuthManager(private val source: TokenSource) {
    @Volatile private var token: String? = (source as? TokenSource.Static)?.token
    @Volatile private var expiresAt: Long? = token?.let(::tokenExpiry)
    private val mutex = Mutex()

    val canRefresh get() = source is TokenSource.Provider

    /** A token valid for at least 60 s more (refreshing through the provider when needed). */
    suspend fun get(): String {
        val t = token
        val exp = expiresAt
        if (t != null && (exp == null || exp - System.currentTimeMillis() > 60_000)) return t
        if (!canRefresh) return t ?: throw ChatException("token_invalid", "No token", "authentication") // static: let the server answer token_expired
        return refresh()
    }

    /** Calls the provider once even if many callers ask at the same time. */
    suspend fun refresh(): String {
        val p = source as? TokenSource.Provider
            ?: throw ChatException("token_expired", "Token expired and no token provider was given", "authentication")
        val before = token
        return mutex.withLock {
            token?.takeIf { it != before } ?: p.fetch().also {
                if (it.isEmpty()) throw ChatException("token_invalid", "token provider returned no token", "authentication")
                token = it
                expiresAt = tokenExpiry(it)
            }
        }
    }
}

/** Reads `exp` from a JWT without verifying (the server verifies). Dev tokens have no expiry. */
internal fun tokenExpiry(token: String): Long? {
    val part = token.split(".").getOrNull(1) ?: return null
    return try {
        val payload = part.decodeBase64()?.utf8() ?: return null
        json.parseToJsonElement(payload).objOrNull.long("exp")?.times(1000)
    } catch (_: Exception) {
        null
    }
}
