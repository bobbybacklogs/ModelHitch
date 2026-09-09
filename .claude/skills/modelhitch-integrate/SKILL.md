---
name: modelhitch-integrate
description: Integrate, extend, or troubleshoot ModelHitch in TypeScript, JavaScript, React, browser, Node, or edge applications. Use for provider-neutral chat and streaming, BYOK key storage, tool loops, React hooks, custom providers, model discovery, auto-mode failover, usage tracking, and ModelHitchError handling.
license: MIT
compatibility: ModelHitch applications using Node.js 18+ or a compatible browser/edge bundler; React workflows require React 18+.
metadata:
  author: Geno Ventures Labs
  package: modelhitch
---

# Integrate ModelHitch

Implement against the installed package and the target application's architecture. Treat this skill's reference as a map, then confirm exact types from the installed `modelhitch` version or repository source before editing.

## Choose the surface

- Use `modelhitch` for the client, providers, tools, failover, usage, or embedded bridge.
- Use `modelhitch/react` for React state and streaming through a bridge.
- Use the `mock` provider for deterministic tests without credentials.
- Use `createOpenAICompatibleProvider` for an OpenAI-compatible gateway. Implement `Provider` only for another wire protocol.
- Hand off agent/IDE bridge setup to `/modelhitch-bridge` when that skill is available.

Read [api-reference.md](references/api-reference.md) when exact imports, provider IDs, credential precedence, or verification patterns are needed.

## Workflow

1. Inspect the package manager, runtime, framework, existing AI boundary, and installed ModelHitch version.
2. Preserve the application's conventions. Add one long-lived `ModelHitch` instance at the appropriate boundary instead of scattering clients.
3. Select the provider and model deliberately. Use `listModels(providerId)` when the current remote catalog matters.
4. Resolve credentials in this order: request `apiKey` or `baseUrl`, configured keystore, provider environment variable, and for Vercel AI Gateway also the local Vercel CLI token.
5. Keep browser-owned keys in `LocalStorageKeyStore`. Use `MemoryKeyStore` or environment variables server-side. Never print, commit, or accidentally bundle secrets.
6. Use `chat()` for a completed response, `stream()` for normalized events, and `runToolLoop()` only when the application must execute tools and submit results.
7. Handle failures through `ModelHitchError.code`; do not parse provider-specific message text.
8. Add `autoMode` only when retrying 429, provider 5xx, and network failures is desired. Order same-provider fallbacks before cross-provider lanes when data routing matters.
9. Verify with `mock/mock-model` first, then run an explicitly approved live-provider check.

## React

- Import hooks from `modelhitch/react`, not the root package.
- Point `useChat` or `useStream` at a running bridge and use an explicit `providerId/modelId` route.
- Verify pending state, cancellation, streamed deltas, tool events, error state, and reset behavior.

## Safety and correctness

- Do not assume a model ID is current; discover it when availability matters.
- Do not copy a per-call credential into fallback providers.
- Do not retry a stream after content was emitted because output would be duplicated.
- Treat cost estimates as best-effort; zero for free or unknown models is not proof that billing cannot occur.
- Run typecheck and focused tests after edits. State whether verification used the mock provider or contacted a live service.
