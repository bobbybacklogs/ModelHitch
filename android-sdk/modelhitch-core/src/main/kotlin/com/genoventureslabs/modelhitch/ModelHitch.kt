package com.genoventureslabs.modelhitch

import kotlinx.coroutines.flow.Flow

class ModelHitch(
    providers: List<Provider> = DefaultProviders.all,
    private val keyStore: KeyStore? = null,
    private val defaultProviderId: String? = null,
    private val defaultModel: String? = null,
) {
    private val providersById = providers.associateBy(Provider::id)

    init {
        require(providers.isNotEmpty()) { "At least one provider is required." }
        require(providersById.size == providers.size) { "Provider ids must be unique." }
    }

    fun provider(id: String): Provider = providersById[id] ?: throw ModelHitchException(
        code = ModelHitchErrorCode.PROVIDER_NOT_FOUND,
        message = "Unknown provider \"$id\". Available: ${providersById.keys.joinToString()}",
        providerId = id,
    )

    suspend fun chat(request: ChatRequest): ChatResult {
        val resolved = resolve(request)
        return resolved.provider.chat(resolved.params, resolved.credentials)
    }

    suspend fun stream(request: ChatRequest): Flow<StreamChunk> {
        val resolved = resolve(request)
        return resolved.provider.stream(resolved.params, resolved.credentials)
    }

    suspend fun listModels(providerId: String, apiKey: String? = null): List<ModelInfo> {
        val selected = provider(providerId)
        val credentials = ProviderCredentials(apiKey = apiKey ?: keyStore?.get(providerId))
        return selected.listModels(credentials)
    }

    private suspend fun resolve(request: ChatRequest): ResolvedRequest {
        val selected = request.provider?.let(::provider)
            ?: defaultProviderId?.let(::provider)
            ?: providersById.values.first()
        val credentials = if (request.apiKey != null || request.baseUrl != null) {
            ProviderCredentials(request.apiKey, request.baseUrl)
        } else {
            ProviderCredentials(apiKey = keyStore?.get(selected.id))
        }
        val params = ChatParams(
            model = request.model ?: defaultModel ?: selected.defaultModel,
            messages = request.messages,
            tools = request.tools,
            temperature = request.temperature,
            maxTokens = request.maxTokens,
            stop = request.stop,
            toolChoice = request.toolChoice,
            responseFormat = request.responseFormat,
            previousResponseId = request.previousResponseId,
        )
        return ResolvedRequest(selected, params, credentials)
    }

    private data class ResolvedRequest(
        val provider: Provider,
        val params: ChatParams,
        val credentials: ProviderCredentials,
    )
}