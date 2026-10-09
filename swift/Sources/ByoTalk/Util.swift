import Foundation

/// Full-jitter exponential backoff in ms (docs/08 §6): random(0, min(cap, base * 2^attempt)).
func backoffDelay(_ attempt: Int, base: Double = 500, cap: Double = 30_000, rand: () -> Double = { Double.random(in: 0..<1) }) -> Int {
    Int(rand() * min(cap, base * pow(2, Double(attempt))))
}

/// Reads `exp` from a JWT without verifying (the server verifies). Dev tokens have no expiry.
func tokenExpiry(_ token: String) -> Date? {
    let parts = token.split(separator: ".")
    guard parts.count > 1 else { return nil }
    var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
    guard let data = Data(base64Encoded: b64), let exp = (try? JSONDecoder().decode(JSON.self, from: data))?["exp"],
          case .number(let s) = exp else { return nil }
    return Date(timeIntervalSince1970: s)
}

private let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

/// One percent-encoded path segment: an id like "c_1/../../members/u_2" from a deep link can't reach another endpoint.
func seg(_ v: String) throws -> String {
    if v.isEmpty || v == "." || v == ".." { throw ChatError(code: "invalid_request", type: "invalid_request", message: "Invalid id \"\(v)\"") }
    return v.addingPercentEncoding(withAllowedCharacters: unreserved)!
}

func sleep(ms: Int) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, ms)) * 1_000_000)
}

/// Fan-out to any number of AsyncStream listeners (the Swift side of the TS Emitter).
@MainActor
final class Broadcaster<T: Sendable> {
    private var continuations: [UUID: AsyncStream<T>.Continuation] = [:]

    func stream(_ policy: AsyncStream<T>.Continuation.BufferingPolicy = .unbounded, initial: T? = nil) -> AsyncStream<T> {
        let id = UUID()
        let (stream, c) = AsyncStream.makeStream(of: T.self, bufferingPolicy: policy)
        continuations[id] = c
        c.onTermination = { [weak self] _ in Task { @MainActor in self?.continuations[id] = nil } }
        if let initial { c.yield(initial) }
        return stream
    }

    func yield(_ v: T) {
        for c in continuations.values { c.yield(v) }
    }

    var isEmpty: Bool { continuations.isEmpty }
}
