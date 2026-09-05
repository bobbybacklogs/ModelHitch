import { describe, expect, it } from 'vitest';
import { defaultProviders } from '../src/registry.js';

describe('defaultProviders registry', () => {
  it('registers every built-in provider (guards against defined-but-unregistered regressions)', () => {
    const ids = defaultProviders.map((p) => p.id);
    const expected = [
      'opencode-zen',
      'opencode-go',
      'openai',
      'anthropic',
      'groq',
      'openrouter',
      'vercel-ai-gateway',
      'together',
      'huggingface',
      'gemini',
      'deepseek',
      'xai',
      'mistral',
      'moonshot',
      'zai',
      'lmstudio',
      'ollama',
      'vllm',
      'llamacpp',
      'koboldcpp',
      'mock',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });
});
