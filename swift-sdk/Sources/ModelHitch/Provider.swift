import Foundation

/// The contract every provider adapter implements. ModelHitch talks to these
/// only — your app never touches provider-specific payloads.
public protocol Provider: Sendable {
    /// Stable provider id, e.g. "openai".
    var id: String { get }
    /// Human-readable provider name.
    var name: String { get }
    /// Model used when a call does not name one.
    var defaultModel: String { get }
    /// What this provider can do.
    var capabilities: Capabilities { get }
    /// Complete (non-streaming) chat.
    func chat(_ params: ChatParams, credentials: ProviderCredentials) async throws -> ChatResult
    /// Streaming chat, normalized to ``StreamChunk`` events.
    func stream(_ params: ChatParams, credentials: ProviderCredentials) -> AsyncThrowingStream<StreamChunk, Error>
    /// Fetch the provider's available models (e.g. GET /models).
    func listModels(credentials: ProviderCredentials) async throws -> [ModelInfo]
}

public extension Provider {
    /// Default: providers that do not implement discovery report a clear error,
    /// mirroring the TypeScript `provider-error` for unsupported listing.
    func listModels(credentials: ProviderCredentials) async throws -> [ModelInfo] {
        throw ModelHitchError(
            code: .providerError,
            message: "Provider \"\(id)\" does not support model listing.",
            providerId: id
        )
    }
}
