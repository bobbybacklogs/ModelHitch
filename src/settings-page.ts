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
</style>
</head>
<body>
<header>
  <div class="bar">
    <span class="wordmark">model<b>hitch</b></span>
    <span class="local-badge">local · 127.0.0.1</span>
    <span class="spacer"></span>
    <span class="linkbar"><a href="/usage" target="_blank">usage</a> · <a href="/healthz" target="_blank">health</a></span>
  </div>
</header>

<main>
  <div id="errors"></div>
  <div id="saved">Applied.</div>

  <section>
    <div class="section-head"><h2>Providers</h2><span class="hint">paste an API key to enable a provider — stored locally in ~/.modelhitch/config.json, masked everywhere else</span></div>
    <div class="panel" id="providers"></div>
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
    <div class="section-head"><h2>Policy</h2><span class="hint">trusted lanes first, fallback lanes after — the lane is the trust object</span></div>
    <div class="panel lane-list">
      <div class="lbl">trusted</div>
      <div id="trusted-lanes"></div>
      <button class="btn add-lane" data-into="trusted">+ trusted lane</button>
      <div class="lbl" style="margin-top:14px">fallback</div>
      <div id="fallback-lanes"></div>
      <button class="btn add-lane" data-into="fallback">+ fallback lane</button>
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
  return keys;
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
  var bo = policy.backoff;
  el('backoffType').value = bo ? bo.type : 'none';
  if (bo) { el('backoffBase').value = bo.baseMs; el('backoffMax').value = bo.maxMs || ''; }
  el('defaultModel').value = cfg.defaultModel || '';
}

function collectPolicy() {
  var trusted = [];
  var fallback = [];
  document.querySelectorAll('#trusted-lanes .lane, #fallback-lanes .lane').forEach(function (row) {
    var isTrusted = row.parentNode.id === 'trusted-lanes';
    var providerId = row.querySelector('.lane-provider').value.trim();
    var models = Array.prototype.map.call(row.querySelectorAll('.lane-models .chips .chip'), function (c) { return c.dataset.model; });
    if (!providerId) return;
    var entry = { providerId: providerId };
    if (models.length) entry.models = models;
    (isTrusted ? trusted : fallback).push(entry);
  });
  var policy = { trusted: trusted, fallback: fallback };
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

// ---- boot / actions ------------------------------------------------------

function assemble() {
  var cfg = state.config || {};
  var catalogChoice = collectCatalogChoice();
  return {
    version: 1,
    defaultProviderId: el('defaultProviderId').value.trim() || undefined,
    defaultModel: el('defaultModel').value.trim() || undefined,
    policy: collectPolicy(),
    catalog: catalogChoice ? { providers: catalogChoice, baseUrls: (cfg.catalog && cfg.catalog.baseUrls) || undefined, ttlMs: (cfg.catalog && cfg.catalog.ttlMs) || undefined } : undefined,
    cooldown: collectReliability(),
    imageGeneration: collectImageGeneration(),
    keys: collectKeys()
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
    renderImageGeneration(); renderProviders(); renderCatalog(); renderPolicy(); renderReliability();
    refreshHealth();
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
  if (t.classList && t.classList.contains('add-lane')) {
    var group = t.dataset.into;
    var box = el(group + '-lanes');
    box.querySelector('.empty') && box.removeChild(box.querySelector('.empty'));
    box.appendChild(laneRow({}, group));
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
setInterval(refreshHealth, 5000);
loadAll();
</script>
</body>
</html>`;
}
