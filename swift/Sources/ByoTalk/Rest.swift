import Foundation

// REST client: Request-Id capture, idempotency keys, bounded retries for 5xx/429/network (docs/09 §4).

final class RestClient: Sendable {
    private let baseURL: String
    private let env: String
    private let auth: AuthManager
    private let session: URLSession

    init(baseURL: URL, env: String, auth: AuthManager, session: URLSession = .shared) {
        var s = baseURL.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        self.baseURL = s
        self.env = env
        self.auth = auth
        self.session = session
    }

    /// `path` must already be encoded (use `seg()` for ids). `idempotent` retries POST/PATCH/DELETE safely with an Idempotency-Key.
    func request<T: Decodable>(_ method: String, _ path: String, query: [String: String?] = [:], body: JSON? = nil, idempotent: Bool = false) async throws -> T {
        var comps = URLComponents(string: baseURL + path)!
        comps.queryItems = [URLQueryItem(name: "env", value: env)] + query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
        let retrySafe = method == "GET" || idempotent
        let idemKey = idempotent && method != "GET" ? UUID().uuidString.lowercased() : nil
        var refreshed = false
        var attempt = 0

        while true {
            let token = try await auth.get()
            var req = URLRequest(url: comps.url!)
            req.httpMethod = method
            req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            req.setValue(env, forHTTPHeaderField: "byotalk-env")
            if let body {
                req.setValue("application/json", forHTTPHeaderField: "content-type")
                req.httpBody = try JSONEncoder().encode(body)
            }
            if let idemKey { req.setValue(idemKey, forHTTPHeaderField: "idempotency-key") }

            let data: Data, res: HTTPURLResponse
            do {
                let (d, r) = try await session.data(for: req)
                data = d
                res = r as! HTTPURLResponse
            } catch {
                if Task.isCancelled { throw CancellationError() }
                if retrySafe && attempt < 3 {
                    await sleep(ms: backoffDelay(attempt, base: 300, cap: 5_000))
                    attempt += 1
                    continue
                }
                throw ChatError.network()
            }
            if (200..<300).contains(res.statusCode) {
                return try makeDecoder().decode(T.self, from: data.isEmpty ? Data("null".utf8) : data)
            }
            let err = ChatError.fromBody(status: res.statusCode, data: data)
            if err.code == "token_expired" && !refreshed && auth.canRefresh {
                refreshed = true
                _ = try await auth.refresh()
                continue
            }
            if retrySafe && attempt < 3 && (res.statusCode >= 500 || res.statusCode == 429) {
                await sleep(ms: err.retryAfterMs ?? backoffDelay(attempt, base: 300, cap: 5_000))
                attempt += 1
                continue
            }
            throw err
        }
    }
}
