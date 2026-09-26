# Setup — hitch-openai

## Prerequisites

- Node.js **18+**
- A Hitch Bearer API key (whatever Hitch uses today to authorize
  `Authorization: Bearer …` against the OpenAI-compat API)

## Local Cursor plugin (symlink)

This package **is** the plugin root. Install it under Cursor's local plugins
directory (do **not** publish to the marketplace unless the owner asks):

```bash
mkdir -p ~/.cursor/plugins/local
ln -sfn /absolute/path/to/mcps/hitch-openai ~/.cursor/plugins/local/hitch-openai
```

Or copy the tree instead of symlinking.

Reload Cursor so it picks up the local plugin.

### Grok Bot / cloud agents

Grok Bot and Cursor cloud agents load plugins from the **Cursor dashboard /
marketplace**, not from `~/.cursor/plugins/local`. A local symlink alone will
not appear there. Use the dashboard MCP / plugin registration path (or an
explicit MCP config) when you need this server inside Grok Bot.

## MCP config

`mcp.json` already declares the stdio server:

```json
{
  "mcpServers": {
    "hitch-openai": {
      "type": "stdio",
      "command": "node",
      "args": ["./server/index.js"],
      "env": {
        "HITCH_API_KEY": "${HITCH_API_KEY}",
        "HITCH_BASE_URL": "${HITCH_BASE_URL}",
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

`.cursor-plugin/plugin.json` marks `HITCH_API_KEY` as **required** and
`HITCH_BASE_URL` as optional. Paste the Bearer key into Cursor's plugin
variable UI when prompted. An unexpanded `${HITCH_API_KEY}` placeholder is
treated as missing by the server.

You can also export the key in the shell that launches Cursor:

```bash
export HITCH_API_KEY=your-bearer-token
# optional:
# export HITCH_BASE_URL=https://hitch.genoventures.com/v1
# export OPENAI_API_KEY=…   # fallback only if HITCH_API_KEY is unset
```

See `.env.example` for placeholders. Never commit a real key.

## Token generation

Use whatever Hitch currently issues as a Bearer API key (dashboard, CLI, or
ops-provisioned secret). This L1 client only sends:

```http
Authorization: Bearer <token>
```

It does **not** set provider session headers. Prefer models that succeed with
plain Bearer auth.

## Sanity check

```bash
cd ~/.cursor/plugins/local/hitch-openai   # or the package root
node server/index.js --print-tools
node server/index.js --self-test
node scripts/smoke.js
```

With a real key:

```bash
export HITCH_API_KEY=…
node scripts/smoke.js --live
```
