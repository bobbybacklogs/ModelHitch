import Foundation

/// Machine-readable error codes used across all providers.
///
/// Raw values match the TypeScript package's `ModelHitchErrorCode` union so
/// callers can switch on the same string codes across SDKs.
public enum ModelHitchErrorCode: String, Sendable, CaseIterable {
    case missingAPIKey = "missing-api-key"
    case invalidAPIKey = "invalid-api-key"
    case rateLimited = "rate-limited"
    case modelNotFound = "model-not-found"
    case providerNotFound = "provider-not-found"
    case providerError = "provider-error"
    case networkError = "network-error"
    case badRequest = "bad-request"
    case capabilityUnavailable = "capability-unavailable"
}

/// The single error type ModelHitch throws.
///
/// Apps switch on ``code`` to show user-friendly messages (for example
/// "Your API key looks wrong" for ``ModelHitchErrorCode/invalidAPIKey``).
public struct ModelHitchError: Error, Sendable, LocalizedError, Equatable {
    public let code: ModelHitchErrorCode
    public let message: String
    public let status: Int?
    public let providerId: String?
    /// Milliseconds the provider asked us to wait (Retry-After header).
    public let retryAfterMs: Int?

    public init(
        code: ModelHitchErrorCode,
        message: String,
        status: Int? = nil,
        providerId: String? = nil,
        retryAfterMs: Int? = nil
    ) {
        self.code = code
        self.message = message
        self.status = status
        self.providerId = providerId
        self.retryAfterMs = retryAfterMs
    }

    public var errorDescription: String? { message }
}
