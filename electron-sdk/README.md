# ModelHitch for Electron

`modelhitch-electron` is the Electron adapter for ModelHitch. It is a thin layer over the published
`modelhitch` package — same client, same providers, same failover and usage tracking — wired for a
desktop runtime:

- **OS-backed BYOK keys.** `SafeStorageKeyStore` encrypts each provider key with Electron
  `safeStorage` (macOS Keychain, Windows DPAPI, Linux Secret Service when available) and persists the
  ciphertext in the app's user-data directory. Keys never reach your backend.
- **Renderer-safe IPC.** Renderer windows cannot call `safeStorage` directly. Register
  `registerKeyStoreIpc` in the main process and pass `createIpcKeyStore()` to
  `createElectronModelHitch` in the renderer.
- **A bundler-safe entry point.** Some Electron bundlers resolve the Node `modelhitch` entry and pull
  in the bridge server and `node:sqlite`. Importing `modelhitch-electron` gets you the browser-safe
  surface instead.

Runs in the main process and in renderer windows from the same package.

## Install

```bash
npm install modelhitch modelhitch-electron
```

Requires Electron 28 or later.

## Quick start (main process)

```ts
import { createElectronModelHitch } from 'modelhitch-electron';

const mh = createElectronModelHitch({ defaultProviderId: 'openai' });

// The user pastes their own key once; it is encrypted with the OS credential store.
await mh.keystore?.set('openai', keyPastedByUser);

const stream = await mh.stream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello from Electron' }],
});

for await (const chunk of stream) {
  if (chunk.type === 'text-delta') setReply((prev) => prev + chunk.text);
}
```

`createElectronModelHitch` accepts every `ModelHitchOptions` field (`providers`, `policy`, `autoMode`,
`keystore`, ...) plus one Electron-specific option:

| Option | Default | Purpose |
| --- | --- | --- |
| `safeStorage` | `{}` | Options for the default `SafeStorageKeyStore` (`prefix`, `storageDir`, `fallback`) |

For catalog mode (`{ catalog: { ... } }`), use `await createElectronModelHitchAsync({ ... })` — the
models.dev inventory has to be fetched before the first call.

## Renderer process

Register the keystore in the main process, then point the renderer client at IPC:

```ts
// main.ts
import { app, BrowserWindow } from 'electron';
import { SafeStorageKeyStore } from 'modelhitch-electron';
import { registerKeyStoreIpc } from 'modelhitch-electron/ipc';

app.whenReady().then(() => {
  registerKeyStoreIpc(new SafeStorageKeyStore());
  new BrowserWindow({ /* ... */ });
});
```

```ts
// renderer.ts
import { createElectronModelHitch } from 'modelhitch-electron';
import { createIpcKeyStore } from 'modelhitch-electron/ipc';

const mh = createElectronModelHitch({
  defaultProviderId: 'openai',
  keystore: createIpcKeyStore(),
});
```

## Credentials

```ts
import { SafeStorageKeyStore } from 'modelhitch-electron';

const keys = new SafeStorageKeyStore({
  prefix: 'com.acme.app',
  storageDir: '/custom/path/modelhitch-keys',
});

await keys.set('openai', userKey);
await keys.get('openai');
await keys.delete('openai');
```

Entries are namespaced per provider (`modelhitch_openai.enc`), so switching providers never
overwrites another provider's key.

When `safeStorage.isEncryptionAvailable()` is false (common on some Linux setups without a Secret
Service provider), the store falls back to an in-memory `MemoryKeyStore` unless you pass a custom
`fallback`. Treat that as a development-only path — production Linux builds should ship with a
working OS secret backend or route keys through your backend / a ModelHitch bridge.

## React hooks

`modelhitch-electron/react` re-exports `useChat`, `useStream`, and `createBridgeClient` unchanged. They
point at a ModelHitch bridge, which is the right shape when your **backend** owns the keys, tools,
and failover:

```tsx
import { useChat } from 'modelhitch-electron/react';

const { messages, pending, send, isThinking } = useChat({
  baseUrl: 'http://127.0.0.1:3939/v1',
  model: 'openai/gpt-4o-mini',
});
```

Use `http://127.0.0.1:3939/v1` when pointing at a bridge running on the same machine.

## Which pattern?

| | Direct BYOK | Bridge |
| --- | --- | --- |
| Key owner | The end user | Your backend / local bridge |
| Key storage | OS credential store (main) or IPC | Server env vars / local bridge |
| Extra infra | None | A bridge/proxy service |
| Use | `createElectronModelHitch` | `useChat` / `createBridgeClient` |

Never ship your own provider key inside an Electron binary — a desktop app is readable. Direct mode is
only for keys the user supplies; anything else belongs behind the bridge.

## Main-process bridge hosting

This package is a **client** library. It does not embed or wrap the ModelHitch CLI. To host a local
bridge from your app's main process, install `modelhitch` separately and import the Node entry in
main only:

```ts
import { startBridge } from 'modelhitch'; // main process only — never bundle in renderer
```

Keep bridge startup in the main process and point renderer UI code at `http://127.0.0.1:3939/v1`.

## Development

The adapter is typechecked and tested against in-repo stubs for the Electron and `modelhitch` peers,
so no Electron app tree is needed:

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
