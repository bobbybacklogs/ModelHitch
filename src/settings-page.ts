/**
 * Milestone 5 — the local settings UI.
 *
 * A single self-contained HTML document served by the bridge at
 * `GET /settings`. No CDN, no build step, no external fonts — it runs
 * entirely against the local bridge:
 *
 *   GET  /v1/config        masked config document
 *   PUT  /v1/config        validate + apply (writes the config file)
 *   GET  /v1/catalog       provider inventory (registry or models.dev)
 *   GET  /v1/lane-health   circuit-breaker health snapshot (polled)
 *   GET  /v1/chatgpt-plan  Sign in with ChatGPT account panel (polled)
 *   GET  /v1/usage         usage summary (linked)
 *
 * Design language: a local instrument panel, not a SaaS dashboard — warm
 * dark neutrals, a brass accent, mono for identifiers/keys, dense but
 * readable, everything lives on this machine.
 */

export function settingsPageHtml(): string {
  // String.raw: the inline browser JS below contains regex/string escapes
  // (`\n`, `<\/select>`) that must reach the browser verbatim — a plain
  // template literal would consume them at build time and kill the script.
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ModelHitch — local settings</title>
<style>
  :root {
    --bg: #0d0e0c; --panel: #141613; --panel2: #191c18; --raised: #1e221d;
    --line: #2a2e28; --line2: #373c34; --text: #d8d6cf; --muted: #8d8e84;
    --accent: #b7a06a; --accent-dim: #8a7a52; --ok: #8fbf6a; --warn: #d9a441; --bad: #c9704f;
    --mono: ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.45; }
  body { padding-bottom: 84px; }
  code, .mono { font-family: var(--mono); font-size: 0.92em; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { position: sticky; top: 0; z-index: 10; background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); }
  .bar { max-width: 960px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: baseline; gap: 12px; }
  .wordmark { font-family: var(--mono); font-weight: 700; letter-spacing: 0.04em; font-size: 15px; color: var(--text); }
  .wordmark b { color: var(--accent); }
  .local-badge { font-size: 11px; color: var(--muted); border: 1px solid var(--line2); border-radius: 3px; padding: 2px 7px; font-family: var(--mono); }
  .spacer { flex: 1; }
  .linkbar { font-size: 12px; color: var(--muted); }

  main { max-width: 960px; margin: 0 auto; padding: 22px 20px 40px; }
  section { margin-bottom: 26px; }
  .section-head { display: flex; align-items: baseline; gap: 10px; border-bottom: 1px solid var(--line); padding-bottom: 6px; margin-bottom: 12px; }
  .section-head h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); margin: 0; font-weight: 600; }
  .section-head .hint { font-size: 12px; color: var(--muted); }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; }

  .row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .row:last-child { border-bottom: 0; }
  .row .grow { flex: 1; min-width: 220px; }
  label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 3px; }
  input[type=text], input[type=password], input[type=number], select {
    background: var(--raised); color: var(--text); border: 1px solid var(--line2); border-radius: 4px;
    padding: 7px 9px; font-family: var(--mono); font-size: 13px; width: 100%;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent-dim); }
  input[type=number] { width: 110px; }
  .num-row { display: flex; align-items: center; gap: 8px; }
  .btn {
    background: transparent; color: var(--text); border: 1px solid var(--line2); border-radius: 4px;
    padding: 6px 11px; font-size: 12px; cursor: pointer; font-family: var(--sans);
  }
  .btn:hover { border-color: var(--accent-dim); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #14130e; font-weight: 600; }
  .btn.primary:hover { background: #c9b47c; }
  .btn.danger:hover { border-color: var(--bad); color: var(--bad); }
  .btn:disabled { opacity: 0.45; cursor: default; }

  .pill { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 12px; border: 1px solid var(--line2); border-radius: 4px; padding: 3px 8px; background: var(--panel2); }

  .lane-list .lane { display: grid; grid-template-columns: 1fr 2fr auto; gap: 10px; align-items: start; padding: 8px 0; border-bottom: 1px solid var(--line); }
  .lane-list .lane:last-child { border-bottom: 0; }
  .lane-list .lane > select.lane-provider, .lane-list .lane > button.lane-remove { margin-top: 1px; }
  .intent-profile { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 12px; }
  .intent-profile:first-child { border-top: 0; margin-top: 0; padding-top: 0; }
  .lane-list .lbl { font-family: var(--mono); font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }

  .lane-models { min-width: 0; }
  .lane-models .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .lane-models .chips:empty { display: none; }
  .chip { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 12px; background: var(--panel2); border: 1px solid var(--line2); border-radius: 999px; padding: 3px 6px 3px 10px; }
  .chip-x { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 2px; }
  .chip-x:hover { color: var(--bad); }
  .model-add-row { display: flex; gap: 8px; }
  .model-add-row select, .model-add-row input { font-size: 12px; padding: 6px 8px; }
  .no-models-hint { font-size: 11px; color: var(--muted); font-style: italic; margin-top: 4px; }

  .status { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .dot.open { background: var(--bad); box-shadow: 0 0 6px var(--bad); }
  .dot.half-open { background: var(--warn); }
  .dot.closed { background: var(--ok); }
  .dot.key-set { background: var(--ok); }
  .dot.key-missing { background: var(--muted); opacity: 0.55; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--line2); font-weight: 600; }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td.mono, th.mono { font-family: var(--mono); font-size: 12px; }

  /* Provider cards: the one place a provider gets configured. */
  .prov { padding: 10px 2px; border-bottom: 1px solid var(--line); }
  .prov:last-child { border-bottom: 0; }
  .prov-head { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .prov-head .id { font-family: var(--mono); font-size: 13px; font-weight: 600; }
  .prov-head .name { font-size: 12px; color: var(--muted); }
  .badge { font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.07em; border: 1px solid var(--accent-dim); color: var(--accent); border-radius: 3px; padding: 1px 6px; }
  .prov-key { display: flex; align-items: center; gap: 10px; margin-top: 7px; }
  .prov-key input { flex: 1; min-width: 200px; }
  .prov-key .env { font-family: var(--mono); font-size: 11px; color: var(--muted); min-width: 0; overflow-wrap: anywhere; }

  .search { margin-bottom: 10px; }
  .provider-row { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .provider-row:hover { background: var(--panel2); }
  .provider-row input { width: auto; }
  .provider-row .id { font-family: var(--mono); font-size: 13px; min-width: 150px; }
  .provider-row .meta { font-size: 12px; color: var(--muted); }

  #errors { display: none; background: #2a1813; border: 1px solid var(--bad); color: #e8b7a4; border-radius: 6px; padding: 10px 14px; font-size: 13px; margin-bottom: 16px; white-space: pre-line; }
  #saved { display: none; color: var(--ok); font-size: 13px; font-family: var(--mono); }

  .applybar { position: fixed; bottom: 0; left: 0; right: 0; background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(6px); border-top: 1px solid var(--line); }
  .applybar .inner { max-width: 960px; margin: 0 auto; padding: 12px 20px; display: flex; align-items: center; gap: 14px; }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); font-style: italic; padding: 8px 2px; }
  details summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  details { margin-top: 8px; }
  .warnbox { border: 1px solid var(--warn); background: #241d10; color: #e3c98f; border-radius: 4px; padding: 8px 12px; font-size: 12px; margin-bottom: 10px; }

  /* OpenAI's sign-in button is black with a monochrome mark and wording its
     guidelines fix exactly, so it keeps its own class instead of .btn. */
  .btn-chatgpt { display: inline-flex; align-items: center; gap: 8px; background: #000; color: #fff; border: 1px solid #000; border-radius: 6px; padding: 8px 14px; font-size: 13px; font-family: var(--sans); font-weight: 600; cursor: pointer; }
  .btn-chatgpt:hover { background: #212121; color: #fff; }
  .btn-chatgpt svg { display: block; flex: none; }
  /* Account rows in the ChatGPT plan panel: one line per account, detail muted. */
  .plan-account { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .plan-account:last-child { border-bottom: 0; }
  .plan-account .who { font-family: var(--mono); font-size: 13px; }
</style>
</head>
<body>
<header>
  <div class="bar">
    <span class="wordmark">model<b>hitch</b></span>
    <span class="local-badge">local · 127.0.0.1</span>
    <span class="spacer"></span>
    <span class="linkbar"><a href="/workspace">workspace</a> · <a href="/usage">usage</a> · <a href="/healthz" target="_blank">health</a></span>
  </div>
</header>

<main>
  <div id="errors"></div>
  <div id="saved">Applied.</div>

  <section>
    <div class="section-head"><h2>Workspace</h2><span class="hint">default composer target on /workspace — rotation or a pinned provider/model id</span></div>
    <div class="panel">
      <div class="row" style="border-bottom:0">
        <div class="grow">
          <label>default target</label>
          <select id="workspaceTarget">
            <option value="rotation">rotation</option>
          </select>
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Providers</h2><span class="hint">paste an API key to enable a provider — stored locally in ~/.modelhitch/config.json, masked everywhere else</span></div>
    <div class="panel" id="providers"></div>
  </section>

  <section id="opencode-lanes">
    <div class="section-head"><h2>OpenCode Lanes (Zen &amp; Go)</h2><span class="hint">dual-lane routing for OpenCode Zen (pay-per-use) and OpenCode Go (flat-rate) · auto-wires 4 protocols</span></div>
    <div class="panel">
      <div class="prov-head" style="margin-bottom:8px">
        <span class="dot key-missing" id="opencodeDot"></span>
        <span class="id">opencode / opencode-go</span>
        <span class="name">OpenCode AI (Zen &amp; Go)</span>
        <span class="badge">Zen · /zen/v1</span>
        <span class="badge">Go · /zen/go/v1</span>
      </div>
      <div class="row" style="border-bottom:0">
        <div class="grow" style="min-width:300px">
          <label>OPENCODE_API_KEY (shared across Zen &amp; Go)</label>
          <div class="prov-key" style="margin-top:2px">
            <input type="password" id="opencodeKey" placeholder="(paste OPENCODE_API_KEY to enable)" autocomplete="off" />
            <span class="env">OPENCODE_API_KEY</span>
          </div>
        </div>
      </div>
      <div id="lane-rotation-warn"></div>
      <div class="row">
        <div class="grow">
          <label>Free-only lane</label>
          <div class="num-row">
            <input type="checkbox" id="freeOnlyLane" style="width:auto" />
            <span class="muted" style="font-size:12px">Pin free-only routing: the plan uses only free models (OpenCode Go flat-rate, <code>-free</code> tier on Zen, zero-priced). <code>modelhitch/free</code> can also be selected directly as a model.</span>
          </div>
        </div>
      </div>
      <div class="row" style="border-bottom:0; margin-top:8px">
        <div class="grow">
          <label>Policy Presets</label>
          <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:4px">
            <button class="btn" type="button" id="addZenTrusted">+ Add Zen to Trusted</button>
            <button class="btn" type="button" id="addGoTrusted">+ Add Go to Trusted</button>
            <button class="btn" type="button" id="addZenFallback">+ Add Zen to Fallback</button>
            <button class="btn" type="button" id="addGoFallback">+ Add Go to Fallback</button>
            <button class="btn" type="button" id="setDefaultZen">Set Zen as Default</button>
            <button class="btn" type="button" id="setDefaultGo">Set Go as Default</button>
          </div>
        </div>
      </div>
      <details style="margin-top:14px">
        <summary>Wire routing reference &amp; model family breakdown (auto-detected)</summary>
        <table style="margin-top:8px">
          <thead>
            <tr><th>Family</th><th>Example IDs</th><th>Wire endpoint</th><th>Format</th></tr>
          </thead>
          <tbody>
            <tr><td class="mono">GPT, Grok, Muse Spark</td><td class="mono">gpt-5.5, gpt-5.3-codex, grok-4.7, muse-spark-1.3</td><td class="mono">POST /v1/responses</td><td>OpenAI Responses (Bearer)</td></tr>
            <tr><td class="mono">Claude, Qwen</td><td class="mono">claude-sonnet-4-6, claude-opus-4-6, qwen3.7-max</td><td class="mono">POST /v1/messages</td><td>Anthropic Messages (Bearer)</td></tr>
            <tr><td class="mono">Gemini</td><td class="mono">gemini-3-flash, gemini-3.7-flash</td><td class="mono">POST /v1/models/&lt;id&gt;:generateContent</td><td>Google AI (x-goog-api-key)</td></tr>
            <tr><td class="mono">DeepSeek, GLM, Kimi, MiniMax, free</td><td class="mono">deepseek-v4-pro, glm-5.1, kimi-k2.6, big-pickle</td><td class="mono">POST /v1/chat/completions</td><td>OpenAI Chat (Bearer)</td></tr>
          </tbody>
        </table>
        <div class="muted" style="font-size:12px; margin-top:6px">Selecting <span class="mono">modelhitch/free</span> as a model routes through the free lanes only — check <b>Free-only lane</b> above to pin it as the default plan.</div>
      </details>
    </div>
  </section>

  <section id="opencode-byok">
    <div class="section-head"><h2>OpenCode Console BYOK</h2><span class="hint">one lane per Console connection · rotate across them or pin one</span></div>
    <div class="panel">
      <div class="warnbox">
        Console BYOK links a provider account you already pay for to your OpenCode workspace. Each connection exposes exactly one gateway URL —
        <span class="mono">https://opencode.ai/inference/custom/&lt;connection_id&gt;</span> — and authenticates with a Console service-account key, so the provider secret never reaches this machine.
        Connect providers at <a href="https://opencode.ai/console" target="_blank" rel="noreferrer">opencode.ai/console</a> → Providers, then paste the Console API URL (or the bare <span class="mono">conn_…</span> id) below.
      </div>
      <div class="row">
        <div class="grow">
          <label>enabled</label>
          <select id="byokEnabled"><option value="false">disabled</option><option value="true">enabled</option></select>
        </div>
        <div class="grow">
          <label>mode</label>
          <select id="byokMode">
            <option value="rotation">rotation — spread requests across every connection</option>
            <option value="pinned">pinned — one connection first, others only on failure</option>
          </select>
        </div>
        <div class="grow">
          <label>models from OpenCode</label>
          <select id="byokSync"><option value="false">use the model lists below</option><option value="true">seed empty lists from my OpenCode install</option></select>
        </div>
      </div>
      <div class="row">
        <div class="grow">
          <label>pinned connection</label>
          <select id="byokPin"><option value="">(first enabled connection)</option></select>
        </div>
        <div class="grow">
          <label>pinned model</label>
          <input id="byokPinModel" type="text" placeholder="(connection's first model)" />
        </div>
      </div>
      <div class="row">
        <div class="grow" style="min-width:340px">
          <label>Console service-account key</label>
          <div class="prov-key" style="margin-top:2px">
            <input type="password" id="byokKey" autocomplete="off" placeholder="(blank = reuse the OpenCode key above)" />
            <span class="env">keys.opencode-byok</span>
          </div>
        </div>
      </div>
      <div class="row" style="border-bottom:0">
        <button class="btn" type="button" id="byokImport">Import from OpenCode</button>
        <button class="btn" type="button" id="byokAdd">+ connection</button>
        <span class="muted" id="byok-status"></span>
      </div>
      <div id="byok-connections"></div>
      <div class="muted" style="font-size:12px">
        Each connection is served as its own provider (<span class="mono">opencode-byok-&lt;slug&gt;</span>), so it appears in the policy lanes above,
        in the lane-health table, and in <span class="mono">modelhitch bridge --provider opencode-byok-&lt;slug&gt;</span>.
        Per-connection keys can be pasted on that provider's card in the Providers section.
      </div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Custom lanes</h2><span class="hint">a provider we don't ship — paste an endpoint and key, then type the model slots you want</span></div>
    <div class="panel">
      <div class="row">
        <div class="grow">
          <label>enabled</label>
          <select id="customEnabled">
            <option value="false">disabled</option>
            <option value="true">enabled</option>
          </select>
        </div>
        <div class="grow">
          <label>placement</label>
          <select id="customPlacement">
            <option value="lead">lead — route to these lanes first</option>
            <option value="fallback">fallback — only when the lanes above are depleted</option>
          </select>
        </div>
      </div>
      <div class="row" style="border-bottom:0">
        <button class="btn" type="button" id="customAdd">+ lane</button>
        <span class="muted" id="custom-status"></span>
      </div>
      <div id="custom-lanes"></div>
      <div class="muted" style="font-size:12px">
        Each lane is served as its own provider (<span class="mono">custom-&lt;slug&gt;</span>) with its own lane health, so it works in the policy lanes,
        in <span class="mono">modelhitch bridge --provider custom-&lt;slug&gt;</span>, and in the lane-health table.
        The model slots you type are the whole catalog: ModelHitch never calls <span class="mono">GET /models</span> on a custom lane.
        <span class="mono">on limit: stop</span> makes the lane terminal — a rate limit or an empty account surfaces to the caller
        instead of spending another provider, and it keeps stopping while the lane is parked.
      </div>
    </div>
  </section>

  <section id="chatgpt-plan">
    <div class="section-head"><h2>ChatGPT plan</h2><span class="hint">spend your own ChatGPT plan on eligible requests · separate from this app's own charges</span></div>
    <div class="panel">
      <div class="warnbox">
        Eligible requests in this app can spend your ChatGPT plan instead of an API key: sign in once with ChatGPT and the plan pays for those requests.
        This is separate from this app's own charges — the plan is your OpenAI subscription, not credit bought here, and nothing about it is billed through this machine.
        The browser does the sign-in, and the issued tokens land in a protected file beside your config; they are never written into this settings document.
      </div>
      <div class="row">
        <div class="grow">
          <label>account</label>
          <div id="chatgpt-account"><div class="muted">reading the ChatGPT plan state…</div></div>
        </div>
        <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer noopener">Manage usage</a>
      </div>
      <div id="chatgpt-plan-accounts"></div>
      <div class="row">
        <div class="grow">
          <label>enabled</label>
          <select id="chatgptPlanEnabled">
            <option value="false">disabled</option>
            <option value="true">enabled</option>
          </select>
        </div>
        <div class="grow">
          <label>mode</label>
          <select id="chatgptPlanMode">
            <option value="rotation">rotation — spread requests across the model slots</option>
            <option value="pinned">pinned — one model first, the rest directly behind it</option>
          </select>
        </div>
        <div class="grow">
          <label>placement</label>
          <select id="chatgptPlanPlacement">
            <option value="lead">lead — spend the plan first</option>
            <option value="fallback">fallback — only when the lanes above are depleted</option>
          </select>
        </div>
        <div class="grow">
          <label>on limit</label>
          <select id="chatgptPlanOnLimit">
            <option value="rotate">rotate — fail over to the next lane</option>
            <option value="stop">stop — surface the limit, spend nothing else</option>
          </select>
        </div>
      </div>
      <div class="row">
        <div class="grow">
          <label>account for this lane</label>
          <select id="chatgptPlanAccount"><option value="">(the active account)</option></select>
        </div>
        <div class="grow">
          <label>pinned model</label>
          <select id="chatgptPlanPinnedModel"><option value="">(the first model slot)</option></select>
        </div>
      </div>
      <div class="row" style="border-bottom:0">
        <button class="btn" type="button" id="chatgptPlanLoadModels">Load models from account</button>
        <span class="muted" id="chatgpt-plan-status"></span>
      </div>
      <div class="row">
        <div class="grow" style="min-width:340px">
          <label>model slots</label>
          <div id="chatgpt-plan-models"></div>
        </div>
      </div>
      <div class="muted" style="font-size:12px">
        <span class="mono">rotation</span> spreads requests across the model slots above, <span class="mono">pinned</span> makes one of them the main route with the rest directly behind it.
        <span class="mono">lead</span> spends the plan first, before every other lane; <span class="mono">fallback</span> keeps it behind them.
        <span class="mono">on limit: stop</span> makes a spent plan surface to the caller instead of silently spending another provider.
        Slugs come from the signed-in account — ModelHitch never guesses a ChatGPT plan model.
      </div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Image lane</h2><span class="hint">disabled by default; opt in when you want a dedicated image-generation route</span></div>
    <div class="panel">
      <div class="row" style="border-bottom:0">
        <div class="grow">
          <label>enabled</label>
          <select id="imageEnabled">
            <option value="false">disabled</option>
            <option value="true">enabled</option>
          </select>
        </div>
        <div class="grow">
          <label>provider</label>
          <select id="imageProvider">
            <option value="openai">OpenAI</option>
            <option value="gemini">Google Gemini</option>
          </select>
        </div>
        <div class="grow">
          <label>model</label>
          <select id="imageModel">
            <option value="gpt-image-2">gpt-image-2</option>
            <option value="gpt-image-1.5">gpt-image-1.5</option>
          </select>
        </div>
      </div>
      <div class="row" style="border-bottom:0">
        <div class="grow">
          <label>quality</label>
          <select id="imageQuality">
            <option value="low">low</option>
            <option value="medium">medium</option>
          </select>
        </div>
        <div class="grow">
          <label>size</label>
          <input id="imageSize" type="text" placeholder="1024x1024" />
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Cloud Agent lane</h2><span class="hint">disabled by default; explicit cursor-cloud/&lt;model&gt; routes only — bills Cursor usage</span></div>
    <div class="panel">
      <div class="warnbox">Requires CURSOR_API_KEY (stored as keys.cursor-cloud). Service-account keys: set CURSOR_API_KEY in the environment only.</div>
      <div class="row" style="border-bottom:0">
        <div class="grow">
          <label>enabled</label>
          <select id="cloudEnabled">
            <option value="false">disabled</option>
            <option value="true">enabled</option>
          </select>
        </div>
        <div class="grow">
          <label>default model</label>
          <input id="cloudModel" type="text" placeholder="composer-2.5" />
        </div>
      </div>
      <div class="row" style="border-bottom:0">
        <div class="grow">
          <label>repository url</label>
          <input id="cloudRepoUrl" type="text" placeholder="https://github.com/org/repo" />
        </div>
        <div class="grow">
          <label>starting ref</label>
          <input id="cloudRepoRef" type="text" placeholder="main" />
        </div>
      </div>
      <div class="row" style="border-bottom:0">
        <div class="grow">
          <label>CURSOR_API_KEY</label>
          <input id="cloudApiKey" type="password" autocomplete="off" placeholder="(stored as keys.cursor-cloud)" />
        </div>
      </div>
      <div class="row" style="border-bottom:0; margin-top:10px">
        <div class="grow">
          <label>running agents</label>
          <div id="cloud-agents-list" class="empty">Loading…</div>
        </div>
      </div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Policy</h2><span class="hint">trusted lanes first, fallback lanes after — the lane is the trust object</span></div>
    <div class="panel lane-list">
      <div class="lbl">trusted</div>
      <div id="trusted-lanes"></div>
      <button class="btn add-lane" data-into="trusted-lanes">+ trusted lane</button>
      <div class="lbl" style="margin-top:14px">fallback</div>
      <div id="fallback-lanes"></div>
      <button class="btn add-lane" data-into="fallback-lanes">+ fallback lane</button>
      <div class="row" style="margin-top:12px; border-bottom:0">
        <div class="num-row"><label>max providers</label><input id="maxProviders" type="number" min="1" placeholder="none" /></div>
        <div class="num-row"><label>backoff</label><select id="backoffType"><option value="none">instant (default)</option><option value="fixed">fixed</option><option value="exponential">exponential</option></select></div>
        <div class="num-row"><label>base ms</label><input id="backoffBase" type="number" min="0" value="1000" /></div>
        <div class="num-row"><label>cap ms</label><input id="backoffMax" type="number" min="0" placeholder="none" /></div>
      </div>
      <div class="row" style="border-bottom:0">
        <div class="num-row"><label>default provider</label><select id="defaultProviderId"></select></div>
        <div class="num-row"><label>default model</label><input id="defaultModel" type="text" placeholder="(provider default)" /></div>
      </div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Intents</h2><span class="hint">one plan per kind of work — a request routes through the profile its shape selects</span></div>
    <div class="panel">
      <div class="row">
        <div class="num-row"><label>infer from the request</label><select id="intentsInfer"><option value="true">on (default)</option><option value="false">off — always the policy above</option></select></div>
      </div>
      <div id="intent-profiles"></div>
      <div class="no-models-hint">A profile with no lanes is not a plan, so it stays absent and falls back to the policy above. <b>coding</b> needs a tool loop already in flight; <b>bulk</b> needs a one-shot, short request with an explicit small output cap — anything less specific stays on the policy.</div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Reliability</h2><span class="hint">how lanes remember failure</span></div>
    <div class="panel">
      <div class="row">
        <div class="grow">
          <label>lane health engine</label>
          <select id="cooldownType">
            <option value="circuit-breaker">circuit breaker (thresholds + escalation, catalog default)</option>
            <option value="memory">memory cooldown (cool on failure, Retry-After aware)</option>
            <option value="none">none (instant failover, no memory)</option>
          </select>
        </div>
        <div class="num-row"><label>failure threshold</label><input id="cdThreshold" type="number" min="1" value="3" /></div>
        <div class="num-row"><label>base trip ms</label><input id="cdBase" type="number" min="0" value="15000" /></div>
        <div class="num-row"><label>cap ms</label><input id="cdMax" type="number" min="0" value="120000" /></div>
      </div>
      <div class="row" style="border-bottom:0"><span class="muted">A 429 always trips immediately, honoring the provider's Retry-After. 5xx/network failures trip after the threshold.</span></div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Service keys</h2><span class="hint">minting &amp; rotation are CLI-only</span></div>
    <div class="panel">
      <table>
        <thead><tr><th>id</th><th>plan</th><th>limits (rolling 24h)</th><th>status</th></tr></thead>
        <tbody id="service-key-rows"><tr><td colspan="4" class="empty">no service keys — unauthenticated</td></tr></tbody>
      </table>
      <div class="row" style="border-bottom:0"><span class="muted">Mint on the CLI: <span class="mono">modelhitch key new --plan free --id free-starter --daily-requests 500</span> — the key material prints once; only its hash is stored. From the first key on, every inference route requires one. Roll with <span class="mono">modelhitch key rotate &lt;id&gt;</span> / revoke with <span class="mono">modelhitch key revoke &lt;id&gt;</span>. This panel is read-only — key material never round-trips through the page.</span></div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Lane health</h2><span class="hint">live circuit state — refreshed every 5s</span></div>
    <div class="panel">
      <table>
        <thead><tr><th>lane</th><th>state</th><th>consecutive failures</th><th>trips</th><th>remaining</th></tr></thead>
        <tbody id="health-body"><tr><td colspan="5" class="empty">no lanes have failed yet</td></tr></tbody>
      </table>
    </div>
  </section>

  <details>
    <summary>advanced — models.dev catalog mode</summary>
    <div class="warnbox">The bridge normally serves its built-in registry (the providers above). Checking boxes here switches provider resolution to the live models.dev catalog on Apply — different inventory, different defaults. Leave everything unchecked to stay on the built-in registry.</div>
    <div class="panel">
      <input id="provider-search" type="text" placeholder="search catalog providers…" class="search" />
      <div id="provider-list"></div>
    </div>
  </details>
</main>

<div class="applybar"><div class="inner">
  <button class="btn primary" id="apply">Apply</button>
  <button class="btn" id="reload">Discard &amp; reload</button>
  <span class="muted" id="apply-hint">applies immediately — in-flight requests finish on the old config</span>
</div></div>

<script>
"use strict";
var state = { config: null, catalog: [], builtin: [] };

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }

async function api(path, opts) {
  var res = await fetch(path, opts);
  var body = await res.json().catch(function () { return {}; });
  if (!res.ok) { throw new Error((body && body.error && body.error.message) || ('HTTP ' + res.status)); }
  return body;
}

function showErrors(errs) {
  var box = el('errors');
  if (errs && errs.length) { box.style.display = 'block'; box.textContent = errs.join('\n'); }
  else { box.style.display = 'none'; }
}

function flashSaved() {
  var s = el('saved'); s.style.display = 'inline'; setTimeout(function () { s.style.display = 'none'; }, 2200);
}

// ---- providers -----------------------------------------------------------

function callableProviders() {
  return (state.catalog || []).filter(function (p) { return p && p.callable !== false; });
}

/* Provider ids the policy can reference: everything callable, sorted, with
   already-configured ones first so the important rows are on top. */
function knownProviderIds() {
  var cfg = state.config || {};
  var used = {};
  (cfg.policy ? cfg.policy.trusted.concat(cfg.policy.fallback) : []).forEach(function (l) {
    if (l && l.providerId) used[l.providerId] = true;
  });
  if (cfg.defaultProviderId) used[cfg.defaultProviderId] = true;
  if (cfg.keys) Object.keys(cfg.keys).forEach(function (k) { used[k] = true; });
  return callableProviders()
    .map(function (p) { return p.id; })
    .sort(function (a, b) {
      var ua = used[a] ? 0 : 1, ub = used[b] ? 0 : 1;
      return ua !== ub ? ua - ub : (a < b ? -1 : a > b ? 1 : 0);
    });
}

function providerMeta(id) {
  return (state.catalog || []).find(function (p) { return p.id === id; }) || { id: id };
}

function usageBadges(id) {
  var cfg = state.config || {};
  var pol = cfg.policy || { trusted: [], fallback: [] };
  var bits = [];
  if (pol.trusted.some(function (l) { return l.providerId === id; })) bits.push('trusted');
  if (pol.fallback.some(function (l) { return l.providerId === id; })) bits.push('fallback');
  if ((cfg.defaultProviderId || '') === id) bits.push('default');
  return bits;
}

function workspaceTargetValue(model) {
  var id = model && model.id ? String(model.id) : '';
  if (!id) return '';
  if (id.indexOf('/') > 0) return id;
  return model.owned_by ? model.owned_by + '/' + id : id;
}

function renderWorkspaceTarget() {
  var cfg = state.config || {};
  var selected = cfg.defaultWorkspaceTarget || 'rotation';
  var sel = el('workspaceTarget');
  var opts = ['<option value="rotation">rotation</option>'];
  (state.models || []).forEach(function (m) {
    // "rotation" is the option that means the whole plan; the catalog's auto
    // id is that same request, so it is not a second choice here.
    if (m && m.modelhitch && m.modelhitch.kind === 'auto') return;
    var val = workspaceTargetValue(m);
    opts.push('<option value="' + esc(val) + '"' + (val === selected ? ' selected' : '') + '>' + esc(val) + '</option>');
  });
  sel.innerHTML = opts.join('');
  if (selected && selected !== 'rotation') sel.value = selected;
}

function renderProviders() {
  var cfg = state.config || {};
  var keys = cfg.keys || {};
  var box = el('providers');
  box.innerHTML = '';
  callableProviders().forEach(function (p) {
    var id = p.id;
    var hasKey = !!keys[id];
    var badges = usageBadges(id);
    var card = document.createElement('div');
    card.className = 'prov';
    var head = '<div class="prov-head">' +
      '<span class="dot ' + (hasKey ? 'key-set' : 'key-missing') + '" title="' + (hasKey ? 'API key stored locally' : 'no API key yet') + '"></span>' +
      '<span class="id">' + esc(id) + '</span>' +
      '<span class="name">' + esc(p.name || '') + '</span>' +
      badges.map(function (b) { return '<span class="badge">' + esc(b) + '</span>'; }).join('') +
      '</div>';
    var envHint = (p.env && p.env[0]) || '';
    var keyRow = '<div class="prov-key">' +
      '<input type="password" class="key-input" data-provider="' + esc(id) + '" autocomplete="off" ' +
      'placeholder="' + (hasKey ? '(set — leave blank to keep)' : '(no key — paste to enable)') + '" />' +
      (envHint ? '<span class="env">' + esc(envHint) + '</span>' : '') +
      '</div>';
    card.innerHTML = head + keyRow;
    box.appendChild(card);
  });
  if (!box.children.length) box.innerHTML = '<div class="empty">no callable providers reported by the bridge</div>';
}

function collectKeys() {
  var keys = {};
  var existing = (state.config && state.config.keys) || {};
  document.querySelectorAll('.key-input').forEach(function (input) {
    var providerId = input.dataset.provider;
    var val = input.value.trim();
    if (val) keys[providerId] = val;
    else if (existing[providerId]) keys[providerId] = existing[providerId]; // preserve untouched masked keys
  });
  collectCloudAgentKey(keys);
  collectOpenCodeKey(keys);
  collectOpenCodeByokKey(keys);
  collectCustomLaneKeys(keys);
  return keys;
}

function renderOpenCode() {
  var cfg = state.config || {};
  var keys = cfg.keys || {};
  var hasKey = !!(keys['opencode'] || keys['opencode-go']);
  var dot = el('opencodeDot');
  if (dot) {
    dot.className = 'dot ' + (hasKey ? 'key-set' : 'key-missing');
    dot.title = hasKey ? 'OpenCode API key stored locally' : 'No OpenCode API key yet';
  }
  var input = el('opencodeKey');
  if (input) {
    input.placeholder = hasKey ? '(set — leave blank to keep)' : '(paste OPENCODE_API_KEY to enable)';
  }
}

function collectOpenCodeKey(keys) {
  var input = el('opencodeKey');
  if (!input) return;
  var val = input.value.trim();
  var existing = (state.config && state.config.keys) || {};
  if (val) {
    keys['opencode'] = val;
    keys['opencode-go'] = val;
  } else {
    if (existing['opencode']) keys['opencode'] = existing['opencode'];
    if (existing['opencode-go']) keys['opencode-go'] = existing['opencode-go'];
  }
}

// ---- OpenCode Console BYOK ----------------------------------------------

var BYOK_SCHEMAS = ['auto', 'chat-completions', 'responses', 'anthropic', 'google'];

/* Console service-account key shared by every BYOK connection. A blank field
   keeps whatever is stored; the OpenCode Zen/Go key is the fallback when this
   one is unset, which is why the placeholder says so. */
function collectOpenCodeByokKey(keys) {
  var input = el('byokKey');
  if (!input) return;
  var val = input.value.trim();
  var existing = (state.config && state.config.keys) || {};
  if (val) keys['opencode-byok'] = val;
  else if (existing['opencode-byok']) keys['opencode-byok'] = existing['opencode-byok'];
}

function byokState() {
  return state.openCode && state.openCode.found ? state.openCode : null;
}

/* Models the user actually runs in OpenCode across every provider — the model
   picker for a BYOK connection. Console mints connection ids no local file
   records, so the provider names are the only useful join key offline. */
function allDiscoveredModels() {
  var oc = byokState();
  var out = [];
  if (!oc) return out;
  (oc.providers || []).forEach(function (p) {
    (p.models || []).forEach(function (m) { if (out.indexOf(m) === -1) out.push(m); });
  });
  return out;
}

function byokConnectionId(row) {
  var input = row.querySelector('.byok-id');
  return input ? input.value.trim() : '';
}

function byokConnectionRowHtml(connection) {
  var id = connection && connection.id ? connection.id : '';
  var label = connection && connection.label ? connection.label : '';
  var baseUrl = connection && connection.baseUrl ? connection.baseUrl : '';
  var schema = (connection && connection.schema) || 'auto';
  var enabled = !connection || connection.enabled !== false;
  var models = (connection && connection.models) || [];
  var schemaOptions = BYOK_SCHEMAS.map(function (s) {
    return '<option value="' + s + '"' + (s === schema ? ' selected' : '') + '>' + s + '</option>';
  }).join('');
  var chips = models.map(modelChipHtml).join('');
  var known = allDiscoveredModels().filter(function (m) { return models.indexOf(m) === -1; });
  var addOptions = '<option value="">' + (known.length ? '+ model from OpenCode…' : '(no OpenCode models detected)') + '</option>' +
    known.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('');
  return '<div class="byok-conn lane">' +
      '<div>' +
        '<label>connection id or URL</label>' +
        '<input class="byok-id" type="text" placeholder="conn_… or https://opencode.ai/inference/custom/conn_…" value="' + esc(id) + '" />' +
        '<label style="margin-top:6px">label</label>' +
        '<input class="byok-label" type="text" placeholder="(optional)" value="' + esc(label) + '" />' +
        '<label style="margin-top:6px">gateway URL override</label>' +
        '<input class="byok-url" type="text" placeholder="(optional)" value="' + esc(baseUrl) + '" />' +
      '</div>' +
      '<div class="lane-models byok-models">' +
        '<label>models — the rotation pool</label>' +
        '<div class="chips">' + chips + '</div>' +
        '<div class="model-add-row">' +
          '<select class="model-add">' + addOptions + '</select>' +
          '<input type="text" class="model-add-custom" placeholder="or type a model id + Enter" />' +
        '</div>' +
        '<div class="no-models-hint">empty = the connection\'s default model (or the OpenCode models above when syncing)</div>' +
      '</div>' +
      '<div>' +
        '<label>schema</label>' +
        '<select class="byok-schema">' + schemaOptions + '</select>' +
        '<label style="margin-top:6px">enabled</label>' +
        '<select class="byok-enabled"><option value="true"' + (enabled ? ' selected' : '') + '>yes</option><option value="false"' + (enabled ? '' : ' selected') + '>no</option></select>' +
        '<button class="btn danger byok-remove" type="button" style="margin-top:6px">remove</button>' +
      '</div>' +
    '</div>';
}

function renderOpenCodeByok() {
  var cfg = state.config || {};
  var byok = cfg.opencodeByok || { enabled: false, mode: 'rotation', connections: [] };
  var box = el('byok-connections');
  if (!box) return;
  el('byokEnabled').value = String(!!byok.enabled);
  el('byokMode').value = byok.mode === 'pinned' ? 'pinned' : 'rotation';
  el('byokSync').value = String(byok.syncFromOpenCode === true);

  var connections = byok.connections || [];
  box.innerHTML = connections.length
    ? connections.map(byokConnectionRowHtml).join('')
    : '<div class="empty">no BYOK connections yet — add one, or import the providers you already use in OpenCode</div>';

  renderByokPinOptions();
  el('byokPin').value = byok.pinnedConnectionId || '';
  el('byokPinModel').value = byok.pinnedModel || '';
  var isPinned = byok.mode === 'pinned';
  el('byokPin').disabled = !isPinned;
  el('byokPinModel').disabled = !isPinned;

  var hasKey = !!(cfg.keys && cfg.keys['opencode-byok']);
  var input = el('byokKey');
  input.value = '';
  input.placeholder = hasKey ? '(set — leave blank to keep)' : '(blank = reuse the OpenCode key above)';

  var status = el('byok-status');
  var oc = state.openCode;
  if (status) {
    status.textContent = oc
      ? (oc.found
          ? 'OpenCode: ' + (oc.providers || []).length + ' provider(s) detected' + (oc.warnings && oc.warnings.length ? ' (' + oc.warnings.length + ' warning' + (oc.warnings.length === 1 ? '' : 's') + ')' : '')
          : 'OpenCode: no local install found')
      : '';
  }
}

function renderByokPinOptions() {
  var select = el('byokPin');
  if (!select) return;
  var selected = select.value;
  var rows = document.querySelectorAll('#byok-connections .byok-conn');
  var opts = ['<option value="">(first enabled connection)</option>'];
  Array.prototype.forEach.call(rows, function (row) {
    var id = byokConnectionId(row);
    if (!id) return;
    opts.push('<option value="' + esc(id) + '">' + esc(id) + '</option>');
  });
  select.innerHTML = opts.join('');
  if (selected) select.value = selected;
}

function collectOpenCodeByok() {
  var connections = [];
  document.querySelectorAll('#byok-connections .byok-conn').forEach(function (row) {
    var id = byokConnectionId(row);
    if (!id) return;
    var label = row.querySelector('.byok-label').value.trim();
    var url = row.querySelector('.byok-url').value.trim();
    var models = Array.prototype.map.call(row.querySelectorAll('.lane-models .chips .chip'), function (c) { return c.dataset.model; });
    var entry = {
      id: id,
      schema: row.querySelector('.byok-schema').value || 'auto',
      enabled: row.querySelector('.byok-enabled').value === 'true'
    };
    if (label) entry.label = label;
    if (url) entry.baseUrl = url;
    if (models.length) entry.models = models;
    connections.push(entry);
  });
  var pinnedConnectionId = el('byokPin').value.trim();
  var pinnedModel = el('byokPinModel').value.trim();
  var byok = {
    enabled: el('byokEnabled').value === 'true',
    mode: el('byokMode').value === 'pinned' ? 'pinned' : 'rotation',
    connections: connections,
    syncFromOpenCode: el('byokSync').value === 'true'
  };
  if (pinnedConnectionId) byok.pinnedConnectionId = pinnedConnectionId;
  if (pinnedModel) byok.pinnedModel = pinnedModel;
  return byok;
}

function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/^conn[_-]/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* Seed connection rows from the local OpenCode install. Console mints opaque
   connection ids that no local file records, so the provider name is used as
   the id — labelled so it is obvious it still has to be replaced. */
async function importFromOpenCode() {
  var status = el('byok-status');
  if (status) status.textContent = 'Reading the local OpenCode install…';
  try {
    state.openCode = await api('/v1/opencode-state');
  } catch (err) {
    if (status) status.textContent = 'OpenCode import unavailable: ' + err.message;
    return;
  }
  var found = (state.openCode.providers || []).filter(function (p) { return (p.models || []).length > 0; });
  if (!found.length) {
    if (status) status.textContent = 'OpenCode: nothing to import (no provider with model history found)';
    renderOpenCodeByok();
    return;
  }
  var box = el('byok-connections');
  var existing = {};
  Array.prototype.forEach.call(box.querySelectorAll('.byok-conn'), function (row) { existing[slugify(byokConnectionId(row))] = true; });
  var empty = box.querySelector('.empty');
  if (empty) empty.remove();
  var added = 0;
  found.forEach(function (provider) {
    if (existing[slugify(provider.providerId)]) return;
    box.insertAdjacentHTML('beforeend', byokConnectionRowHtml({
      id: provider.providerId,
      label: provider.providerId + ' (from OpenCode)',
      schema: 'auto',
      models: provider.models,
      enabled: true
    }));
    added++;
  });
  el('byokEnabled').value = 'true';
  renderByokPinOptions();
  if (status) {
    status.textContent = 'Imported ' + added + ' connection' + (added === 1 ? '' : 's') +
      ' from OpenCode — replace each id with its Console connection id, then Apply.';
  }
}

// ---- custom BYOK lanes ---------------------------------------------------

/* Same slug rules as the bridge (providers/custom-lane.ts): the lane id becomes
   the provider id, so the two must agree or the key lands on nothing. */
function customSlug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function customProviderId(laneId) {
  return 'custom-' + (customSlug(laneId) || 'lane');
}

/* The env var the bridge falls back to when no key is stored — shown as a hint
   so a user can keep the secret out of the config document entirely. */
function customEnvVar(laneId) {
  var slug = (customSlug(laneId) || 'lane').replace(/-/g, '_').toUpperCase();
  return 'MODELHITCH_CUSTOM_' + slug + '_API_KEY';
}

function customModelsEditorHtml(models) {
  var chosen = models || [];
  return '<div class="lane-models">' +
      '<label>models — the only slots this lane serves</label>' +
      '<div class="chips">' + chosen.map(modelChipHtml).join('') + '</div>' +
      '<div class="model-add-row">' +
        '<select class="model-add"><option value="">(type the model id)</option></select>' +
        '<input type="text" class="model-add-custom" placeholder="type a model id + Enter" />' +
      '</div>' +
      '<div class="no-models-hint">typed by hand — a custom lane is never polled for its model list</div>' +
    '</div>';
}

function customCapabilityValue(caps) {
  caps = caps || {};
  if (caps.toolCalling === false && caps.vision === false) return 'text';
  if (caps.vision === false) return 'tools';
  return 'both';
}

function customLaneRowHtml(lane) {
  var id = lane && lane.id ? lane.id : '';
  var label = lane && lane.label ? lane.label : '';
  var url = lane && lane.baseUrl ? lane.baseUrl : '';
  var schema = (lane && lane.schema) || 'auto';
  var onLimit = (lane && lane.onLimit) === 'stop' ? 'stop' : 'rotate';
  var caps = customCapabilityValue(lane && lane.capabilities);
  var enabled = !lane || lane.enabled !== false;
  var models = (lane && lane.models) || [];
  var schemaOptions = BYOK_SCHEMAS.map(function (s) {
    return '<option value="' + s + '"' + (s === schema ? ' selected' : '') + '>' + s + '</option>';
  }).join('');
  var stored = ((state.config && state.config.keys) || {})[customProviderId(id)];
  return '<div class="custom-lane lane">' +
      '<div>' +
        '<label>lane id</label>' +
        '<input class="custom-id" type="text" placeholder="my-provider" value="' + esc(id) + '" />' +
        '<label style="margin-top:6px">label</label>' +
        '<input class="custom-label" type="text" placeholder="(optional)" value="' + esc(label) + '" />' +
        '<label style="margin-top:6px">base URL</label>' +
        '<input class="custom-url" type="text" placeholder="https://api.example.com/v1" value="' + esc(url) + '" />' +
      '</div>' +
      customModelsEditorHtml(models) +
      '<div>' +
        '<label>schema</label>' +
        '<select class="custom-schema">' + schemaOptions + '</select>' +
        '<label style="margin-top:6px">on limit</label>' +
        '<select class="custom-onlimit">' +
          '<option value="rotate"' + (onLimit === 'rotate' ? ' selected' : '') + '>rotate — fail over to the next lane</option>' +
          '<option value="stop"' + (onLimit === 'stop' ? ' selected' : '') + '>stop — surface the limit, spend nothing else</option>' +
        '</select>' +
        '<label style="margin-top:6px">capabilities</label>' +
        '<select class="custom-caps">' +
          '<option value="both"' + (caps === 'both' ? ' selected' : '') + '>tools + vision</option>' +
          '<option value="tools"' + (caps === 'tools' ? ' selected' : '') + '>tools only</option>' +
          '<option value="text"' + (caps === 'text' ? ' selected' : '') + '>text only</option>' +
        '</select>' +
      '</div>' +
      '<div>' +
        '<label>API key</label>' +
        '<input class="custom-key" type="password" autocomplete="off" placeholder="' +
          (stored ? '(set — leave blank to keep)' : (id ? 'paste the key' : 'set the lane id first')) + '" />' +
        '<div class="no-models-hint mono" id="custom-env-' + esc(customSlug(id)) + '">' + esc(id ? customEnvVar(id) : 'env fallback: MODELHITCH_CUSTOM_&lt;ID&gt;_API_KEY') + '</div>' +
        '<label style="margin-top:6px">enabled</label>' +
        '<select class="custom-enabled"><option value="true"' + (enabled ? ' selected' : '') + '>yes</option><option value="false"' + (enabled ? '' : ' selected') + '>no</option></select>' +
        '<button class="btn danger custom-remove" type="button" style="margin-top:6px">remove</button>' +
      '</div>' +
    '</div>';
}

function renderCustomLanes() {
  var cfg = state.config || {};
  var custom = cfg.customLanes || { enabled: false, placement: 'lead', lanes: [] };
  var box = el('custom-lanes');
  if (!box) return;
  el('customEnabled').value = String(!!custom.enabled);
  el('customPlacement').value = custom.placement === 'fallback' ? 'fallback' : 'lead';
  var lanes = custom.lanes || [];
  box.innerHTML = lanes.length
    ? lanes.map(customLaneRowHtml).join('')
    : '<div class="empty">no custom lanes yet — add one when your provider is not in the list above</div>';
  var status = el('custom-status');
  if (status) {
    status.textContent = lanes.length
      ? lanes.length + ' lane' + (lanes.length === 1 ? '' : 's') + ' configured'
      : '';
  }
}

/* Keys for the custom lanes live under their provider id, beside every other
   provider key — the bridge reads the same map. */
function collectCustomLaneKeys(keys) {
  var existing = (state.config && state.config.keys) || {};
  document.querySelectorAll('#custom-lanes .custom-lane').forEach(function (row) {
    var id = row.querySelector('.custom-id').value.trim();
    if (!id) return;
    var providerId = customProviderId(id);
    var input = row.querySelector('.custom-key');
    var val = input ? input.value.trim() : '';
    if (val) keys[providerId] = val;
    else if (existing[providerId]) keys[providerId] = existing[providerId];
  });
}

/* capability preset -> the honest claims the lane advertises. "tools + vision"
   is the engine default, so it is left implicit. */
function customCapabilities(value) {
  if (value === 'text') return { toolCalling: false, vision: false };
  if (value === 'tools') return { vision: false };
  return undefined;
}

function collectCustomLanes() {
  var lanes = [];
  document.querySelectorAll('#custom-lanes .custom-lane').forEach(function (row) {
    var id = row.querySelector('.custom-id').value.trim();
    if (!id) return;
    var url = row.querySelector('.custom-url').value.trim();
    var label = row.querySelector('.custom-label').value.trim();
    var models = Array.prototype.map.call(row.querySelectorAll('.lane-models .chips .chip'), function (c) { return c.dataset.model; });
    var entry = {
      id: id,
      // Incomplete lanes are kept rather than dropped: the bridge validates the
      // document and names the missing field, which beats losing what was typed.
      baseUrl: url,
      models: models,
      schema: row.querySelector('.custom-schema').value || 'auto',
      onLimit: row.querySelector('.custom-onlimit').value === 'stop' ? 'stop' : 'rotate',
      enabled: row.querySelector('.custom-enabled').value === 'true'
    };
    var caps = customCapabilities(row.querySelector('.custom-caps').value);
    if (label) entry.label = label;
    if (caps) entry.capabilities = caps;
    lanes.push(entry);
  });
  return {
    enabled: el('customEnabled').value === 'true',
    placement: el('customPlacement').value === 'fallback' ? 'fallback' : 'lead',
    lanes: lanes
  };
}

// ---- Sign in with ChatGPT ------------------------------------------------

/* The account panel is live server state rather than config: the bridge knows
   who is signed in, what the grant covers, and whether a browser hand-off is in
   flight. Sign-in finishes on OpenAI's own loopback redirect (not this bridge),
   so the page can only poll for it — never await it. */

var chatgptPlanUnavailable = false;

/* OpenAI's own mark. Inline because the page loads nothing from the network. */
var CHATGPT_MARK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>';

/* A separate helper from api() because a 501 carrying error.code
   "not_implemented" is not a failure here: it means this bridge was built
   without the lane, and the section says so instead of printing HTTP codes. */
async function chatgptPlanApi(path, opts) {
  var res = await fetch(path, opts);
  var body = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    var err = new Error((body && body.error && body.error.message) || ('HTTP ' + res.status));
    err.code = body && body.error ? body.error.code : '';
    throw err;
  }
  return body;
}

function chatgptPlanUnsupported(err) {
  return !!(err && err.code === 'not_implemented');
}

function chatgptPlanClock(value) {
  var at = new Date(value);
  return isNaN(at.getTime()) ? String(value) : at.toLocaleString();
}

/* Token expiry, said the way it matters: a refreshable account renews itself,
   one without a refresh token needs a human before the token lapses. */
function chatgptPlanTokenText(account) {
  if (!account.expiresAt) return 'no token expiry recorded';
  if (account.expired) {
    return 'access token expired ' + chatgptPlanClock(account.expiresAt) +
      (account.refreshable ? ' — renewed on the next request' : ' — sign in again');
  }
  return 'access token valid until ' + chatgptPlanClock(account.expiresAt) +
    (account.refreshable ? '' : ' — no refresh token, so sign in again before then');
}

/* OpenAI's guidelines fix this wording and the mark; the button is the only way
   the page asks for plan access, so every entry point uses the same one. */
function chatgptPlanSignInButtonHtml(opts) {
  var kind = opts && opts.forceConsent ? 'plan-force-consent' : 'plan-signin';
  var attrs = opts && opts.accountKey ? ' data-account="' + esc(opts.accountKey) + '"' : '';
  return '<button class="btn-chatgpt ' + kind + '" type="button"' + attrs + '>' + CHATGPT_MARK_SVG + 'Continue with ChatGPT</button>';
}

/* The attempt in flight: the status object names it, and the attempt itself
   carries the authorization URL the fallback link needs. A terminal attempt
   never renders as pending, so a finished sign-in cannot leave the panel
   waiting on a browser that already came back. */
function chatgptPlanPending(status) {
  var pending = status && status.pendingSignIn;
  var attempt = state.chatgptPlanAttempt;
  if (pending && pending.attemptId && !(attempt && attempt.attemptId === pending.attemptId)) {
    return { attemptId: pending.attemptId, status: 'pending', startedAt: pending.startedAt, expiresAt: pending.expiresAt };
  }
  if (attempt && attempt.status === 'pending' && (!attempt.expiresAt || Date.parse(attempt.expiresAt) > Date.now())) return attempt;
  return null;
}

function renderChatGptPlanAccount(status) {
  var box = el('chatgpt-account');
  if (!box) return;
  if (chatgptPlanUnavailable) {
    box.innerHTML = '<div class="muted">This bridge was built without Sign in with ChatGPT support.</div>';
    return;
  }
  var plan = status || {};
  var account = plan.account || null;
  var accounts = plan.accounts || [];
  var pending = chatgptPlanPending(plan);
  var html = '';

  if (pending) {
    html += '<div class="plan-account">' +
      '<span class="status"><span class="dot half-open"></span>waiting for your browser</span>' +
      '<span class="muted">finish the sign-in in the tab that just opened — this panel updates on its own.</span>' +
      '<button class="btn plan-cancel" type="button" data-attempt="' + esc(pending.attemptId) + '">cancel</button>' +
      '</div>';
    html += pending.authUrl
      ? '<div class="muted" style="font-size:12px">browser did not open? ' +
        '<a href="' + esc(pending.authUrl) + '" target="_blank" rel="noreferrer noopener">open the sign-in page</a>' +
        (pending.expiresAt ? ' — that link stops working at ' + esc(chatgptPlanClock(pending.expiresAt)) : '') + '</div>'
      : '<div class="muted" style="font-size:12px">reading the authorization URL from the bridge…</div>';
    box.innerHTML = html;
    return;
  }

  if (account) {
    html += '<div class="plan-account">' +
      '<span class="dot key-set"></span>' +
      '<span class="who">' + esc(account.label || account.key) + '</span>' +
      (account.key === plan.activeAccountKey ? '<span class="badge">active</span>' : '') +
      '<span class="badge"' + (account.planUsage ? '' : ' style="border-color:var(--warn);color:var(--warn)"') + '>' +
        (account.planUsage ? 'plan usage granted' : 'plan usage not granted') + '</span>' +
      '<span class="muted">' + esc(chatgptPlanTokenText(account)) + '</span>' +
      '<button class="btn danger plan-signout" type="button" data-account="' + esc(account.key) + '">sign out</button>' +
      '</div>';
    if (!account.planUsage) {
      // Signed in, but the grant lacks chatgpt.tokens.use.direct: requests will
      // not spend the plan until consent is asked for again.
      html += '<div class="warnbox" style="margin:6px 0 0">This account is signed in, but ChatGPT plan usage was not granted — requests will not spend the plan. ' +
        'Ask for it again and accept the scope set: ' + chatgptPlanSignInButtonHtml({ forceConsent: true }) + '</div>';
    }
    box.innerHTML = html;
    return;
  }

  var saved = accounts[0];
  var failed = state.chatgptPlanAttempt;
  html += '<div class="plan-account">' +
    '<span class="dot key-missing"></span>' +
    '<span class="muted">' + (saved
      ? 'ChatGPT plan usage was not granted for the saved account — sign in again to grant it.'
      : 'No ChatGPT account is connected yet.') + '</span>' +
    '</div>';
  if (failed && failed.status === 'failed' && failed.error) {
    html += '<div class="muted" style="font-size:12px;color:var(--bad)">The last sign-in failed: ' + esc(failed.error) + '</div>';
  }
  html += '<div class="plan-account">' + chatgptPlanSignInButtonHtml(saved ? { accountKey: saved.key } : null) + '</div>';
  box.innerHTML = html;
}

/* Saved accounts, shown whenever the choice matters: more than one is saved, or
   one is saved but no longer signed in and needs a fresh consent. */
function renderChatGptPlanSavedAccounts(status) {
  var box = el('chatgpt-plan-accounts');
  if (!box) return;
  var plan = status || {};
  var accounts = plan.accounts || [];
  if (chatgptPlanUnavailable || (accounts.length < 2 && (plan.signedIn || !accounts.length))) { box.innerHTML = ''; return; }
  box.innerHTML = accounts.map(function (a) {
    var isActive = a.key === plan.activeAccountKey;
    return '<div class="plan-account">' +
      '<span class="dot ' + (a.planUsage ? 'key-set' : 'key-missing') + '"></span>' +
      '<span class="who">' + esc(a.label || a.key) + '</span>' +
      (isActive ? '<span class="badge">active</span>' : '') +
      '<span class="muted">' + esc(a.planUsage ? 'plan usage granted' : 'plan usage not granted') + ' · ' +
        esc(a.expiresAt ? (a.expired ? 'token expired ' : 'token until ') + chatgptPlanClock(a.expiresAt) : 'no token expiry recorded') + '</span>' +
      '<button class="btn plan-activate" type="button" data-account="' + esc(a.key) + '"' + (isActive ? ' disabled' : '') + '>activate</button>' +
      '<button class="btn danger plan-signout" type="button" data-account="' + esc(a.key) + '">sign out</button>' +
      '</div>';
  }).join('');
}

/* Option lists are built from what the bridge last reported, never from config:
   an account key the bridge does not know would route to nothing. */
function renderChatGptPlanAccountOptions(preferred) {
  var sel = el('chatgptPlanAccount');
  if (!sel) return;
  var keep = preferred === undefined ? sel.value : preferred;
  var accounts = ((state.chatgptPlan || {}).accounts) || [];
  var seen = {};
  var opts = ['<option value="">(the active account)</option>'];
  accounts.forEach(function (a) {
    if (!a || !a.key || seen[a.key]) return;
    seen[a.key] = true;
    opts.push('<option value="' + esc(a.key) + '">' + esc(a.label || a.key) + '</option>');
  });
  // A stored key with no matching account stays selectable: the bridge's
  // validator should name it, not have the page drop it on the next Apply.
  if (keep && !seen[keep]) opts.push('<option value="' + esc(keep) + '">' + esc(keep) + ' — not signed in on this bridge</option>');
  sel.innerHTML = opts.join('');
  sel.value = keep || '';
  sel.disabled = !accounts.length && !keep;
}

/* The pin list is the model slots themselves, so it is rebuilt from the chips:
   a slot removed by hand must not stay pinnable. */
function renderChatGptPlanPinned(preferred) {
  var sel = el('chatgptPlanPinnedModel');
  if (!sel) return;
  var keep = preferred === undefined ? sel.value : preferred;
  var chips = document.querySelectorAll('#chatgpt-plan-models .chips .chip');
  var seen = {};
  var opts = ['<option value="">(the first model slot)</option>'];
  Array.prototype.forEach.call(chips, function (c) {
    var id = c.dataset.model;
    if (!id || seen[id]) return;
    seen[id] = true;
    opts.push('<option value="' + esc(id) + '">' + esc(chatgptPlanModelLabel(id)) + '</option>');
  });
  if (keep && !seen[keep]) opts.push('<option value="' + esc(keep) + '">' + esc(keep) + ' — not in the slots</option>');
  sel.innerHTML = opts.join('');
  sel.value = keep || '';
  sel.disabled = el('chatgptPlanMode').value !== 'pinned';
}

function chatgptPlanModelLabel(id) {
  var hit = (state.chatgptPlanModels || []).find(function (m) { return m && m.id === id; });
  return hit && hit.name ? hit.name + ' (' + id + ')' : id;
}

/* Same chip editor as the custom lanes: the account's own catalog is only read
   when asked for, because ModelHitch never guesses a plan model slug. */
function chatgptPlanModelsEditorHtml(models) {
  var chosen = models || [];
  return '<div class="lane-models">' +
      '<div class="chips">' + chosen.map(modelChipHtml).join('') + '</div>' +
      '<div class="model-add-row">' +
        '<select class="model-add"><option value="">(load the account, or type a slug)</option></select>' +
        '<input type="text" class="model-add-custom" placeholder="type a model slug + Enter" />' +
      '</div>' +
      '<div class="no-models-hint">empty = the bridge reads the signed-in account catalog at startup</div>' +
    '</div>';
}

function renderChatGptPlan() {
  var cfg = state.config || {};
  var plan = cfg.chatgptPlan || { enabled: false, mode: 'rotation', placement: 'lead', onLimit: 'rotate', models: [] };
  el('chatgptPlanEnabled').value = String(!!plan.enabled);
  el('chatgptPlanMode').value = plan.mode === 'pinned' ? 'pinned' : 'rotation';
  el('chatgptPlanPlacement').value = plan.placement === 'fallback' ? 'fallback' : 'lead';
  el('chatgptPlanOnLimit').value = plan.onLimit === 'stop' ? 'stop' : 'rotate';
  el('chatgpt-plan-models').innerHTML = chatgptPlanModelsEditorHtml(plan.models || []);
  renderChatGptPlanAccountOptions(plan.accountKey || '');
  renderChatGptPlanPinned(plan.pinnedModel || '');
}

/* Config for the lane. Like the custom lanes this keeps whatever is on screen —
   the bridge's validator names a missing value better than the page guesses. */
function collectChatGptPlan() {
  var models = Array.prototype.map.call(document.querySelectorAll('#chatgpt-plan-models .chips .chip'), function (c) { return c.dataset.model; });
  var plan = {
    enabled: el('chatgptPlanEnabled').value === 'true',
    mode: el('chatgptPlanMode').value === 'pinned' ? 'pinned' : 'rotation',
    placement: el('chatgptPlanPlacement').value === 'fallback' ? 'fallback' : 'lead',
    // An empty list is meaningful (ask the account), so it is always sent; the
    // keys that mean "no preference" are only sent when they are set.
    models: models,
    onLimit: el('chatgptPlanOnLimit').value === 'stop' ? 'stop' : 'rotate'
  };
  var pinnedModel = el('chatgptPlanPinnedModel').value.trim();
  var accountKey = el('chatgptPlanAccount').value.trim();
  if (pinnedModel) plan.pinnedModel = pinnedModel;
  if (accountKey) plan.accountKey = accountKey;
  return plan;
}

/* A second click while the first request is in flight would fight the bridge's
   own one-attempt-at-a-time rule, so the buttons are held shut until it lands. */
var chatgptPlanStarting = false;

async function startChatGptPlanSignIn(body) {
  if (chatgptPlanStarting) return;
  chatgptPlanStarting = true;
  try {
    var res = await chatgptPlanApi('/v1/chatgpt-plan/sign-in', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || { registration: true })
    });
    state.chatgptPlanAttempt = res.attempt || null;
    await refreshChatGptPlan();
  } catch (err) {
    if (chatgptPlanUnsupported(err)) { chatgptPlanUnavailable = true; renderChatGptPlanAccount(null); renderChatGptPlanSavedAccounts(null); return; }
    showErrors(['Could not start the ChatGPT sign-in: ' + err.message]);
  } finally {
    chatgptPlanStarting = false;
  }
}

async function cancelChatGptPlanSignIn(attemptId) {
  try {
    await chatgptPlanApi('/v1/chatgpt-plan/sign-in/' + encodeURIComponent(attemptId) + '/cancel', { method: 'POST' });
  } catch (err) {
    // The attempt may have settled between the click and the request; the next
    // status poll is the authority either way.
    if (!chatgptPlanUnsupported(err)) showErrors(['Could not cancel the ChatGPT sign-in: ' + err.message]);
  }
  refreshChatGptPlan();
}

async function activateChatGptPlanAccount(accountKey) {
  try {
    await chatgptPlanApi('/v1/chatgpt-plan/activate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountKey: accountKey })
    });
    renderChatGptPlanAccountOptions(accountKey);
    refreshChatGptPlan();
  } catch (err) {
    if (chatgptPlanUnsupported(err)) { chatgptPlanUnavailable = true; renderChatGptPlanAccount(null); return; }
    showErrors(['Could not activate that ChatGPT account: ' + err.message]);
  }
}

async function signOutChatGptPlanAccount(accountKey) {
  var status = el('chatgpt-plan-status');
  try {
    var res = await chatgptPlanApi('/v1/chatgpt-plan/sign-out', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountKey: accountKey, revoke: true })
    });
    if (status) {
      // A revocation the server could not confirm is a warning, not a failure:
      // the local tokens are gone either way.
      status.textContent = (res.warnings && res.warnings.length)
        ? res.warnings.join(' ')
        : (res.revoked ? 'Signed out and revoked at ChatGPT.' : 'Signed out locally.');
    }
    await refreshChatGptPlan();
  } catch (err) {
    if (chatgptPlanUnsupported(err)) { chatgptPlanUnavailable = true; renderChatGptPlanAccount(null); return; }
    showErrors(['Could not sign out of ChatGPT: ' + err.message]);
  }
}

