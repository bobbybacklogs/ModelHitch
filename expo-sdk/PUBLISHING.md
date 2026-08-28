# Publishing `modelhitch-expo`

The adapter is a separate npm package from `modelhitch`. It is not built or published by the root
package's release scripts — `expo-sdk` is excluded from the root `files[]`, tsconfig, and vitest run.

## Prerequisites

- The `modelhitch` version the adapter targets is already on npm (it is a peer dependency).
- `npm install` has been run **inside `expo-sdk`**. The peers (`expo`, `expo-secure-store`,
  `react-native`, `react`, `modelhitch`) are pinned as devDependencies to the SDK 57 pairing, so
  the release build typechecks against the real types — no peer auto-install conflicts. The
  stubbed `tsconfig.dev.json` is for fast in-repo verification only and is not used for the
  release build.
- npm 2FA is available; `npm publish` prompts for an OTP.

## Release

From `expo-sdk` (commit any pending changes first — `npm version` requires a clean tree):

```bash
npm install
npm version <patch|minor|major>   # bumps version, commits, tags expo-vX.Y.Z (via .npmrc)
npm publish
```

`prepublishOnly` runs `typecheck:pkg` (real peers), `test`, and `build`, so a broken package cannot
be published.

Then push from the repository root:

```bash
git push origin main
git push origin expo-vX.Y.Z
```

The `expo-vX.Y.Z` tag is created by `npm version` (the `expo-sdk/.npmrc` sets
`tag-version-prefix=expo-v`), so no manual `git tag` is needed.

## Version policy

- Bump the `modelhitch` peer range whenever the adapter depends on a newly added core export.
- Keep the peer range permissive (`>=`) rather than pinning, so Expo apps can upgrade the core
  independently.
- Bump the `expo` peer floor only when a newer Expo API is actually required; the current floor is
  SDK 52 for `expo/fetch`, global `ReadableStream`, and `TextDecoder`.

## Verification before release

```bash
npm run typecheck:pkg
npm test
npm run build
npm pack --dry-run   # confirm only dist/ ships
```

Smoke-test the tarball in a real Expo app on a device or simulator: install the key via
`SecureStoreKeyStore`, run a streaming chat, and confirm token deltas arrive incrementally rather
than in a single burst. A single-burst reply means the non-streaming React Native `fetch` is active.
