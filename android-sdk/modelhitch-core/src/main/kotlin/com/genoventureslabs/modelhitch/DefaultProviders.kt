package com.genoventureslabs.modelhitch

import com.genoventureslabs.modelhitch.openai.OpenAICompatibleConfig
import com.genoventureslabs.modelhitch.openai.OpenAICompatibleProvider

object DefaultProviders {
    val openAI: Provider by lazy {
        compatible(
            id = "openai",
            name = "OpenAI",
            baseUrl = "https://api.openai.com/v1",
            defaultModel = "gpt-4o-mini",
            maxContextTokens = 128_000,
        )
    }

    val openRouter: Provider by lazy {
        compatible(
            id = "openrouter",
            name = "OpenRouter",
            baseUrl = "https://openrouter.ai/api/v1",
            defaultModel = "meta-llama/llama-3.1-8b-instruct:free",
        )
    }

    val groq: Provider by lazy {
        compatible(
            id = "groq",
            name = "Groq",
            baseUrl = "https://api.groq.com/openai/v1",
            defaultModel = "llama-3.3-70b-versatile",
            maxContextTokens = 128_000,
            vision = false,
        )
    }

    val together: Provider by lazy {
        compatible(
            id = "together",
            name = "Together AI",
            baseUrl = "https://api.together.xyz/v1",
            defaultModel = "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        )
    }

    val huggingFace: Provider by lazy {
        compatible(
            id = "huggingface",
            name = "HuggingFace",
            baseUrl = "https://router.huggingface.co/v1",
            defaultModel = "Qwen/Qwen2.5-72B-Instruct",
            maxContextTokens = 128_000,
        )
    }

    val gemini: Provider by lazy {
        compatible(
            id = "gemini",
            name = "Google Gemini",
            baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai",
            defaultModel = "gemini-3.7-flash",
            maxContextTokens = 1_000_000,
        )
    }

    val deepSeek: Provider by lazy {
        compatible(
            id = "deepseek",
            name = "DeepSeek",
            baseUrl = "https://api.deepseek.com",
            defaultModel = "deepseek-v4-pro",
            maxContextTokens = 1_000_000,
            vision = false,
        )
    }

    val xAI: Provider by lazy {
        compatible(
            id = "xai",
            name = "xAI (Grok)",
            baseUrl = "https://api.x.ai/v1",
            defaultModel = "grok-4.6",
            maxContextTokens = 500_000,
        )
    }

    val mistral: Provider by lazy {
        compatible(
            id = "mistral",
            name = "Mistral",
            baseUrl = "https://api.mistral.ai/v1",
            defaultModel = "mistral-medium-3-5",
            maxContextTokens = 256_000,
        )
    }

    val moonshot: Provider by lazy {
        compatible(
            id = "moonshot",
            name = "Moonshot (Kimi)",
            baseUrl = "https://api.moonshot.ai/v1",
            defaultModel = "kimi-k3",
            maxContextTokens = 1_000_000,
        )
    }

    val zai: Provider by lazy {
        compatible(
            id = "zai",
            name = "Z.ai (GLM)",
            baseUrl = "https://api.z.ai/api/paas/v4",
            defaultModel = "glm-5.2",
            maxContextTokens = 1_000_000,
            vision = false,
        )
    }

    val all: List<Provider> by lazy {
        listOf(openAI, openRouter, groq, together, huggingFace, gemini, deepSeek, xAI, mistral, moonshot, zai)
    }

    private fun compatible(
        id: String,
        name: String,
        baseUrl: String,
        defaultModel: String,
        maxContextTokens: Int? = null,
        vision: Boolean = true,
    ): Provider = OpenAICompatibleProvider(
        OpenAICompatibleConfig(
            id = id,
            name = name,
            baseUrl = baseUrl,
            defaultModel = defaultModel,
            capabilities = Capabilities(
                streaming = true,
                toolCalling = true,
                vision = vision,
                embeddings = false,
                maxContextTokens = maxContextTokens,
            ),
        ),
    )
}