import Foundation

/// Where end-user API keys live for the BYOK flow. ModelHitch reads keys from
/// here when the app does not pass one explicitly — the key never needs to
/// touch your backend. Mirrors the TypeScript `KeyStore` interface.
public protocol KeyStore: Sendable {
    func get(_ providerId: String) async throws -> String?
    func set(_ providerId: String, _ apiKey: String) async throws
    func delete(_ providerId: String) async throws
}

/// In-memory key store. Intended for tests and ephemeral use — nothing is
/// persisted. Mirrors the TypeScript `MemoryKeyStore`.
public actor InMemoryKeyStore: KeyStore {
    private var storage: [String: String]

    public init(_ initial: [String: String] = [:]) {
        self.storage = initial
    }

    public func get(_ providerId: String) async throws -> String? {
        storage[providerId]
    }

    public func set(_ providerId: String, _ apiKey: String) async throws {
        storage[providerId] = apiKey
    }

    public func delete(_ providerId: String) async throws {
        storage[providerId] = nil
    }
}
