import '../types.dart';
import 'openai_compatible.dart';

final class DefaultProviders {
  static final List<OpenAICompatibleProvider> all = List.unmodifiable([
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'openai',
        name: 'OpenAI',
        defaultModel: 'gpt-4o-mini',
        baseUrl: 'https://api.openai.com/v1')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'openrouter',
        name: 'OpenRouter',
        defaultModel: 'openai/gpt-4o-mini',
        baseUrl: 'https://openrouter.ai/api/v1')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'groq',
        name: 'Groq',
        defaultModel: 'llama-3.3-70b-versatile',
        baseUrl: 'https://api.groq.com/openai/v1')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'together',
        name: 'Together AI',
        defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        baseUrl: 'https://api.together.xyz/v1')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'huggingface',
        name: 'Hugging Face',
        defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
        baseUrl: 'https://router.huggingface.co/v1')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'gemini',
        name: 'Google Gemini',
        defaultModel: 'gemini-2.0-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'deepseek',
        name: 'DeepSeek',
        defaultModel: 'deepseek-chat',
        baseUrl: 'https://api.deepseek.com/v1')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'xai',
        name: 'xAI',
        defaultModel: 'grok-3-mini',
        baseUrl: 'https://api.x.ai/v1')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'mistral',
        name: 'Mistral AI',
        defaultModel: 'mistral-small-latest',
        baseUrl: 'https://api.mistral.ai/v1')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'moonshot',
        name: 'Moonshot AI',
        defaultModel: 'moonshot-v1-8k',
        baseUrl: 'https://api.moonshot.ai/v1')),
    OpenAICompatibleProvider(OpenAICompatibleConfig(
        id: 'zai',
        name: 'Z.ai',
        defaultModel: 'glm-4-flash',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4')),
  ]);
}

const defaultCapabilities = Capabilities(
  streaming: true,
  toolCalling: true,
  vision: true,
  embeddings: false,
);
