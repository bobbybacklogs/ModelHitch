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
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 14px; line-height: 1.45; }
  code, .mono { font-family: var(--mono); font-size: 0.92em; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { background: color-mix(in srgb, var(--bg) 92%, transparent); border-bottom: 1px solid var(--line); }
  .bar { padding: 14px 20px; display: flex; align-items: baseline; gap: 12px; }
  .wordmark { font-family: var(--mono); font-weight: 700; letter-spacing: 0.04em; font-size: 15px; color: var(--text); }
  .wordmark b { color: var(--accent); }
  .local-badge { font-size: 11px; color: var(--muted); border: 1px solid var(--line2); border-radius: 3px; padding: 2px 7px; font-family: var(--mono); }
  .spacer { flex: 1; }
  .linkbar { font-size: 12px; color: var(--muted); }

  .rail { display: flex; height: calc(100vh - 52px); }
  .rail-side { width: 280px; flex-shrink: 0; border-right: 1px solid var(--line); display: flex; flex-direction: column; background: var(--panel); }
  .rail-side.right { border-right: 0; border-left: 1px solid var(--line); }
  .rail-center { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg); }
  .rail-head { padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); font-weight: 600; }
  .rail-body { flex: 1; overflow-y: auto; padding: 8px; }

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
  textarea, select {
    background: var(--raised); color: var(--text); border: 1px solid var(--line2); border-radius: 4px;
    padding: 8px 10px; font-family: var(--sans); font-size: 13px; width: 100%;
  }
  textarea { min-height: 72px; resize: vertical; font-family: var(--sans); }
  textarea:focus, select:focus { outline: none; border-color: var(--accent-dim); }
  .btn {
    background: transparent; color: var(--text); border: 1px solid var(--line2); border-radius: 4px;
    padding: 8px 14px; font-size: 12px; cursor: pointer; font-family: var(--sans); white-space: nowrap;
  }
  .btn:hover { border-color: var(--accent-dim); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #14130e; font-weight: 600; }
  .btn.primary:hover { background: #c9b47c; }
  .btn:disabled { opacity: 0.45; cursor: default; }

  .status-pill { display: inline-block; font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; border-radius: 3px; padding: 1px 6px; border: 1px solid var(--line2); }
  .status-pill.running { color: var(--warn); border-color: var(--warn); }
  .status-pill.done { color: var(--ok); border-color: var(--ok); }
  .status-pill.failed { color: var(--bad); border-color: var(--bad); }
  .status-pill.cancelled { color: var(--muted); }

  #errors { display: none; background: #2a1813; border: 1px solid var(--bad); color: #e8b7a4; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin: 8px 16px; white-space: pre-line; }
</style>
</head>
<body>
<header>
  <div class="bar">
    <span class="wordmark">model<b>hitch</b></span>
    <span class="local-badge">workspace · local</span>
    <span class="spacer"></span>
    <span class="linkbar"><a href="/settings">settings</a> · <a href="/usage" target="_blank">usage</a></span>
  </div>
</header>

<div id="errors"></div>

<div class="rail">
  <aside class="rail-side">
    <div class="rail-head">Sessions</div>
    <div class="rail-body" id="sessions-list"><div class="empty-state">No sessions yet</div></div>
    <div style="padding:8px;border-top:1px solid var(--line)">
      <button class="btn" id="new-session" style="width:100%">+ New session</button>
    </div>
  </aside>

  <section class="rail-center">
    <div class="transcript" id="transcript"><div class="empty-state">Select or create a session</div></div>
    <div class="composer">
      <div class="composer-row">
        <div>
          <label for="chat-target">target</label>
          <select id="chat-target" style="width:200px"></select>
        </div>
        <div class="grow">
          <label for="chat-prompt">message</label>
          <textarea id="chat-prompt" placeholder="Send a message…"></textarea>
        </div>
        <button class="btn primary" id="send-message">Send</button>
      </div>
    </div>
  </section>

  <aside class="rail-side right">
    <div class="rail-head">Work orders</div>
    <div class="rail-body" id="work-orders-list"><div class="empty-state">No work orders yet</div></div>
    <div class="composer" style="border-top:1px solid var(--line)">
      <div class="composer-row" style="flex-direction:column;align-items:stretch">
        <div>
          <label for="wo-target">target</label>
          <select id="wo-target"></select>
        </div>
        <div>
          <label for="wo-prompt">prompt</label>
          <textarea id="wo-prompt" placeholder="One-shot task…" style="min-height:56px"></textarea>
        </div>
        <button class="btn primary" id="submit-work-order">Work order</button>
      </div>
    </div>
    <div class="rail-head" style="border-top:1px solid var(--line)">Cloud agents</div>
    <div class="rail-body"><div class="empty-state">None connected</div></div>
  </aside>
</div>

<script>
"use strict";
var state = { sessions: [], workOrders: [], models: [], activeSessionId: null, defaultTarget: 'rotation' };

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

function fillTargetSelect(sel, selected) {
  var opts = ['<option value="rotation">rotation</option>'];
  (state.models || []).forEach(function (m) {
    var val = m.id;
    opts.push('<option value="' + esc(val) + '"' + (val === selected ? ' selected' : '') + '>' + esc(val) + '</option>');
  });
  sel.innerHTML = opts.join('');
  if (selected && selected !== 'rotation') sel.value = selected;
}

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
    btn.innerHTML = '<div class="title">' + esc(s.title || 'Untitled') + '</div>' +
      '<div class="meta">' + esc(targetLabel(s.target)) + '</div>';
    btn.addEventListener('click', function () { selectSession(s.id); });
    box.appendChild(btn);
  });
}

