# Feature Map — npm package `modelhitch`

Truthful inventory of the **core TypeScript package** (`package.json` `"name": "modelhitch"`, CLI bin `modelhitch`). README and `docs/guide.md` are hints. Grades come from source and the default verify gate, not marketing copy.

Generated against package version **2.6.0**. Re-grade after material API or test changes.

## Grades

| Grade | Meaning |
| --- | --- |
| **Proven (verify)** | Exercised by `npm run verify` (`tsc --noEmit` + `tsup` + `vitest run`) with **no secret API keys**. |
| **Code-inspected** | Present in `src/`. Default verify does not fully drive it, or coverage is export/shape-only. |
| **Unverified (env-gated)** | Needs live credentials, a local model server, Bun+TTY, a real browser, or network to `models.dev` / provider APIs. Not part of default verify. |
| **Gap** | Claimed, advertised, or declared as a capability, but not implemented on this package’s public API — or a sister product, not this npm package. |

Default verify is defined in [`.agents/skills/verify-modelhitch/SKILL.md`](../.agents/skills/verify-modelhitch/SKILL.md).

## Scope

**In:** library client, providers, BYOK keystores, tool loop, React entry, browser entry, local multi-wire bridge, CLI, failover/policy/catalog/usage, skill installer, Sign in with ChatGPT (OAuth credential store, ChatGPT plan lane, account routes, `/settings` account panel).

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
| OpenCode Console BYOK credentials: shared Console service-account key (`keys.opencode-byok` → `keys.opencode` → `keys.opencode-go` → `OPENCODE_API_KEY`) with a per-connection override | **Proven (verify)** | Precedence chain in `tests/opencode-byok.test.ts`; end-to-end against a local fake Console upstream in `tests/cli-bridge-flags.test.ts` |
| Live OpenCode Console connection (`https://opencode.ai/inference/custom/<conn_…>`) | **Unverified (env-gated)** | Needs a real Console workspace + service-account key. Default verify points the connection at `127.0.0.1` through `baseUrl` |
| Sign in with ChatGPT OAuth: dynamic client registration, PKCE S256, loopback callback, code exchange, JWKS-backed ID-token validation, credential file | **Proven (verify)** | `tests/chatgpt-plan-auth.test.ts` runs the whole flow over a real loopback socket: the callback is fetched for real, the token/JWKS/revocation endpoints are stubbed, and ID tokens are signed with a generated RSA key. PKCE is pinned to the RFC 7636 Appendix B vector. Rejections covered: wrong key, tampered payload, unknown `kid`, `alg: none`, wrong audience/issuer/nonce, expired, not-yet-valid, missing `sub` |
| Sign in with ChatGPT credential file: documented snake_case record, atomic write, `0600` on POSIX, corrupt-file rejection | **Proven (verify)** | `tests/chatgpt-plan-auth.test.ts`. The read path proves no temp file survives an overwrite, that a missing file is empty rather than an error, and that corrupt or non-object content throws instead of silently emptying |
| Sign in with ChatGPT token lifecycle: refresh with the issued client id, rotating refresh token persisted, serialized refreshes, `invalid_grant` vs 5xx recovery, scopes retained when a refresh omits `scope` | **Proven (verify)** | `tests/chatgpt-plan-auth.test.ts` (`refreshResponse` stub per grant) |
| Sign in with ChatGPT sign-out: revoke the renewable session, warn when revocation is unconfirmed, clear local tokens, retain the account/client mapping and host id | **Proven (verify)** | `tests/chatgpt-plan-auth.test.ts` |
| Live `https://auth.openai.com` authorization, token, JWKS, and revocation endpoints | **Unverified (env-gated)** | Needs a real ChatGPT account and a browser. Default verify stubs all four; the endpoints and scopes are taken from the live `/.well-known/openid-configuration` |
| Live BYOK against a real provider | **Unverified (env-gated)** | Needs a real key. `examples/quickstart.ts` / `npm run canary`. |

## Providers (built-in registry)

`src/registry.ts` registers 19 ids. `tests/registry.test.ts` asserts that list. The `chatgpt-plan`
provider is **not** in the registry: it needs an OAuth credential source, so `bridgeProviders()`
injects it only when the config block is on and a store exists.

