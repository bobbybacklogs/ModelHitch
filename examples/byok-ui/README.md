# BYOK UI — reference template

A reference implementation for adding **bring-your-own-key (BYOK) AI chat** to a web app,
built on the published [`modelhitch@^0.14`](https://www.npmjs.com/package/modelhitch) npm
package. It demonstrates both integration patterns and the security model in one small app:

- **Bridge mode** — keys live in a local ModelHitch bridge service; the UI talks
  OpenAI-compatible `/v1/chat/completions` through the `modelhitch/react` hooks.
- **Direct BYOK** — users paste their own keys; the browser calls providers straight from
  `modelhitch`'s browser build.

This demo runs against the **published npm package** — no source aliases, no workspace
links. Whatever the browser bundle does here is exactly what the artifact on npm does, so
the `modelhitch/browser` build is proven end-to-end.

## The two patterns

| | Bridge mode | Direct BYOK |
| --- | --- | --- |
| Keys live in | your bridge service (`server.ts`) | the user's `localStorage` |
| Browser calls | `POST /v1/chat/completions` on the bridge | provider APIs directly |
| Integration | `useChat` from `modelhitch/react` | `new ModelHitch({ keystore })` + `mh.stream()` |
| Tools / failover / usage | ✅ bridge-side | ❌ single provider, straight call |
| Backend needed | yes (or self-hosted) | no |
| CORS surface | bridge-to-provider only | providers must allow browser origins |

### When to use which

- **Bridge mode** when keys are backend-owned (a SaaS backend, per-tenant keys), or when you
  want agentic tool loops, auto-failover, usage tracking, and multi-provider routing without
  exposing keys. The bridge speaks OpenAI-compatible APIs, so any client that can reach it
  works.
- **Direct BYOK** when the product is *user-owned* keys with no backend (zero infra), when a
  single provider is enough, and when provider CORS allows browser-origin calls.
- If CORS blocks you, that is usually the signal to run a bridge.

### Files in this template

| File | Role |
| --- | --- |
| `src/App.tsx` | Two-mode UI — `BridgeChat` (`useChat`) and `DirectChat` (`ModelHitch` + `LocalStorageKeyStore`) |
| `src/main.tsx` | React entry — nothing modelhitch-specific, copy as-is |
| `server.ts` | Bridge harness — `createModelHitchServer` + `mockProvider` on `:3939` |
| `vite.config.ts` | Vite config with the production `/v1` proxy pattern |
| `index.html` | Shell + demo CSS (tabs, messages, forms) |
| `tsconfig.json` | Strict TS, `vite/client` + `node` types, no source paths |

Copy the two-mode shape; replace the demo tool, provider list, and styling with your product's.

## Security model

- **Direct mode: keys never leave the user's device.** `LocalStorageKeyStore` stores them in
  `localStorage`; requests carry the key straight to the provider. Nothing ships in the
  bundle and nothing hits your backend.
- **Never ship a server key in a browser bundle.** Anything a client component imports is
  visible to users. Server keys belong in the bridge or backend, referenced only through
  environment variables (`process.env`), and the bridge should be reachable only from your
  origin.
- **`localStorage` is not XSS-hardened.** Same caveat as any client-side BYOK: any script
  that can run on your page can read stored keys. Choose bridge mode when your product must
  hold keys for users.
- **The published package guarantees a browser-safe bundle.** The `browser` export condition
  (and the explicit `modelhitch/browser` subpath) resolve to `dist/browser.js`, which
  contains no `node:` modules — bundlers never pull the Node-only pieces (bridge server,
  SQLite usage storage) into the client.

## Provider / CORS notes

Providers that accept browser-origin calls without extra setup: OpenAI, OpenRouter, Groq,
Together, DeepSeek, Mistral, xAI, Moonshot, Z.ai (GLM), HuggingFace, and Vercel AI Gateway.

- **Anthropic** rejects browser-origin requests unless you pass `dangerouslyAllowBrowser:
  true` in the provider options (it sends the `anthropic-dangerous-direct-browser-access`
  header). Use it deliberately — it exists because direct browser access is not Anthropic's
  default posture.
- **Local runtimes** (Ollama, LM Studio, vLLM, llama.cpp, KoboldCpp) need CORS enabled and
  must be reachable from the page's origin — usually a dev-only `localhost` setup.
- **`mockProvider`** works fully offline and needs no key, which makes it handy for demos
  and tests.

## Run it

```bash
cd examples/byok-ui
npm install
npm run server   # bridge on http://127.0.0.1:3939 (mock provider)
npm run dev      # UI on http://localhost:5173
```

Open http://localhost:5173. The **Bridge** tab talks to the local bridge (mock model, weather
tool loop — try *"What is the weather in london?"* and watch the bridge drive a `get_weather`
tool call plus the follow-up turn). For **Direct BYOK**: switch tabs, pick a provider, paste a
key (or choose *Mock (offline)*), and send a message — the key is stored in `localStorage`
only and no server is needed.

Environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_BRIDGE_URL` | `http://127.0.0.1:3939/v1` | Bridge endpoint for the hooks |
| `VITE_BRIDGE_MODEL` | `mock-model` | Model the bridge routes |
| `MODELHITCH_MAX_BODY_BYTES` | `64 MiB` | Bridge request-size limit |

## Adapt to a new SaaS project — checklist

1. `npm install modelhitch` (React hooks need React ≥ 18 as a peer).
2. **Pick the pattern.** Backend-owned keys / tools / failover / usage → bridge mode.
   User-owned keys, zero infra → direct BYOK.
3. **Direct:** create `new ModelHitch({ keystore: new LocalStorageKeyStore() })` once
   (module scope or `useState`), then `keystore.set(provider, key)` from your key input.
   **Bridge:** stand up `createModelHitchServer({ providers, defaultProviderId })` with your
   providers + env-var keys, then point `useChat({ baseUrl, model })` at it.
4. **Register the providers you need** in the bridge config (`providers: [...]`), or for
   direct mode pick from the built-ins (`openai`, `openrouter`, `groq`, `mock`, ...).
5. **Wire the UI.** Copy the `useChat` / `mh.stream()` loops from `src/App.tsx`. Replace the
   demo `get_weather` `executeTool` with calls to *your* backend — never put keys in a tool
   handler, and keep the handler thin (return JSON the model can read).
6. **Handle the states** an MVP needs: loading (`isThinking`/`busy`), empty drafts, streaming
   (`pending`), error display, and disabled sends while streaming.
7. **CORS.** Direct mode: verify your providers allow browser origins (see above) or add
   `dangerouslyAllowBrowser` for Anthropic. Bridge mode: proxy `/v1` through your app origin
   (see `vite.config.ts`) or CORS-configure the bridge.
8. **Ship the right entry.** Vite resolves the `browser` condition automatically; you can
   also `import { ModelHitch } from 'modelhitch/browser'` explicitly. Run `vite build` and
   grep the output for `node:` to confirm the client bundle is Node-free.
9. **Know the boundaries.** This template does not implement product auth, per-tenant key
   vaults, rate limiting, or usage billing — wire those into your backend before shipping
   keys to real users.

## Agent handoff

Hand this block verbatim to another coding agent to replicate the pattern in a different repo:

```text
You are adding a bring-your-own-key (BYOK) AI chat UI to a React + Vite app,
mirroring the reference template at ModelHitch's examples/byok-ui. Use the
published modelhitch@^0.14 package — never alias it to source. Stack: React 18,
Vite 5, modelhitch + modelhitch/react from npm.

Architecture — two modes in one app:
1. BRIDGE: a local server (tsx, modelhitch Node entry) runs
   createModelHitchServer({ providers, defaultProviderId }) on :3939/v1; the UI
   uses useChat({ baseUrl, model, tools, executeTool }) from modelhitch/react and
   streams OpenAI-compatible responses. Keys live server-side (env vars only).
2. DIRECT: new ModelHitch({ keystore: new LocalStorageKeyStore() }), the user
   pastes a key, keystore.set(provider, key) stores it in localStorage, and
   mh.stream({ provider, messages }) calls the provider straight from the
   browser. Include a mock provider for offline demos and a weather-style tool
   demo in bridge mode.

Security rules (must follow):
- Never ship a server key in the browser bundle; server keys come from env vars.
- Direct-mode keys never leave the device (localStorage). Clear the stored key
  when the input is emptied (keystore.delete), and block send with an inline
  hint when a key is required but empty.
- Vite must resolve the package's browser export condition so the client bundle
  contains no node: modules; verify with `vite build` + grep for "node:".

Files to mirror: package.json (deps: modelhitch, react, react-dom; scripts
dev/server/build), vite.config.ts (react plugin; proxy /v1 to the bridge in
production), server.ts (bridge harness with mockProvider), src/App.tsx (tabbed
two-mode UI, useChat + DirectChat components, message list, stream loop), and a
README.md documenting patterns, the security model, and an adapt checklist.
See examples/byok-ui for the exact shape.
```
