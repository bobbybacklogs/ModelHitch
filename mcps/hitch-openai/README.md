# hitch-openai

Cursor **Agent Plugin** that exposes a narrow OpenAI-compatible slice of the
[Hitch](https://hitch.genoventures.com) API as a stdio MCP server: list models
and create chat completions.

Requires **Node 18+** (built-in `fetch`). **Zero npm dependencies.**

## Purpose

Give agents a Bearer-authenticated Hitch client without pulling in the
`modelhitch` npm package, Cloudflare ops tooling, or marketplace packaging.

## Tools

| Tool | HTTP | Returns |
| --- | --- | --- |
| `hitch_list_models` | `GET /models` | `{ models: ModelSummary[], total, returned }` |
| `hitch_chat_completions` | `POST /chat/completions` | `ChatCompletionSummary` |

### Shapes

`ModelSummary`:

```json
{ "id": "deepseek-chat", "object": "model", "created": 0, "owned_by": "deepseek" }
```

`ChatCompletionSummary`:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 0,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "finish_reason": "stop",
      "message": { "role": "assistant", "content": "…" }
    }
  ],
  "usage": {
    "prompt_tokens": 1,
    "completion_tokens": 1,
    "total_tokens": 2
  }
}
```

`usage` is `null` when the upstream response omits it.

### Auth

- **Required for chat** (and used for list): `HITCH_API_KEY` Bearer token.
- Fallback: `OPENAI_API_KEY` if `HITCH_API_KEY` is unset.
- Unexpanded `${HITCH_API_KEY}` / `${OPENAI_API_KEY}` is treated as **missing**.
- Chat is **never** called without a real token — missing key returns a tool
  error before any network request.
- Optional `HITCH_BASE_URL` (default `https://hitch.genoventures.com/v1`).
  Trailing slash is stripped; do not append a second `/v1`.

### Streaming

L1 does **not** support `stream: true`. If `stream` is true, the tool returns a
clear error and does not call the network.

## Non-goals

- Marketplace / cursor.directory publish
- Rewriting or vendoring the `modelhitch` npm package
- Cloudflare Workers ops, deploys, or gateway admin
- Provider session headers beyond Bearer (some Hitch models need them — L1
  does not set them; prefer models that work with plain Bearer)
- Streaming chat completions
- Embeddings, images, audio, fine-tunes, or other OpenAI surfaces

## Prove it locally (no token)

```bash
node --version          # >= 18
node server/index.js --print-tools
node server/index.js --self-test
node scripts/smoke.js
```

`--print-tools` prints tool names + JSON Schemas and exits.
`--self-test` maps fixtures to the canonical shapes (no network).
`scripts/smoke.js` spawns the stdio server, checks `initialize` + `tools/list`
(exactly 2 tools), rejects a fake tool, and asserts missing-token on
`hitch_chat_completions`.

### Live (optional)

```bash
export HITCH_API_KEY=…   # real Bearer token
node scripts/smoke.js --live
```

`--live` calls `hitch_list_models` with `limit: 3`, then
`hitch_chat_completions` with model `deepseek-chat` and `max_tokens: 16`.

## Install

See [SETUP.md](./SETUP.md). Skill guidance lives in
[skills/hitch-openai/SKILL.md](./skills/hitch-openai/SKILL.md).
Verification log: [VERIFICATION.md](./VERIFICATION.md).

## Layout

```
plugin.json                 # Agent Plugins 1.0.0
.cursor-plugin/plugin.json  # Cursor metadata + HITCH_API_KEY (required)
mcp.json                    # node ./server/index.js + env interpolation
package.json
server/index.js             # NDJSON JSON-RPC stdio, zero deps
scripts/smoke.js
skills/hitch-openai/SKILL.md
README.md
SETUP.md
VERIFICATION.md
LICENSE
.env.example
.gitignore
```
