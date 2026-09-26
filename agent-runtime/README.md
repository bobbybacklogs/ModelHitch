# agent-runtime

Phase 0 of an **Eve-shaped** (filesystem-first durable agent) runtime, owned
inside ModelHitch. Docs only in this PR — zero runtime code, zero new npm
deps, no CLI, no executable fixtures.

## Intent

Build a **filesystem-first durable agent** runtime that treats the working
tree as its source of truth: sessions, subagents, memory, and checkpoints are
plain files on disk, readable and diffable by humans and tools, safe to pause
and resume across restarts, and clear to audit.

This is not a fork of Vercel's Eve and we do not borrow its name. Eve's public
architecture is **inspirational** for how a filesystem-compiled agent runtime
can be shaped; see [ARCHITECTURE.md](./ARCHITECTURE.md) for where that shows
up in our concepts.

Present-day role in ModelHitch: the **local multi-wire bridge** is the
**model provider lane** for this runtime. The runtime orchestrates agent work;
the bridge already speaks OpenAI / Anthropic / Gemini wire formats for tools,
streaming, failover, and usage telemetry on `127.0.0.1:3939`.

Forge-of-record origin: **GitHub `bobbybacklogs/ModelHitch`** (primary once
the forge slug is confirmed; do not invent Origin URLs until then).

## Phase map (sketch, 0–7)

| Phase | Focus | Ships |
| --- | --- | --- |
| 0 | Scaffold | `agent-runtime/**` architecture docs only (this PR) |
| 1 | Runtime contract | Hooks, event stream, agent-work-unit shapes — no durable store yet |
| 2 | Filesystem compiler | Workdir → plan / task-graph / sandbox manifest compile step |
| 3 | Durable sessions | Session lifecycle on disk, pause / resume, rollback points |
| 4 | App / sandbox split | Host-app isolation from agent sandbox, capability gates |
| 5 | Subagents-as-sessions | Nested agent sessions as first-class filesystem sessions |
| 6 | Harness operability | Supervisor, heartbeat, kill, offline restart — the *agent-work-unit* sense |
| 7 | Hardening | Crash-resume guarantees, sandbox hardening, conformance, docs |

Phases 1–7 are **sketches**. Nothing commits to them yet; each takes its own
scoped PR with its own acceptance.

## Non-goals (this PR)

- No runtime code, no new npm deps, no CLI, no fixtures that execute.
- No `/harness/` directory anywhere.
- No changes to `src/` (library, bridge, providers, daemon, server).
- No touch of client SDKs, `.agents/`, `.claude/`, `.cursor-plugin/`, `plugins/`, `conformance/`.
- **No claim of crash-resume durability or sandbox support in Phase 0** — those are later phases.
- No use of the name "Eve" (Vercel's). Say "Eve-shaped" or "filesystem-first durable agent".

## Never-touch list

1. **No `/harness/`** anywhere in this repo.
2. **`src/`** — library + bridge core.
3. **`src/agent.ts`** stays a tool-loop helper, untouched.
4. **Client SDKs** — `android-sdk/`, `flutter-sdk/`, `expo-sdk/`, `electron-sdk/`, `modelhitch-dotnet/`.
5. **Existing skill/plugin packs** — `.agents/`, `.claude/`, `.cursor-plugin/`, `plugins/`.
6. **`conformance/` + published npm API** — wire contracts and the exported package surface.
7. **Foreign repos / inventing Origin paths** — only the confirmed forge-of-record.
8. **No full-spec rewrite** in this PR — concepts map only.

## Where to go next

- [ARCHITECTURE.md](./ARCHITECTURE.md) — concepts map ↔ future `agent-runtime/` modules.
- Root [README link](../README.md) — ModelHitch overview and the bridge as the model provider lane.