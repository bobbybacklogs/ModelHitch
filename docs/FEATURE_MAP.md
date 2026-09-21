# Feature Map — npm package `modelhitch`

Truthful inventory of the **core TypeScript package** (`package.json` `"name": "modelhitch"`, CLI bin `modelhitch`). README and `docs/guide.md` are hints. Grades come from source and the default verify gate, not marketing copy.

Generated against package version **2.0.3**. Re-grade after material API or test changes.

## Grades

| Grade | Meaning |
| --- | --- |
| **Proven (verify)** | Exercised by `npm run verify` (`tsc --noEmit` + `tsup` + `vitest run`) with **no secret API keys**. |
| **Code-inspected** | Present in `src/`. Default verify does not fully drive it, or coverage is export/shape-only. |
| **Unverified (env-gated)** | Needs live credentials, a local model server, Bun+TTY, a real browser, or network to `models.dev` / provider APIs. Not part of default verify. |
| **Gap** | Claimed, advertised, or declared as a capability, but not implemented on this package’s public API — or a sister product, not this npm package. |

Default verify is defined in [`.agents/skills/verify-modelhitch/SKILL.md`](../.agents/skills/verify-modelhitch/SKILL.md).

## Scope

**In:** library client, providers, BYOK keystores, tool loop, React entry, browser entry, local multi-wire bridge, CLI, failover/policy/catalog/usage, skill installer.

**Out of this map’s default verify:** `android-sdk`, `flutter-sdk`, `expo-sdk`, `electron-sdk`, `modelhitch-dotnet`. Those are separate packages with their own CI jobs. README “What you get” lists them; they are not shipped inside the `modelhitch` npm tarball (`"files": ["dist"]`).

Product agent skills (`.claude/skills/modelhitch-*`, `plugins/modelhitch/…`) are installable documentation. They are not this gardener verify skill.

## Default verify

```bash
npm run verify
```

Equivalent to `npm run typecheck && npm run build && npm test`. `prepublishOnly` calls `npm run verify`. GitHub Actions job `typescript` runs `npm run prepublishOnly` on Node 22.

Must exit 0 without provider keys. Provider unit tests inject stub `fetch`. Bridge tests use `mockProvider` on `127.0.0.1`. Catalog tests inject a fixture `api.json`.

---

## Library API

| Claim | Grade | Evidence |
| --- | --- | --- |
| `ModelHitch.chat()` returns a completed assistant message | **Proven (verify)** | `tests/client.test.ts` against `mock` |
| `ModelHitch.stream()` yields normalized `StreamChunk`s; `streamToResult()` aggregates | **Proven (verify)** | `tests/client.test.ts`, `tests/stream.test.ts` |
| Provider lookup + `provider-not-found` | **Proven (verify)** | `tests/client.test.ts` |
| Default model / default provider resolution | **Proven (verify)** | `tests/client.test.ts` |
| `capabilities(providerId)` | **Proven (verify)** | `tests/client.test.ts` (gateway streaming flag) |
| `listModels(providerId)` | **Proven (verify)** on the gateway adapter; **Code-inspected** on the `ModelHitch` wrapper | Stub `fetch` in `tests/vercel-ai-gateway.test.ts`. Client throw when `listModels` is missing is `src/client.ts` only |
| `ModelHitch.create({ catalog })` warms models.dev then constructs the client | **Proven (verify)** | `tests/catalog.test.ts` with fixture fetch — **not** a live `https://models.dev` fetch |
| Typed `ModelHitchError` codes | **Proven (verify)** | `src/core/errors.ts`; asserted across client, failover, and provider tests |
| Custom `Provider` implementation | **Proven (verify)** | Recording / failing fixtures in `tests/client.test.ts`, `tests/auto-mode.test.ts`, `tests/exhaustion.test.ts` |
| `runToolLoop()` multi-turn tool execution | **Proven (verify)** | `tests/agent.test.ts` (mock streams; no live model) |
| SSE / NDJSON stream parsers | **Proven (verify)** | `tests/stream.test.ts` |

## BYOK and credentials

