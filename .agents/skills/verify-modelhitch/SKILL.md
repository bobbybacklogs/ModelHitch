---
name: verify-modelhitch
description: Verify the core TypeScript npm package modelhitch with the default offline gates. Use after library, CLI, bridge, or test changes, or when asked to prove ModelHitch still typechecks, builds, and tests without provider API keys.
---

# Verify ModelHitch (`modelhitch`)

This is the gardener verification skill for the **core TypeScript package**. It is not a product skill.

Do **not** confuse this with:

- `.claude/skills/modelhitch-integrate`
- `.claude/skills/modelhitch-bridge`
- `plugins/modelhitch/skills/modelhitch`
- `npx modelhitch setup …` installs

Those teach agents how to *use* ModelHitch. This skill only checks whether the npm package still holds.

Treat [docs/FEATURE_MAP.md](../../../docs/FEATURE_MAP.md) as the claim list. Do not invent shipped features from README marketing. Do not change product behavior to make verify pass.

## Default path (required)

No secret API keys. Must exit 0 on a clean checkout with Node.js 22 (CI uses 22; SQLite usage tests need Node 22.5+).

```bash
npm ci
npm run verify
```

`npm run verify` is:

```bash
npm run typecheck && npm run build && npm test
```

Order is load-bearing: `tests/daemon.test.ts` exercises `dist/cli.js`, so **build before test**. `prepublishOnly` and the CI `typescript` job both call `npm run verify`.

Record the exact command and exit code. Default verify is the only required proof.

### In scope

Root package only: `src/`, `tests/` (except `expo-sdk/**` and `electron-sdk/**`, which vitest already excludes), `examples/` typechecked via `tsconfig.json`, built entries (`src/index.ts`, `src/browser.ts`, `src/react/index.ts`, `src/cli.ts`, `src/settings-tui.ts`).

### Out of default verify

Do **not** run these unless the user explicitly asks. They are not required for this skill to succeed.

| Lane | Why it is excluded |
| --- | --- |
| `npm run canary` | Live Vercel AI Gateway + tool loop; needs `AI_GATEWAY_API_KEY` / `VERCEL_OIDC_TOKEN` / `VERCEL_TOKEN` |
| `npm run example` live path | Quickstart uses mock without a key; live gateway is env-gated |
| Live provider calls | Hosted APIs need provider keys; tests stub `fetch` |
| Local runtimes | Ollama / LM Studio / vLLM / llama.cpp / KoboldCpp need a process on localhost |
| Live `models.dev` catalog | Catalog tests inject a fixture `fetch` |
| `modelhitch settings` TUI | Needs Bun + an interactive TTY |
| Sister packages | `android-sdk`, `flutter-sdk`, `expo-sdk`, `electron-sdk`, `modelhitch-dotnet` have their own CI jobs |
| `conformance/` | Fixture file, not executed by root vitest |

## Optional env-gated canaries

Run only with explicit approval and credentials that are already present. Never print keys. Never add these to default verify.

### Live gateway + bridge tool loop

```bash
# requires AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN or VERCEL_TOKEN
npm run canary
```

Exit 2 means no credential (not a product failure). Exit 1 means the live loop failed.

### Mock quickstart (no key)

```bash
npx tsx examples/quickstart.ts
```

Uses `mock/mock-model` when no gateway credential is set. This is a smoke demo, not a substitute for `npm run verify`.

### Live quickstart

```bash
# requires a gateway credential
npx tsx examples/quickstart.ts
```

### Local mock bridge (no provider keys)

```bash
# start in another process if you need a long-lived server
npx tsx examples/studio-bridge.ts
# or, after build:
node dist/cli.js --help
```

A background `modelhitch bridge` against live providers is env-gated. Default tests already cover mock-wired `/healthz`, `/v1/models`, chat, Responses, Anthropic, and Gemini wires.

## How to report

1. Quote the command(s) run.
2. Quote each exit code.
3. State whether any env-gated canary ran (default: no).
4. If default verify is non-zero, stop. Do not weaken docs, skip tests, or change product code to hide the failure unless the user asked for a product fix.

## Success

Default verify exit 0 without secret API keys, on Node 22, after `npm ci`.
