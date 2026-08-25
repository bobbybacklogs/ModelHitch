package com.genoventureslabs.modelhitch

import kotlinx.coroutines.flow.Flow

interface Provider {
    val id: String
    val name: String
    val defaultModel: String
    val capabilities: Capabilities

    suspend fun chat(
        params: ChatParams,
        credentials: ProviderCredentials = ProviderCredentials(),
    ): ChatResult

    fun stream(
        params: ChatParams,
        credentials: ProviderCredentials = ProviderCredentials(),
    ): Flow<StreamChunk>

    suspend fun listModels(
        credentials: ProviderCredentials = ProviderCredentials(),
    ): List<ModelInfo> = emptyList()
}