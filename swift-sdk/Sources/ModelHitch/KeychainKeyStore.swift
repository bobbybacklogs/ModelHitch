#if canImport(Security)
import Foundation
import Security

/// Keychain-backed key storage using Apple's Security framework.
///
/// Keys are stored as generic passwords under `service` + the provider id as
/// account. This is the production default for Apple platforms; tests should
/// use ``InMemoryKeyStore`` instead.
public final class KeychainKeyStore: KeyStore {
    /// Keychain service (namespace) all entries live under.
    public let service: String

    public init(service: String = "com.modelhitch.apikeys") {
        self.service = service
    }

    public func get(_ providerId: String) async throws -> String? {
        var query = baseQuery(providerId)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw ModelHitchError(
                code: .providerError,
                message: "Keychain read failed (OSStatus \(status)).",
                providerId: providerId
            )
        }
        return String(data: data, encoding: .utf8)
    }

    public func set(_ providerId: String, _ apiKey: String) async throws {
        let data = Data(apiKey.utf8)
        let query = baseQuery(providerId)

        if SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess {
            let attributes: [String: Any] = [kSecValueData as String: data]
            let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            guard status == errSecSuccess else {
                throw ModelHitchError(
                    code: .providerError,
                    message: "Keychain update failed (OSStatus \(status)).",
                    providerId: providerId
                )
            }
            return
        }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw ModelHitchError(
                code: .providerError,
                message: "Keychain write failed (OSStatus \(status)).",
                providerId: providerId
            )
        }
    }

    public func delete(_ providerId: String) async throws {
        let status = SecItemDelete(baseQuery(providerId) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ModelHitchError(
                code: .providerError,
                message: "Keychain delete failed (OSStatus \(status)).",
                providerId: providerId
            )
        }
    }

    private func baseQuery(_ providerId: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: providerId,
        ]
    }
}
#endif
