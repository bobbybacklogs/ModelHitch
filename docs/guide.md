<p align="center"><img src="../repo_assets/guide_banner.png" width="750"></p>


# ModelHitch guide

The root [README](../README.md) is the storefront. This is the operations manual.

- [Library API](#library-api)
- [Credentials and BYOK](#credentials-and-byok)
- [Web apps (browser)](#web-apps-browser)
- [Android SDK](#android-sdk)
- [Dart and Flutter SDKs](#dart-and-flutter-sdks)
- [Electron SDK](#electron-sdk)
- [Tools and React](#tools-and-react)
- [Local agent bridge](#local-agent-bridge)
- [Auto-mode failover](#auto-mode-failover)
- [Capability-aware routing](#capability-aware-routing)
- [Usage and persistence](#usage-and-persistence)
- [Errors and custom providers](#errors-and-custom-providers)

## Library API

```ts
import { ModelHitch } from 'modelhitch';

const mh = new ModelHitch({ autoMode: true });

const result = await mh.chat({
  provider: 'mock',
  model: 'mock-model',
  messages: [{ role: 'user', content: 'Clock in.' }],
});

for await (const chunk of await mh.stream({
  provider: 'vercel-ai-gateway',
  model: 'openai/gpt-5.4',
  messages: [{ role: 'user', content: 'Stream it.' }],
})) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.text);
}
```

Useful methods include `chat`, `stream`, `streamToResult`, `provider`, `capabilities`, and
`listModels`. Use `mock/mock-model` for deterministic tests without credentials.

## Credentials and BYOK

Credentials resolve in this order:

1. Explicit request `apiKey` or `baseUrl`
2. Configured keystore
3. Provider environment variable
4. For Vercel AI Gateway: Vercel CLI `auth.json` token after `vercel login`

Use `LocalStorageKeyStore` for browser-owned keys and `MemoryKeyStore` or environment variables on
the server. Never put a server credential in a browser bundle.

| Provider | Environment variable |
| --- | --- |
| Vercel AI Gateway (default) | `AI_GATEWAY_API_KEY`, then `VERCEL_OIDC_TOKEN`, then `VERCEL_TOKEN`, then Vercel CLI auth |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Groq | `GROQ_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Together | `TOGETHER_API_KEY` |
| HuggingFace | `HF_TOKEN` |
| Google Gemini | `GEMINI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| xAI | `XAI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Moonshot | `MOONSHOT_API_KEY` |
| Z.ai (GLM) | `ZAI_API_KEY` |

Local providers and `mock` require no key by default.

Vercel AI Gateway uses provider-qualified model IDs such as `openai/gpt-5.4` and
`anthropic/claude-sonnet-4.6`. Its public model catalog is loaded dynamically by `listModels`, so
the settings model picker stays current without a hard-coded inventory; inference still requires
an AI Gateway API key, OIDC token, `VERCEL_TOKEN`, or a logged-in Vercel CLI.

## Web apps (browser)

The library ships a browser entry. Bundlers (Vite, webpack, esbuild, Rollup) resolve the `browser`
export condition automatically, so `import { ModelHitch } from 'modelhitch'` in a web app loads the
browser build — no Node polyfills required. You can also import from the dedicated entry explicitly:

```ts
import { ModelHitch } from 'modelhitch/browser';
```

The browser entry exposes the full library surface (client, providers, keystores, agent tool loop,
failover, usage tracking, stream helpers, types) minus the Node-only bridge server and SQLite usage
storage, which are never included in the browser bundle.

### Direct BYOK

The direct-BYOK pattern keeps keys on the user's device — never ship a server key in a browser bundle:

```ts
import { ModelHitch, LocalStorageKeyStore } from 'modelhitch';

const mh = new ModelHitch({ keystore: new LocalStorageKeyStore() });
await mh.keystore?.set('openai', userPastedKey); // stored in localStorage only
const result = await mh.chat({
  provider: 'openai',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

Keys stay in `localStorage` on the user's device and are read straight from the keystore on each call.

### CORS notes

Provider APIs that accept browser-origin calls without extra setup: OpenAI, OpenRouter, Groq,
Together, DeepSeek, Mistral, xAI, Moonshot, Z.ai (GLM), HuggingFace, and Vercel AI Gateway.

Anthropic rejects browser-origin requests unless the request carries the
`anthropic-dangerous-direct-browser-access: true` header. Pass `dangerouslyAllowBrowser: true` to
the provider options to send it:

```ts
import { createAnthropicProvider } from 'modelhitch';

const anthropic = createAnthropicProvider({ dangerouslyAllowBrowser: true });
```

Local runtimes (Ollama, LM Studio, vLLM, llama.cpp, KoboldCpp) must be reachable from the page's
origin with CORS enabled — usually a dev-only setup via `localhost`. `mockProvider` works fully
offline and needs no key, which makes it handy for demos.

### React and Node-only pieces

The React hooks (`useChat`, `useStream`) and `createBridgeClient` from `modelhitch/react` work
unchanged in browsers. The bridge server and SQLite usage storage are Node-only and are never
included in the browser bundle.

## Android SDK

The native Kotlin SDK lives in [`android-sdk`](../android-sdk). It uses OkHttp, coroutines, Kotlin
serialization, and Android Keystore directly; it does not embed the npm package or a JavaScript
runtime. Applications can register every built-in provider or an approved subset:

```kotlin
val keys = AndroidKeyStoreCredentialStore(applicationContext)
keys.set(selectedProviderId, keyEnteredByUser)

val hitch = ModelHitch(
  providers = DefaultProviders.all,
  keyStore = keys,
)

hitch.stream(
  ChatRequest(
    provider = selectedProviderId,
    model = selectedModelId,
    messages = listOf(ModelMessage.User(text("Hello from Android"))),
  ),
).collect { event ->
  if (event is StreamChunk.TextDelta) render(event.text)
}
```

Credentials are encrypted independently by provider ID, so changing providers does not overwrite
another provider's key. Explicit request credentials override the Keystore. Cancel the collecting
coroutine to cancel the underlying network call.

Use direct BYOK only for keys owned and supplied by the device user. Application-owned credentials
belong behind an HTTPS backend or the ModelHitch bridge. An emulator reaches a bridge on its host
machine through `10.0.2.2`; `127.0.0.1` points back to the emulator itself.

The Android implementation currently covers OpenAI-compatible providers, normalized chat and SSE
streaming, tools, multimodal request content, typed errors, model listing, and secure credentials.
Native Anthropic/Gemini protocol adapters, policy routing, automatic failover, catalog routing,
usage persistence, and the automated tool loop remain TypeScript-only. The Kotlin contracts are
designed so those capabilities can be added without changing application call sites.

See the [Android guide](../android-sdk/README.md) for build commands, Maven Local consumption,
backup exclusions, custom providers, the multi-provider Compose sample, and the complete scope.

## .NET and Windows SDK

The [`modelhitch-dotnet`](../modelhitch-dotnet) subtree provides the pure `net8.0` NuGet package
for WPF, WinUI 3, MAUI Windows, console, and service applications. It does not embed Node.js or the
npm package. It provides provider-neutral chat types, OpenAI-compatible HTTP and SSE streaming, tool
calls, model listing, typed errors, and a convenience client for the local ModelHitch bridge.

```csharp
using ModelHitch;

using var httpClient = new HttpClient();
var hitch = ModelHitchClient.ForBridge(
  httpClient,
  new Uri("http://127.0.0.1:3939/v1"),
  "mock/mock-model");
var reply = await hitch.ChatAsync(new ChatRequest([
  ModelMessage.User("Hello from a Windows app."),
]));
```

Use `OpenAICompatibleProvider` for a direct BYOK OpenAI-compatible provider. Application-owned
secrets do not belong in a Windows binary; connect those applications to a trusted backend or the
local bridge instead. See the [.NET README](../modelhitch-dotnet/README.md) and
[NuGet publishing guide](../modelhitch-dotnet/PUBLISHING.md) for build, package, and release steps.

## Dart and Flutter SDKs

The [`flutter-sdk`](../flutter-sdk) subtree separates the reusable Dart client from Flutter-only
platform storage. `modelhitch_dart` provides the normalized types, `ModelHitch`, `Provider`,
OpenAI-compatible HTTP/SSE adapter, `KeyStore`, and typed error contract. External Dart extensions
implement `Provider` for a new protocol or `KeyStore` for a credential mechanism. The Flutter
adapter re-exports the core and provides `FlutterSecureKeyStore` through `flutter_secure_storage`.

```dart
import 'package:modelhitch_dart/modelhitch_dart.dart';

final hitch = ModelHitch(keyStore: MemoryKeyStore());
await hitch.keyStore!.set('openai', userProvidedKey);
final result = await hitch.chat(
  ChatRequest(
    provider: 'openai',
    messages: [ModelMessage.user(MessageContent.text('Hello from Dart'))],
  ),
);
```

Use `package:modelhitch_flutter/modelhitch_flutter.dart` and `FlutterSecureKeyStore` in a Flutter
application. Do not put an application-owned key in either package; connect to a trusted backend or
ModelHitch bridge instead.

Cross-SDK OpenAI-compatible behavior is specified by the repository's
[conformance fixtures](../conformance). The Dart core must release before a Flutter adapter that
depends on it. See the [Dart/Flutter publishing guide](../flutter-sdk/PUBLISHING.md) for the
trusted-publishing setup and release order.

## Expo and React Native SDK

The [`expo-sdk`](../expo-sdk) package adapts the published `modelhitch` npm package for Expo
(SDK 52+) and React Native. It is a thin layer, not a reimplementation: the same `ModelHitch`
client, providers, failover, and usage tracking run on iOS, Android, and Expo web.

Two things make it necessary:

- **Streaming.** React Native's built-in `fetch` buffers the whole response, so SSE token deltas
  arrive in one burst. The adapter uses `expo/fetch`, which exposes `response.body` as a real
  `ReadableStream`, and installs it globally so the built-in providers stream.
- **Metro.** Metro does not resolve the `browser` export condition, so a bare `modelhitch` import
  in an Expo app would pull in the Node bridge server and `node:sqlite`. `modelhitch-expo`
  re-exports the browser-safe surface instead.

```ts
import { createExpoModelHitch } from 'modelhitch-expo';

const mh = createExpoModelHitch({ defaultProviderId: 'openai' });
await mh.keystore?.set('openai', keyPastedByUser); // device keychain

const stream = await mh.stream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello from Expo' }],
});
for await (const chunk of stream) {
  if (chunk.type === 'text-delta') appendText(chunk.text);
}
```

`SecureStoreKeyStore` stores each provider's key with `expo-secure-store` (Android Keystore / iOS
keychain) and falls back to `localStorage` on web. The React hooks (`useChat`, `useStream`) are
re-exported from `modelhitch-expo/react` for bridge-backed apps. See the
[Expo README](../expo-sdk/README.md) for the full setup, security notes, and publishing guide.

## Electron SDK

The [`electron-sdk`](../electron-sdk) package adapts the published `modelhitch` npm package for
Electron 28+ desktop apps. It is a thin layer, not a reimplementation: the same `ModelHitch`
client, providers, failover, and usage tracking run in the main process and in renderer windows.

Two things make it necessary:

- **Credential storage.** Renderer windows cannot call `safeStorage` directly. The adapter stores
  keys in the main process with `SafeStorageKeyStore` and exposes them to renderers through IPC
  (`registerKeyStoreIpc` / `createIpcKeyStore`).
- **Bundlers.** Some Electron bundlers resolve the Node `modelhitch` entry and pull in the bridge
  server and `node:sqlite`. `modelhitch-electron` re-exports the browser-safe surface instead.

```ts
import { createElectronModelHitch } from 'modelhitch-electron';

const mh = createElectronModelHitch({ defaultProviderId: 'openai' });
await mh.keystore?.set('openai', keyPastedByUser); // OS credential store

const stream = await mh.stream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello from Electron' }],
});
for await (const chunk of stream) {
  if (chunk.type === 'text-delta') appendText(chunk.text);
}
```

`SafeStorageKeyStore` encrypts each provider key with Electron `safeStorage` and persists the
ciphertext under the app's user-data directory. The React hooks (`useChat`, `useStream`) are
re-exported from `modelhitch-electron/react` for bridge-backed apps. See the
[Electron README](../electron-sdk/README.md) for renderer IPC, security notes, and publishing.

## Tools and React

Use `runToolLoop` when the application must execute model tool calls and submit results. It handles
streaming, execution, and follow-up turns while keeping the provider-neutral message format.

React integrations come from the separate entrypoint:

```tsx
import { useChat } from 'modelhitch/react';

const chat = useChat({
  baseUrl: 'http://127.0.0.1:3939/v1',
  model: 'vercel-ai-gateway/openai/gpt-5.4',
});
```

`useStream` handles a single streaming turn; `createBridgeClient` provides the lower-level client.
The runnable [BYOK UI](../examples/byok-ui) is a reference template: it runs against the published
`modelhitch@^0.14` npm package (no source aliases) and has its own
[README](../examples/byok-ui/README.md) covering both integration patterns, the security model, and
how to adapt it to a new project.

## Local agent bridge

The bridge supports OpenAI-compatible clients, Codex, Claude Code, Gemini CLI, and IDE agents over
their native wires.

```bash
npx modelhitch bridge
npx modelhitch bridge --background
npx modelhitch status
npx modelhitch settings
npx modelhitch front
npx modelhitch stop
```

The CLI bridge requires Node.js 22.5+ because SQLite usage persistence is enabled. Verify
`GET /healthz` and `GET /v1/models`, then smoke-test `mock/mock-model` before adding a live key.

| Endpoint | Client family |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat clients |
| `POST /v1/responses` | Codex and Responses clients |
| `POST /v1/images/generations` | OpenAI-compatible image generation (opt-in) |
| `POST /v1/messages` | Claude and Anthropic clients |
| `POST /v1beta/models/{model}:generateContent` | Gemini clients |
| `GET /v1/models`, `GET /healthz` | Discovery and health |
| `GET /v1/usage`, `GET /usage` | Usage JSON and dashboard |

Use `http://127.0.0.1:3939/v1` for OpenAI-style clients and
`http://127.0.0.1:3939` for clients that append Anthropic or Gemini paths. Route explicit models as
`providerId/modelId`; bare IDs use the default provider.

Some OpenAI-compatible clients (for example, the official `openai` SDK and IDE agents) require a
nonempty `apiKey` field before they will send a request. The bridge resolves credentials locally
and ignores the incoming Authorization header, so you can supply any harmless bridge-local
placeholder such as `sk-bridge-local` — never a real user key — solely to satisfy that client-side
validation.

### Lanes in the model picker

A client that treats the bridge as a custom endpoint builds its picker from `GET /v1/models` alone.
So the bridge publishes its routing plan there first: the trusted lanes in order, then the fallback
lanes, ahead of the rest of the catalog.

```json
{
  "id": "opencode-go/deepseek-v4-pro",
  "object": "model",
  "created": 0,
  "owned_by": "opencode-go",
  "name": "DeepSeek V4 Pro · OpenCode Go · trusted lane 1",
  "modelhitch": {
    "id": "opencode-go/deepseek-v4-pro",
    "providerId": "opencode-go",
    "model": "deepseek-v4-pro",
    "tier": "trusted",
    "laneIndex": 1,
    "terminal": false,
    "name": "DeepSeek V4 Pro · OpenCode Go · trusted lane 1"
  }
}
```

Notes:

- Lane ids are qualified (`providerId/modelId`) so the id names the lane. The exception is the
  default provider's own lanes, where the bare id already *is* the lane and the catalog advertises
  the same id — using it keeps a picker from listing one lane twice. That exception is guarded: if
  another registered provider id is a prefix of the bare route (the default config's gateway lane
  `openai/gpt-5.4` would otherwise reach the `openai` provider), the lane stays qualified.
- `name` and `modelhitch` are additions to the OpenAI shape. Clients that do not know them ignore
  them; the `id` remains the route a client sends back.
- Picking a lane is not a pin that bypasses failover: the lane you pick leads, and the rest of the
  plan stays behind it. Pick the first trusted lane for the plan's own order.
- A lane id is a route, so the fully qualified form always works (`mock/mock-model` reaches the same
  lane the picker published as `mock-model`).
- `tier` is `trusted`/`fallback` for a policy plan and `primary`/`fallback` for auto-mode. A lane
  marked `terminal` (`onLimit: "stop"`) says so in its label.
- With no policy and no auto-mode, `GET /v1/models` lists providers only — unchanged.

Claude Code is the exception: it filters discovered ids to those containing `claude` or `anthropic`,
so pin its lanes with `ANTHROPIC_DEFAULT_*_MODEL` as described below.

### Terminal settings

Run `modelhitch settings` to edit the local config without starting the bridge or opening a browser.
The OpenTUI interface covers default routing, the image lane, and cooldown behavior. Use Tab and
Shift+Tab to move, Left/Right to choose values, Ctrl+S to validate and save, and Escape to close.

```bash
modelhitch settings
modelhitch settings --config ./modelhitch.config.json
```

The TUI writes the same JSON document as `/settings` and preserves policy lanes, catalog choices,
and API keys that are outside its current editing surface. Secrets remain intentionally excluded
from visible terminal inputs; configure them through environment variables or the local web UI.
OpenTUI currently requires Bun for this command. The bridge, library, and other CLI commands retain
their existing Node.js runtime support.

### Image generation

The dedicated image lane is disabled by default. Enable and configure it in `/settings`, or for a
bridge process with CLI flags:

```bash
npx modelhitch bridge --image-lane --image-provider openai --image-model gpt-image-2 --image-quality low
```

The verified OpenAI combinations are `gpt-image-2` at low or medium quality and
`gpt-image-1.5` at medium quality. Gemini uses its native image models, with
`gemini-3.1-flash-image` as the default. Configure `OPENAI_API_KEY` or `GEMINI_API_KEY` locally,
then send OpenAI-shaped generation requests to `POST /v1/images/generations`. Responses contain
base64 image data in `data[].b64_json`. Hugging Face is intentionally not exposed by this lane
because its text-to-image API uses a different request and raw-binary response contract.

### Cursor Cloud Agent lane

The Cloud Agent lane is disabled by default. When enabled, route explicitly as
`cursor-cloud/<model>` (for example `cursor-cloud/composer-2.5`). The bridge calls
`https://api.cursor.com/v1` directly — the same API Cursor's companion apps use.

Enable via `/settings` (Cloud Agent lane section) or CLI:

```bash
export CURSOR_API_KEY="your-user-api-key"
npx modelhitch bridge \
  --cloud-agent-lane \
  --cloud-agent-repo https://github.com/org/repo \
  --cloud-agent-ref main \
  --cloud-agent-model composer-2.5
```

Requirements:

- `cloudAgent.enabled` must be `true`
- `cloudAgent.repos[]` must include at least one repository URL (or exactly one connected repo cached from the API)
- Store the user API key as `keys.cursor-cloud` in config or set `CURSOR_API_KEY` in the environment (service-account keys: env only)
- Client-side `tools` in the wire request are dropped; the cloud VM runs its own tool surface

There is no automatic routing to cloud agents in this release — use an explicit model prefix only.

### Pinning a provider

`--provider <id>` pins the whole bridge to one provider for the life of that process:

```bash
npx modelhitch bridge --background --provider opencode-go
npx modelhitch status          # shows "provider: pinned to opencode-go"
```

Routing rules while pinned:

- The pinned provider is the lane for **every** request, including one that names a different
  provider — `openai/gpt-5.4` becomes `opencode-go/gpt-5.4` (the model id survives; only the
  provider changes).
- The route the pin displaced is the **first fallback**, followed by the configured policy lanes.
  A pinned provider that is rate-limited, out of credit, or erroring therefore rotates on to a
  working provider instead of failing the request.
- A bare request uses the configured `defaultModel` unless it is namespaced to another provider
  (`openai/gpt-5.4`), in which case the pinned provider's own default model is used.
- Unknown ids are rejected before the bridge starts, with the available provider ids listed.

Without `--provider`, routing is unchanged. The pin is runtime-only: it is never written to
`~/.modelhitch/config.json`, and restarting without the flag restores the configured rotation.

### OpenCode Console BYOK

[Console BYOK](https://opencode.ai/v2/docs/console/byok/) links a provider account you already pay
for to an OpenCode workspace. Console stores the provider credential and exposes one gateway URL
per connection:

```
https://opencode.ai/inference/custom/<connection_id>
```

Members and integrations call that URL with a Console **service-account key**; Console swaps it for
the connection's credential before forwarding, so the provider secret never leaves the workspace.
Four schemas are supported, each with its own path under the connection URL: `/chat/completions`,
`/responses`, `/messages`, and `/models/<model>:generateContent`.

ModelHitch serves one Console connection as one provider lane, `opencode-byok-<slug>`:

```bash
# rotate across every connection configured in /settings
npx modelhitch bridge --background --opencode-byok

# pin one connection for this process
npx modelhitch bridge --background --provider opencode-byok-deepseek

# configure entirely from the CLI
npx modelhitch bridge \
  --opencode-byok \
  --opencode-byok-connection conn_abc123 --opencode-byok-models deepseek-chat,deepseek-reasoner \
  --opencode-byok-connection conn_def456 --opencode-byok-schema anthropic --opencode-byok-models claude-sonnet-4-6 \
  --opencode-byok-mode rotation
```

`/settings` → **OpenCode Console BYOK** is the primary surface. It stores `opencodeByok` in the
config document:

| Field | Meaning |
| --- | --- |
| `enabled` | Master switch. Off = no BYOK providers, no BYOK lanes |
| `mode` | `rotation` (spread across every connection) or `pinned` (one connection first) |
| `pinnedConnectionId` / `pinnedModel` | Primary lane when `mode` is `pinned` |
| `connections[]` | `id` (Console API URL or bare `conn_…`), optional `label`, `baseUrl`, `schema`, `models`, `enabled` |
| `syncFromOpenCode` | Seed empty model lists from the local OpenCode install |

Rotation puts every enabled connection × model at the front of the lane plan; the configured
policy stays directly behind it as the safety net. Pinned leads with the pinned connection and its
remaining models, then the configured policy — a depleted connection still falls through to
another provider. Both modes cost nothing when the block is off.

If a connection's model list is empty and `syncFromOpenCode` is on, the bridge reads the local
OpenCode install (`~/.local/share/opencode/auth.json`, `opencode.db` credential rows and recent
`providerID`/`modelID` message history, `~/.config/opencode/opencode.json[c]`) and rotates the
models you actually run there. **Import from OpenCode** in `/settings` does the same interactively
and shows what it found; `--opencode-byok-import` prints the discovered providers and seeds them
into the config file before exiting. Console mints opaque connection ids that no local file
records, so an import seeds the provider names and models — replace each id with its Console
connection id (or paste the Console API URL) before relying on it.

Credentials: Console BYOK reuses the OpenCode key from settings. Resolution order is
`keys.opencode-byok` → the connection's own `keys.opencode-byok-<slug>` (the per-provider card in
`/settings` → Providers) → `keys.opencode` → `keys.opencode-go` → `OPENCODE_API_KEY`. The bridge
never sends the incoming client Authorization header upstream; it resolves the key locally.

### Custom BYOK lanes

A custom lane is for the key ModelHitch has no provider for: a self-hosted gateway, a regional
reseller, an internal deployment, a provider that launched last week. You give ModelHitch the
endpoint, a key, and the model slots you want to use, and it serves the lane like any other
provider — `custom-<slug>` shows up in the policy lanes, the lane-health table, `GET /v1/models`,
and `--provider`.

```bash
npx modelhitch bridge --background \
  --custom-lanes \
  --custom-lane upstream \
  --custom-lane-url https://api.example.com/v1 \
  --custom-lane-models fast-model,smart-model \
  --custom-lane-schema chat-completions \
  --custom-lane-on-limit stop \
  --custom-lanes-placement lead
```

**No model discovery, by design.** ModelHitch never sends `GET /models` to a custom lane. A
catalog we cannot know would be either empty or wrong, so the slots you type are the authority:
they are what the lane advertises to clients and what appears in the model picker.

`/settings` → **Custom lanes** is the primary surface. It stores `customLanes` in the config
document:

| Field | Meaning |
| --- | --- |
| `enabled` | Master switch. Off = no custom providers, no custom lanes |
| `placement` | `lead` (default) puts the lanes at the front of the plan; `fallback` keeps the buffet primary |
| `lanes[]` | `id` (becomes `custom-<slug>`), optional `label`, `baseUrl`, `schema`, `models[]`, optional `headers`, `apiKeyEnvVar`, `requiresKey`, `capabilities`, `enabled`, `onLimit` |

Each lane's `schema` picks the wire, because an unlisted endpoint can be shaped like any of them:

| Schema | Path | Auth |
| --- | --- | --- |
| `auto` (default) | detected from the model family (`gpt-*`/`grok-*` → responses, `claude-*`/`qwen*` → messages, `gemini*` → generateContent, else chat completions) | bearer / both |
| `chat-completions` | `POST <baseUrl>/chat/completions` | `Authorization: Bearer` |
| `responses` | `POST <baseUrl>/responses` | `Authorization: Bearer` |
| `anthropic` | `POST <baseUrl>/messages` | `x-api-key` **and** bearer |
| `google` | `POST <baseUrl>/models/<model>:generateContent` (and `:streamGenerateContent?alt=sse`) | `x-goog-api-key` |

Pin the schema when detection would guess wrong — a gateway exposing `claude-*` over Chat
Completions needs `chat-completions`, and a self-hosted `gpt-*` served over Chat Completions does
too.

**Placement.** `lead` prepends every lane × typed slot to `trusted` and makes the first slot the
bridge's default route: adding a lane is a request to use it. Your configured policy stays
directly behind it, so a depleted custom lane still falls through to the buffet. `fallback`
appends the lanes behind everything instead, leaving the primary route exactly as configured.
When the OpenCode Console BYOK block is also on, the custom lanes land in front of it under
`lead`, behind it under `fallback`.

**What a limit means.** `onLimit` is per lane:

| Value | Behavior |
| --- | --- |
| `rotate` (default) | A 429, a 402 (no credit), a 5xx, or a network blip rotates to the next lane, exactly like every other provider |
| `stop` | The lane is **terminal**. The error surfaces to the caller instead of spending another provider's quota — and the lane keeps stopping while it is parked from that failure, so a metered endpoint cannot quietly become someone else's bill |

`stop` ends the walk at that lane; it does not disable the lanes behind it. They stay reachable
when a request is routed to them explicitly (`custom-<id>/<model>`, `--provider`, or a policy that
lists them first), which is why the settings page warns when lanes sit behind a `stop` lane.

**Credentials.** Resolution order is `keys["custom-<slug>"]` (the same local `keys` map every
provider uses) → the lane's own `apiKeyEnvVar` → `MODELHITCH_CUSTOM_<ID>_API_KEY` derived from the
lane id. Set `requiresKey: false` for a keyless endpoint; the Anthropic wire still expects a key,
and validation warns when a lane asks for both. Capability claims (`tools + vision`, `tools only`,
`text only`) decide which requests the lane is eligible for, so a text-only endpoint is skipped
rather than attempted for a tool-calling request.

Custom lanes are read from the same document by the bridge **and** the harness (`mhh`), so a lane
added in `/settings` is available to both — including the `lead` default route.

### Sign in with ChatGPT

OpenAI's Sign in with ChatGPT lets an open-source or locally hosted client spend the user's
ChatGPT plan on eligible Responses API requests, through the `chatgpt.tokens.use.direct` scope.
ModelHitch serves that as the `chatgpt-plan` lane, so the plan can lead, trail, be pinned as the
main route, cool down on a limit, or be selected with `--provider chatgpt-plan`.

```bash
# 1. Sign in. Opens your system browser; the callback returns to a loopback listener.
npx modelhitch chatgpt-plan sign-in

# 2. See what the account can serve.
npx modelhitch chatgpt-plan models

# 3. Serve it. `lead` makes the plan the primary route, buffet behind as the safety net.
npx modelhitch bridge --background --chatgpt-plan

# Or pin one model as the main route and let its siblings follow as the first fallback.
npx modelhitch bridge --background \
  --chatgpt-plan --chatgpt-plan-mode pinned --chatgpt-plan-pin gpt-5.1
```

Everything is in `/settings` too, under **Sign in with ChatGPT**: the account panel with a
**Continue with ChatGPT** button, a **Manage usage** link, the saved-account picker, and the same
routing controls.

**How the sign-in works.** ModelHitch opens `https://auth.openai.com/api/accounts/authorize` in your
system browser with a fresh `state`, OIDC `nonce`, and PKCE challenge. The first sign-in registers a
client through `client_id=dynamic_agent_client` and gets back an issued `oaiapp_…` id, which is what
later sign-ins reuse. The callback lands on `http://127.0.0.1:<port>/auth/callback`, where a
listener ModelHitch started beforehand receives it. The code is exchanged for tokens with the PKCE
verifier and no client secret, then the ID token is verified against OpenAI's published JWKS with
its issuer, audience, expiry, and nonce all checked. Only then is anything saved.

Because sign-in finishes on its own loopback listener rather than on the bridge, the settings page
polls `GET /v1/chatgpt-plan` instead of waiting on a request, and the bridge rebuilds the lane the
moment the account changes. You do not restart it.

**Where the credentials live.** In `~/.modelhitch/chatgpt-plan.json`, written atomically with owner-only
permissions, holding the access token, the rotating refresh token, the retained ID token, the
issued client id, this host's stable `ext_agent_host_id`, and the granted scopes. They never enter
`config.json`, which is masked on every read, and they are never put in a URL. Access tokens last an
hour and refresh an hour-wide window ahead of expiry; refreshes are serialized so two requests
cannot race a rotating token. Signing out revokes the renewable session first, then clears the
tokens locally, and tells you when remote revocation could not be confirmed.

**Model slugs are the account's, not ours.** ChatGPT plan catalogs are account-specific, so
ModelHitch asks `GET /v1/models` (which answers `{ models: [{ slug, display_name, visibility }] }`)
and keeps the entries marked `visibility: "list"`. Leave `models` empty and the bridge reads them at
startup; name them and the config wins. With neither, the lane does not serve rather than routing to
a guessed slug.

| Field | Meaning |
| --- | --- |
| `enabled` | Master switch. Off = no lane, whatever the saved account says |
| `mode` | `rotation` (default) spreads requests across the model slots · `pinned` leads on `pinnedModel` with the remaining slots immediately behind it |
| `placement` | `lead` (default) puts the lane at the front of the plan · `fallback` appends it behind everything |
| `models[]` | Model slots, in rotation order. Empty means "read the signed-in account" |
| `pinnedModel` | Model that leads when `mode` is `pinned`. Must be one of `models` |
| `accountKey` | Saved ChatGPT account to serve this lane. Default: the active one |
| `onLimit` | `rotate` (default) fails over like any 429 · `stop` makes the lane terminal |

**This route is a preview with rules.** Every inference request must set `store: false` and
`stream: true`, so `chat()` streams and aggregates rather than using a non-streaming form. History
travels in `input`, system prompts travel in `instructions` (an explicit `{type:"message",
role:"system"}` item is rejected), and `previous_response_id` is unavailable over HTTP. A list of
fields is rejected outright, including `temperature`, `top_p`, `max_output_tokens`, `metadata`,
`user`, `truncation`, `prompt`, `safety_identifier`, `max_tool_calls`, and `moderation`. ModelHitch
drops those rather than sending them, which means `ChatParams.temperature` and
`ChatParams.maxTokens` have no effect on this lane; `stop` has no Responses equivalent.

Inference counts as successful only after `response.completed`. A stream that just ends is reported
as an interrupted stream, not as a finished answer, so a truncated response can never masquerade as
a complete one.

| Failure | Mapped to | Why |
| --- | --- | --- |
| `subscription_sharing_usage_limit_exceeded` (429) | `rate-limited`, status 429 | The lane is rested, not broken, so rotation continues. The message carries the `chatgpt.com/settings/usage` link |
| `subscription_sharing_usage_unavailable`, `subscription_sharing_user_unavailable` (503) | `provider-error` | Availability could not be checked. Credentials are kept, retried later |
| `subscription_sharing_invalid_user` (401) | `invalid-api-key` | The subscriber context failed to validate, so the lane is skipped |
| `subscription_sharing_user_not_eligible`, `subscription_sharing_route_not_supported` (403) | `bad-request` | A policy refusal. The same request is not repeated and OAuth is not looped |
| `subscription_sharing_unsupported_capability` (400) | `bad-request` | The offending `param` is kept in the message, since the fix is to change the body |

A Plus account's five-hour limit is shared across every app that uses the plan, so hitting it is
normal and expected. `onLimit: "stop"` is there for anyone who would rather see the limit than have
ModelHitch quietly spend a different provider's quota after it. Under `rotate`, a plan limit walks
every model slot of the lane before leaving it, because `rotation` means the slots are all tried.
A refused request spends nothing, so the extra hop costs latency rather than quota; `stop` skips it.

**Terminal commands.**

```bash
modelhitch chatgpt-plan status [--json]        # accounts, plan usage, token expiry
modelhitch chatgpt-plan models                 # the account's model slugs
modelhitch chatgpt-plan accounts               # saved registrations and their keys
modelhitch chatgpt-plan use --account <key>    # switch which account serves the lane
modelhitch chatgpt-plan sign-in [--account <key>] [--register] [--force-consent] [--no-open]
modelhitch chatgpt-plan sign-out [--account <key>] [--no-revoke]
```

A signed-in account that was not granted plan usage still counts as signed in: the identity is
valid, only plan spending is not. Re-request the grant with
`modelhitch chatgpt-plan sign-in --force-consent`, or turn it on in ChatGPT settings. The lane
refuses to serve in that state rather than failing later.

### Bridge CLI commands

These commands talk to a running bridge (start one with `modelhitch bridge` or
`modelhitch bridge --background` first).

**Chat and work** send a prompt through the bridge. `chat` opens an interactive session;
`work` runs a one-shot work order.

```bash
modelhitch chat --prompt "Summarize the README"
modelhitch chat --rotation --prompt "Use the default provider"
modelhitch chat --model openai/gpt-4o-mini --prompt "Hello"
modelhitch work --prompt "Refactor the auth module"
```

Shared flags for `chat` and `work`:

| Flag | Purpose |
| --- | --- |
| `--rotation` | Use the bridge default provider/model (rotation target) |
| `--model <provider>/<model>` | Pin a provider and model (split on the first slash) |
| `--prompt <text>` | User prompt text |
| `--base-url <url>` | Bridge base URL (default `http://127.0.0.1:3939`, or `MODELHITCH_PORT`) |

**Workspace** opens the running bridge `/workspace` page in a browser:

```bash
modelhitch workspace
```

**Cloud** lists and manages Cursor Cloud agents via the bridge:

```bash
modelhitch cloud list
modelhitch cloud get <id>
modelhitch cloud cancel <id>
```

`cloud cancel` exits 0 when the agent is cancelled. Requires the Cloud Agent lane to be enabled
and a valid `CURSOR_API_KEY` (see [Cursor Cloud Agent lane](#cursor-cloud-agent-lane)).

Environment controls:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODELHITCH_PORT` | `3939` | Bridge port |
| `MODELHITCH_HOST` | `127.0.0.1` | Bind host |
| `MODELHITCH_MAX_BODY_BYTES` | 64 MiB | Request-body limit |
| `MODELHITCH_HOME` | `~/.modelhitch` | PID and log directory |
| `MODELHITCH_DEBUG` | disabled | Full forwarded-body diagnostics; may expose sensitive content |

Agent-specific setup lives in [examples/codex.config.toml](../examples/codex.config.toml) and the
[ModelHitch skill reference](../plugins/modelhitch/skills/modelhitch/references/api-and-operations.md).

## Auto-mode failover

Enable `autoMode: true` on `ModelHitch` or `createModelHitchServer` to retry 429, provider 5xx, and
network failures on fallback lanes. Same-provider fallbacks should come before cross-provider lanes
when data routing matters.

- Credentials resolve independently for every lane.
- A per-call key stays with the primary provider.
- Streaming can fail over before content is emitted.
- Mid-stream failures propagate to avoid duplicated output.
- If all lanes fail, the original error remains actionable.

## Capability-aware routing

A request that carries `tools` needs a tool-calling-capable lane — ModelHitch checks every resolved
lane (primary included) against its provider's `capabilities` before attempting it. Lanes that can't
meet a requirement are skipped entirely: no call is made, so nothing cools down and nothing counts
as a provider failure. If every configured lane lacks the capability, the call rejects with a
`CapabilityUnavailableError` (`code: 'capability-unavailable'`) carrying `requirements` and the
skipped lanes instead of quietly forwarding tools to a provider that will ignore or reject them.

```ts
import { isCapabilityUnavailableError } from 'modelhitch';

try {
  await mh.chat({ provider: 'ollama', messages, tools });
} catch (err) {
  if (isCapabilityUnavailableError(err)) {
    console.error(err.requirements, err.skipped); // { toolCalling: true }, [{ target, reason }]
  }
}
```

`toolCalling` is inferred automatically from `tools`; `vision`/`streaming`/`embeddings` are
recognized requirement keys you can pass explicitly (matching `Provider.capabilities`) as more
requirement classes come up.

## Usage and persistence

The bridge tracks requests, tokens, estimated cost, latency, wire, model, provider, and failovers.
Read JSON at `/v1/usage` or open `/usage` for the dashboard.

```ts
import { SqliteUsageStorage, UsageTracker } from 'modelhitch';

const usage = new UsageTracker(new SqliteUsageStorage('./data/usage.db'));
```

SQLite uses Node's built-in `node:sqlite` and requires Node.js 22.5+. Cost values are estimates;
free or unknown pricing reports zero and is not proof that billing cannot occur.

## Errors and custom providers

Handle `ModelHitchError.code` instead of parsing provider strings. Stable codes include
`missing-api-key`, `invalid-api-key`, `rate-limited`, `model-not-found`, `provider-not-found`,
`provider-error`, `network-error`, `bad-request`, and `capability-unavailable`.

### What triggers failover

A lane is replaced by the next lane in the resolved list when the failure is lane-local and
transient. Detection checks the HTTP status first, then the normalized code:

| Trigger | Why it rotates |
| --- | --- |
| `status === 429` | The provider is rate limiting this lane. Checked by status because adapters surface 429s as `bad-request` with the status preserved. |
| `status === 402` | The lane's account cannot fund the request. Providers arrive here for both "no credit" and "the requested `max_tokens` exceeds what the account can afford", and another lane can serve the same request. Checked by status because providers surface 402 as `bad-request`. |
| `rate-limited`, `provider-error`, `network-error` | The default retryable codes, for failures that carry no usable status. |

Failures that are not lane-local never rotate: `bad-request` without a 402 or 429 status,
`model-not-found`, and `invalid-api-key`. A lane with no key at all is skipped silently instead.
Aborts and cancellations are never retried. Failover happens only before any content is emitted, so
a lane that dies mid-stream propagates its error rather than duplicating output.

Narrow or widen the code set per invocation with `retryableCodes` on an `AutoModeOptions` object or
on a policy. The status check for 429 and 402 applies regardless of that list.

Create an OpenAI-compatible integration with `createOpenAICompatibleProvider`. For another wire
protocol, implement the `Provider` interface with `chat`, `stream`, `capabilities`, and optionally
`listModels`.

## Repository checks

```bash
npm run typecheck
npm test
npm run build
```

The [quickstart](../examples/quickstart.ts) and [canary](../examples/canary.ts) cover deterministic
and live-provider verification respectively.
