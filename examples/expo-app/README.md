# ModelHitch Expo example app

A minimal Expo (SDK 57) chat app demonstrating `modelhitch-expo` on iOS, Android, and web from one
codebase. It mirrors the two modes of [`examples/byok-ui`](../byok-ui):

1. **Direct BYOK** (default) — chats straight from the device via `createExpoModelHitch`. The
   pasted API key is stored with `SecureStoreKeyStore` (Android Keystore / iOS keychain;
   `localStorage` fallback on web) and never leaves the device. Works offline with the `mock`
   provider, which streams a word-by-word echo so you can watch token deltas arrive.
2. **Bridge** — points at a ModelHitch bridge (`npx modelhitch bridge`), which holds the keys and
   speaks OpenAI-compatible `/v1/chat/completions`. Uses the `useChat` hook from
   `modelhitch-expo/react`.

## Run it

```bash
npm install
npm run web        # expo start --web
# or
npm run android    # expo start --android  (needs a device/emulator + Expo Go or a dev build)
npm run ios        # expo start --ios
```

The `mock` provider needs no key — pick it, type a message, and watch the reply stream in.

For a real provider, paste a key in the Direct BYOK tab (stored on-device) or run a bridge and
switch to the Bridge tab. On the Android emulator the bridge host defaults to `10.0.2.2` instead of
`127.0.0.1`.

## How it's wired

- `modelhitch-expo` is installed from `file:../../expo-sdk` (it is not published yet).
- `modelhitch` comes from npm — per repo convention, examples use the published package, never an
  alias to source. This also keeps a single React instance (the app's), which the `useChat` hooks
  require.
- `metro.config.js` adds the repo root to `watchFolders` so Metro can read the symlinked
  `modelhitch-expo` package, and points `nodeModulesPaths` at this project's `node_modules`.

## Files

| File | Purpose |
| --- | --- |
| `App.tsx` | The whole UI: tabs, provider/key controls, streaming chat, error banner |
| `index.ts` | Expo entry (`registerRootComponent`) |
| `app.json` | Expo config incl. the `expo-secure-store` config plugin |
| `metro.config.js` | Monorepo-aware Metro resolution for the `file:` dependency |

## Verify a release build

```bash
npm run export:web   # npx expo export --platform web
npx serve dist -l 8080
```

Then open http://localhost:8080. The exported bundle is what a device would run after a production
build.