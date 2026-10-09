import Foundation

/// Where the SDK keeps unsent messages and the sync cursor. Keys are namespaced per environment and user by the SDK.
public protocol PersistenceAdapter: Sendable {
    func get(_ key: String) async -> String?
    func set(_ key: String, _ value: String) async
    func delete(_ key: String) async
}

/// Default adapter: nothing survives a restart (unsent messages are lost when the app is killed).
public actor MemoryPersistence: PersistenceAdapter {
    private var values: [String: String] = [:]

    public init() {}
    public func get(_ key: String) -> String? { values[key] }
    public func set(_ key: String, _ value: String) { values[key] = value }
    public func delete(_ key: String) { values[key] = nil }
}

/// Unsent messages survive an app restart (resent within 24 h).
public final class UserDefaultsPersistence: PersistenceAdapter, @unchecked Sendable { // UserDefaults is thread-safe
    private let defaults: UserDefaults

    public init(_ defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func get(_ key: String) async -> String? { defaults.string(forKey: key) }
    public func set(_ key: String, _ value: String) async { defaults.set(value, forKey: key) }
    public func delete(_ key: String) async { defaults.removeObject(forKey: key) }
}
