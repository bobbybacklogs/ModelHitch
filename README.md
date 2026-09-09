<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/repo_banner.png" alt="ModelHitch — LLM temp agency" width="100%"/>
</p>

<p align="center">
  <strong>Hitch any model to your app.</strong><br/>
  One TypeScript API. Your keys. Hosted or local models. No runtime dependencies.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/modelhitch"><img alt="npm version" src="https://img.shields.io/npm/v/modelhitch?style=for-the-badge&color=8bd600"/></a>
  <a href="https://www.npmjs.com/package/modelhitch"><img alt="npm downloads" src="https://img.shields.io/npm/dm/modelhitch?style=for-the-badge&color=cc3f88"/></a>
  <a href="./LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-17b8d4?style=for-the-badge"/></a>
  <img alt="Node 18 or later" src="https://img.shields.io/badge/node-%E2%89%A518-8bd600?style=for-the-badge&logo=node.js&logoColor=white"/>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=for-the-badge&logo=typescript&logoColor=white"/>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#agent-skills--plugins">Agent skills</a> ·
  <a href="#what-you-get">Features</a> ·
  <a href="./docs/guide.md">Guide</a> ·
  <a href="./examples">Examples</a>
</p>

> Provider harness by day. Temp agency for LLMs by accident.

ModelHitch normalizes chat, streaming, tools, BYOK credentials, model discovery, failover, and
usage across **Vercel AI Gateway** (default), OpenAI, Anthropic, OpenRouter, Groq, Together, and local
runtimes. It can also expose them through one local multi-wire bridge for coding agents and IDEs.

## Install

```bash
npm install modelhitch
```

```ts
import { ModelHitch } from 'modelhitch';

const mh = new ModelHitch();
const result = await mh.chat({
  provider: 'vercel-ai-gateway',
  model: 'openai/gpt-5.4',
  messages: [{ role: 'user', content: 'Clock in.' }],
});

console.log(result.message.content);
```

Chat, streaming, tools, custom providers, and React hooks use the same provider-neutral types.
[Open the technical guide →](./docs/guide.md)

## Agent skills + plugins

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/All4.png" alt="ModelHitch plugins and skills for Codex, Cursor, VS Code, and Claude" width="100%"/>
</p>

Give your agent the ModelHitch playbook in one command:

```bash
npx modelhitch setup codex    # claude | cursor | vscode | all
```

Personal installs are the default. Add `--project` for the current repo, `--dry-run` to preview,
or `--force` to update an existing install.

| Agent | Skill command | Full package |
| --- | --- | --- |
| **Codex** | `npx modelhitch setup codex` | [Plugin guide](./.agents/plugins/README.md) |
| **Claude** | `npx modelhitch setup claude` | [Two-skill guide](./.claude/skills/README.md) |
| **Cursor** | `npx modelhitch setup cursor` | [Plugin guide](./.cursor-plugin/README.md) |
| **VS Code / Copilot** | `npx modelhitch setup vscode` | [Agent Plugin guide](./.github/plugin/README.md) |

## What you get

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/own_section.png" alt="One interface. BYOK. Any model, any time." width="85%"/>
</p>

| Surface | Included |
| --- | --- |
| **Library** | `chat`, `stream`, tools, model discovery, typed errors, custom providers |
| **Web apps** | Browser bundler support via `modelhitch/browser` — no Node polyfills |
| **Android** | Native Kotlin SDK, coroutine streaming, Compose sample, Android Keystore BYOK storage |
| **Flutter** | Dart SDK, SSE streaming, secure BYOK storage, OpenAI-compatible providers and bridges |
| **BYOK** | Request keys, memory storage, browser local storage, environment fallback |
| **React** | `useChat`, `useStream`, and a bridge client via `modelhitch/react` |
| **Bridge** | OpenAI Chat/Responses/Images, Anthropic Messages, and Gemini GenerateContent wires |
| **Reliability** | Automatic 429/5xx/network failover across models and providers |
| **Usage** | Tokens, estimated spend, latency, failovers, dashboard, optional SQLite |

### Providers

`Vercel AI Gateway` · `OpenAI` · `Anthropic` · `Groq` · `OpenRouter` ·
`Together AI` · `HuggingFace` · `Google Gemini` · `DeepSeek` · `xAI` ·
`Mistral` · `Moonshot` · `Z.ai (GLM)` · `LM Studio` · `Ollama` · `vLLM` · `llama.cpp` ·
`KoboldCpp` · `mock`

## Android SDK