| Claim | Grade | Evidence |
| --- | --- | --- |
| Per-call `apiKey` / `baseUrl` override | **Proven (verify)** | `tests/client.test.ts` |
| `MemoryKeyStore` used when no explicit key | **Proven (verify)** | `tests/client.test.ts` |
| Fallback lanes do **not** inherit the primary per-call key | **Code-inspected** | `src/client.ts` `laneCredentials()` reads the keystore only. No dedicated test that a primary `apiKey` is withheld from lane 2 |
| Provider env-var fallback (`OPENAI_API_KEY`, …) | **Proven (verify)** | Hosted OpenAI-compatible tests assert `missing-api-key` when the env var is unset (`tests/gemini.test.ts`, `tests/moonshot.test.ts`, …) |
| Vercel AI Gateway credential order: `AI_GATEWAY_API_KEY` → `VERCEL_OIDC_TOKEN` → `VERCEL_TOKEN` → Vercel CLI `auth.json` | **Proven (verify)** | `tests/vercel-ai-gateway.test.ts` (env + fake CLI paths; live gateway **Unverified**) |
| `LocalStorageKeyStore` (browser BYOK) | **Code-inspected** | `src/storage/local-storage.ts` exported; only constructor existence in `tests/browser-entry.test.ts`. No get/set/delete tests (Node has no `localStorage`). |
| Live BYOK against a real provider | **Unverified (env-gated)** | Needs a real key. `examples/quickstart.ts` / `npm run canary`. |

## Providers (built-in registry)

`src/registry.ts` registers 19 ids. `tests/registry.test.ts` asserts that list.

| Provider id | Grade | Notes |
| --- | --- | --- |
| `mock` | **Proven (verify)** | Deterministic chat/stream/tools; used by client, agent, and bridge tests |
| `vercel-ai-gateway` | **Proven (verify)** for adapter wiring; **Unverified (env-gated)** live | Stub `fetch` in `tests/vercel-ai-gateway.test.ts` |
| `huggingface`, `gemini`, `deepseek`, `xai`, `mistral`, `moonshot`, `zai` | **Proven (verify)** for config + stubbed chat + missing-key; **Unverified (env-gated)** live | Dedicated tests mock `fetch` |
| `openai`, `groq`, `openrouter`, `together` | **Proven (verify)** as registry entries + shared OpenAI-compatible factory; **Unverified (env-gated)** live | No dedicated `tests/<id>.test.ts`. Factory coverage is `tests/passthrough.test.ts` |
| `anthropic` | **Code-inspected** native adapter; **Proven (verify)** Anthropic *wire* on the bridge; **Unverified (env-gated)** live | `src/providers/anthropic.ts` has no dedicated HTTP test. `tests/anthropic-bridge.test.ts` maps `/v1/messages` through `mockProvider` |
| `ollama` | **Code-inspected** adapter; **Unverified (env-gated)** live localhost | `src/providers/ollama.ts`; no dedicated live test |
| `lmstudio`, `vllm`, `llamacpp`, `koboldcpp` | **Code-inspected** OpenAI-compatible local defaults; **Unverified (env-gated)** | `requiresKey: false`; need a local server |
| `createOpenAICompatibleProvider` | **Proven (verify)** | Passthrough, error mapping, max_tokens, tool content coercion |

Live hosted inference and local-runtime inference are **not** in default verify.

## Streaming, tools, multimodal

| Claim | Grade | Evidence |
| --- | --- | --- |
| Normalized stream events (text, tool-call start/args/end, finish, usage) | **Proven (verify)** | Mock + `tests/stream.test.ts` + bridge SSE tests |
| Tool definitions, `toolChoice`, `responseFormat` passthrough | **Proven (verify)** | `tests/passthrough.test.ts` |
| Image `ContentPart` types (`image`, `image-data`) | **Code-inspected** on the library path | Types in `src/core/types.ts`; library tests do not round-trip a vision model |
| Bridge local-file image inlining (`file://`, `vscode-resource://`) with sniffing/size gates | **Proven (verify)** | `tests/local-images.test.ts` |
| Vision capability auto-inferred from image parts | **Gap** (intentional) | `inferRequirements` only auto-infers `toolCalling`; comment in `src/core/capabilities.ts` |
| Embeddings API (`Provider.embed` / `POST /v1/embeddings`) | **Gap** | `Capabilities.embeddings` is `true` for `openai` and `lmstudio`. `Provider` has no embed method. Bridge `POST /v1/embeddings` is 404 (`tests/server.test.ts`) |

