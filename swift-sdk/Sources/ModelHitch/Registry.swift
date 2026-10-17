import Foundation

/// The OpenAI-compatible providers that ship with ModelHitch out of the box.
///
/// This mirrors the TypeScript registry's OpenAI-compatible subset (the
/// adapters that share one wire format). Native multi-wire adapters
/// (Anthropic Messages, Gemini generateContent, Vercel AI Gateway, the
/// ChatGPT-plan lane) are not ported yet — see docs/swift-api-contract.md.
public enum DefaultProviders {
    public static let openai = OpenAICompatibleProvider(
        id: "openai",
        name: "OpenAI",
        baseURL: "https://api.openai.com/v1",
        defaultModel: "gpt-4o-mini",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: true, embeddings: true, maxContextTokens: 128_000),
        apiKeyEnvVar: "OPENAI_API_KEY"
    )

    public static let groq = OpenAICompatibleProvider(
        id: "groq",
        name: "Groq",
        baseURL: "https://api.groq.com/openai/v1",
        defaultModel: "llama-3.3-70b-versatile",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: false, embeddings: false, maxContextTokens: 128_000),
        apiKeyEnvVar: "GROQ_API_KEY"
    )

    public static let openrouter = OpenAICompatibleProvider(
        id: "openrouter",
        name: "OpenRouter",
        baseURL: "https://openrouter.ai/api/v1",
        defaultModel: "meta-llama/llama-3.1-8b-instruct:free",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: true, embeddings: false),
        apiKeyEnvVar: "OPENROUTER_API_KEY"
    )

    public static let together = OpenAICompatibleProvider(
        id: "together",
        name: "Together AI",
        baseURL: "https://api.together.xyz/v1",
        defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: true, embeddings: false),
        apiKeyEnvVar: "TOGETHER_API_KEY"
    )

    public static let huggingface = OpenAICompatibleProvider(
        id: "huggingface",
        name: "HuggingFace",
        baseURL: "https://router.huggingface.co/v1",
        defaultModel: "Qwen/Qwen2.5-72B-Instruct",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: true, embeddings: false, maxContextTokens: 128_000),
        apiKeyEnvVar: "HF_TOKEN"
    )

    public static let gemini = OpenAICompatibleProvider(
        id: "gemini",
        name: "Google Gemini",
        baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
        defaultModel: "gemini-3.7-flash",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: true, embeddings: false, maxContextTokens: 1_000_000),
        apiKeyEnvVar: "GEMINI_API_KEY"
    )

    public static let deepseek = OpenAICompatibleProvider(
        id: "deepseek",
        name: "DeepSeek",
        baseURL: "https://api.deepseek.com",
        defaultModel: "deepseek-v4-pro",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: false, embeddings: false, maxContextTokens: 1_000_000),
        apiKeyEnvVar: "DEEPSEEK_API_KEY"
    )

    public static let xai = OpenAICompatibleProvider(
        id: "xai",
        name: "xAI (Grok)",
        baseURL: "https://api.x.ai/v1",
        defaultModel: "grok-4.6",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: true, embeddings: false, maxContextTokens: 500_000),
        apiKeyEnvVar: "XAI_API_KEY"
    )

    public static let mistral = OpenAICompatibleProvider(
        id: "mistral",
        name: "Mistral",
        baseURL: "https://api.mistral.ai/v1",
        defaultModel: "mistral-medium-3-5",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: true, embeddings: false, maxContextTokens: 256_000),
        apiKeyEnvVar: "MISTRAL_API_KEY"
    )

    public static let moonshot = OpenAICompatibleProvider(
        id: "moonshot",
        name: "Moonshot (Kimi)",
        baseURL: "https://api.moonshot.ai/v1",
        defaultModel: "kimi-k3",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: true, embeddings: false, maxContextTokens: 1_000_000),
        apiKeyEnvVar: "MOONSHOT_API_KEY"
    )

    public static let zai = OpenAICompatibleProvider(
        id: "zai",
        name: "Z.ai (GLM)",
        baseURL: "https://api.z.ai/api/paas/v4/",
        defaultModel: "glm-5.2",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: false, embeddings: false, maxContextTokens: 1_000_000),
        apiKeyEnvVar: "ZAI_API_KEY"
    )

    /// Fully local, no key required.
    public static let lmstudio = OpenAICompatibleProvider(
        id: "lmstudio",
        name: "LM Studio (local)",
        baseURL: "http://localhost:1234/v1",
        defaultModel: "local-model",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: false, embeddings: true),
        requiresKey: false
    )

    /// Fully local, no key required.
    public static let vllm = OpenAICompatibleProvider(
        id: "vllm",
        name: "vLLM (local)",
        baseURL: "http://localhost:8000/v1",
        defaultModel: "local-model",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: false, embeddings: false),
        requiresKey: false
    )

    /// Fully local, no key required.
    public static let llamacpp = OpenAICompatibleProvider(
        id: "llamacpp",
        name: "llama.cpp (local)",
        baseURL: "http://localhost:8080/v1",
        defaultModel: "local-model",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: false, embeddings: false),
        requiresKey: false
    )

    /// Fully local, no key required.
    public static let koboldcpp = OpenAICompatibleProvider(
        id: "koboldcpp",
        name: "KoboldCpp (local)",
        baseURL: "http://localhost:5001/v1",
        defaultModel: "local-model",
        capabilities: Capabilities(streaming: true, toolCalling: true, vision: false, embeddings: false),
        requiresKey: false
    )

    /// The providers that ship with ModelHitch out of the box.
    public static let all: [Provider] = [
        openai,
        groq,
        openrouter,
        together,
        huggingface,
        gemini,
        deepseek,
        xai,
        mistral,
        moonshot,
        zai,
        lmstudio,
        vllm,
        llamacpp,
        koboldcpp,
    ]
}

/// TypeScript-compatible alias for ``DefaultProviders/all``.
public var defaultProviders: [Provider] { DefaultProviders.all }