async function loadChatGptPlanModels() {
  var status = el('chatgpt-plan-status');
  if (status) status.textContent = 'Reading the model list from the account…';
  try {
    var res = await chatgptPlanApi('/v1/chatgpt-plan/models', { method: 'POST' });
    var models = res.models || [];
    var box = el('chatgpt-plan-models');
    // The editor is rendered from config; a config that failed to load leaves
    // nothing to add chips to, so it is created here rather than throwing.
    if (!box.querySelector('.lane-models')) box.innerHTML = chatgptPlanModelsEditorHtml([]);
    var addSel = box.querySelector('.model-add');
    state.chatgptPlanModels = models;
    models.forEach(function (m) { if (m && m.id) addModelChip(addSel, m.id); });
    renderChatGptPlanPinned();
    if (status) {
      status.textContent = models.length
        ? 'Loaded ' + models.length + ' model' + (models.length === 1 ? '' : 's') + ' from the account — remove the slots you do not want, then Apply.'
        : 'The account reported no models.';
    }
  } catch (err) {
    if (chatgptPlanUnsupported(err)) {
      chatgptPlanUnavailable = true;
      renderChatGptPlanAccount(null);
      renderChatGptPlanSavedAccounts(null);
      if (status) status.textContent = '';
      return;
    }
    if (status) status.textContent = 'Could not read the account models: ' + err.message;
  }
}