## Failover, policy, catalog, circuit breaker

| Claim | Grade | Evidence |
| --- | --- | --- |
| `autoMode` retries 429 / 5xx / network; skips credential-missing lanes; no mid-stream failover after content | **Proven (verify)** | `tests/failover.test.ts`, `tests/auto-mode.test.ts` (in-process / mock HTTP) |
| Exhaustion preserves the first error (`ExhaustedError`) | **Proven (verify)** | `tests/exhaustion.test.ts` |
| Policy trusted/fallback lanes, backoff, validation | **Proven (verify)** | `tests/policy.test.ts`, `tests/settings.test.ts` |
| Capability filter skips tool-incapable lanes | **Proven (verify)** | `tests/capabilities.test.ts`, `tests/client.test.ts`, `tests/auto-mode.test.ts` |
| `CircuitBreaker` trip / half-open / snapshot | **Proven (verify)** | `tests/circuit-breaker.test.ts` |
| `MemoryLaneCooldown` + Retry-After | **Proven (verify)** | Cooldown used from policy/settings tests; `parseRetryAfter` via failover/breaker |
| Catalog merge: registry wins; auto-build OpenAI-compatible adapters; usability errors | **Proven (verify)** with fixture JSON | `tests/catalog.test.ts` |
| Live models.dev catalog download | **Unverified (env-gated)** | Needs network to `https://models.dev` |

## Browser and React

| Claim | Grade | Evidence |
| --- | --- | --- |
| `modelhitch/browser` exports client/providers/keystores/tool loop/usage **without** `node:` imports or the bridge server / `SqliteUsageStorage` | **Proven (verify)** | `tests/browser-entry.test.ts` (static graph + export presence) |
| Bundler `browser` export condition | **Code-inspected** | `package.json` `"exports"."."."browser"` → `./dist/browser.js`. No Vite/webpack integration test in root verify |
| `createBridgeClient` | **Proven (verify)** | `tests/react-core.test.ts` (constructs; does not hit a live bridge) |
| Stream reducer (text + tool-call assembly) | **Proven (verify)** | `tests/react-core.test.ts` |
| `useChat` / `useStream` React hooks | **Code-inspected** | `src/react/index.ts`. No hook renderer / JSDOM test. Pending, cancel, reset, error states are unproven in default verify |
| Direct browser CORS / `dangerouslyAllowBrowser` on Anthropic | **Code-inspected** | `src/providers/anthropic.ts`; not live-browser proven |

## Local agent bridge and CLI

| Claim | Grade | Evidence |
| --- | --- | --- |
| `GET /healthz`, `GET /v1/models`, OpenAI `POST /v1/chat/completions` (sync + SSE) | **Proven (verify)** | `tests/server.test.ts` with `mockProvider` |
| OpenAI `POST /v1/responses` (sync, SSE, `previous_response_id`) | **Proven (verify)** | `tests/responses-bridge.test.ts`, `tests/responses-mapping.test.ts` |
| Anthropic `POST /v1/messages` (+ token count stub) | **Proven (verify)** | `tests/anthropic-bridge.test.ts` |
| Gemini `POST /v1beta/models/{model}:generateContent` (+ stream) | **Proven (verify)** | `tests/gemini-bridge.test.ts` |
| Route `providerId/modelId`; bare ids → default provider | **Proven (verify)** | `tests/server.test.ts` |
| `GET /v1/usage`, `GET /usage` dashboard HTML, `POST /v1/usage/reset` | **Proven (verify)** | `tests/auto-mode.test.ts`, `tests/usage.test.ts` |
| `GET/PUT /v1/config` (masked secrets; no masked write-back) | **Proven (verify)** | `tests/settings.test.ts` |
| `GET /v1/lane-health`, `GET /v1/catalog` | **Proven (verify)** | `tests/settings.test.ts` |
| Image lane `POST /v1/images/generations` (OpenAI + Gemini mapping), **off by default** | **Proven (verify)** with stub `imageFetch` | `tests/settings.test.ts`. Live image APIs **Unverified (env-gated)** |
| Usage SQLite persistence (`node:sqlite`) | **Proven (verify)** on Node 22.5+ | `tests/usage-storage.test.ts`. Library still supports Node 18 without persistence |
| Cost estimates | **Proven (verify)** as a lookup table | `tests/cost.test.ts`. README already warns estimates are best-effort |
| CLI `bridge --background` / pid / log / `status` / `stop` | **Proven (verify)** | `tests/daemon.test.ts` (builds CLI, spawns background mock bridge) |
| CLI `setup` skill install (codex/claude/cursor/vscode, user/project, dry-run, force) | **Proven (verify)** | `tests/skill-installer.test.ts` (in-process; not the `dist/cli.js setup` argv path) |
| CLI `--help` / `--version` / `config` / `front` | **Code-inspected** | `src/cli.ts` |
| CLI `settings` OpenTUI | **Code-inspected** form mapping; **Unverified (env-gated)** live TUI | `tests/settings-form.test.ts`; TUI requires Bun + TTY (`src/cli.ts`) |
| CLI `settings --web` opens `/settings` | **Code-inspected** | Needs a running bridge; HTML helper is tested via `settingsPageHtml` |
| Live bridge → real gateway tool loop | **Unverified (env-gated)** | `npm run canary` (`examples/canary.ts`) |

