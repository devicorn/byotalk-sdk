import Foundation
import Network
#if canImport(UIKit)
import UIKit
#endif

// WebSocket lifecycle for chat.v1: auth-first, request/ack correlation, heartbeats, reconnect with
// full-jitter backoff, close-code handling (docs/08-REALTIME-PROTOCOL.md §1, §4–6).

struct Hello: Decodable, Sendable {
    let sessionId: String
    let userId: String
    let heartbeatMs: Int
    let tokenExpiresAt: String?
}

struct WireFrame: Decodable, Sendable {
    let t: String
    let re: String?
    let e: String?
    let cid: String?
    let seq: Int?
    let d: JSON?
    let code: String?
    let message: String?
    let retryAfterMs: Int?
}

private let livenessMs = 60_000

@MainActor
final class Transport {
    private(set) var state: ConnectionState = .disconnected
    private(set) var hello: Hello?
    var onState: ((ConnectionState) -> Void)?
    var onError: ((ChatError) -> Void)?
    var onHello: (() -> Void)?
    var onFrame: ((WireFrame) -> Void)?

    private let url: URL
    private let auth: AuthManager
    private let session = URLSession(configuration: .default)
    private(set) var ws: URLSessionWebSocketTask?
    private var wanted = false
    private var attempt = 0
    // Backoff restarts only after a connection that stayed up: a server that says hello and closes at once
    // must not get an instant reconnect loop.
    private var helloAt: Date?
    private var reqId = 0
    private var pending: [String: CheckedContinuation<JSON, Error>] = [:]
    private var reconnectTask: Task<Void, Never>?
    private var livenessTask: Task<Void, Never>?
    private var lastFrameAt = Date()
    private var authRefreshed = false
    private var pathMonitor: NWPathMonitor?
    private var wasOnline = true
    private var foregroundObserver: NSObjectProtocol?

    init(realtimeURL: URL, env: String, sdk: String, auth: AuthManager) {
        var base = realtimeURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        var comps = URLComponents(string: base + "/v1")!
        comps.queryItems = [URLQueryItem(name: "env", value: env), URLQueryItem(name: "sdk", value: sdk)]
        url = comps.url!
        self.auth = auth
    }

    func setState(_ s: ConnectionState) {
        guard state != s else { return }
        state = s
        onState?(s)
    }

    var isOpen: Bool { ws?.state == .running && hello != nil }

    func start() {
        guard !wanted else { return }
        wanted = true
        attempt = 0
        if state == .failed { state = .disconnected }
        watchOnline()
        Task { await open() }
    }

    /// Normal close (1000); no reconnect.
    func stop() {
        wanted = false
        clearTimers()
        unwatchOnline()
        let ws = self.ws
        self.ws = nil
        hello = nil
        ws?.cancel(with: .normalClosure, reason: Data("client disconnect".utf8))
        failPending(ChatError.network("Disconnected"))
        setState(.disconnected)
    }

    /// Reconnect now (app foreground, network back): resets backoff.
    func reconnectNow() {
        guard wanted, ![.failed, .connected, .syncing, .connecting].contains(state) else { return }
        attempt = 0
        reconnectTask?.cancel()
        reconnectTask = nil
        Task { await open() }
    }

    func request(_ t: String, _ d: JSON, timeoutMs: Int = 5_000) async throws -> JSON {
        guard isOpen else { throw ChatError.network("Not connected") }
        reqId += 1
        let id = String(reqId)
        return try await withCheckedThrowingContinuation { c in
            pending[id] = c
            Task { [weak self] in
                await sleep(ms: timeoutMs)
                self?.settle(id, .failure(ChatError(code: "timeout", type: "network", message: "\(t) timed out")))
            }
            write(["t": .string(t), "id": .string(id), "d": d])
        }
    }

    func send(_ t: String, _ d: JSON) {
        if isOpen { write(["t": .string(t), "d": d]) }
    }

    private func write(_ frame: JSON) {
        guard let ws, let data = try? JSONEncoder().encode(frame) else { return }
        ws.send(.string(String(decoding: data, as: UTF8.self))) { _ in } // a failed write surfaces as a close
    }

    private func settle(_ id: String, _ result: Result<JSON, Error>) {
        pending.removeValue(forKey: id)?.resume(with: result)
    }