/* Same shape as refreshHealth(): a tick that swallows transient failures, but
   faster, because the panel changes while the user is over in the browser. */
async function refreshChatGptPlan() {
  try {
    var status = (await chatgptPlanApi('/v1/chatgpt-plan')) || {};
    chatgptPlanUnavailable = false;
    state.chatgptPlan = status;
    var pending = status.pendingSignIn;
    var known = state.chatgptPlanAttempt;
    // The attempt record outlives the pending flag and carries the fallback
    // authorization URL, so it is refreshed until it reaches a terminal status.
    var attemptId = (pending && pending.attemptId) || (known && known.status === 'pending' ? known.attemptId : '');
    if (attemptId && (!known || known.attemptId !== attemptId || known.status === 'pending')) {
      try {
        var res = await chatgptPlanApi('/v1/chatgpt-plan/sign-in/' + encodeURIComponent(attemptId));
        state.chatgptPlanAttempt = res.attempt || known || null;
      } catch (ignored) { /* the bridge may have restarted mid-attempt */ }
    } else if (status.signedIn) {
      state.chatgptPlanAttempt = null;
    }
    renderChatGptPlanAccount(status);
    renderChatGptPlanSavedAccounts(status);
    renderChatGptPlanAccountOptions();
  } catch (err) {
    if (chatgptPlanUnsupported(err)) {
      chatgptPlanUnavailable = true;
      renderChatGptPlanAccount(null);
      renderChatGptPlanSavedAccounts(null);
      return;
    }
    /* the bridge may be mid-restart — the next tick retries */
  }
}