| Provider id | Grade | Notes |
| --- | --- | --- |
| `mock` | **Proven (verify)** | Deterministic chat/stream/tools; used by client, agent, and bridge tests |
| `chatgpt-plan` (injected, not in the registry) | **Proven (verify)** for the Responses request body, SSE normalization, failure mapping, model listing, and the injected provider set; **Unverified (env-gated)** live | `tests/chatgpt-plan.test.ts` (stub `fetch`), `tests/bridge-providers.test.ts` (injection). Live inference needs a signed-in ChatGPT account. This route's request shape differs from the ordinary OpenAI API: `store:false` + `stream:true` are forced, an explicit system input item is refused, `previous_response_id` is unavailable, and `temperature`/`max_output_tokens`/`top_p`/`metadata`/`user`/`truncation`/`prompt`/`safety_identifier`/`max_tool_calls`/`moderation` are dropped rather than sent |
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
| OpenCode Console BYOK rotation: every enabled connection × model becomes a lane at the front of `trusted`, the configured policy stays behind as the safety net | **Proven (verify)** | `tests/opencode-byok.test.ts` (`applyOpenCodeByokPlan`), `tests/cli-bridge-flags.test.ts` (end-to-end lane) |
| OpenCode Console BYOK pin: one connection (and model) leads, its remaining models and the configured policy follow as fallback | **Proven (verify)** | `tests/opencode-byok.test.ts` |
| Custom BYOK lanes: a provider ModelHitch does not ship is configured as a lane (endpoint + key + hand-typed model slots, multi-wire `auto`/chat-completions/responses/anthropic/google) and joins the plan as an ordinary `custom-<slug>` provider | **Proven (verify)** | `tests/custom-lanes.test.ts`; `tests/cli-bridge-flags.test.ts` (built CLI against a local fake upstream); `tests/bridge-providers.test.ts` |
| Custom lanes are never polled for models — the typed slots are the only catalog, and `GET /models` is never sent | **Proven (verify)** | `tests/custom-lanes.test.ts` (`listModels` with a fetch that throws), `tests/cli-bridge-flags.test.ts` (no `GET` on the fake upstream) |
| Custom lane placement: `lead` (default) routes to the lanes first with the configured policy behind; `fallback` appends them behind the buffet without touching the primary route | **Proven (verify)** | `tests/custom-lanes.test.ts` (`applyCustomLanesPlan`) |
| Custom lane `onLimit: "stop"`: the lane is terminal — a 429/402/5xx surfaces instead of rotating on, and keeps stopping while the lane is parked | **Proven (verify)** | `tests/terminal-lanes.test.ts` (kernel, client, cooldown engines), `tests/cli-bridge-flags.test.ts` (end-to-end: the lane behind a stopped lane is never called) |
| Custom lane key order: `keys["custom-<slug>"]` → the lane's `apiKeyEnvVar` → `MODELHITCH_CUSTOM_<ID>_API_KEY`; `requiresKey:false` for a keyless endpoint | **Proven (verify)** | `tests/custom-lanes.test.ts` |
| Custom lanes in the harness (`mhh`) run: providers are injected and the plan applied, so a document with lanes neither fails policy validation nor is ignored | **Proven (verify)** | `tests/harness-custom-lanes.test.ts` |
| `bridge --provider <id>` pin: the pinned provider serves even requests that name another provider, the displaced route becomes the first fallback, and a depleted pin still rotates on | **Proven (verify)** | `tests/provider-pin.test.ts` (in-process server), `tests/cli-bridge-flags.test.ts` (built CLI) |
| Sign in with ChatGPT lane rotation and pin: `rotation` rotates over the model slots, `pinned` leads on one slot with its siblings as the first fallback, `onLimit:"stop"` marks the lane terminal | **Proven (verify)** | `tests/chatgpt-plan.test.ts` (`applyChatGptPlanPlan`) |
| Sign in with ChatGPT lane placement: `lead` (default) prepends the lane and becomes the primary route; `fallback` appends it and leaves the primary route alone | **Proven (verify)** | `tests/chatgpt-plan.test.ts` |
| Sign in with ChatGPT model resolution: the config slot list wins, else the account catalogue, else the lane does not serve (never a guessed slug) | **Proven (verify)** | `tests/chatgpt-plan.test.ts` (`resolveChatGptPlan`), `tests/bridge-providers.test.ts` |
| Sign in with ChatGPT plan-limit failure rotates: `subscription_sharing_usage_limit_exceeded` becomes `rate-limited` with status 429, which the failover walk treats as retryable | **Proven (verify)** | `tests/chatgpt-plan.test.ts` (mapping), `tests/chatgpt-plan-routes.test.ts` (route) |
| Sign in with ChatGPT stream completeness: a stream that ends without `response.completed` errors instead of reporting a clean stop; `response.incomplete` maps to `length`/`content-filter` | **Proven (verify)** | `tests/chatgpt-plan.test.ts` |
| Sign in with ChatGPT lane end to end through the bridge: reachable on the OpenAI chat-completions and Responses wires, advertised in `GET /v1/models`, serves as the default route when it leads | **Proven (verify)** | `tests/chatgpt-plan-bridge.test.ts` (in-process server, stub Responses transport) |
| Sign in with ChatGPT rotation through the bridge: a plan 429 rotates to the next lane and cools the lane so later requests skip it; `onLimit:"stop"` surfaces the limit instead | **Proven (verify)** | `tests/chatgpt-plan-bridge.test.ts` |
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
| The routing plan published as models: `GET /v1/models` leads with the trusted lanes, then the fallback lanes (or auto-mode's primary + rotation), named and flagged with tier/index/terminal metadata | **Proven (verify)** | `tests/lane-catalog.test.ts` (projection, order, dedupe, drift guard against `resolvePolicyLanes`), `tests/lane-models.test.ts` (in-process server: order, lane id addressable, lane routable, bare default-provider id, shadowing guard, no lane entries without a plan) |
| The auto id `modelhitch/auto` stands for the whole plan on every wire: it routes exactly as a request that omits `model` (a `--provider` pin still applies), is published first in `GET /v1/models` carrying the lanes it expands to, and is addressed by `GET /v1/models/modelhitch/auto` | **Proven (verify)** | `tests/auto-model.test.ts` (unit + in-process server: catalog order/metadata, chat streaming and non-stream failover past a dead primary, Responses/Messages/Gemini wires, identical route to an unnamed request, pin interaction). Live bridge on 127.0.0.1: 200 `modelhitch/auto` → `deepseek-v4-pro` |
| `GET /v1/usage`, `GET /usage` dashboard HTML, `POST /v1/usage/reset` | **Proven (verify)** | `tests/auto-mode.test.ts`, `tests/usage.test.ts` |
| `GET/PUT /v1/config` (masked secrets; no masked write-back) | **Proven (verify)** | `tests/settings.test.ts` |
| `GET /v1/lane-health`, `GET /v1/catalog` | **Proven (verify)** | `tests/settings.test.ts` |
| `GET /v1/opencode-state` (local OpenCode snapshot; 501 without a reader) | **Proven (verify)** | `tests/settings.test.ts`; reader itself in `tests/opencode-byok.test.ts` |
| Agent lanes behind one set of routes: `GET /v1/cloud-agents` merges every enabled lane, `GET|POST /v1/cloud-agents/:id[/cancel]`, and `POST /v1/cloud-agents/run` for a lane that drives its own runs | **Proven (verify)** + **live-verified** end to end against a real provider (a run reached `FINISHED` with a 3-turn, 5-tool-call session on disk, scoped to its configured workspace) | `tests/local-agent-routes.test.ts` (merge, owner discovery by asking, 400 for a non-driver lane, backend cache stability), `tests/local-agent-backend.test.ts`, `tests/cloud-agent-backend.test.ts`, `tests/cloud-agent-session-store.test.ts`, `tests/cloud-agent-readopt.test.ts`, `tests/cursor-cloud*.test.ts` |
| A local agent refuses to run without an explicit `localAgent.workspaceDir` (no `process.cwd()` fallback, which would hand it the whole repo a bridge was started from) | **Proven (verify)** | `tests/local-agent-backend.test.ts` (not ready / startRun rejects / whitespace-only counts as absent / ready with a real dir) |
| Cloud-agent conversations map to sessions durably (`~/.modelhitch/cloud-agents/`), so a restarted bridge continues an existing session instead of forking a new one | **Proven (verify)** | `tests/cloud-agent-session-store.test.ts` (cross-instance round-trip, per-backend isolation, path-hostile ids, corrupt-record tolerance), `tests/cloud-agent-readopt.test.ts`, `tests/cursor-cloud.test.ts` (restart continuity + stale-id recovery) |
| `GET /workspace` page (sessions, chat composer, work orders, cloud agents) | **Proven (verify)** for the routes + served HTML, and **verified by hand in a browser** for the rendered UI (desktop 1440×900 and mobile 390×844: no sideways overflow, rails stack, send/pending/filter flows) | `tests/workspace-http.test.ts` (routes), `tests/workspace-page.test.ts` (ids, inline-script parse guard, narrow-viewport rule). No automated browser/DOM test |
| Session auto-title from the first prompt (placeholder titles only, 60 chars) | **Proven (verify)** | `tests/workspace-http.test.ts` (untitled session named by first prompt, later turns do not rename, a chosen title survives, long prompt trimmed) |
| Workspace page target catalog: the plan lanes are pickable by name, with a filter that never changes the current choice, and the auto id is listed once (as `rotation`) | **Proven (verify)** for the served script | `tests/workspace-page.test.ts`, `tests/auto-model.test.ts`. Filter/pinning behaviour **verified by hand in a browser** |
| `/healthz` reports `pinnedProviderId` while a pin is active | **Proven (verify)** | `tests/provider-pin.test.ts` |
| `opencodeByok` block in `/v1/config` (connection editor, rotation/pin controls, import button) | **Proven (verify)** for the document + served HTML; **Unverified** for the rendered UI | `tests/settings.test.ts` (`validateConfig`, page HTML ids, inline-script parse guard). No browser/DOM test |
| `customLanes` block in `/v1/config` (lane editor: endpoint, schema, typed model slots, on-limit, capabilities, per-lane key) | **Proven (verify)** for the document + served HTML; **Unverified** for the rendered UI | `tests/settings.test.ts` (`validateConfig`, page HTML ids, inline-script parse guard). No browser/DOM test |
| `GET /v1/chatgpt-plan` plus `POST` `sign-in`, `sign-in/<id>`, `sign-in/<id>/cancel`, `sign-out`, `activate`, `models` (the account panel and sign-in flow) | **Proven (verify)** | `tests/chatgpt-plan-routes.test.ts`: every route, the 501 story on a bridge with no ChatGPT plan surface, `404` for an unknown path under the prefix, the 429-with-usage-link mapping, and hot-swap via `reconfigure` |
| `chatgptPlan` block in `/v1/config` (account panel, "Continue with ChatGPT", mode/placement/on-limit, model-slot editor, pin) | **Proven (verify)** for the document + served HTML; **Unverified** for the rendered UI | `tests/settings.test.ts` (page HTML ids, the `chatgptPlan: collectChatGptPlan()` payload key, the exact button label, the usage-settings URL, inline-script parse guard). No browser/DOM test |
| CLI `chatgpt-plan` command family (`status`, `sign-in`, `models`, `accounts`, `use`, `sign-out`) and the `bridge --chatgpt-plan*` flag family | **Code-inspected** for behavior; **Proven (verify)** for `--help` tokens | `tests/cli-help.test.ts` asserts the flags and the subcommand text. Sign-in needs a real browser, so the command body is not driven by default verify |
| Image lane `POST /v1/images/generations` (OpenAI + Gemini mapping), **off by default** | **Proven (verify)** with stub `imageFetch` | `tests/settings.test.ts`. Live image APIs **Unverified (env-gated)** |
| Usage SQLite persistence (`node:sqlite`) | **Proven (verify)** on Node 22.5+ | `tests/usage-storage.test.ts`. Library still supports Node 18 without persistence |
| Cost estimates | **Proven (verify)** as a lookup table | `tests/cost.test.ts`. README already warns estimates are best-effort |
| CLI `bridge --background` / pid / log / `status` / `stop` | **Proven (verify)** | `tests/daemon.test.ts` (builds CLI, spawns background mock bridge) |
| CLI `bridge --provider <id>` (pin, unknown-id rejection) and the `--opencode-byok*` flag family | **Proven (verify)** | `tests/cli-bridge-flags.test.ts` spawns the built CLI against a local fake upstream; `--help` tokens in `tests/cli-help.test.ts` |
| CLI `bridge --custom-lane*` flag family (`--custom-lane`, `-url`, `-models`, `-schema`, `-label`, `-on-limit`, `--custom-lanes`, `--custom-lanes-placement`) | **Proven (verify)** | `tests/cli-bridge-flags.test.ts` spawns the built CLI against local fake upstreams (including the stop-on-limit case); `--help` token in `tests/cli-help.test.ts` |
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
