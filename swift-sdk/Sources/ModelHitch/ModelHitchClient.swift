import Foundation

/// Construction options for ``ModelHitch``. Mirrors the core of the
/// TypeScript `ModelHitchOptions` (providers, keystore, defaults). Policy,
/// auto-mode failover, and catalog options are not ported yet.
public struct ModelHitchOptions: Sendable {
    /// Providers to use. Defaults to the built-in set.
    public var providers: [Provider]
    /// Where end-user API keys live (optional — pass keys per-call instead).
    public var keyStore: KeyStore?
    /// Default provider used when calls do not specify one.
    public var defaultProviderId: String?
    /// Default model used when calls do not specify one.
    public var defaultModel: String?

    public init(
        providers: [Provider] = defaultProviders,
        keyStore: KeyStore? = nil,
        defaultProviderId: String? = nil,
        defaultModel: String? = nil
    ) {
        self.providers = providers
        self.keyStore = keyStore
        self.defaultProviderId = defaultProviderId
        self.defaultModel = defaultModel
    }
}

/// ModelHitch — the BYOK integration layer.
///
/// ```swift
/// let mh = ModelHitch(ModelHitchOptions(keyStore: KeychainKeyStore()))
/// let result = try await mh.chat(ChatInput(
///     messages: [.user("hi")],
///     provider: "openai"
/// ))
/// ```
public final class ModelHitch: @unchecked Sendable {
    public static let version = "0.1.0"

    public let providers: [Provider]
    public let keyStore: KeyStore?
    public let defaultProviderId: String?
    public let defaultModel: String?

    public init(_ options: ModelHitchOptions = ModelHitchOptions()) {
        self.providers = options.providers
        self.keyStore = options.keyStore
        self.defaultProviderId = options.defaultProviderId
        self.defaultModel = options.defaultModel
    }

    // MARK: - Provider lookup

    /// Look up a provider by id. Throws `provider-not-found` if unknown.
    public func provider(_ id: String) throws -> Provider {
        guard let provider = providers.first(where: { $0.id == id }) else {
            let known = providers.map(\.id).joined(separator: ", ")
            throw ModelHitchError(
                code: .providerNotFound,
                message: "Unknown provider \"\(id)\". Available: \(known)",
                providerId: id
            )
        }
        return provider
    }

    /// Capabilities of a provider (streaming? tool calling? vision?).
    public func capabilities(_ providerId: String) throws -> Capabilities {
        try provider(providerId).capabilities
    }

    // MARK: - Chat

    /// Complete (non-streaming) chat call.
    public func chat(
        _ input: ChatInput,
        credentialsOverride: ProviderCredentials? = nil
    ) async throws -> ChatResult {
        let provider = try resolveProvider(input)
        let params = buildParams(input, provider: provider)
        let credentials = try await resolveCredentials(
            provider, input, override: credentialsOverride)
        return try await provider.chat(params, credentials: credentials)
    }

    /// Streaming chat call — normalized ``StreamChunk`` events.
    ///
    /// Returns an ``AsyncThrowingStream``; provider/model and key resolution
    /// run inside the stream so callers can `for try await` directly.
    public func stream(
        _ input: ChatInput,
        credentialsOverride: ProviderCredentials? = nil
    ) -> AsyncThrowingStream<StreamChunk, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let provider = try resolveProvider(input)
                    let params = buildParams(input, provider: provider)
                    let credentials = try await resolveCredentials(
                        provider, input, override: credentialsOverride)
                    for try await chunk in provider.stream(params, credentials: credentials) {
                        continuation.yield(chunk)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Convenience: consume a stream and return the full aggregated result.
    public func streamToResult(
        _ input: ChatInput,
        credentialsOverride: ProviderCredentials? = nil
    ) async throws -> ChatResult {
        let stream = self.stream(input, credentialsOverride: credentialsOverride)
        return try await aggregateStream(stream)
    }

    // MARK: - Model listing

    /// Fetch the models a provider offers, if it supports discovery.
    public func listModels(
        _ providerId: String,
        credentialsOverride: ProviderCredentials? = nil
    ) async throws -> [ModelInfo] {
        let provider = try provider(providerId)
        var credentials = credentialsOverride ?? ProviderCredentials()
        if credentialsOverride == nil, let keyStore, let key = try await keyStore.get(providerId) {
            credentials.apiKey = key
        }
        return try await provider.listModels(credentials: credentials)
    }

    // MARK: - Resolution

    private func resolveProvider(_ input: ChatInput) throws -> Provider {
        guard let id = input.provider ?? defaultProviderId ?? providers.first?.id else {
            throw ModelHitchError(code: .providerNotFound, message: "No providers registered.")
        }
        return try provider(id)
    }

    private func buildParams(_ input: ChatInput, provider: Provider) -> ChatParams {
        ChatParams(
            model: input.model ?? defaultModel ?? provider.defaultModel,
            messages: input.messages,
            tools: input.tools,
            temperature: input.temperature,
            maxTokens: input.maxTokens,
            stop: input.stop,
            toolChoice: input.toolChoice,
            responseFormat: input.responseFormat,
            previousResponseId: input.previousResponseId,
            sessionId: input.sessionId
        )
    }

    /// Resolve credentials: explicit (override or input) > KeyStore > none.
    private func resolveCredentials(
        _ provider: Provider,
        _ input: ChatInput,
        override: ProviderCredentials?
    ) async throws -> ProviderCredentials {
        if let override { return override }
        if input.apiKey != nil || input.baseUrl != nil {
            return ProviderCredentials(apiKey: input.apiKey, baseUrl: input.baseUrl)
        }
        if let keyStore, let key = try await keyStore.get(provider.id) {
            return ProviderCredentials(apiKey: key)
        }
        return ProviderCredentials()
    }
}