function setupChatGptPlanListeners() {
  var load = el('chatgptPlanLoadModels');
  if (load) load.addEventListener('click', function () { loadChatGptPlanModels(); });
  var mode = el('chatgptPlanMode');
  if (mode) mode.addEventListener('change', function () { renderChatGptPlanPinned(); });

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t.classList) return;
    if (t.classList.contains('plan-signin')) {
      // No key means no saved registration to reauthorize, so this is a fresh one.
      startChatGptPlanSignIn(t.dataset.account ? { accountKey: t.dataset.account } : { registration: true });
    } else if (t.classList.contains('plan-force-consent')) {
      startChatGptPlanSignIn({ forceConsent: true });
    } else if (t.classList.contains('plan-cancel')) {
      cancelChatGptPlanSignIn(t.dataset.attempt);
    } else if (t.classList.contains('plan-activate')) {
      activateChatGptPlanAccount(t.dataset.account);
    } else if (t.classList.contains('plan-signout')) {
      signOutChatGptPlanAccount(t.dataset.account);
    }
    // Chip edits run through the page-wide lane listeners, which were registered
    // first — so the pin list is rebuilt from the DOM as it now stands.
    if (t.closest && t.closest('#chatgpt-plan-models')) renderChatGptPlanPinned();
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.closest && t.closest('#chatgpt-plan-models')) renderChatGptPlanPinned();
  });
  document.addEventListener('keydown', function (ev) {
    var t = ev.target;
    if (ev.key === 'Enter' && t.closest && t.closest('#chatgpt-plan-models')) renderChatGptPlanPinned();
  });
}

