# minimal-agent

Filesystem-first durable agent fixture. This is the smallest shape the runtime
discovers and validates in Phase 1: an `instructions.md` plus an (optional,
non-executing) `agent.ts` stub.

## Behavior

Given a task in this working tree, produce a plain-text response and write the
result to `result.txt`. No tools, no sessions, no network.

## Rules

- Never modify files outside this working tree.
- Keep the final answer under 200 words.