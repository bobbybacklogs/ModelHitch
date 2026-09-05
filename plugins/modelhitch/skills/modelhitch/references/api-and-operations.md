# ModelHitch API and operations reference

## Package surfaces

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

The root package provides ESM, CommonJS, and TypeScript declarations. React 18 or later is an optional peer dependency.

## Client shape

```ts
const hitch = new ModelHitch({ autoMode: true });

const result = await hitch.chat({
  provider: 'mock',
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Clock in.' }],
});

for await (const chunk of await hitch.stream({
  provider: 'mock',
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Stream it.' }],
})) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text);
}
```

Useful methods include `chat`, `stream`, `streamToResult`, `provider`, `capabilities`, and `listModels`. Use `runToolLoop` for provider-neutral tool execution and follow-up turns.

## Built-in providers

| Provider ID | Credential environment variable |
| --- | --- |
| `opencode-zen` | `OPENCODE_ZEN_API_KEY`, fallback `OPENCODE_API_KEY` |
| `opencode-go` | `OPENCODE_GO_API_KEY`, fallback `OPENCODE_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `openrouter` | `OPENROUTER_API_KEY` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY`, fallback `VERCEL_OIDC_TOKEN` |
| `together` | `TOGETHER_API_KEY` |
| `huggingface` | `HF_TOKEN` |
| `gemini` | `GEMINI_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |
| `xai` | `XAI_API_KEY` |
| `mistral` | `MISTRAL_API_KEY` |
| `moonshot` | `MOONSHOT_API_KEY` |
| `zai` | `ZAI_API_KEY` |
| `lmstudio`, `ollama`, `vllm`, `llamacpp`, `koboldcpp`, `mock` | None by default |

OpenCode Zen chooses the upstream protocol by model family: GPT/Grok use Responses, Claude/Qwen use Anthropic Messages, Gemini uses GenerateContent, and other models use chat completions.

## Bridge commands and environment

```bash
npx modelhitch bridge
npx modelhitch bridge --background
npx modelhitch status
npx modelhitch front
npx modelhitch stop
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODELHITCH_PORT` | `3939` | Listening port |
| `MODELHITCH_HOST` | `127.0.0.1` | Listening host |
| `MODELHITCH_MAX_BODY_BYTES` | 64 MiB | Maximum request body |
| `MODELHITCH_HOME` | `~/.modelhitch` | Background PID and log directory |
| `MODELHITCH_DEBUG` | disabled | Log forwarded request and upstream error details; may expose sensitive content |

## Bridge endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat clients |
| `POST /v1/responses` | Codex and Responses clients |
| `POST /v1/messages` | Anthropic clients |
| `POST /v1beta/models/{model}:generateContent` | Gemini clients |
| `GET /v1/models`, `GET /healthz` | Discovery and health |
| `GET /v1/usage`, `GET /usage` | Usage JSON and dashboard |
| `POST /v1/usage/reset` | Reset usage history |

Use `http://127.0.0.1:3939/v1` for OpenAI-style clients and `http://127.0.0.1:3939` for clients that append their own Anthropic or Gemini paths.

Clients that mandate a nonempty `apiKey` field (for example, the official `openai` SDK or IDE agents) can be given any harmless bridge-local placeholder such as `sk-bridge-local`. The bridge resolves credentials locally and ignores the incoming Authorization header, so the placeholder is never sent upstream. Never use a real user key.

## Stable error codes

Handle `missing-api-key`, `invalid-api-key`, `rate-limited`, `model-not-found`, `provider-not-found`, `provider-error`, `network-error`, and `bad-request` through `ModelHitchError.code`.

## Common diagnosis sequence

1. Confirm Node.js and the installed ModelHitch version.
2. Confirm the bridge process and `/healthz`.
3. Test `mock/mock-model` on the same client wire.
4. Confirm the requested `providerId/modelId` appears in `/v1/models`.
5. Confirm the provider credential exists without displaying it.
6. Inspect the background log and `/v1/usage`.
7. Reproduce in the foreground.
8. Use debug logging only after considering prompt and payload sensitivity.