// ---- catalog (advanced) --------------------------------------------------

function renderCatalog() {
  var q = (el('provider-search').value || '').toLowerCase();
  var configured = ((state.config && state.config.catalog && state.config.catalog.providers) || []);
  var list = el('provider-list');
  list.innerHTML = '';
  var hits = state.catalog.filter(function (p) {
    if (!q) return true;
    return (p.id + ' ' + (p.name || '')).toLowerCase().indexOf(q) !== -1;
  });
  if (!hits.length) {
    list.innerHTML = state.catalog.length
      ? '<div class="empty">no providers match</div>'
      : '<div class="empty">no providers available from the bridge</div>';
  }
  hits.forEach(function (p) {
    var row = document.createElement('label');
    row.className = 'provider-row';
    var checked = configured.indexOf(p.id) !== -1;
    row.innerHTML = '<input type="checkbox" data-provider="' + esc(p.id) + '"' + (checked ? ' checked' : '') + ' />' +
      '<span class="id">' + esc(p.id) + '</span>' +
      '<span class="meta">' + esc(p.name || '') + (p.modelCount ? ' · ' + p.modelCount + ' models' : '') + (p.minCost ? ' · from $' + p.minCost + '/1M' : '') + '</span>' +
      (p.callable ? '' : '<span class="meta" style="color:var(--warn)">(no api url)</span>');
    list.appendChild(row);
  });
}

