---
name: hitch-openai
description: Call the Hitch OpenAI-compatible API to list models and create chat completions via Bearer auth. Use when the user wants Hitch/Genoventures models, an OpenAI-compat chat call through Hitch, or to discover available model ids before chatting. Do not invent model ids; list first. Do not use for marketplace publish, modelhitch npm rewrites, or Cloudflare ops.
---

# Hitch OpenAI compat

This plugin's MCP server talks to Hitch's OpenAI-compatible API
(`HITCH_BASE_URL`, default `https://hitch.genoventures.com/v1`).

## Auth

- Prefer `HITCH_API_KEY`. Fallback: `OPENAI_API_KEY`.
- Unexpanded `${HITCH_API_KEY}` means **missing**.
- **Never** call `hitch_chat_completions` without a real Bearer token — the
  server errors before any network request if the key is missing.
- Some Hitch models need provider **session** headers beyond Bearer. L1 does
  **not** set those. Prefer models that work with plain Bearer; if a model
  fails with an auth/session error, try another id from `hitch_list_models`
  (often ones that are not locked behind a third-party session).

## Which tool

| Need | Tool |
| --- | --- |
| What model ids exist? Filter by provider? | `hitch_list_models` |
| Run a non-streaming chat completion | `hitch_chat_completions` |

### List before chat

1. Call `hitch_list_models` (optionally `owned_by`, `limit`) when the model id
   is unknown or the user asks what is available.
2. **Never invent** model ids. Pass an `id` returned by list (or an id the
   user explicitly gave that you confirmed).
3. Then call `hitch_chat_completions` with `model` + `messages`.

### Chat rules

- Required: `model`, `messages` (`[{ role, content }, …]`).
- Optional: `temperature`, `max_tokens`, `top_p`.
- Do **not** set `stream: true` — L1 rejects it with a clear error and does
  not hit the network.
- On missing key, report the auth error; do not fabricate a completion.

## Return shapes

- List: `{ models: [{ id, object, created, owned_by }], total, returned }`
- Chat: `{ id, object, created, model, choices: [{ index, finish_reason, message: { role, content } }], usage: { prompt_tokens, completion_tokens, total_tokens } | null }`

## Out of scope

Marketplace publish, rewriting the `modelhitch` npm package, Cloudflare
gateway ops, streaming, embeddings, images, and provider-session header
injection.
