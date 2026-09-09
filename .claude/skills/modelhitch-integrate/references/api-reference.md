# ModelHitch application API

## Imports

```ts
import {
  ModelHitch,
  ModelHitchError,
  LocalStorageKeyStore,
  MemoryKeyStore,
  runToolLoop,
  createModelHitchServer,
  createOpenAICompatibleProvider,
} from 'modelhitch';

import { useChat, useStream, createBridgeClient } from 'modelhitch/react';
```

The root package publishes ESM, CommonJS, and TypeScript declarations. React 18+ is an optional peer dependency.

## Minimal deterministic check

```ts
const hitch = new ModelHitch();

const result = await hitch.chat({
  provider: 'mock',
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Clock in.' }],
});
```

Useful methods are `chat`, `stream`, `streamToResult`, `provider`, `capabilities`, and `listModels`.

## Built-in provider credentials

| Provider | Environment variable |
| --- | --- |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN`, then `VERCEL_TOKEN`, then Vercel CLI auth |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `together` | `TOGETHER_API_KEY` |
| `huggingface` | `HF_TOKEN` |
| `gemini` | `GEMINI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `moonshot` | `MOONSHOT_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `lmstudio`, `ollama`, `vllm`, `llamacpp`, `koboldcpp`, `mock` | None by default |

Vercel AI Gateway is the default provider. Model ids use `creator/model` slugs (for example `openai/gpt-5.4`).

## Errors

Handle these stable `ModelHitchError.code` values: `missing-api-key`, `invalid-api-key`, `rate-limited`, `model-not-found`, `provider-not-found`, `provider-error`, `network-error`, and `bad-request`.

## Source map

When working in the ModelHitch repository, inspect:

- `src/client.ts` for client behavior and credential resolution
- `src/core/types.ts` for normalized request, response, tool, and stream types
- `src/providers/` and `src/registry.ts` for adapters and built-ins
- `src/agent.ts` for the tool loop
- `src/core/failover.ts` for auto-mode
- `src/react/` for hooks and reducer behavior
- `tests/client.test.ts`, `tests/agent.test.ts`, `tests/failover.test.ts`, and `tests/react-core.test.ts` for executable examples