function collectCatalogChoice() {
  var providers = [];
  document.querySelectorAll('#provider-list input[type=checkbox]').forEach(function (cb) {
    if (cb.checked) providers.push(cb.dataset.provider);
  });
  return providers.length ? providers : undefined;
}

// ---- policy --------------------------------------------------------------

function providerSelect(group, value) {
  var sel = '<select class="lane-provider" data-group="' + group + '">';
  knownProviderIds().forEach(function (id) {
    sel += '<option value="' + esc(id) + '"' + (id === value ? ' selected' : '') + '>' + esc(id) + '</option>';
  });
  return sel + '</select>';
}

/* Bare (provider-scoped) model ids the bridge currently advertises for a
   provider, sourced from GET /v1/models — the same ids a policy lane's
   models array expects (no providerId/ prefix). */
function modelsForProvider(providerId) {
  var prefix = providerId + '/';
  var seen = {};
  var out = [];
  (state.models || []).forEach(function (m) {
    if (m.owned_by !== providerId) return;
    var bare = m.id.indexOf(prefix) === 0 ? m.id.slice(prefix.length) : m.id;
    if (!bare || seen[bare]) return;
    seen[bare] = true;
    out.push(bare);
  });
  return out.sort();
}

function modelChipHtml(model) {
  return '<span class="chip" data-model="' + esc(model) + '">' + esc(model) + '<button type="button" class="chip-x" title="remove">\u00d7</button></span>';
}

function modelsEditorHtml(models, group, providerId) {
  var chosen = models || [];
  var available = modelsForProvider(providerId).filter(function (m) { return chosen.indexOf(m) === -1; });
  var options = '<option value="">' + (available.length ? '+ add a known model…' : '(no catalog models for this provider)') + '</option>' +
    available.map(function (m) { return '<option value="' + esc(m) + '">' + esc(m) + '</option>'; }).join('');
  return '<div class="lane-models" data-group="' + group + '">' +
    '<div class="chips">' + chosen.map(modelChipHtml).join('') + '</div>' +
    '<div class="model-add-row">' +
      '<select class="model-add">' + options + '</select>' +
      '<input type="text" class="model-add-custom" placeholder="or type an id + Enter" />' +
    '</div>' +
    '<div class="no-models-hint">empty = the provider\'s default model</div>' +
  '</div>';
}

function addModelChip(originEl, model) {
  var modelsDiv = originEl.closest('.lane-models');
  var chips = modelsDiv.querySelector('.chips');
  var dup = Array.prototype.some.call(chips.children, function (c) { return c.dataset.model === model; });
  if (dup) return;
  var span = document.createElement('span');
  span.className = 'chip';
  span.dataset.model = model;
  span.innerHTML = esc(model) + '<button type="button" class="chip-x" title="remove">\u00d7</button>';
  chips.appendChild(span);
  var addSel = modelsDiv.querySelector('.model-add');
  Array.prototype.slice.call(addSel.options).forEach(function (opt) {
    if (opt.value === model) addSel.removeChild(opt);
  });
}

function laneRow(lane, group) {
  var row = document.createElement('div');
  row.className = 'lane';
  var providerId = lane.providerId || knownProviderIds()[0] || '';
  row.innerHTML =
    providerSelect(group, providerId) +
    modelsEditorHtml(lane.models, group, providerId) +
    '<button class="btn danger lane-remove">remove</button>';
  return row;
}

function setImageModels(providerId, selected) {
  var models = providerId === 'gemini'
    ? ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image']
    : ['gpt-image-2', 'gpt-image-1.5'];
  el('imageModel').innerHTML = models.map(function (model) {
    return '<option value="' + model + '">' + model + '</option>';
  }).join('');
  el('imageModel').value = models.indexOf(selected) === -1 ? models[0] : selected;
}

function renderImageGeneration() {
  var cfg = state.config || {};
  var image = cfg.imageGeneration || { enabled: false, providerId: 'openai', model: 'gpt-image-2', quality: 'medium', size: '1024x1024' };
  el('imageEnabled').value = String(!!image.enabled);
  el('imageProvider').value = image.providerId || 'openai';
  setImageModels(image.providerId || 'openai', image.model || 'gpt-image-2');
  el('imageQuality').value = image.quality || 'medium';
  el('imageSize').value = image.size || '1024x1024';
  el('imageQuality').disabled = image.providerId === 'gemini';
}

