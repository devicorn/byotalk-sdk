import Foundation

// Token cache + token provider calls (docs/09-SDK-DESIGN.md §4 AuthManager).

/// A token, or a function that returns one (called before expiry and after token_expired).
public enum TokenSource: Sendable, ExpressibleByStringLiteral {
    case token(String)
    case provider(@Sendable () async throws -> String)

    public init(stringLiteral value: String) { self = .token(value) }
}

actor AuthManager {
    private let source: TokenSource
    private var token: String?
    private var expiresAt: Date?
    private var inflight: Task<String, Error>?

    init(_ source: TokenSource) {
        self.source = source
        if case .token(let t) = source {
            token = t
            expiresAt = tokenExpiry(t)
        }
    }

    nonisolated var canRefresh: Bool {
        if case .provider = source { return true }
        return false
    }

    /// A token valid for at least 60 s more (refreshing through the provider when needed).
    func get() async throws -> String {
        if let token, expiresAt.map({ $0.timeIntervalSinceNow > 60 }) ?? true { return token }
        if !canRefresh {
            if let token { return token } // static token: let the server answer token_expired
            throw ChatError(code: "token_invalid", type: "authentication", message: "No token")
        }
        return try await refresh()
    }

    /// Calls the provider once even if many callers ask at the same time.
    func refresh() async throws -> String {
        guard case .provider(let provide) = source else {
            throw ChatError(code: "token_expired", type: "authentication", message: "Token expired and no token provider was given")
        }
        let task = inflight ?? Task { try await provide() }
        inflight = task
        defer { if inflight == task { inflight = nil } }
        let t = try await task.value
        guard !t.isEmpty else { throw ChatError(code: "token_invalid", type: "authentication", message: "Token provider returned no token") }
        token = t
        expiresAt = tokenExpiry(t)
        return t
    }
}
