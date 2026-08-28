# ModelHitch for Expo

`modelhitch-expo` is the Expo / React Native adapter for ModelHitch. It is a thin layer over the
published `modelhitch` package — same client, same providers, same failover and usage tracking —
wired for a mobile runtime:

- **Streaming that actually streams.** React Native's built-in `fetch` buffers the whole response,
  so SSE token deltas arrive all at once. The adapter uses [`expo/fetch`](https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api),
  which exposes `response.body` as a real `ReadableStream`.
- **Device-encrypted BYOK keys.** `SecureStoreKeyStore` stores each provider's key with
  `expo-secure-store` (Android Keystore / iOS keychain). Keys never reach your backend.
- **A Metro-safe entry point.** Metro does not resolve the `browser` export condition, so importing
  `modelhitch` directly in an Expo app pulls in the Node bridge server and `node:sqlite`. Importing
  `modelhitch-expo` gets you the browser-safe surface instead.

Runs on iOS, Android, and Expo web from the same code.

## Install

```bash
npx expo install expo-secure-store
npm install modelhitch modelhitch-expo
```

Requires Expo SDK 52 or later (the New Architecture) for `expo/fetch`, `ReadableStream`, and
`TextDecoder`.

## Quick start

```ts
import { createExpoModelHitch } from 'modelhitch-expo';

const mh = createExpoModelHitch({ defaultProviderId: 'openai' });

// The user pastes their own key once; it lands in the device keychain.
await mh.keystore?.set('openai', keyPastedByUser);

const stream = await mh.stream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello from Expo' }],
});

for await (const chunk of stream) {
  if (chunk.type === 'text-delta') setReply((prev) => prev + chunk.text);
}
```

`createExpoModelHitch` accepts every `ModelHitchOptions` field (`providers`, `policy`, `autoMode`,
`keystore`, ...) plus two Expo-specific ones:

| Option | Default | Purpose |
| --- | --- | --- |
| `secureStore` | `{}` | Options for the default `SecureStoreKeyStore` (`prefix`, `secureStoreOptions`, `webFallback`) |
| `installGlobalFetch` | `true` | Point `globalThis.fetch` at Expo's streaming fetch |

For catalog mode (`{ catalog: { ... } }`), use `await createExpoModelHitchAsync({ ... })` — the
models.dev inventory has to be fetched before the first call.

## Credentials

```ts
import { SecureStoreKeyStore } from 'modelhitch-expo';

const keys = new SecureStoreKeyStore({
  secureStoreOptions: { keychainService: 'com.acme.app', requireAuthentication: true },
});

await keys.set('openai', userKey);   // encrypted, per provider
await keys.get('openai');
await keys.delete('openai');         // clear when the user empties the field
```

Entries are namespaced per provider (`modelhitch_openai`), so switching providers never overwrites
another provider's key. Pass the same `secureStoreOptions` to reads and writes — SecureStore keys a
value to its `keychainService`.

`requireAuthentication: true` adds a biometric prompt. It needs the `expo-secure-store` config
plugin (for `NSFaceIDUsageDescription`) and a real device; it is not supported in Expo Go.

### Web

`expo-secure-store` has no web implementation. On web the keystore transparently falls back to
`localStorage` (or in-memory when unavailable). **That fallback is not encrypted** — treat web BYOK
keys as browser-local secrets, or override it:

```ts
new SecureStoreKeyStore({ webFallback: myWebKeyStore });
```

## Streaming without the helper

If you build providers yourself, hand them the streaming fetch explicitly:

```ts
import { createOpenAICompatibleProvider, expoFetch } from 'modelhitch-expo';

const provider = createOpenAICompatibleProvider({
  id: 'acme',
  name: 'Acme',
  baseUrl: 'https://api.acme.dev/v1',
  defaultModel: 'acme-large',
  fetchImpl: expoFetch,
});
```

Or call `installExpoFetch()` once at app start so the built-in providers pick it up. Expo already
installs its fetch globally on Android and iOS; this matters when an app sets
`EXPO_PUBLIC_USE_RN_FETCH=1`, and `hasStreamingFetch()` reports which implementation is active.

## React hooks

`modelhitch-expo/react` re-exports `useChat`, `useStream`, and `createBridgeClient` unchanged. They
point at a ModelHitch bridge, which is the right shape when your **backend** owns the keys, tools,
and failover:

```tsx
import { useChat } from 'modelhitch-expo/react';

const { messages, pending, send, isThinking } = useChat({
  baseUrl: 'https://api.example.com/v1',
  model: 'openai/gpt-4o-mini',
});
```

Use a device-local emulator host (`http://10.0.2.2:3939/v1` on Android) when pointing at a bridge
running on your dev machine.

## Which pattern?

| | Direct BYOK | Bridge |
| --- | --- | --- |
| Key owner | The end user | Your backend |
| Key storage | Device keychain | Server env vars |
| Extra infra | None | A bridge/proxy service |
| Use | `createExpoModelHitch` | `useChat` / `createBridgeClient` |

Never ship your own provider key inside an app bundle — a mobile binary is readable. Direct mode is
only for keys the user supplies; anything else belongs behind the bridge.

## Example app

A runnable Expo SDK 57 app lives in [`examples/expo-app`](../examples/expo-app): Direct BYOK with
`SecureStoreKeyStore` (works offline with the `mock` provider) plus a Bridge tab using `useChat`.
Run it with `npm install && npm run web` from that folder.

## Development

The adapter is typechecked and tested against in-repo stubs for the Expo, React Native, and
`modelhitch` peers, so no Expo app tree is needed:

```bash
npm run typecheck            # tsc -p tsconfig.dev.json (stubbed peers)
npx vitest run --config vitest.config.ts
```

Building or publishing uses the real peers:

```bash
npm install
npm run build
```

See [PUBLISHING.md](./PUBLISHING.md).