function renderCloudAgentsList(agents, errorMessage) {
  var box = el('cloud-agents-list');
  if (errorMessage) {
    box.className = 'empty';
    box.textContent = errorMessage;
    return;
  }
  if (!agents || !agents.length) {
    box.className = 'empty';
    box.textContent = 'No cloud agents';
    return;
  }
  box.className = '';
  box.innerHTML = '';
  agents.forEach(function (agent) {
    var row = document.createElement('div');
    row.className = 'row';
    row.style.borderBottom = '1px solid var(--line)';
    var status = (agent.status || 'unknown').toLowerCase();
    row.innerHTML = '<div class="grow"><span class="mono">' + esc(agent.id) + '</span> <span class="muted">' + esc(agent.status || 'unknown') + '</span></div>';
    if (status !== 'cancelled' && status !== 'finished') {
      var btn = document.createElement('button');
      btn.className = 'btn danger';
      btn.type = 'button';
      btn.textContent = 'Cancel';
      btn.addEventListener('click', function () { cancelCloudAgent(agent.id); });
      row.appendChild(btn);
    }
    box.appendChild(row);
  });
}

async function loadCloudAgents() {
  try {
    var body = await api('/v1/cloud-agents');
    renderCloudAgentsList(body.agents || []);
  } catch (err) {
    renderCloudAgentsList([], err.message);
  }
}

async function cancelCloudAgent(id) {
  showErrors([]);
  try {
    await api('/v1/cloud-agents/' + encodeURIComponent(id) + '/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    await loadCloudAgents();
  } catch (err) {
    showErrors(['Cancel failed: ' + err.message]);
  }
}

function renderCloudAgent() {
  var cfg = state.config || {};
  var cloud = cfg.cloudAgent || { enabled: false, defaultModel: 'composer-2.5', repos: [] };
  var repo = (cloud.repos && cloud.repos[0]) || {};
  el('cloudEnabled').value = String(!!cloud.enabled);
  el('cloudModel').value = cloud.defaultModel || 'composer-2.5';
  el('cloudRepoUrl').value = repo.url || '';
  el('cloudRepoRef').value = repo.startingRef || '';
  var hasKey = !!(cfg.keys && cfg.keys['cursor-cloud']);
  el('cloudApiKey').placeholder = hasKey ? '(set — leave blank to keep)' : '(paste CURSOR_API_KEY)';
  el('cloudApiKey').value = '';
  loadCloudAgents();
}

function collectCloudAgent() {
  var enabled = el('cloudEnabled').value === 'true';
  var url = el('cloudRepoUrl').value.trim();
  var ref = el('cloudRepoRef').value.trim();
  var cfg = {
    enabled: enabled,
    defaultModel: el('cloudModel').value.trim() || 'composer-2.5',
    repos: url ? [{ url: url, startingRef: ref || undefined }] : [],
    mode: 'agent',
    autoCreatePR: false,
    workOnCurrentBranch: false,
    sessionReuse: 'per-bridge-session'
  };
  if (!enabled) {
    cfg.enabled = false;
    if (url) cfg.repos = [{ url: url, startingRef: ref || undefined }];
  }
  return cfg;
}

function collectCloudAgentKey(keys) {
  var val = el('cloudApiKey').value.trim();
  if (val) keys['cursor-cloud'] = val;
}

function collectImageGeneration() {
  var enabled = el('imageEnabled').value === 'true';
  var cfg = {
    enabled: enabled,
    providerId: el('imageProvider').value || 'openai',
    model: el('imageModel').value.trim() || (el('imageProvider').value === 'gemini' ? 'gemini-3.1-flash-image' : 'gpt-image-2'),
    quality: el('imageQuality').value || 'medium',
    size: el('imageSize').value.trim() || '1024x1024',
  };
  return enabled ? cfg : { enabled: false, providerId: cfg.providerId, model: cfg.model, quality: cfg.quality, size: cfg.size };
}

function renderPolicy() {
  var cfg = state.config || {};
  var policy = cfg.policy || { trusted: [], fallback: [] };

  // Default-provider dropdown shares the same option set.
  var dp = el('defaultProviderId');
  dp.innerHTML = providerSelect('default', cfg.defaultProviderId || '')
    .replace(/^<select[^>]*>/, '').replace(/<\/select>$/, '');
  dp.value = cfg.defaultProviderId || '';

  var trusted = el('trusted-lanes');
  var fallback = el('fallback-lanes');
  trusted.innerHTML = '';
  fallback.innerHTML = '';
  if (!policy.trusted.length) trusted.innerHTML = '<div class="empty">no trusted lanes — the router will try whatever the request asks for, then fall back</div>';
  if (!policy.fallback.length) fallback.innerHTML = '<div class="empty">no fallback lanes</div>';
  policy.trusted.forEach(function (l) { trusted.appendChild(laneRow(l, 'trusted')); });
  policy.fallback.forEach(function (l) { fallback.appendChild(laneRow(l, 'fallback')); });

  el('maxProviders').value = policy.maxProviders || '';
  var freeOnly = el('freeOnlyLane');
  if (freeOnly) freeOnly.checked = policy.freeOnly === true;
  var bo = policy.backoff;
  el('backoffType').value = bo ? bo.type : 'none';
  if (bo) { el('backoffBase').value = bo.baseMs; el('backoffMax').value = bo.maxMs || ''; }
  el('defaultModel').value = cfg.defaultModel || '';
}

/** Read the lane rows out of one lane-list container. */
function readLanes(container) {
  var out = [];
  if (!container) return out;
  container.querySelectorAll('.lane').forEach(function (row) {
    var providerId = row.querySelector('.lane-provider').value.trim();
    if (!providerId) return;
    var models = Array.prototype.map.call(row.querySelectorAll('.lane-models .chips .chip'), function (c) { return c.dataset.model; });
    var entry = { providerId: providerId };
    if (models.length) entry.models = models;
    out.push(entry);
  });
  return out;
}

function collectPolicy() {
  var policy = { trusted: readLanes(el('trusted-lanes')), fallback: readLanes(el('fallback-lanes')) };
  // Always sent as a boolean so unchecking it clears a previously pinned lane —
  // an omitted key would leave the bridge's last value standing on some viewers.
  policy.freeOnly = !!(el('freeOnlyLane') && el('freeOnlyLane').checked);
  var maxP = el('maxProviders').value;
  if (maxP && Number(maxP) >= 1) policy.maxProviders = Number(maxP);
  var boType = el('backoffType').value;
  if (boType !== 'none') {
    policy.backoff = { type: boType, baseMs: Number(el('backoffBase').value) || 0 };
    var cap = el('backoffMax').value;
    if (cap && Number(cap) > 0) policy.backoff.maxMs = Number(cap);
  }
  return policy;
}

// ---- intents -------------------------------------------------------------

/* Fixed vocabulary, mirrored from src/core/intent.ts: the bridge infers these
   names from a request's shape, so the editor has to offer exactly them. */
var INTENT_NAMES = ['coding', 'reasoning', 'vision', 'bulk'];

function intentProfileHtml(intent) {
  return '<div class="intent-profile" data-intent="' + intent + '">' +
    '<div class="lbl">' + intent + '</div>' +
    '<div class="lane-list">' +
      '<div class="lbl">trusted</div>' +
      '<div id="intent-' + intent + '-trusted"></div>' +
      '<button class="btn add-lane" data-into="intent-' + intent + '-trusted">+ trusted lane</button>' +
      '<div class="lbl" style="margin-top:14px">fallback</div>' +
      '<div id="intent-' + intent + '-fallback"></div>' +
      '<button class="btn add-lane" data-into="intent-' + intent + '-fallback">+ fallback lane</button>' +
    '</div>' +
  '</div>';
}

function renderIntents() {
  var intents = (state.config && state.config.intents) || {};
  var profiles = intents.profiles || {};
  el('intentsInfer').value = intents.infer === false ? 'false' : 'true';
  el('intent-profiles').innerHTML = INTENT_NAMES.map(intentProfileHtml).join('');
  INTENT_NAMES.forEach(function (intent) {
    var trusted = el('intent-' + intent + '-trusted');
    var fallback = el('intent-' + intent + '-fallback');
    var profile = profiles[intent];
    if (!profile) {
      trusted.innerHTML = '<div class="empty">not configured — falls back to the policy above</div>';
      return;
    }
    if (!profile.trusted || !profile.trusted.length) trusted.innerHTML = '<div class="empty">no trusted lanes</div>';
    if (!profile.fallback || !profile.fallback.length) fallback.innerHTML = '<div class="empty">no fallback lanes</div>';
    (profile.trusted || []).forEach(function (l) { trusted.appendChild(laneRow(l, 'trusted')); });
    (profile.fallback || []).forEach(function (l) { fallback.appendChild(laneRow(l, 'fallback')); });
  });
}

function collectIntents() {
  var profiles = {};
  INTENT_NAMES.forEach(function (intent) {
    var trusted = readLanes(el('intent-' + intent + '-trusted'));
    var fallback = readLanes(el('intent-' + intent + '-fallback'));
    // A profile with no lanes names no plan, so it stays absent — which is what
    // makes it fall back to the policy above rather than routing nowhere.
    if (!trusted.length && !fallback.length) return;
    profiles[intent] = { trusted: trusted, fallback: fallback };
  });
  var out = {};
  if (el('intentsInfer').value === 'false') out.infer = false;
  if (Object.keys(profiles).length) out.profiles = profiles;
  // Nothing configured and inference left on: omit the block entirely, so the
  // saved document looks the same as one that never had it.
  return Object.keys(out).length ? out : undefined;
}

// ---- reliability ---------------------------------------------------------

function renderReliability() {
  var cd = state.config && state.config.cooldown;
  if (!cd || cd.type === 'circuit-breaker') {
    el('cooldownType').value = 'circuit-breaker';
    el('cdThreshold').value = (cd && cd.failureThreshold) || 3;
    el('cdBase').value = (cd && cd.baseTripMs) || 15000;
    el('cdMax').value = (cd && cd.maxTripMs) || 120000;
  } else if (cd.type === 'memory') {
    el('cooldownType').value = 'memory';
  } else {
    el('cooldownType').value = 'none';
  }
}

function collectReliability() {
  var type = el('cooldownType').value;
  if (type === 'none') return undefined;
  if (type === 'memory') return { type: 'memory' };
  return { type: 'circuit-breaker', failureThreshold: Number(el('cdThreshold').value) || 3, baseTripMs: Number(el('cdBase').value) || 15000, maxTripMs: Number(el('cdMax').value) || 120000 };
}

// ---- health --------------------------------------------------------------

function renderHealth(health) {
  var tbody = el('health-body');
  tbody.innerHTML = '';
  if (!health || !health.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">no lanes have failed yet</td></tr>'; return; }
  health.forEach(function (h) {
    var tr = document.createElement('tr');
    tr.innerHTML = '<td class="mono">' + esc(h.providerId + '/' + h.model) + '</td>' +
      '<td><span class="status"><span class="dot ' + esc(h.state) + '"></span>' + esc(h.state) + '</span></td>' +
      '<td class="mono">' + esc(h.consecutiveFailures) + '</td>' +
      '<td class="mono">' + esc(h.trips) + '</td>' +
      '<td class="mono">' + (h.remainingMs ? Math.ceil(h.remainingMs / 1000) + 's' : '—') + '</td>';
    tbody.appendChild(tr);
  });
}

// ---- OpenCode lane rotation ----------------------------------------------

/* A configured plan lane can rotate out of the provider's live model list
   (upstream rename/retire). GET /v1/lane-rotation reports those; the endpoint
   may not exist on an older bridge, in which case nothing is rendered. */
async function refreshLaneRotation() {
  var box = el('lane-rotation-warn');
  if (!box) return;
  var lanes = [];
  try {
    var res = await fetch('/v1/lane-rotation');
    if (!res.ok) { box.innerHTML = ''; return; }
    var body = await res.json().catch(function () { return {}; });
    lanes = body.rotated || [];
  } catch (err) { box.innerHTML = ''; return; }
  if (!lanes.length) { box.innerHTML = ''; return; }
  box.innerHTML = lanes.map(function (lane) {
    var laneId = (lane.providerId || '') + '/' + (lane.model || '');
    var btn = lane.suggestion
      ? ' <button class="btn lane-rotate-switch" type="button" data-provider="' + esc(lane.providerId) + '" data-from="' + esc(lane.model) + '" data-to="' + esc(lane.suggestion) + '">Switch to ' + esc(lane.providerId + '/' + lane.suggestion) + '</button>'
      : '';
    return '<div class="warnbox"><span class="mono">' + esc(laneId) + '</span> is no longer in the provider\'s model list.' + btn + '</div>';
  }).join('');
}

/* Splice the replacement model id into every policy lane that pinned the
   rotated one, then PUT the full document back — the server validates and
   hot-reloads, exactly like Apply does. */
/* Service keys: read-only. The GET doc carries only hashes + prefixes, so
   rendering it is safe; the panel has NO inputs, so Apply can never round-trip
   key material and the mandate "minting is CLI-only" holds structurally. */
function renderServiceKeys() {
  var keys = (state.config && state.config.serviceKeys) || [];
  var box = el('service-key-rows');
  if (!keys.length) {
    box.innerHTML = '<tr><td colspan="4" class="empty">no service keys — unauthenticated</td></tr>';
    return;
  }
  box.innerHTML = keys.map(function (k) {
    var limits = [];
    if (k.dailyRequests !== undefined) limits.push('req≤' + k.dailyRequests + '/day');
    if (k.dailyTokens !== undefined) limits.push('tok≤' + k.dailyTokens + '/day');
    if (k.dailyCostUsd !== undefined) limits.push('$≤' + k.dailyCostUsd + '/day');
    var plan = '<span class="pill ' + (k.plan === 'free' ? 'pill-muted' : '') + '">' + esc(k.plan) + '</span>';
    var status = k.revoked ? 'REVOKED' : (k.rotatedAt ? 'rotated' : 'active');
    return '<tr><td class="mono">' + esc(k.id) + '</td><td>' + plan + '</td><td class="mono">' +
      (limits.length ? limits.join(' ') : 'unlimited') + '</td><td>' +
      esc(status) + (k.name ? '<div class="meta" style="font-size:11px;color:var(--muted)">' + esc(k.name) + '</div>' : '') + '</td></tr>';
  }).join('');
}

async function switchRotatedLane(providerId, from, to) {
  try {
    var doc = JSON.parse(JSON.stringify(await api('/v1/config')));
    var policy = doc.policy || (doc.policy = { trusted: [], fallback: [] });
    [policy.trusted, policy.fallback].forEach(function (group) {
      (group || []).forEach(function (lane) {
        if (!lane || !Array.isArray(lane.models)) return;
        if (providerId && lane.providerId && lane.providerId !== providerId) return;
        lane.models = lane.models.map(function (m) { return m === from ? to : m; });
      });
    });
    var res = await fetch('/v1/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(doc)
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) { showErrors(body && body.errors ? body.errors : ['HTTP ' + res.status]); return; }
    flashSaved();
    await loadAll();
  } catch (err) {
    showErrors(['Could not switch the rotated lane: ' + err.message]);
  }
}

// ---- boot / actions ------------------------------------------------------

function assemble() {
  var cfg = state.config || {};
  var catalogChoice = collectCatalogChoice();
  return {
    version: 1,
    defaultProviderId: el('defaultProviderId').value.trim() || undefined,
    defaultModel: el('defaultModel').value.trim() || undefined,
    defaultWorkspaceTarget: el('workspaceTarget').value || 'rotation',
    policy: collectPolicy(),
    intents: collectIntents(),
    catalog: catalogChoice ? { providers: catalogChoice, baseUrls: (cfg.catalog && cfg.catalog.baseUrls) || undefined, ttlMs: (cfg.catalog && cfg.catalog.ttlMs) || undefined } : undefined,
    cooldown: collectReliability(),
    imageGeneration: collectImageGeneration(),
    cloudAgent: collectCloudAgent(),
    opencodeByok: collectOpenCodeByok(),
    customLanes: collectCustomLanes(),
    chatgptPlan: collectChatGptPlan(),
    keys: collectKeys(),
    /* Read-only pass-through: Apply must carry the minted keys along or the
       daemon clears the block (keyed on presence) and every key dies on the
       next Apply. The panel has no inputs, so this is exactly the doc as
       loaded — hashes and prefixes only, no key material to lose. */
    serviceKeys: cfg.serviceKeys || undefined
  };
}

async function loadAll() {
  try {
    state.config = await api('/v1/config');
    var cat = await api('/v1/catalog');
    state.catalog = cat.providers || [];
    state.builtin = cat.builtin || [];
    var models = await api('/v1/models');
    state.models = models.data || [];
    renderImageGeneration(); renderCloudAgent(); renderWorkspaceTarget(); renderProviders(); renderOpenCode(); renderOpenCodeByok(); renderCustomLanes(); renderChatGptPlan(); renderCatalog(); renderPolicy(); renderIntents(); renderReliability(); renderServiceKeys();
    refreshHealth();
    refreshChatGptPlan();
    refreshLaneRotation();
  } catch (err) {
    showErrors(['Failed to load settings: ' + err.message]);
  }
}

async function apply() {
  var btn = el('apply'); btn.disabled = true; showErrors([]);
  try {
    var payload = assemble();
    var res = await fetch('/v1/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) { showErrors(body && body.errors ? body.errors : ['HTTP ' + res.status]); return; }
    flashSaved();
    await loadAll();
    refreshHealth();
  } catch (err) {
    showErrors(['Failed to apply: ' + err.message]);
  } finally {
    btn.disabled = false;
  }
}

function refreshHealth() {
  api('/v1/lane-health').then(renderHealth).catch(function () { /* bridge may be mid-restart */ });
}

document.getElementById('apply').addEventListener('click', apply);
document.getElementById('reload').addEventListener('click', loadAll);
document.getElementById('provider-search').addEventListener('input', renderCatalog);
document.getElementById('imageProvider').addEventListener('change', function () {
  var gemini = el('imageProvider').value === 'gemini';
  setImageModels(el('imageProvider').value, gemini ? 'gemini-3.1-flash-image' : 'gpt-image-2');
  el('imageQuality').disabled = gemini;
  if (!gemini) el('imageQuality').value = 'medium';
});
document.getElementById('imageModel').addEventListener('change', function () {
  if (el('imageModel').value === 'gpt-image-1.5') el('imageQuality').value = 'medium';
});
document.addEventListener('click', function (ev) {
  var t = ev.target;
  if (t.classList && t.classList.contains('lane-remove')) { t.closest('.lane').remove(); return; }
  if (t.classList && t.classList.contains('byok-remove')) {
    t.closest('.byok-conn').remove();
    renderByokPinOptions();
    return;
  }
  if (t.classList && t.classList.contains('custom-remove')) {
    var laneEl = t.closest('.custom-lane');
    var box = laneEl.parentNode;
    laneEl.remove();
    // Removing the last lane should leave the same "add one" prompt the section
    // starts with, not a silently empty box.
    if (box && !box.querySelector('.custom-lane')) {
      box.innerHTML = '<div class="empty">no custom lanes yet — add one when your provider is not in the list above</div>';
    }
    return;
  }
  if (t.classList && t.classList.contains('add-lane')) {
    // The button names its container by id, so a profile's lane list needs no
    // extra wiring: data-into="intent-coding-trusted" IS the element id.
    var target = t.dataset.into;
    var box = el(target);
    if (!box) return;
    var placeholder = box.querySelector('.empty');
    if (placeholder) box.removeChild(placeholder);
    box.appendChild(laneRow({}, target));
    return;
  }
  if (t.classList && t.classList.contains('chip-x')) {
    var chip = t.closest('.chip');
    var modelsDiv = chip.closest('.lane-models');
    var model = chip.dataset.model;
    chip.remove();
    var addSel = modelsDiv.querySelector('.model-add');
    if (!Array.prototype.some.call(addSel.options, function (o) { return o.value === model; })) {
      var opt = document.createElement('option');
      opt.value = model; opt.textContent = model;
      addSel.appendChild(opt);
    }
    return;
  }
});
document.addEventListener('change', function (ev) {
  var t = ev.target;
  if (t.classList && t.classList.contains('lane-provider')) {
    var laneEl = t.closest('.lane');
    var group = t.dataset.group;
    var modelsDiv = laneEl.querySelector('.lane-models');
    modelsDiv.outerHTML = modelsEditorHtml([], group, t.value);
    return;
  }
  if (t.classList && t.classList.contains('model-add') && t.value) {
    addModelChip(t, t.value);
    t.value = '';
    return;
  }
  if (t.classList && t.classList.contains('byok-id')) {
    renderByokPinOptions();
    return;
  }
  if (t.classList && t.classList.contains('custom-id')) {
    // The provider id (and therefore the key slot) follows the lane id, so the
    // hint has to follow it too.
    var row = t.closest('.custom-lane');
    var hint = row.querySelector('.no-models-hint.mono');
    var laneId = t.value.trim();
    if (hint) hint.textContent = laneId ? customEnvVar(laneId) : 'env fallback: MODELHITCH_CUSTOM_<ID>_API_KEY';
    return;
  }
});
document.addEventListener('keydown', function (ev) {
  var t = ev.target;
  if (t.classList && t.classList.contains('model-add-custom') && ev.key === 'Enter') {
    ev.preventDefault();
    var val = t.value.trim();
    if (!val) return;
    addModelChip(t, val);
    t.value = '';
  }
});
function setupOpenCodeListeners() {
  function addLane(providerId, models, group) {
    var box = el(group + '-lanes');
    if (!box) return;
    var empty = box.querySelector('.empty');
    if (empty) empty.remove();
    box.appendChild(laneRow({ providerId: providerId, models: models }, group));
  }

  var az = el('addZenTrusted');
  if (az) az.addEventListener('click', function () {
    addLane('opencode', ['deepseek-v4-pro', 'claude-sonnet-4-6', 'gpt-5.5'], 'trusted');
  });
  var ag = el('addGoTrusted');
  if (ag) ag.addEventListener('click', function () {
    addLane('opencode-go', ['deepseek-v4-pro'], 'trusted');
  });
  var azf = el('addZenFallback');
  if (azf) azf.addEventListener('click', function () {
    addLane('opencode', ['deepseek-v4-pro'], 'fallback');
  });
  var agf = el('addGoFallback');
  if (agf) agf.addEventListener('click', function () {
    addLane('opencode-go', ['deepseek-v4-pro'], 'fallback');
  });
  var sdz = el('setDefaultZen');
  if (sdz) sdz.addEventListener('click', function () {
    var dp = el('defaultProviderId');
    if (dp) dp.value = 'opencode';
    var dm = el('defaultModel');
    if (dm) dm.value = 'deepseek-v4-pro';
  });
  var sdg = el('setDefaultGo');
  if (sdg) sdg.addEventListener('click', function () {
    var dp = el('defaultProviderId');
    if (dp) dp.value = 'opencode-go';
    var dm = el('defaultModel');
    if (dm) dm.value = 'deepseek-v4-pro';
  });

  // Rotation-warning buttons carry provider/from/to in data attributes, so one
  // delegated listener serves every lane the endpoint ever reports.
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t.classList || !t.classList.contains('lane-rotate-switch')) return;
    switchRotatedLane(t.dataset.provider, t.dataset.from, t.dataset.to);
  });
}