function renderTranscript(session) {
  var box = el('transcript');
  if (!session) {
    box.innerHTML = '<div class="empty-state">Select or create a session</div>';
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

function renderWorkOrders() {
  var box = el('work-orders-list');
  if (!state.workOrders.length) {
    box.innerHTML = '<div class="empty-state">No work orders yet</div>';
    return;
  }
  box.innerHTML = '';
  state.workOrders.slice().reverse().forEach(function (wo) {
    var div = document.createElement('div');
    div.className = 'item';
    div.style.cursor = 'default';
    var preview = (wo.prompt || '').slice(0, 60);
    div.innerHTML = '<div class="title">' + esc(preview) + (wo.prompt && wo.prompt.length > 60 ? '…' : '') + '</div>' +
      '<div class="meta"><span class="status-pill ' + esc(wo.status) + '">' + esc(wo.status) + '</span> ' + esc(targetLabel(wo.target)) + '</div>';
    box.appendChild(div);
  });
}

async function reloadLists() {
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
      renderTranscript(null);
    }
  }
}

async function selectSession(id) {
  state.activeSessionId = id;
  renderSessions();
  var session = await api('/v1/sessions/' + encodeURIComponent(id));
  renderTranscript(session);
  fillTargetSelect(el('chat-target'), targetLabel(session.target));
}

async function loadBoot() {
  try {
    var config = await api('/v1/config');
    state.defaultTarget = config.defaultWorkspaceTarget || 'rotation';
    var models = await api('/v1/models');
    state.models = models.data || [];
    fillTargetSelect(el('chat-target'), state.defaultTarget);
    fillTargetSelect(el('wo-target'), state.defaultTarget);
    await reloadLists();
  } catch (err) {
    showErrors(['Failed to load workspace: ' + err.message]);
  }
}

async function createSession() {
  var target = parseTargetValue(el('chat-target').value);
  var session = await api('/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'New session', target: target })
  });
  state.activeSessionId = session.id;
  await reloadLists();
  renderTranscript(session);
}

async function sendMessage() {
  showErrors([]);
  var prompt = el('chat-prompt').value.trim();
  if (!prompt) return;
  var btn = el('send-message');
  btn.disabled = true;
  try {
    if (!state.activeSessionId) await createSession();
    var session = await api('/v1/sessions/' + encodeURIComponent(state.activeSessionId) + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt })
    });
    el('chat-prompt').value = '';
    renderTranscript(session);
    await reloadLists();
  } catch (err) {
    showErrors(['Send failed: ' + err.message]);
  } finally {
    btn.disabled = false;
  }
}

async function submitWorkOrder() {
  showErrors([]);
  var prompt = el('wo-prompt').value.trim();
  if (!prompt) return;
  var btn = el('submit-work-order');
  btn.disabled = true;
  try {
    var target = parseTargetValue(el('wo-target').value);
    await api('/v1/work-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt, target: target })
    });
    el('wo-prompt').value = '';
    await reloadLists();
  } catch (err) {
    showErrors(['Work order failed: ' + err.message]);
  } finally {
    btn.disabled = false;
  }
}

el('new-session').addEventListener('click', function () {
  state.activeSessionId = null;
  renderTranscript(null);
  createSession().catch(function (err) { showErrors([err.message]); });
});
el('send-message').addEventListener('click', sendMessage);
el('submit-work-order').addEventListener('click', submitWorkOrder);
el('chat-prompt').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); sendMessage(); }
});

loadBoot();
</script>
</body>
</html>`;
}
