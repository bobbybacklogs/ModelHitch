# Agent Runtime — Architecture (Phase 0 concepts map)

> Status: **docs only**. Phase 0 maps concepts to future `agent-runtime/`
> modules. Nothing here is implemented; nothing here claims runtime behavior.

**Forge-of-record origin:** GitHub `bobbybacklogs/ModelHitch` (primary once
the forge slug is confirmed; no invented Origin URLs).

## 0. Scope and framing

This document is a **concepts map**: named concepts on the left, the
modules that will own them on the right. It is not a spec. The full spec is
written piecewise in later phases, each with its own PR.

**Naming:** this runtime is **Eve-shaped** but is not Eve. We reference
Vercel's **Eve** (https://vercel.com/docs/eve) only as inspirational public
architecture — filesystem-compiled, durable, subagent-capable agents — and
explicitly do **not** use its name, folder, package, or branding here.

## 1. Concept map

| Concept | Shape | Future home (agent-runtime modules, sketch) | Notes |
| --- | --- | --- | --- |
| **Filesystem compiler** | Workdir + session files compile into a runnable plan/task graph you can diff | `compiler/` | Eve's filesystem-as-source-of-truth is the inspiration. Output is a first-class artifact, not magic state |
| **Durable session** | Session state as plain files (context, narrative, memory, checkpoint refs) | `session/` | Phase 3. Phase 0 makes no durability claim |
| **App / sandbox split** | Host app and agent sandbox are separate surfaces with a controlled boundary | `sandbox/`, `app-host/` | Phase 4. Phase 0 makes no sandbox claim |
| **Subagents-as-sessions** | A subagent is a nested session with its own filesystem-backed context | `session/`, `subagent/` | Phase 5 |
| **Harness operability** | Supervisor, heartbeat, kill, offline restart — the **agent-work-unit** sense of "harness" | `harness/` (runtime-internal; **not** a top-level `/harness/`) | Phase 6. We say *harness operability*, never a `/harness/` tree |
| **Model provider lane** | All model calls route through the local multi-wire bridge (`127.0.0.1:3939`) | `bridge-client/` | Present-day bridge (src/): OpenAI Chat/Responses, Anthropic Messages, Gemini GenerateContent, tools, streaming, failover, usage |
| **Agent work unit** | One dispatched unit of agent work, supervised, heartbeat-able, killable | Core runtime concept | The "harness-operability in the *agent-work-unit* sense" framing |
| **Checkpoint** | Named point in session history for pause/resume and rollback | `session/checkpoints` | Crash-resume guarantees are later phases, not Phase 0 |

## 2. Where Vercel Eve is cited (and where it is not)

- **Inspirational:** filesystem as source of truth; sessions you can read,
  diff, and resume; subagents as first-class sessions; a compile step that
  turns workdir + session into a plan.
- **Not this product:** the name Eve, its folder/package structure, its
  branding, and any claim of being a fork of vercel/eve.

## 3. Non-architecture decisions (Phase 0)

- No `/harness/` directory. Harness concepts live inside this package if/when
  they are implemented (Phase 6), not as a repo-wide top-level folder.
- No sandbox or crash-resume durability claims yet.
- No runtime code: no hooks, no events, no compiled plans. Phase 1 defines the
  runtime contract; Phase 2 defines the filesystem compiler; Phase 3+ build
  durability and isolation.

## 4. Relationship to existing ModelHitch surfaces

| Existing surface | Relationship |
| --- | --- |
| `src/` (`agent.ts`, bridge, providers, daemon, server) | Untouched. The bridge is this runtime's model provider lane |
| `.agents/`, `.claude/`, `.cursor-plugin/`, `plugins/`, `conformance/` | Untouched. Existing skill/plugin packs and wire contracts stay external |
| Client SDKs | Out of scope. The runtime talks to the bridge, not to client SDKs |

## 5. Reading order

1. `agent-runtime/README.md` — intent, non-goals, never-touch list, phase map.
2. This file — concepts ↔ future modules.
3. Root `README.md` — where the bridge lives today.