function setupByokListeners() {
  var add = el('byokAdd');
  if (add) add.addEventListener('click', function () {
    var box = el('byok-connections');
    var empty = box.querySelector('.empty');
    if (empty) empty.remove();
    box.insertAdjacentHTML('beforeend', byokConnectionRowHtml({ enabled: true, schema: 'auto' }));
    el('byokEnabled').value = 'true';
    renderByokPinOptions();
  });
  var imp = el('byokImport');
  if (imp) imp.addEventListener('click', function () { importFromOpenCode(); });
  var mode = el('byokMode');
  if (mode) mode.addEventListener('change', function () {
    var pinned = el('byokMode').value === 'pinned';
    el('byokPin').disabled = !pinned;
    el('byokPinModel').disabled = !pinned;
  });
}

function setupCustomLaneListeners() {
  var add = el('customAdd');
  if (add) add.addEventListener('click', function () {
    var box = el('custom-lanes');
    var empty = box.querySelector('.empty');
    if (empty) empty.remove();
    box.insertAdjacentHTML('beforeend', customLaneRowHtml({ enabled: true, schema: 'auto', onLimit: 'rotate', models: [] }));
    el('customEnabled').value = 'true';
  });
}

setupOpenCodeListeners();
setupByokListeners();
setupCustomLaneListeners();
setupChatGptPlanListeners();
setInterval(refreshHealth, 5000);
// The account panel changes while the user is over in the browser, so it polls
// faster than lane health.
setInterval(refreshChatGptPlan, 2000);
loadAll();
</script>
</body>
</html>`;
}
