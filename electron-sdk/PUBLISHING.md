# Publishing `modelhitch-electron`

The adapter is a separate npm package from `modelhitch`. It is not built or published by the root
package's release scripts — `electron-sdk` is excluded from the root `files[]`, tsconfig, and vitest run.

## Prerequisites

- The `modelhitch` version the adapter targets is already on npm (it is a peer dependency).
- `npm install` has been run **inside `electron-sdk`**. The peers (`react`, `modelhitch`) are pinned
  as devDependencies so the release build typechecks against the real types. `typecheck:pkg` resolves
  `electron` through `types/electron.d.ts` so publish does not require the Electron binary download
  (which often fails on Windows). The stubbed `tsconfig.dev.json` is for fast in-repo verification
  only and is not used for the release build.
- npm 2FA is available; `npm publish` prompts for an OTP.

## Release

From `electron-sdk` (commit any pending changes first — `npm version` requires a clean tree):

```bash
npm install
npm version <patch|minor|major>   # bumps version, commits, tags electron-vX.Y.Z (via .npmrc)
npm publish
```

`prepublishOnly` runs `typecheck:pkg` (real peers), `test`, and `build`, so a broken package cannot
be published.

Then push from the repository root:

```bash
git push origin main
git push origin electron-vX.Y.Z
```

The `electron-vX.Y.Z` tag is created by `npm version` (the `electron-sdk/.npmrc` sets
`tag-version-prefix=electron-v`), so no manual `git tag` is needed.

## Version policy

- Bump the `modelhitch` peer range whenever the adapter depends on a newly added core export.
- Keep the peer range permissive (`>=`) rather than pinning, so Electron apps can upgrade the core
  independently.
- Bump the `electron` peer floor only when a newer Electron API is actually required; the current
  floor is Electron 28 for `safeStorage` and modern IPC.

## Verification before release

```bash
npm run typecheck:pkg
npm test
npm run build
npm pack --dry-run   # confirm only dist/ ships
```

Smoke-test the tarball in a real Electron app on each target OS: store a key with
`SafeStorageKeyStore`, run a streaming chat from the main process, and confirm renderer IPC works when
the UI runs in a separate process.
