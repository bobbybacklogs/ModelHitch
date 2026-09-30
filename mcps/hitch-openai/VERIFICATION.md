# Verification — hitch-openai

Recorded on **2026-09-25 20:51 PDT** (America/Los_Angeles).
Node: `v20.19.2`. No `HITCH_API_KEY` / `OPENAI_API_KEY` in this
environment, so live Hitch calls were skipped.

## Commands run

From `/workspace/mcps/hitch-openai`:

```bash
node server/index.js --print-tools
node server/index.js --self-test
node scripts/smoke.js
```

## `--print-tools`

Stdout (abbreviated tool list confirmed):

- server: `hitch-openai` @ `1.0.0`
- tools (exactly 2):
  - `hitch_list_models` — optional `owned_by`, `limit` (default 50, max 200)
  - `hitch_chat_completions` — required `model`, `messages`; optional
    `temperature`, `max_tokens`, `top_p`, `stream` (must be false/omitted)

Full JSON:

```json
{
  "server": {
    "name": "hitch-openai",
    "version": "1.0.0"
  },
  "tools": [
    {
      "name": "hitch_list_models",
      "description": "List models from the Hitch OpenAI-compat API (GET /models). Optional owned_by filter and limit (default 50, max 200). Returns { models: ModelSummary[], total, returned } where ModelSummary = { id, object, created, owned_by }. Call this before inventing model ids for chat.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "owned_by": {
            "type": "string",
            "description": "Optional exact owned_by filter (e.g. openai, anthropic, deepseek, openrouter)."
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 200,
            "description": "Max models to return after filter. Default 50, max 200."
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "hitch_chat_completions",
      "description": "Create a chat completion via Hitch (POST /chat/completions). Requires Bearer auth (HITCH_API_KEY or OPENAI_API_KEY). Streaming is not supported in L1 — if stream is true, returns an error without calling the network. Returns ChatCompletionSummary: { id, object, created, model, choices: [{ index, finish_reason, message: { role, content } }], usage }.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "model": {
            "type": "string",
            "description": "Model id from hitch_list_models. Do not invent ids."
          },
          "messages": {
            "type": "array",
            "description": "Chat messages as [{ role, content }, ...].",
            "items": {
              "type": "object",
              "properties": {
                "role": {
                  "type": "string"
                },
                "content": {}
              },
              "required": [
                "role",
                "content"
              ],
              "additionalProperties": true
            },
            "minItems": 1
          },
          "temperature": {
            "type": "number",
            "description": "Optional sampling temperature."
          },
          "max_tokens": {
            "type": "integer",
            "minimum": 1,
            "description": "Optional max completion tokens."
          },
          "top_p": {
            "type": "number",
            "description": "Optional nucleus sampling top_p."
          },
          "stream": {
            "type": "boolean",
            "description": "Must be omitted or false. Streaming is not supported in L1."
          }
        },
        "required": [
          "model",
          "messages"
        ],
        "additionalProperties": false
      }
    }
  ]
}
```

## `--self-test`

No network. Maps fixtures through shape mappers; checks placeholder tokens,
base URL slash stripping, `stream=true` rejection, and missing-token before
fetch.

```
ok  shape mapper self-test
```

## `scripts/smoke.js`

Spawns stdio MCP server with keys stripped:

1. `initialize` → `serverInfo.name === "hitch-openai"`
2. `tools/list` → exactly the two tools above
3. fake tool `hitch_delete_everything` → `isError` (unknown/disallowed)
4. `hitch_chat_completions` without token → `isError` mentioning
   `HITCH_API_KEY` (no HTTP)

```
ok  initialize
ok  tools/list (exactly 2)
ok  fake tool rejected
ok  missing-token on hitch_chat_completions
skip live Hitch calls (no HITCH_API_KEY)
smoke passed
```

## Live (`--live`)

**Not run** — neither `HITCH_API_KEY` nor `OPENAI_API_KEY` was set to a
real token.

When a key is available:

```bash
export HITCH_API_KEY=…   # real Bearer token
node scripts/smoke.js --live
```

Expected extra lines (from `scripts/smoke.js`):

```
ok  live hitch_list_models (returned=N, total=T)
ok  live hitch_chat_completions model=deepseek-chat finish=…
```

Live calls: `hitch_list_models` with `limit: 3`, then
`hitch_chat_completions` with model `deepseek-chat` and `max_tokens: 16`.
