import Foundation

// Errors mirror the server catalogue (docs/07-API-REFERENCE.md §1.7).

private let retryableCodes: Set<String> = [
    "rate_limited", "plan_limit_reached", "history_unavailable", "storage_unavailable", "internal", "network", "timeout", "resync_required",
]

public struct ChatError: Error, Sendable, Equatable, LocalizedError {
    public let code: String
    public let type: String
    public let message: String
    public let requestId: String?
    public let retryAfterMs: Int?
    public let status: Int?

    public init(code: String, type: String? = nil, message: String, requestId: String? = nil, retryAfterMs: Int? = nil, status: Int? = nil) {
        self.code = code
        self.type = type ?? (code == "network" ? "network" : "internal")
        self.message = message
        self.requestId = requestId
        self.retryAfterMs = retryAfterMs
        self.status = status
    }

    public var retryable: Bool { retryableCodes.contains(code) || (status ?? 0) >= 500 }

    /// Older history lives in a customer database that is temporarily unreachable; loaded pages stay.
    public var isHistoryUnavailable: Bool { code == "history_unavailable" }

    public var errorDescription: String? { message }

    static func network(_ message: String = "Network request failed") -> ChatError {
        ChatError(code: "network", type: "network", message: message)
    }

    static func from(_ error: Error, code: String = "internal") -> ChatError {
        error as? ChatError ?? ChatError(code: code, message: String(describing: error))
    }

    static func fromBody(status: Int, data: Data) -> ChatError {
        let e = (try? JSONDecoder().decode(JSON.self, from: data))?["error"]
        return ChatError(
            code: e?["code"]?.string ?? (status >= 500 ? "internal" : "invalid_request"),
            type: e?["type"]?.string,
            message: e?["message"]?.string ?? (e == nil && !data.isEmpty ? String(decoding: data.prefix(200), as: UTF8.self) : "Request failed with status \(status)"),
            requestId: e?["requestId"]?.string,
            retryAfterMs: e?["retryAfterMs"]?.int,
            status: status
        )
    }
}