    private func watchOnline() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.pathChanged(online) }
        }
        monitor.start(queue: DispatchQueue(label: "byotalk.network"))
        pathMonitor = monitor
        #if canImport(UIKit) && !os(watchOS)
        foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.reconnectNow() }
        }
        #endif
    }

    private func pathChanged(_ online: Bool) {
        defer { wasOnline = online }
        if online && !wasOnline { reconnectNow() }
    }

    private func unwatchOnline() {
        pathMonitor?.cancel()
        pathMonitor = nil
        if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
        foregroundObserver = nil
    }

    private func open() async {
        guard wanted else { return }
        setState(attempt == 0 && state != .reconnecting ? .connecting : .reconnecting)
        let token: String
        do {
            token = try await auth.get()
        } catch {
            return fail(ChatError.from(error, code: "token_invalid"))
        }
        guard wanted, ws == nil else { return }
        let task = session.webSocketTask(with: url, protocols: ["chat.v1"])
        ws = task
        hello = nil
        lastFrameAt = Date()
        task.resume()
        write(["t": "auth", "d": ["token": .string(token)]])
        receive(task)
        startLiveness()
    }

    private func receive(_ task: URLSessionWebSocketTask) {
        Task { [weak self] in
            while true {
                let message: URLSessionWebSocketTask.Message
                do {
                    message = try await task.receive()
                } catch {
                    guard let self, self.ws === task else { return }
                    let reason = task.closeReason.map { String(decoding: $0, as: UTF8.self) } ?? ""
                    return self.onClose(task.closeCode.rawValue, reason)
                }
                guard let self, self.ws === task else { return }
                self.lastFrameAt = Date()
                if case .string(let s) = message, let f = try? JSONDecoder().decode(WireFrame.self, from: Data(s.utf8)) {
                    self.handle(f)
                }
            }
        }
    }

    private func handle(_ f: WireFrame) {
        switch f.t {
        case "hello":
            guard let h = try? f.d?.decode(Hello.self) else { return }
            hello = h
            helloAt = Date()
            authRefreshed = false
            onHello?()
        case "ack", "error":
            if let re = f.re, pending[re] != nil {
                if f.t == "ack" { settle(re, .success(f.d ?? .null)) }
                else { settle(re, .failure(ChatError(code: f.code ?? "internal", message: f.message ?? "Request failed", retryAfterMs: f.retryAfterMs))) }
            } else if f.t == "error" {
                onError?(ChatError(code: f.code ?? "internal", message: f.message ?? "Server error"))
            }
        case "hb":
            send("hb", [:])
        case "goaway":
            ws?.cancel(with: .normalClosure, reason: Data("goaway".utf8))
            dropSocket()
            scheduleReconnect(f.d?["reconnectAfterMs"]?.int ?? 0)
        case "token_expiring":
            Task { await refreshToken() }
        default:
            onFrame?(f)
        }
    }

    private func refreshToken() async {
        guard auth.canRefresh else { return }
        do {
            let token = try await auth.refresh()
            _ = try await request("token.refresh", ["token": .string(token)])
        } catch {
            onError?(ChatError.from(error))
        }
    }

    private func onClose(_ code: Int, _ reason: String) {
        dropSocket()
        guard wanted else { return }
        let info = (try? JSONDecoder().decode(JSON.self, from: Data(reason.utf8)))?.object ?? [:]
        let err = { (c: String, type: String) in
            ChatError(code: info["code"]?.string ?? c, type: type, message: info["message"]?.string ?? (reason.isEmpty ? "Connection closed (\(code))" : reason),
                      retryAfterMs: info["retryAfterMs"]?.int)
        }
        switch code {
        case 4001:
            // Token problem: refresh once through the provider, else give up.
            if auth.canRefresh && !authRefreshed {
                authRefreshed = true
                Task {
                    do {
                        _ = try await auth.refresh()
                        scheduleReconnect(0)
                    } catch {
                        fail(error as? ChatError ?? err("token_invalid", "authentication"))
                    }
                }
                return
            }
            fail(err("token_invalid", "authentication"))
        case 4003:
            fail(err("forbidden", "permission"))
        case 4009:
            fail(err("too_many_connections", "rate_limited"))
        case 4008:
            scheduleReconnect(info["retryAfterMs"]?.int ?? nextBackoff())
        case 1009:
            onError?(err("body_too_large", "payload_too_large"))
            scheduleReconnect()
        case 1012:
            scheduleReconnect(Int.random(in: 0..<5_000))
        default:
            scheduleReconnect()
        }
    }

    private func dropSocket() {
        ws = nil
        hello = nil
        livenessTask?.cancel()
        livenessTask = nil
        failPending(ChatError.network("Connection lost"))
    }

    private func nextBackoff() -> Int {
        defer { attempt += 1 }
        return backoffDelay(attempt)
    }

    private func scheduleReconnect(_ delay: Int? = nil) {
        guard wanted else { return }
        setState(.reconnecting)
        if let helloAt, Date().timeIntervalSince(helloAt) > 30 { attempt = 0 }
        helloAt = nil
        let ms = delay ?? nextBackoff()
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            await sleep(ms: ms)
            guard !Task.isCancelled, let self else { return }
            self.reconnectTask = nil
            await self.open()
        }
    }

    private func fail(_ err: ChatError) {
        wanted = false
        clearTimers()
        unwatchOnline()
        setState(.failed)
        onError?(err)
    }

    private func startLiveness() {
        livenessTask?.cancel()
        livenessTask = Task { [weak self] in
            while !Task.isCancelled {
                await sleep(ms: 5_000)
                guard let self, !Task.isCancelled, let ws = self.ws else { return }
                if Date().timeIntervalSince(self.lastFrameAt) * 1000 > Double(livenessMs) {
                    self.dropSocket()
                    ws.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: 4000) ?? .goingAway, reason: Data("liveness timeout".utf8))
                    self.scheduleReconnect()
                    return
                }
            }
        }
    }

    private func clearTimers() {
        reconnectTask?.cancel()
        livenessTask?.cancel()
        reconnectTask = nil
        livenessTask = nil
    }

    private func failPending(_ err: ChatError) {
        let all = pending
        pending = [:]
        for c in all.values { c.resume(throwing: err) }
    }
}
