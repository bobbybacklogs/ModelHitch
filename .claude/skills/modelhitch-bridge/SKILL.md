---
name: modelhitch-bridge
description: Set up, configure, operate, verify, or troubleshoot the ModelHitch local multi-wire bridge for Claude Code, Codex, Gemini CLI, IDEs, and OpenAI-compatible clients. Use for bridge lifecycle commands, client base URLs, provider/model routing, local credentials, auto-mode failover, health checks, logs, and usage telemetry.
license: MIT
compatibility: ModelHitch CLI bridge on Node.js 22.5+; clients may use OpenAI Responses/chat, Anthropic Messages, or Gemini GenerateContent wires.
metadata:
  author: Geno Ventures Labs
  package: modelhitch
---

# Operate the ModelHitch bridge

Configure the bridge and its clients without exposing provider credentials or overwriting existing user settings.

Read [operations-reference.md](references/operations-reference.md) before changing a client configuration or diagnosing a wire-specific failure.

## Setup and verification

1. Run `node --version`. Require Node.js 22.5+ for the packaged CLI bridge because it enables SQLite usage persistence. The application library itself supports Node.js 18+.
2. Set the required provider credential in the bridge process environment without echoing it.
3. Start `npx modelhitch bridge` in the foreground for diagnosis or `npx modelhitch bridge --background` for normal local use.
4. Verify `npx modelhitch status`, `GET /healthz`, and `GET /v1/models` before editing any client.
5. Send a request using `mock/mock-model` over the same wire as the target client. Separate bridge/wire correctness from provider credentials.
6. Route explicit models as `providerId/modelId`. Treat bare model IDs as routes through the default provider.
7. Read the plan from `GET /v1/models`: it leads with the trusted lanes, then the fallback lanes (ids qualified except on the default provider, plus a `name` and `modelhitch.tier`). A client's model picker is built from this list, so a lane missing here cannot be chosen. Picking a lane puts it first and keeps the rest of the plan behind it.
8. Ask before changing user-level Claude Code, Codex, Gemini, IDE, shell-profile, or environment configuration. Merge narrowly and preserve unrelated settings.
9. Start a new client process after environment or startup configuration changes.
10. Inspect `/v1/usage` or `/usage` for request, latency, cost-estimate, and failover evidence.

## Diagnose failures

1. Confirm the running process, version, host, and port.
2. Confirm `/healthz` and the model catalog.
3. Reproduce with `mock/mock-model` on the target wire.
4. Confirm the explicit provider/model route exists.
5. Confirm the credential is present without revealing its value.
6. Inspect `npx modelhitch status`, the reported background log, and usage events.
7. Use `npx modelhitch front` to reproduce in the foreground.
8. Enable `MODELHITCH_DEBUG=1` only with the user's awareness because forwarded requests and upstream errors may contain sensitive content.

## Lifecycle

- Use `npx modelhitch bridge --background` to detach.
- Use `npx modelhitch status` to inspect the PID, health, and log path.
- Use `npx modelhitch front` to stop the background bridge and run it in the current terminal.
- Use `npx modelhitch stop` to stop the background process.
- Keep the default host `127.0.0.1` unless network exposure is explicitly required and secured.

## Auto-mode

- Expect retries only for configured retryable codes, HTTP 429, provider 5xx, and network errors.
- Expect missing fallback credentials to skip that lane.
- Expect pre-content streaming failures to move to another lane; propagate failures after content begins.
- Treat the original error as the actionable failure when every lane fails.
