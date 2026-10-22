# ModelHitch Swift SDK — API Contract

Source of truth: the TypeScript package in `src/` (`modelhitch` v2.8.1, "One
TypeScript API. Your keys. Hosted or local. No runtime dependencies").

This contract defines the public surface the Swift package mirrors. It is a
**core BYOK client parity** contract: the pieces an app calls to send chat
requests with a user's own key. It is not a 1:1 port of every Node-only
subsystem (see [Deferred surface](#deferred-surface)).

Working folder: `C:\Users\labs\OneDrive\Documents\GitHub\ModelHitch`.
Package root: `swift-sdk/`.

---

## 1. Scope

Covered (parity target):

| TS symbol | Swift symbol |
| --- | --- |
| `ModelHitch` (client, core methods) | `ModelHitch` |
| `ChatInput` | `ChatInput` |
| `ChatParams` | `ChatParams` |
| `ModelMessage` / `ContentPart` | `ModelMessage` / `ContentPart` / `MessageContent` |
| `ToolDefinition`, `ToolCall`, `ToolChoice` | same names |
| `ResponseFormat` | `ResponseFormat` |
| `ChatResult`, `Usage` | `ChatResult`, `Usage` |
| `StreamChunk` | `StreamChunk` |
| `Capabilities` | `Capabilities` |
| `ProviderCredentials` | `ProviderCredentials` |
| `ModelInfo` | `ModelInfo` |
| `Provider` interface | `Provider` protocol |
| `KeyStore` | `KeyStore` protocol |
| `MemoryKeyStore` | `InMemoryKeyStore` (actor) |
| — (new, Apple) | `KeychainKeyStore` |
| `ModelHitchError`, `ModelHitchErrorCode` | `ModelHitchError`, `ModelHitchErrorCode` |
| `createOpenAICompatibleProvider` | `OpenAICompatibleProvider` |
| `defaultProviders` (OpenAI-compatible subset) | `DefaultProviders.all` / `defaultProviders` |
| `aggregateStream` | `aggregateStream(_:)` |

Deferred: see [Deferred surface](#deferred-surface). Wave 2 adds the test
target and tests.

---

## 2. Client — `ModelHitch`

Constructed with `ModelHitchOptions { providers, keyStore, defaultProviderId,
defaultModel }`. `providers` defaults to `defaultProviders`.

| Method | Signature | Behavior |
| --- | --- | --- |
| `provider` | `func provider(_ id: String) throws -> Provider` | Lookup by id; throws `provider-not-found` with the available ids. |
| `capabilities` | `func capabilities(_ providerId: String) throws -> Capabilities` | Delegates to the provider. |
| `chat` | `func chat(_ input: ChatInput, credentialsOverride: ProviderCredentials? = nil) async throws -> ChatResult` | Complete call. |
| `stream` | `func stream(_ input: ChatInput, credentialsOverride: ProviderCredentials? = nil) -> AsyncThrowingStream<StreamChunk, Error>` | Streaming call. |
| `streamToResult` | `func streamToResult(_ input: ChatInput, credentialsOverride: ProviderCredentials? = nil) async throws -> ChatResult` | `stream` + `aggregateStream`. |
| `listModels` | `func listModels(_ providerId: String, credentialsOverride: ProviderCredentials? = nil) async throws -> [ModelInfo]` | Provider model discovery. |

TS parity notes:

- TS `chat(input, credentialsOverride?)` and `stream(...)` become `chat(_:)` /
  `stream(_:)` in Swift (labeled-argument style). `async` + `throws` replaces
  the returned `Promise`.
- TS `ModelHitch.create()` exists only for catalog mode. The Swift client has a
  single `init` — no catalog warm-up.
- Provider/model resolution matches TS: explicit `input.provider` >
  `defaultProviderId` > first registered provider; `input.model` >
  `defaultModel` > `provider.defaultModel`.

## 3. Input shapes

### `ChatInput`

Mirrors TS `ChatInput` = `Omit<ChatParams,'model'>` plus routing/credential
overrides:

```
messages: [ModelMessage]      provider: String?      model: String?
apiKey: String?               baseUrl: String?       tools: [ToolDefinition]?
temperature: Double?          maxTokens: Int?        stop: [String]?
toolChoice: ToolChoice?       responseFormat: ResponseFormat?
previousResponseId: String?   sessionId: String?
```

### `ChatParams`

Identical to `ChatInput` minus the four routing/credential fields, plus a
non-optional `model: String`. TS `signal?: AbortSignal` is represented in Swift
by task cancellation (`Task.cancel()` / `AsyncThrowingStream` termination)
rather than a field.

### `ModelMessage`

TS is a role-discriminated union. Swift models it as a struct with `role:
Role`, `content: MessageContent` (`.text(String)` or `.parts([ContentPart])`),
`name`, `toolCalls`, `toolCallId`, `reasoningContent`. Construction helpers
`system`/`user`/`assistant`/`tool` mirror the dotnet port's ergonomics.

### `ContentPart`

`text(String)` | `imageURL(String)` | `imageData(data:mimeType:)`. On the wire
(OpenAI-compatible) these encode to `{type:"text",text}` and
`{type:"image_url",image_url:{url}}`; `imageData` becomes a `data:<mime>;base64,`
URL.

### `ToolDefinition`, `ToolCall`, `ToolChoice`, `ResponseFormat`

- `ToolDefinition { name, description?, parameters: JSONValue? }` — `parameters`
  is a JSON Schema object.
- `ToolCall { id, name, arguments: JSONValue, thoughtSignature? }` — arguments
  are structured in Swift, string-encoded only at the OpenAI wire boundary.
- `ToolChoice`: `.auto | .none | .required | .function(name:)`.
- `ResponseFormat`: `.text | .jsonObject | .jsonSchema(name:strict:schema:)`.

`JSONValue` is a dependency-free Codable enum replacing TS
`Record<string, unknown>` / `unknown`.

## 4. Output shapes

### `ChatResult`

`{ message: ModelMessage, finishReason: String, usage: Usage?, responseId:
String?, raw: JSONValue? }`. TS `finishReason` is a union (`'stop' | 'length' |
'tool-calls' | 'content-filter' | string`); Swift keeps it a `String` to allow
provider-specific values, matching TS's open `(string & {})` arm.

### `StreamChunk`

Enum with associated values, one case per TS union member:

```
textDelta(String)
reasoningDelta(String)
toolCallStart(id:name:thoughtSignature:)
toolCallArgsDelta(id:argsDelta:)
toolCallEnd(id:)
finish(finishReason:usage:responseId:)
```

`aggregateStream(_:)` mirrors TS `aggregateStream`: concatenates text and
reasoning, assembles tool calls from start/args/end events (parsing accumulated
argument JSON), and returns a `ChatResult`.

## 5. Provider protocol

```
protocol Provider: Sendable {
  var id: String { get }
  var name: String { get }
  var defaultModel: String { get }
  var capabilities: Capabilities { get }
  func chat(_ params: ChatParams, credentials: ProviderCredentials) async throws -> ChatResult
  func stream(_ params: ChatParams, credentials: ProviderCredentials) -> AsyncThrowingStream<StreamChunk, Error>
  func listModels(credentials: ProviderCredentials) async throws -> [ModelInfo]
}
```

TS `listModels?` is optional on the interface; Swift provides a default
implementation that throws `provider-error` ("does not support model listing"),
preserving the TS behavior.

## 6. Base URL — hosted vs local

Each `OpenAICompatibleProvider` carries a `baseURL`. A call may override it with
`input.baseUrl` or `credentialsOverride.baseUrl`. Paths are appended after
normalizing a trailing slash (`<base>/chat/completions`, `<base>/models`).

Defaults mirror `src/providers/defaults.ts`:

| id | baseURL | key env var | requires key |
| --- | --- | --- | --- |
| openai | `https://api.openai.com/v1` | `OPENAI_API_KEY` | yes |
| groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | yes |
| openrouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | yes |
| together | `https://api.together.xyz/v1` | `TOGETHER_API_KEY` | yes |
| huggingface | `https://router.huggingface.co/v1` | `HF_TOKEN` | yes |
| gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` | yes |
| deepseek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | yes |
| xai | `https://api.x.ai/v1` | `XAI_API_KEY` | yes |
| mistral | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` | yes |
| moonshot | `https://api.moonshot.ai/v1` | `MOONSHOT_API_KEY` | yes |
| zai | `https://api.z.ai/api/paas/v4/` | `ZAI_API_KEY` | yes |
| lmstudio | `http://localhost:1234/v1` | — | no |
| vllm | `http://localhost:8000/v1` | — | no |
| llamacpp | `http://localhost:8080/v1` | — | no |
| koboldcpp | `http://localhost:5001/v1` | — | no |

The "hosted vs local" split is therefore a per-provider base URL, exactly as in
TS. The local bridge (`http://127.0.0.1:3939/v1`) is reachable the same way: a
provider (or `OpenAICompatibleProvider`) pointed at that base with
`requiresKey: false`.

## 7. Auth / key handling

Resolution order (matches TS `resolveCredentials`):

1. Explicit per-call: `credentialsOverride` (Swift-only escape hatch) or
   `input.apiKey` / `input.baseUrl`.
2. `keyStore.get(providerId)`.
3. Provider env-var fallback (`apiKeyEnvVar`) — TS adapter behavior.

The key is sent as `Authorization: Bearer <key>`. A missing required key throws
`missing-api-key` before any network call.

`KeyStore` protocol:

```
func get(_ providerId: String) async throws -> String?
func set(_ providerId: String, _ apiKey: String) async throws
func delete(_ providerId: String) async throws
```

- `InMemoryKeyStore` (actor) — tests / ephemeral. TS `MemoryKeyStore`.
- `KeychainKeyStore` (`Security`) — production on Apple platforms. Generic
  password under `service` (default `com.modelhitch.apikeys`) + provider id as
  account, `kSecAttrAccessibleAfterFirstUnlock`. Guarded by
  `#if canImport(Security)`. This is the required "in-memory override for
  tests" pair.

## 8. Streaming protocol

**Server-Sent Events (SSE).** TS `parseSSE` splits on `\n\n` / `\r\n\r\n`,
reads `data:` lines, skips comments and the `[DONE]` sentinel. Swift uses
`URLSession.bytes(for:).lines` to iterate SSE lines, then per `data:` frame:

- decode a JSON chat-completion chunk,
- emit `.reasoningDelta` from `delta.reasoning_content`, `.textDelta` from
  `delta.content`,
- emit `.toolCallStart` once per new `tool_calls[].id` (with optional
  `thought_signature`), then `.toolCallArgsDelta` for each
  `function.arguments` fragment,
- track `finish_reason`, `usage` (via `stream_options.include_usage`), and
  response `id`.

On `[DONE]` the adapter emits `.toolCallEnd` for each started tool call,
then `.finish(finishReason:usage:responseId:)`.

Ollama's native NDJSON is **not** covered — TS reaches Ollama through its
OpenAI-compatible endpoint, which the Swift adapter does too. (TS `parseLines`
is NDJSON-only and deferred.)

## 9. Error model

`ModelHitchError` is the single thrown type: `{ code, message, status?,
providerId?, retryAfterMs? }`, `LocalizedError`. Raw `code` strings match TS:

`missing-api-key`, `invalid-api-key`, `rate-limited`, `model-not-found`,
`provider-not-found`, `provider-error`, `network-error`, `bad-request`,
`capability-unavailable`.

HTTP mapping in the OpenAI-compatible adapter: `401/403` → `invalid-api-key`,
`429` → `rate-limited` (Retry-After seconds → `retryAfterMs`), `404` →
`model-not-found`, `400/422` → `bad-request`, else `provider-error`.

---

## Deferred surface

Not ported in this pass. Each is Node-only, UI/host-specific, or outside the
core BYOK client. Flagging for Compass's parity ruling.

- **Routing engine** — `policy`, `autoMode`, `intents`, `cooldown`,
  `CircuitBreaker`, `withFailover`, `resolveLanes`, `CapabilityUnavailable` /
  `filterEligibleLanes`. The Swift client resolves exactly one provider. This is
  the largest parity gap; a follow-up could port `autoMode` (ordered lane list +
  retryable-code walk) without the catalog.
- **Catalog** (`mdev-sdk`, `createCatalogSource`, `ModelHitch.create`) —
  depends on a Node package.
- **Native multi-wire adapters** — Anthropic Messages, Gemini generateContent,
  OpenAI Responses endpoint, Vercel AI Gateway (default runtime), ChatGPT-plan
  lane, custom lanes, OpenCode BYOK. Only the OpenAI-compatible wire is ported.
- **Agent/tool loop** — `runToolLoop` (`src/agent.ts`).
- **Bridge server & lane catalog** — `OpenAICompatibleServer`,
  `createModelHitchServer`, `planLanes`, `intentModelId`, etc.
- **Usage tracking** — `UsageTracker`, `SqliteUsageStorage` (SQLite, Node).
- **Settings/config** — `readConfigFile`/`writeConfigFile`, validation, masking,
  serialization. Requires filesystem + Node conventions.
- **Workspace, React hooks, CLI, TUI, ASCII logo, session-id helpers, DSML
  recovery** — host-specific.

## Ambiguities / missing in the TS surface

- `AgentRuntime`/plugin surfaces are excluded.
- TS `ChatResult.finishReason` open union is represented as `String` (parity is
  behavioral, not exhaustive-type).
- TS `ChatParams.signal` has no Swift field; cancellation is via Task.
- `memory` naming: TS `MemoryKeyStore` exposes `get/set/delete`; Swift keeps the
  same method names but the type is `InMemoryKeyStore` to match its actor role —
  rename if strict name parity is required.