## Packaging and engines

| Claim | Grade | Evidence |
| --- | --- | --- |
| TypeScript build (ESM + CJS + dts) for index, browser, react, cli, settings-tui | **Proven (verify)** | `tsup.config.ts` + `npm run build` in verify |
| `engines.node: >=18` for the library | **Code-inspected** | Declared in `package.json`. CI/default verify run Node 22 |
| Bridge SQLite needs Node 22.5+ | **Proven (verify)** on Node 22 | `src/core/usage-storage.ts`; usage-storage tests |
| `prepublishOnly` / `npm run verify` | **Proven (verify)** | `tests/release-scripts.test.ts` locks the script graph |
| README “No runtime dependencies” | **Gap** (marketing) | `package.json` `dependencies`: `@opentui/core`, `mdev-sdk`. `mdev-sdk` is bundled (`tsup` `noExternal`); OpenTUI stays external for the TUI |
| `conformance/openai-compatible-v1.json` as a cross-SDK wire contract | **Code-inspected** | File + `conformance/README.md`. **Not** imported by root vitest |

## Sister products (not this npm package)

| Surface | Grade for *this* package | Notes |
| --- | --- | --- |
| Android Kotlin SDK | **Gap** relative to the npm tarball; exists in-repo | `android-sdk/` — CI job `android`, not `npm run verify` |
| Dart / Flutter SDKs | **Gap** relative to the npm tarball; exists in-repo | `flutter-sdk/` — CI jobs `dart`, `flutter` |
| Expo / React Native adapter | **Gap** relative to the npm tarball; exists in-repo | `expo-sdk/` (`modelhitch-expo`) — excluded from root vitest; no root CI job in `.github/workflows/ci.yml` |
| Electron adapter | **Gap** relative to the npm tarball; exists in-repo | `electron-sdk/` (`modelhitch-electron`) — CI job `electron` |
| .NET library | **Gap** relative to the npm tarball; exists in-repo | `modelhitch-dotnet/` — no job in `.github/workflows/ci.yml` |

Do not mark those as Proven for `modelhitch` because they are not in default verify and not in the published `dist/`.

## Must still do (honest leftover)

Not a backlog to implement in a gardener PR. These are the remaining holes if someone treats README as a contract:

1. **Live provider/BYOK/bridge canaries** — optional, env-gated; never part of default verify.
2. **Embeddings** — capability flag without an embeddings method or bridge route.
3. **React hooks** — implement, but untested under a renderer.
4. **`LocalStorageKeyStore` behavior** — untested (needs a `Storage` fake or browser).
5. **Local runtimes and live catalog** — adapters exist; default verify does not start Ollama/etc. or fetch models.dev.
6. **Expo / .NET CI** — in-repo packages without a root `npm run verify` lane (Expo also lacks a workflow job).
7. **README “no runtime dependencies”** — false as written.

## What default verify does *not* prove

- Any real OpenAI / Anthropic / Gemini / Gateway / Groq / … HTTP call
- Browser CORS, localStorage persistence, or React hook UX
- Bun OpenTUI settings session
- Image generation against OpenAI or Gemini
- Sister SDK behavior
- That cost estimates match vendor invoices
