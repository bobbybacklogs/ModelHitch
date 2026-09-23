# ModelHitch bridge operations

## Commands and environment

```bash
npx modelhitch bridge
npx modelhitch bridge --background
npx modelhitch status
npx modelhitch front
npx modelhitch stop
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `MODELHITCH_PORT` | `3939` | Listening port |
| `MODELHITCH_HOST` | `127.0.0.1` | Listening host |
| `MODELHITCH_MAX_BODY_BYTES` | 64 MiB | Maximum body size |
| `MODELHITCH_HOME` | `~/.modelhitch` | Background PID and log directory |
| `MODELHITCH_DEBUG` | disabled | Logs forwarded bodies and upstream errors; may expose sensitive data |

## Endpoints

| Endpoint | Client family |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible chat |
| `POST /v1/responses` | Codex and Responses clients |
| `POST /v1/messages` | Claude Code and Anthropic clients |
| `POST /v1beta/models/{model}:generateContent` | Gemini clients |
| `GET /v1/models`, `GET /healthz` | Discovery and health |
| `GET /v1/usage`, `GET /usage` | Usage JSON and HTML dashboard |
| `POST /v1/usage/reset` | Reset usage history |

### Cursor Cloud Agent lane (opt-in)

Disabled by default. When `cloudAgent.enabled` is true and `CURSOR_API_KEY` (or `keys.cursor-cloud`) is set, route explicitly as `cursor-cloud/<model>`. The bridge spawns or resumes agents via `https://api.cursor.com/v1`. Client `tools` are dropped on this route.

```bash
npx modelhitch bridge --cloud-agent-lane --cloud-agent-repo https://github.com/org/repo --cloud-agent-ref main
```

Use `http://127.0.0.1:3939/v1` for OpenAI-style clients. Use `http://127.0.0.1:3939` for clients that append Anthropic or Gemini paths.

## Claude Code

Start the bridge in the environment holding the upstream provider key. Start a new Claude Code process with:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3939"
export ANTHROPIC_AUTH_TOKEN="local-bridge"
export ANTHROPIC_DEFAULT_SONNET_MODEL="mock/mock-model"
claude
```

Switch `ANTHROPIC_DEFAULT_SONNET_MODEL` to an explicit live `providerId/modelId` only after the mock wire succeeds. Do not put the real upstream provider key in Claude Code; the bridge resolves it locally.

## Codex

Merge this into the user-level Codex config, never replacing the entire file:

```toml
model_provider = "modelhitch"
model = "mock/mock-model"

[model_providers.modelhitch]
name = "ModelHitch local bridge"
base_url = "http://127.0.0.1:3939/v1"
```

Do not set `env_key`; the bridge resolves provider credentials. Project-scoped Codex config cannot define custom `model_providers`.

## Source map

When working in the ModelHitch repository, inspect:

- `src/cli.ts` and `src/daemon.ts` for lifecycle behavior
- `src/server/server.ts` for endpoints and server options
- `src/server/*-wire.ts` and `src/server/responses.ts` for wire translation
- `src/core/failover.ts` and `src/core/usage.ts` for retries and telemetry
- `examples/codex.config.toml` for the maintained Codex example
- `tests/server.test.ts`, `tests/responses-bridge.test.ts`, `tests/anthropic-bridge.test.ts`, and `tests/gemini-bridge.test.ts` for wire coverage