The [`android-sdk`](./android-sdk) subtree is a native Kotlin implementation for Android 6.0 and
later. It provides provider-neutral chat types, `Flow` streaming, tool-call events, built-in
OpenAI-compatible providers, typed errors, model listing, and AES-GCM credential storage backed by
Android Keystore. It does not embed Node.js or a JavaScript runtime.

```kotlin
dependencies {
  implementation("io.github.bobbybacklogs.modelhitch:modelhitch-android:0.1.0")
}
```

```kotlin
val keys = AndroidKeyStoreCredentialStore(applicationContext)
keys.set(selectedProviderId, userProvidedKey)

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
).collect { chunk ->
  if (chunk is StreamChunk.TextDelta) append(chunk.text)
}
```

[Android setup, architecture, security, sample, and build guide →](./android-sdk/README.md)

## Dart and Flutter SDKs

The [`flutter-sdk`](./flutter-sdk) subtree contains a Dart 3.4 core and a Flutter 3.22 adapter.
`modelhitch_dart` owns the provider-neutral types, OpenAI-compatible transport, `Stream`-based SSE
events, typed errors, model listing, and extension contracts. `modelhitch_flutter` re-exports that
core and adds encrypted per-provider credential storage through `flutter_secure_storage`.

```yaml
dependencies:
  modelhitch_flutter: ^0.1.0
```

```dart
final hitch = ModelHitch(keyStore: FlutterSecureKeyStore());

hitch.stream(
  ChatRequest(
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [ModelMessage.user(MessageContent.text('Hello from Flutter'))],
  ),
).listen((chunk) {
  if (chunk case TextDelta(:final text)) append(text);
});
```

Store only keys provided by a device user. For an application-owned credential, point an
`OpenAICompatibleProvider` at a backend or ModelHitch bridge instead.

[Dart/Flutter setup, security, extension contract, and publishing guide →](./flutter-sdk/README.md)

## Expo / React Native SDK

The [`expo-sdk`](./expo-sdk) package is a thin adapter over the published `modelhitch` npm package
for Expo (SDK 52+) and React Native. It uses `expo/fetch` for streaming `ReadableStream` support,
`expo-secure-store` for device-encrypted BYOK credentials, and a Metro-safe entry point that avoids
pulling in Node-only modules.

```bash
npx expo install expo-secure-store
npm install modelhitch modelhitch-expo
```

```ts
import { createExpoModelHitch } from 'modelhitch-expo';

const mh = createExpoModelHitch({ defaultProviderId: 'openai' });
await mh.keystore?.set('openai', keyPastedByUser);

const stream = await mh.stream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello from Expo' }],
});

for await (const chunk of stream) {
  if (chunk.type === 'text-delta') appendText(chunk.text);
}
```

Keys are stored per provider and encrypted on the device — the same BYOK contract as the Dart and
Android SDKs. Runs on iOS, Android, and Expo web from the same codebase.

[Expo setup, streaming, SecureStore, hooks, and publishing guide →](./expo-sdk/README.md)

## Local agent bridge

```bash
npx modelhitch bridge --background
npx modelhitch status
npx modelhitch settings
```

Point compatible clients at `http://127.0.0.1:3939/v1`, then route models as
`providerId/modelId`. The bridge includes automatic failover and a local usage dashboard at
`http://127.0.0.1:3939/usage`. Its OpenAI-compatible image lane is disabled by default and can be
enabled from `http://127.0.0.1:3939/settings` or with `--image-lane`.

`modelhitch settings` opens an OpenTUI editor for routing, image-generation, and reliability
settings without requiring the bridge or web UI. It edits the same local config file and preserves
policy lanes, catalog choices, and API keys. The TUI currently requires Bun; all other ModelHitch
commands retain their existing Node.js runtime support.

> The packaged bridge uses SQLite persistence and requires Node.js 22.5+. The application library
> supports Node.js 18+.

[Bridge setup, client configs, routing, security, and operations →](./docs/guide.md#local-agent-bridge)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

The [quickstart](./examples/quickstart.ts), [BYOK UI](./examples/byok-ui), and
[Expo app](./examples/expo-app) use the deterministic mock provider without an API key. Public
contributions are currently closed, but the project is MIT licensed—clone it, inspect it, and remix
your own.

<p align="center">
  <img src="https://raw.githubusercontent.com/genoventures-labs/ModelHitch/main/repo_assets/footer_repo.png" alt="ModelHitch — We route. You build." width="90%"/>
</p>
