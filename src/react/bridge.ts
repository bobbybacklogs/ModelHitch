import { ModelHitch } from '../client.js';
import { createOpenAICompatibleProvider } from '../providers/openai-compatible.js';

/**
 * Build a ModelHitch client pointed at a ModelHitch bridge server (the
 * `createModelHitchServer` harness). This is the recommended setup for BYOK
 * UIs: the bridge holds your keys locally and speaks OpenAI-compatible
 * `/v1/chat/completions`, so the UI only needs a URL.
 */
export interface BridgeConfig {
  /** Bridge base URL, e.g. "http://127.0.0.1:3939/v1". */
  baseUrl: string;
  /** Routed model id, e.g. "vercel-ai-gateway/openai/gpt-5.4" or "mock-model". */
  model: string;
  /** Optional key forwarded as Authorization (the bridge may ignore it). */
  apiKey?: string;
}

export function createBridgeClient(config: BridgeConfig): ModelHitch {
  const provider = createOpenAICompatibleProvider({
    id: 'bridge',
    name: 'ModelHitch bridge',
    baseUrl: config.baseUrl.replace(/\/$/, ''),
    defaultModel: config.model,
    requiresKey: false, // local bridge; key optional
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
  });
  return new ModelHitch({ providers: [provider], defaultProviderId: 'bridge' });
}
