/**
 * Local workspace UI — sessions, chat, and work orders against the bridge.
 *
 * Served at `GET /workspace`. Same self-contained HTML rules as settings:
 * no CDN, no build step, local bridge APIs only.
 */

export function workspacePageHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ModelHitch — workspace</title>
<style>
  :root {
    --bg: #0d0e0c; --panel: #141613; --panel2: #191c18; --raised: #1e221d;
    --line: #2a2e28; --line2: #373c34; --text: #d8d6cf; --muted: #8d8e84;
    --accent: #b7a06a; --accent-dim: #8a7a52; --ok: #8fbf6a; --warn: #d9a441; --bad: #c9704f;
    --mono: ui-monospace, "Cascadia Mono", "JetBrains Mono", Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  * { box-sizing: border-box; }
  html { height: 100%; }
  /* Fixed-height app shell: the rail takes exactly what the header leaves and
     the panels scroll inside it. Sizing the rail with viewport arithmetic
     instead left it a few pixels taller than the header, so the whole page
     scrolled a little as well. */
  body { margin: 0; height: 100%; overflow: hidden; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.45; display: flex; flex-direction: column; }
  code, .mono { font-family: var(--mono); font-size: 0.92em; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { flex-shrink: 0; background: color-mix(in srgb, var(--bg) 92%, transparent); border-bottom: 1px solid var(--line); }
  .bar { padding: 14px 20px; display: flex; align-items: baseline; gap: 12px; }
  .wordmark { font-family: var(--mono); font-weight: 700; letter-spacing: 0.04em; font-size: 15px; color: var(--text); }
  .wordmark b { color: var(--accent); }
  .local-badge { font-size: 11px; color: var(--muted); border: 1px solid var(--line2); border-radius: 3px; padding: 2px 7px; font-family: var(--mono); }
  .spacer { flex: 1; }
  .linkbar { font-size: 12px; color: var(--muted); }

  .rail { flex: 1; min-height: 0; display: flex; }
  .rail-side { width: 280px; flex-shrink: 0; min-height: 0; border-right: 1px solid var(--line); display: flex; flex-direction: column; background: var(--panel); }
  .rail-side.right { border-right: 0; border-left: 1px solid var(--line); }
  .rail-center { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
  .rail-head { padding: 8px 10px 8px 14px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); font-weight: 600; }
  .rail-head .spacer { flex: 1; }
  .rail-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px; }

  .item { display: block; width: 100%; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 8px 10px; margin-bottom: 4px; cursor: pointer; color: var(--text); font-family: var(--sans); font-size: 13px; }
  .item:hover { background: var(--panel2); border-color: var(--line); }
  .item.active { background: var(--raised); border-color: var(--accent-dim); }
  .item .title { font-family: var(--mono); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item .meta { font-size: 11px; color: var(--muted); margin-top: 2px; }

  .transcript { flex: 1; overflow-y: auto; padding: 16px 20px; }
  .msg { margin-bottom: 14px; max-width: 720px; }
  .msg .role { font-family: var(--mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 4px; }
  .msg.user .role { color: var(--accent-dim); }
  .msg .body { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
  .msg.user .body { background: var(--panel2); }
  .empty-state { color: var(--muted); font-style: italic; padding: 20px; }

  .composer { border-top: 1px solid var(--line); padding: 12px 16px; background: var(--panel); }
  .composer-row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; }
  .composer-row .grow { flex: 1; min-width: 200px; }
  label { font-size: 11px; color: var(--muted); display: block; margin-bottom: 3px; }
  textarea, select, input {
    background: var(--raised); color: var(--text); border: 1px solid var(--line2); border-radius: 4px;
    padding: 8px 10px; font-family: var(--sans); font-size: 13px; width: 100%;
  }
  textarea { min-height: 72px; resize: vertical; font-family: var(--sans); }
  textarea:focus, select:focus, input:focus { outline: none; border-color: var(--accent-dim); }
  .btn {
    background: transparent; color: var(--text); border: 1px solid var(--line2); border-radius: 4px;
    padding: 8px 14px; font-size: 12px; cursor: pointer; font-family: var(--sans); white-space: nowrap;
  }
  .btn:hover { border-color: var(--accent-dim); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #14130e; font-weight: 600; }
  .btn.primary:hover { background: #c9b47c; }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .btn.ghost { border-color: transparent; color: var(--muted); padding: 2px 6px; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; }
  .btn.ghost:hover { border-color: var(--line2); color: var(--accent); }

  /* The catalog carries 1000+ targets, so the target select is paired with a
     filter. The filter only narrows the list (and the current choice stays
     pinned in place) — it never silently changes what a send will use. */
  .target-col { display: flex; flex-direction: column; gap: 4px; min-width: 200px; }
  .filter-input { font-size: 12px; padding: 5px 8px; }
  .hint { color: var(--muted); font-size: 10px; text-transform: none; letter-spacing: 0; font-weight: 400; }
  .msg.pending .body { color: var(--muted); font-style: italic; }
  .pulse { animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
  .info-state { color: var(--muted); padding: 16px 12px; font-size: 12px; }
  .info-state code { color: var(--text); }

  .status-pill { display: inline-block; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-radius: 3px; padding: 1px 6px; border: 1px solid var(--line2); }
  .status-pill.running { color: var(--warn); border-color: var(--warn); }
  .status-pill.done { color: var(--ok); border-color: var(--ok); }
  .status-pill.failed { color: var(--bad); border-color: var(--bad); }
  .status-pill.cancelled { color: var(--muted); }
  .status-pill.queued { color: var(--muted); }

  #errors { display: none; flex-shrink: 0; background: #2a1813; border: 1px solid var(--bad); color: #e8b7a4; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin: 8px 16px; white-space: pre-line; }

  /* Narrow viewports: the three columns stop being columns. Leaving them
     side by side pushed the page wider than the screen (280 + 280 + center),
     so below this width the rail stacks — sessions, then chat, then work
     orders and cloud agents — and the page scrolls as one document. */
  @media (max-width: 900px) {
    body { display: block; height: auto; overflow: visible; }
    .rail { display: block; }
    .rail-side, .rail-side.right { width: 100%; border: 0; border-top: 1px solid var(--line); }
    .rail-center { display: block; }
    .rail-body { max-height: 32vh; }
    .transcript { max-height: 55vh; padding: 12px; }
    .composer { padding: 10px 12px; }
    .composer-row { flex-direction: column; align-items: stretch; }
    .target-col, .target-col input, .target-col select { min-width: 0; width: 100%; }
    .msg { max-width: none; }
    .bar { flex-wrap: wrap; }
  }
</style>
</head>
<body>
<header>
  <div class="bar">
    <span class="wordmark">model<b>hitch</b></span>
    <span class="local-badge">workspace · local</span>
    <span class="spacer"></span>
    <span class="linkbar"><a href="/settings">settings</a> · <a href="/usage">usage</a></span>
  </div>
</header>

<div id="errors"></div>

<div class="rail">
  <aside class="rail-side">
    <div class="rail-head"><span>Sessions</span><span class="spacer"></span><button class="btn ghost" id="refresh-sessions" type="button" title="Reload sessions">refresh</button></div>
    <div class="rail-body" id="sessions-list"><div class="empty-state">Loading…</div></div>
    <div style="padding:8px;border-top:1px solid var(--line)">
      <button class="btn" id="new-session" style="width:100%">+ New session</button>
    </div>
  </aside>

  <section class="rail-center">
    <div class="transcript" id="transcript"><div class="empty-state">Select or create a session</div></div>
    <div class="composer">
      <div class="composer-row">
        <div class="target-col">
          <label for="chat-target">target</label>
          <input class="filter-input" id="chat-target-filter" placeholder="filter targets…" autocomplete="off" spellcheck="false" />
          <select id="chat-target" class="target-select"></select>
          <div class="hint" id="chat-target-count"></div>
        </div>
        <div class="grow">
          <label for="chat-prompt">message <span class="hint">ctrl+enter sends</span></label>
          <textarea id="chat-prompt" placeholder="Send a message…"></textarea>
        </div>
        <button class="btn primary" id="send-message">Send</button>
      </div>
    </div>
  </section>

  <aside class="rail-side right">
    <div class="rail-head"><span>Work orders</span><span class="spacer"></span><button class="btn ghost" id="refresh-work-orders" type="button" title="Reload work orders">refresh</button></div>
    <div class="rail-body" id="work-orders-list"><div class="empty-state">Loading…</div></div>
    <div class="composer" style="border-top:1px solid var(--line)">
      <div class="composer-row" style="flex-direction:column;align-items:stretch">
        <div class="target-col">
          <label for="wo-target">target</label>
          <input class="filter-input" id="wo-target-filter" placeholder="filter targets…" autocomplete="off" spellcheck="false" />
          <select id="wo-target" class="target-select"></select>
          <div class="hint" id="wo-target-count"></div>
        </div>
        <div>
          <label for="wo-prompt">prompt <span class="hint">ctrl+enter submits</span></label>
          <textarea id="wo-prompt" placeholder="One-shot task…" style="min-height:56px"></textarea>
        </div>
        <button class="btn primary" id="submit-work-order">Work order</button>
      </div>
    </div>
    <div class="rail-head" style="border-top:1px solid var(--line)"><span>Cloud agents</span><span class="spacer"></span><button class="btn ghost" id="refresh-cloud-agents" type="button" title="Reload cloud agents">refresh</button></div>
    <div class="rail-body" id="cloud-agents-list"><div class="empty-state">Loading…</div></div>
  </aside>
</div>

<script>
"use strict";
var state = {
  sessions: [], workOrders: [], cloudAgents: [], models: [],
  activeSessionId: null, defaultTarget: 'rotation',
  targetOptions: [], targetSelection: { 'chat-target': 'rotation', 'wo-target': 'rotation' },
  sending: false, submitting: false, draft: false, pollTimer: null
};

/* The two target pickers differ only in their element ids. */
var TARGETS = [
  { sel: 'chat-target', filter: 'chat-target-filter', count: 'chat-target-count' },
  { sel: 'wo-target', filter: 'wo-target-filter', count: 'wo-target-count' }
];

function el(id) { return document.getElementById(id); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }

function relTime(iso) {
  if (!iso) return '';
  var t = Date.parse(iso);
  if (isNaN(t)) return '';
  var secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 45) return 'just now';
  if (secs < 90) return '1m ago';
  var mins = Math.round(secs / 60);
  if (mins < 60) return mins + 'm ago';
  var hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.round(hours / 24);
  if (days < 7) return days + 'd ago';
  return new Date(t).toLocaleDateString();
}

/* Only these statuses are worth polling for: everything else is final. */
function isActiveStatus(status) {
  var s = String(status || '').toLowerCase();
  return s === 'queued' || s === 'running' || s === 'pending';
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 200) + 'px';
}

async function api(path, opts) {
  var res = await fetch(path, opts);
  var body = await res.json().catch(function () { return {}; });
  if (!res.ok) {
    var err = new Error((body && body.error && body.error.message) || ('HTTP ' + res.status));
    err.status = res.status;
    throw err;
  }
  return body;
}

function showErrors(errs) {
  var box = el('errors');
  if (errs && errs.length) { box.style.display = 'block'; box.textContent = errs.join('\n'); }
  else { box.style.display = 'none'; }
}

function targetLabel(t) {
  if (!t || t.kind === 'rotation') return 'rotation';
  return t.providerId + '/' + t.modelId;
}

function parseTargetValue(value) {
  if (!value || value === 'rotation') return { kind: 'rotation' };
  var slash = value.indexOf('/');
  if (slash <= 0) return { kind: 'rotation' };
  return { kind: 'model', providerId: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

function targetOptionValue(model) {
  var id = model && model.id ? String(model.id) : '';
  if (!id) return '';
  if (id.indexOf('/') > 0) return id;
  return model.owned_by ? model.owned_by + '/' + id : id;
}

/* One option per advertised target. The label prefers the catalog's own name
   ("DeepSeek V4 Pro · OpenCode Go · trusted lane 1") because a list of 1000+
   raw routes is not something a person can scan; the value stays the route. */
function buildTargetOptions() {
  var out = [];
  (state.models || []).forEach(function (m) {
    // The catalog's auto id means "the plan", which is exactly what the
    // rotation option already is — offering it again would just be the same
    // choice under a name this composer cannot route.
    if (m && m.modelhitch && m.modelhitch.kind === 'auto') return;
    var value = targetOptionValue(m);
    if (!value) return;
    var name = m && m.name ? String(m.name) : '';
    out.push({ value: value, label: name || value });
  });
  return out;
}

function renderTarget(spec) {
  var sel = el(spec.sel);
  var filterEl = el(spec.filter);
  var countEl = el(spec.count);
  if (!sel) return;
  var filter = (filterEl && filterEl.value ? filterEl.value : '').trim().toLowerCase();
  var selected = state.targetSelection[spec.sel] || state.defaultTarget || 'rotation';
  var options = [];
  var selectedVisible = false;
  state.targetOptions.forEach(function (o) {
    if (o.value === selected) selectedVisible = true;
    if (!filter || (o.value + ' ' + o.label).toLowerCase().indexOf(filter) >= 0) options.push(o);
  });
  var html = ['<option value="rotation">rotation</option>'];
  // A filter finds a target, it never changes one: if the current choice is
  // filtered out it stays at the top, labelled as the current choice.
  if (selected && selected !== 'rotation' && !selectedVisible) {
    html.push('<option value="' + esc(selected) + '">' + esc(selected) + ' (current)</option>');
  }
  options.forEach(function (o) {
    html.push('<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>');
  });
  sel.innerHTML = html.join('');
  sel.value = selected;
  if (sel.value !== selected) sel.value = 'rotation';
  state.targetSelection[spec.sel] = sel.value;
  if (countEl) {
    countEl.textContent = filter
      ? options.length + ' of ' + state.targetOptions.length + ' match'
      : state.targetOptions.length + ' targets';
  }
}

function renderTargets() { TARGETS.forEach(renderTarget); }

function renderSessions() {
  var box = el('sessions-list');
  if (!state.sessions.length) {
    box.innerHTML = '<div class="empty-state">No sessions yet</div>';
    return;
  }
  box.innerHTML = '';
  state.sessions.forEach(function (s) {
    var btn = document.createElement('button');
    btn.className = 'item' + (s.id === state.activeSessionId ? ' active' : '');
    btn.type = 'button';
    var when = relTime(s.updatedAt);
    var count = (s.messages || []).length;
    btn.innerHTML = '<div class="title">' + esc(s.title || 'Untitled') + '</div>' +
      '<div class="meta">' + esc(targetLabel(s.target)) +
      (when ? ' · ' + esc(when) : '') +
      (count ? ' · ' + count + (count === 1 ? ' message' : ' messages') : '') +
      '</div>';
    btn.addEventListener('click', function () { selectSession(s.id); });
    box.appendChild(btn);
  });
}

function renderTranscript(session) {
  var box = el('transcript');
  if (!session) {
    box.innerHTML = '<div class="empty-state">' +
      (state.draft ? 'New session — send a message to start it' : 'Select or create a session') +
      '</div>';
    return;
  }
  if (!session.messages || !session.messages.length) {
    box.innerHTML = '<div class="empty-state">No messages yet — send one below</div>';
    return;
  }
  box.innerHTML = '';
  session.messages.forEach(function (m) {
    var div = document.createElement('div');
    div.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
    var text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    div.innerHTML = '<div class="role">' + esc(m.role) + '</div><div class="body">' + esc(text) + '</div>';
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

function renderCloudAgents() {
  var box = el('cloud-agents-list');
  if (!state.cloudAgents.length) {
    box.innerHTML = '<div class="empty-state">No cloud agents</div>';
    return;
  }
  box.innerHTML = '';
  state.cloudAgents.forEach(function (agent) {
    var div = document.createElement('div');
    div.className = 'item';
    div.style.cursor = 'default';
    var status = (agent.status || 'unknown').toLowerCase();
    var pillClass = status === 'cancelled' ? 'cancelled' : status === 'running' ? 'running' : status === 'finished' ? 'done' : '';
    div.innerHTML = '<div class="title mono">' + esc(agent.id) + '</div>' +
      '<div class="meta"><span class="status-pill ' + esc(pillClass) + '">' + esc(agent.status || 'unknown') + '</span></div>';
    if (status !== 'cancelled' && status !== 'finished') {
      var btn = document.createElement('button');
      btn.className = 'btn';
      btn.type = 'button';
      btn.textContent = 'Cancel';
      btn.style.marginTop = '6px';
      btn.addEventListener('click', function () { cancelCloudAgent(agent.id); });
      div.appendChild(btn);
    }
    box.appendChild(div);
  });
}

async function loadCloudAgents() {
  try {
    var body = await api('/v1/cloud-agents');
    state.cloudAgents = body.agents || [];
    renderCloudAgents();
  } catch (err) {
    state.cloudAgents = [];
    var box = el('cloud-agents-list');
    // The lane is opt-in. A bridge without it is a state to explain, not a
    // failure to shout about — the server's own sentence already says how to
    // turn it on.
    if (err.status === 403 || err.status === 501) {
      box.innerHTML = '<div class="info-state">' + esc(err.message) + '</div>';
    } else {
      box.innerHTML = '<div class="info-state">Could not read cloud agents: ' + esc(err.message) + '</div>';
    }
  }
  scheduleRefresh();
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

function renderWorkOrders() {
  var box = el('work-orders-list');
  if (!state.workOrders.length) {
    box.innerHTML = '<div class="empty-state">No work orders yet</div>';
    return;
  }
  box.innerHTML = '';
  // Newest first, like the sessions rail. Ordered by when it was submitted
  // rather than by updatedAt, so a long-running order keeps its place instead
  // of jumping to the top every time its status changes.
  state.workOrders.slice().sort(function (a, b) {
    return String(b.createdAt || b.updatedAt || '').localeCompare(String(a.createdAt || a.updatedAt || ''));
  }).forEach(function (wo) {
    var div = document.createElement('div');
    div.className = 'item';
    div.style.cursor = 'default';
    var preview = (wo.prompt || '').slice(0, 60);
    var when = relTime(wo.createdAt || wo.updatedAt);
    var detail = wo.status === 'failed' && wo.error ? wo.error : wo.status === 'done' ? wo.result : '';
    div.innerHTML = '<div class="title mono">' + esc(wo.id) + '</div>' +
      '<div class="meta"><span class="status-pill ' + esc(wo.status) + '">' + esc(wo.status) + '</span>' +
      (when ? ' ' + esc(when) : '') + '</div>' +
      '<div class="meta">' + esc(preview) + (wo.prompt && wo.prompt.length > 60 ? '…' : '') + '</div>' +
      (detail ? '<div class="meta">' + esc(String(detail).slice(0, 80)) + '</div>' : '');
    box.appendChild(div);
  });
}

async function reloadLists(options) {
  var quiet = !!(options && options.quiet);
  try {
    var sessionsBody = await api('/v1/sessions');
    var ordersBody = await api('/v1/work-orders');
    state.sessions = sessionsBody.sessions || [];
    state.workOrders = ordersBody.workOrders || [];
    renderSessions();
    renderWorkOrders();
    if (state.activeSessionId) {
      try {
        var session = await api('/v1/sessions/' + encodeURIComponent(state.activeSessionId));
        renderTranscript(session);
      } catch (err) {
        state.activeSessionId = null;
        state.draft = false;
        renderTranscript(null);
      }
    }
  } catch (err) {
    if (!quiet) showErrors(['Reload failed: ' + err.message]);
  }
  scheduleRefresh();
}

/*
 * Nothing here is streamed, so a chat in flight or a queued work order has no
 * push to wait on. Poll only while something is actually pending, and stop as
 * soon as everything is final — an idle workspace stays quiet.
 */
function scheduleRefresh() {
  clearTimeout(state.pollTimer);
  var busyOrders = (state.workOrders || []).some(function (wo) { return isActiveStatus(wo.status); });
  var busyAgents = (state.cloudAgents || []).some(function (a) { return isActiveStatus(a.status); });
  if (!busyOrders && !busyAgents) return;
  state.pollTimer = setTimeout(function () {
    reloadLists({ quiet: true }).catch(function () { /* a failed poll is not an error state */ });
    if (busyAgents) loadCloudAgents().catch(function () { /* same */ });
  }, 4000);
}

async function selectSession(id) {
  state.activeSessionId = id;
  state.draft = false;
  renderSessions();
  var session = await api('/v1/sessions/' + encodeURIComponent(id));
  renderTranscript(session);
  state.targetSelection['chat-target'] = targetLabel(session.target);
  renderTargets();
}

async function loadBoot() {
  try {
    var config = await api('/v1/config');
    state.defaultTarget = config.defaultWorkspaceTarget || 'rotation';
    state.targetSelection['chat-target'] = state.defaultTarget;
    state.targetSelection['wo-target'] = state.defaultTarget;
    var models = await api('/v1/models');
    state.models = models.data || [];
    state.targetOptions = buildTargetOptions();
    renderTargets();
    await reloadLists({ quiet: true });
    await loadCloudAgents();
  } catch (err) {
    showErrors(['Failed to load workspace: ' + err.message]);
  }
  syncComposer();
  el('chat-prompt').focus();
}

/* The server titles a session from its first prompt, so nothing is named
   "Untitled"/"New session" in the rail just because it was created early. */
async function createSession(target) {
  var session = await api('/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: target || parseTargetValue(el('chat-target').value) })
  });
  state.activeSessionId = session.id;
  state.draft = false;
  return session;
}

/* Start a draft instead of filing an empty session: a session is created when
   it has something to say. */
function newSession() {
  state.activeSessionId = null;
  state.draft = true;
  renderSessions();
  renderTranscript(null);
  showErrors([]);
  el('chat-prompt').focus();
}

function syncComposer() {
  el('send-message').disabled = state.sending || !el('chat-prompt').value.trim();
  el('submit-work-order').disabled = state.submitting || !el('wo-prompt').value.trim();
}

function clearPending() {
  var node = el('pending-msg');
  if (node) node.remove();
}

/* Show the wait where the answer will land, naming the target it is waiting
   on — a chat call is a network round trip, not an instant. */
function showPending() {
  clearPending();
  var box = el('transcript');
  var target = targetLabel(parseTargetValue(el('chat-target').value));
  var div = document.createElement('div');
  div.className = 'msg assistant pending';
  div.id = 'pending-msg';
  div.innerHTML = '<div class="role">assistant</div><div class="body pulse">waiting on ' + esc(target) + '…</div>';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* Back to rest the moment the answer is on screen: the list reload that
   follows is bookkeeping, and it should not hold the compose box hostage. */
function finishSending() {
  state.sending = false;
  el('send-message').textContent = 'Send';
  clearPending();
  syncComposer();
  el('chat-prompt').focus();
}

function finishSubmitting() {
  state.submitting = false;
  el('submit-work-order').textContent = 'Work order';
  syncComposer();
}

async function sendMessage() {
  showErrors([]);
  var prompt = el('chat-prompt').value.trim();
  if (!prompt || state.sending) return;
  state.sending = true;
  syncComposer();
  el('send-message').textContent = 'Sending…';
  showPending();
  try {
    var target = parseTargetValue(el('chat-target').value);
    if (!state.activeSessionId) await createSession(target);
    var session = await api('/v1/sessions/' + encodeURIComponent(state.activeSessionId) + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt })
    });
    el('chat-prompt').value = '';
    autoGrow(el('chat-prompt'));
    renderTranscript(session);
    finishSending();
    await reloadLists({ quiet: true });
  } catch (err) {
    // The prompt stays in the box: a failed send should cost a retry, not a
    // retype.
    showErrors(['Send failed: ' + err.message]);
  } finally {
    finishSending();
  }
}

async function submitWorkOrder() {
  showErrors([]);
  var prompt = el('wo-prompt').value.trim();
  if (!prompt || state.submitting) return;
  state.submitting = true;
  syncComposer();
  el('submit-work-order').textContent = 'Submitting…';
  try {
    var target = parseTargetValue(el('wo-target').value);
    await api('/v1/work-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, target: target })
    });
    el('wo-prompt').value = '';
    autoGrow(el('wo-prompt'));
    finishSubmitting();
    await reloadLists({ quiet: true });
  } catch (err) {
    showErrors(['Work order failed: ' + err.message]);
  } finally {
    finishSubmitting();
  }
}

function reload(what) {
  return function () {
    var job = what === 'agents' ? loadCloudAgents() : reloadLists();
    job.catch(function (err) { showErrors(['Reload failed: ' + err.message]); });
  };
}

el('new-session').addEventListener('click', newSession);
el('refresh-sessions').addEventListener('click', reload('lists'));
el('refresh-work-orders').addEventListener('click', reload('lists'));
el('refresh-cloud-agents').addEventListener('click', reload('agents'));
el('send-message').addEventListener('click', sendMessage);
el('submit-work-order').addEventListener('click', submitWorkOrder);
el('chat-prompt').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); sendMessage(); }
});
el('wo-prompt').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submitWorkOrder(); }
});
el('chat-prompt').addEventListener('input', function () {
  autoGrow(el('chat-prompt'));
  syncComposer();
});
el('wo-prompt').addEventListener('input', function () {
  autoGrow(el('wo-prompt'));
  syncComposer();
});
TARGETS.forEach(function (spec) {
  el(spec.filter).addEventListener('input', function () {
    state.targetSelection[spec.sel] = el(spec.sel).value;
    renderTarget(spec);
  });
  el(spec.sel).addEventListener('change', function () {
    state.targetSelection[spec.sel] = el(spec.sel).value;
  });
});

syncComposer();
loadBoot();
</script>
</body>
</html>`;
}
