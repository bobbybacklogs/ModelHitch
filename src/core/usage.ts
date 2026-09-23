import type { FailoverEvent } from './failover.js';
import type { UsageStorage } from './usage-storage.js';

/**
 * Usage tracking for the local dashboard.
 *
 * The server records every completed inference request (via `onUsage`) and
 * every auto-mode failover into a `UsageTracker`. Snapshots aggregate totals
 * and per-provider/model/wire breakdowns for the retained history and for
 * rolling periods (24h / 7d / 30d). These are observed counts, not quotas.
 */

/** One completed inference request, as reported to the `onUsage` hook. */
export interface UsageEvent {
  /** Provider id, e.g. "vercel-ai-gateway". */
  providerId: string;
  /** Routed model id. */
  model: string;
  /** Wire that served the request: chat-completions | responses | messages | gemini. */
  wire: string;
  /** True when the client requested SSE streaming. */
  streamed: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated USD (best-effort list pricing; 0 for free/unknown). */
  costUsd: number;
  /** Wall time from request start to completion, ms. */
  latencyMs: number;
  /** ISO timestamp. */
  at: string;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated USD (best-effort list pricing; 0 for free/unknown). */
  costUsd: number;
  latencyMs: number;
}

/** Totals plus the same breakdowns, scoped to one period. */
export interface UsageSlice {
  totals: UsageTotals;
  perProvider: Record<string, UsageTotals>;
  /** Keyed by `providerId/model`. */
  perModel: Record<string, UsageTotals>;
  perWire: Record<string, UsageTotals>;
}

export interface UsageSnapshot {
  /** ISO timestamp of the first recorded event (or tracker creation). */
  since: string;
  /** True when history is persisted (SQLite) and survives restarts. */
  persisted: boolean;
  totals: UsageTotals;
  perProvider: Record<string, UsageTotals>;
  /** Keyed by `providerId/model`. */
  perModel: Record<string, UsageTotals>;
  perWire: Record<string, UsageTotals>;
  /** Most recent events, newest first. */
  recent: UsageEvent[];
  failovers: { total: number; recent: FailoverEvent[] };
  /**
   * Observed spend. `all` is retained history. The others are rolling
   * periods ending now. There is no dollar cap.
   */
  periods: { all: UsageSlice; '24h': UsageSlice; '7d': UsageSlice; '30d': UsageSlice };
}

const MAX_EVENTS = 10_000;
const MAX_FAILOVERS = 200;

export class UsageTracker {
  private events: UsageEvent[] = [];
  private failoverEvents: FailoverEvent[] = [];
  private since = new Date();
  private readonly storage?: UsageStorage;

  /**
   * @param storage Optional durable sink. When provided, history is loaded on
   *   construction and mirrored on every record, so it survives restarts.
   */
  constructor(storage?: UsageStorage) {
    this.storage = storage;
    if (storage) {
      const loaded = storage.load();
      this.events = loaded.events.slice(-MAX_EVENTS);
      this.failoverEvents = loaded.failovers.slice(-MAX_FAILOVERS);
      this.since = this.events.length > 0 ? new Date(this.events[0]!.at) : new Date();
    }
  }

  /** True when history is persisted (SQLite) and survives restarts. */
  get persisted(): boolean {
    return this.storage != null;
  }

  record(event: UsageEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.storage?.append(event);
  }

  recordFailover(event: FailoverEvent): void {
    this.failoverEvents.push(event);
    if (this.failoverEvents.length > MAX_FAILOVERS) {
      this.failoverEvents.splice(0, this.failoverEvents.length - MAX_FAILOVERS);
    }
    this.storage?.appendFailover(event);
  }

  reset(): void {
    this.events = [];
    this.failoverEvents = [];
    this.since = new Date();
    this.storage?.clear();
  }

  /** Close the backing storage (no-op for in-memory trackers). */
  close(): void {
    this.storage?.close();
  }

  totals(events: readonly UsageEvent[] = this.events): UsageTotals {
    let requests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;
    let costUsd = 0;
    let latencyMs = 0;
    for (const e of events) {
      requests += 1;
      inputTokens += e.inputTokens ?? 0;
      outputTokens += e.outputTokens ?? 0;
      totalTokens += e.totalTokens ?? 0;
      costUsd += e.costUsd ?? 0;
      latencyMs += e.latencyMs ?? 0;
    }
    return { requests, inputTokens, outputTokens, totalTokens, costUsd, latencyMs };
  }

  private group(events: readonly UsageEvent[], key: (e: UsageEvent) => string): Record<string, UsageTotals> {
    const groups = new Map<string, UsageEvent[]>();
    for (const e of events) {
      const k = key(e);
      const list = groups.get(k);
      if (list) list.push(e);
      else groups.set(k, [e]);
    }
    const out: Record<string, UsageTotals> = {};
    for (const [k, list] of groups) out[k] = this.totals(list);
    return out;
  }

  private slice(events: readonly UsageEvent[]): UsageSlice {
    return {
      totals: this.totals(events),
      perProvider: this.group(events, (e) => e.providerId),
      perModel: this.group(events, (e) => `${e.providerId}/${e.model}`),
      perWire: this.group(events, (e) => e.wire),
    };
  }

  private sinceHours(hours: number): UsageEvent[] {
    const cutoff = Date.now() - hours * 3_600_000;
    return this.events.filter((e) => Date.parse(e.at) >= cutoff);
  }

  snapshot(): UsageSnapshot {
    const all = this.slice(this.events);
    return {
      since: this.since.toISOString(),
      persisted: this.persisted,
      totals: all.totals,
      perProvider: all.perProvider,
      perModel: all.perModel,
      perWire: all.perWire,
      recent: this.events.slice(-50).reverse(),
      failovers: {
        total: this.failoverEvents.length,
        recent: this.failoverEvents.slice(-20).reverse(),
      },
      periods: {
        all,
        '24h': this.slice(this.sinceHours(24)),
        '7d': this.slice(this.sinceHours(24 * 7)),
        '30d': this.slice(this.sinceHours(24 * 30)),
      },
    };
  }
}

/** Self-contained dashboard served by the bridge at `GET /usage`. */
export function usageDashboardHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ModelHitch — usage</title>
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
  .rail-side { width: 260px; flex-shrink: 0; border-right: 1px solid var(--line); display: flex; flex-direction: column; background: var(--panel); }
  .rail-side.right { width: 320px; border-right: 0; border-left: 1px solid var(--line); }
  .rail-center { flex: 1; min-width: 0; display: flex; flex-direction: column; background: var(--bg); }
  .rail-head { padding: 10px 14px; border-bottom: 1px solid var(--line); font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
  .rail-head .hint { color: var(--muted); letter-spacing: 0; text-transform: none; font-weight: 400; font-size: 12px; }
  .rail-body { flex: 1; overflow-y: auto; padding: 8px; }
  .rail-foot { padding: 8px; border-top: 1px solid var(--line); }

  .item { display: block; width: 100%; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 4px; padding: 8px 10px; margin-bottom: 4px; cursor: pointer; color: var(--text); font-family: var(--sans); font-size: 13px; }
  .item:hover { background: var(--panel2); border-color: var(--line); }
  .item.active { background: var(--raised); border-color: var(--accent-dim); }
  .item .title { font-family: var(--mono); font-size: 12px; }
  .item .meta { font-size: 11px; color: var(--muted); margin-top: 2px; }

  .center-scroll { flex: 1; overflow-y: auto; padding: 16px 20px 28px; }
  .lede { color: var(--muted); font-size: 12px; margin: 0 0 14px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 16px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; }
  .stat .k { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
  .stat .v { font-family: var(--mono); font-size: 18px; margin-top: 4px; }

  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 4px 12px 8px; margin-bottom: 14px; }
  .panel h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); margin: 10px 0 6px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); padding: 6px 8px; border-bottom: 1px solid var(--line2); font-weight: 600; }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td.mono { font-family: var(--mono); font-size: 12px; }
  .share { height: 3px; background: var(--raised); border-radius: 2px; margin-top: 6px; }
  .share > span { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
  .wires { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .pill { display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; border: 1px solid var(--line2); border-radius: 3px; padding: 2px 7px; background: var(--panel2); color: var(--text); }
  .pill.warn { color: var(--warn); border-color: var(--warn); }
  .pill.bad { color: var(--bad); border-color: var(--bad); }
  .pill.muted { color: var(--muted); }

  .event { padding: 8px 10px; border-bottom: 1px solid var(--line); }
  .event:last-child { border-bottom: 0; }
  .event .title { font-family: var(--mono); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .event .meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .event.stale { opacity: 0.55; }
  .empty-state { color: var(--muted); font-style: italic; padding: 12px 10px; }

  .btn {
    background: transparent; color: var(--text); border: 1px solid var(--line2); border-radius: 4px;
    padding: 8px 14px; font-size: 12px; cursor: pointer; font-family: var(--sans); width: 100%;
  }
  .btn:hover { border-color: var(--bad); color: var(--bad); }
  .btn:disabled { opacity: 0.45; cursor: default; }

  #errors { display: none; background: #2a1813; border: 1px solid var(--bad); color: #e8b7a4; border-radius: 6px; padding: 8px 12px; font-size: 13px; margin: 8px 16px; white-space: pre-line; }

  @media (max-width: 960px) {
    .rail { flex-direction: column; height: auto; }
    .rail-side, .rail-side.right { width: auto; border-right: 0; border-left: 0; border-bottom: 1px solid var(--line); }
    .rail-body { max-height: 280px; }
  }
</style>
</head>
<body>
<header>
  <div class="bar">
    <span class="wordmark">model<b>hitch</b></span>
    <span class="local-badge">usage · local</span>
    <span class="spacer"></span>
    <span class="linkbar"><a href="/workspace">workspace</a> · <a href="/settings">settings</a></span>
  </div>
</header>
<div id="errors"></div>
<div class="rail">
  <aside class="rail-side">
    <div class="rail-head">Range</div>
    <div class="rail-body" id="ranges"></div>
  </aside>
  <section class="rail-center">
    <div class="center-scroll" id="detail"><div class="empty-state">Loading…</div></div>
  </section>
  <aside class="rail-side right">
    <div class="rail-head">Recent <span class="hint" id="recent-count"></span></div>
    <div class="rail-body" id="recent"><div class="empty-state">No requests yet</div></div>
    <div class="rail-head">Failovers <span class="hint" id="fail-count"></span></div>
    <div class="rail-body" id="fails"><div class="empty-state">No failovers yet</div></div>
    <div class="rail-foot">
      <button class="btn" id="clear-history" type="button">Clear history</button>
    </div>
  </aside>
</div>
<script>
"use strict";
var RANGES = [
  { id: "all", label: "All recorded", hours: 0 },
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", hours: 24 * 7 },
  { id: "30d", label: "Last 30 days", hours: 24 * 30 }
];
var range = "all";
var snap = null;
var lastPaint = "";

function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function fmtMoney(n) { return "$" + Number(n || 0).toFixed(2); }
function fmtI(n) { return Math.round(Number(n) || 0).toLocaleString("en-US"); }
function fmtMs(ms) {
  var n = Number(ms) || 0;
  if (n < 1000) return Math.round(n) + " ms";
  return (n / 1000).toFixed(1) + " s";
}
function timeAgo(iso) {
  var ms = Date.now() - new Date(iso).getTime();
  var s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  var m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  var h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  var d = Math.round(h / 24);
  if (d < 30) return d + "d ago";
  return Math.round(d / 30) + "mo ago";
}
function inRange(iso) {
  var spec = RANGES.filter(function (r) { return r.id === range; })[0];
  if (!spec || !spec.hours) return true;
  return Date.now() - new Date(iso).getTime() <= spec.hours * 3600000;
}
function avgMs(totals) {
  if (!totals || !totals.requests) return 0;
  return totals.latencyMs / totals.requests;
}
function rows(record, limit) {
  return Object.entries(record || {}).sort(function (a, b) {
    return (b[1].costUsd - a[1].costUsd) || (b[1].requests - a[1].requests);
  }).slice(0, limit || 100);
}
function shareWidth(part, whole) {
  if (!whole) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}

function renderRanges() {
  var box = el("ranges");
  box.innerHTML = "";
  RANGES.forEach(function (spec) {
    var slice = snap && snap.periods ? snap.periods[spec.id] : null;
    var totals = slice ? slice.totals : { requests: 0, costUsd: 0 };
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "item" + (spec.id === range ? " active" : "");
    btn.innerHTML = '<div class="title">' + esc(spec.label) + '</div>' +
      '<div class="meta">' + fmtI(totals.requests) + " requests · " + fmtMoney(totals.costUsd) + "</div>";
    btn.addEventListener("click", function () {
      range = spec.id;
      lastPaint = "";
      render();
    });
    box.appendChild(btn);
  });
}

function renderDetail() {
  var slice = snap.periods[range];
  var totals = slice.totals;
  var spec = RANGES.filter(function (r) { return r.id === range; })[0];
  var since = "since " + new Date(snap.since).toLocaleString();
  var persist = snap.persisted ? " · saved in SQLite" : "";
  var providerRows = rows(slice.perProvider);
  var modelRows = rows(slice.perModel, 20);
  var wireRows = rows(slice.perWire);
  var denom = totals.costUsd > 0 ? totals.costUsd : totals.requests;
  var useCost = totals.costUsd > 0;
  var body = providerRows.length
    ? providerRows.map(function (pair) {
        var id = pair[0];
        var v = pair[1];
        var part = useCost ? v.costUsd : v.requests;
        return "<tr><td class=\"mono\">" + esc(id) +
          '<div class="share"><span style="width:' + shareWidth(part, denom) + '%"></span></div></td>' +
          "<td>" + fmtI(v.requests) + "</td><td>" + fmtI(v.inputTokens) + " / " + fmtI(v.outputTokens) +
          "</td><td>" + fmtMoney(v.costUsd) + "</td><td>" + fmtMs(avgMs(v)) + "</td></tr>";
      }).join("")
    : '<tr><td colspan="5" class="empty-state">No requests in this range</td></tr>';
  var models = modelRows.length
    ? modelRows.map(function (pair) {
        var v = pair[1];
        return "<tr><td class=\"mono\">" + esc(pair[0]) + "</td><td>" + fmtI(v.requests) +
          "</td><td>" + fmtI(v.totalTokens) + "</td><td>" + fmtMoney(v.costUsd) +
          "</td><td>" + fmtMs(avgMs(v)) + "</td></tr>";
      }).join("")
    : '<tr><td colspan="5" class="empty-state">No requests in this range</td></tr>';
  var wires = wireRows.length
    ? wireRows.map(function (pair) {
        return '<span class="pill">' + esc(pair[0]) + " · " + fmtI(pair[1].requests) + "</span>";
      }).join("")
    : "";
  el("detail").innerHTML =
    '<p class="lede">' + esc(spec.label) + " · " + esc(since) + esc(persist) +
    ". Estimated from list prices. Models without a price count as $0. No quota.</p>" +
    '<div class="stats">' +
      '<div class="stat"><div class="k">Requests</div><div class="v">' + fmtI(totals.requests) + "</div></div>" +
      '<div class="stat"><div class="k">Tokens in</div><div class="v">' + fmtI(totals.inputTokens) + "</div></div>" +
      '<div class="stat"><div class="k">Tokens out</div><div class="v">' + fmtI(totals.outputTokens) + "</div></div>" +
      '<div class="stat"><div class="k">Est. cost</div><div class="v">' + fmtMoney(totals.costUsd) + "</div></div>" +
      '<div class="stat"><div class="k">Avg latency</div><div class="v">' + fmtMs(avgMs(totals)) + "</div></div>" +
    "</div>" +
    (wires ? '<div class="wires">' + wires + "</div>" : "") +
    '<div class="panel"><h2>Providers</h2><table><thead><tr><th>Provider</th><th>Requests</th><th>Tokens in / out</th><th>Est. cost</th><th>Avg</th></tr></thead><tbody>' +
      body + "</tbody></table></div>" +
    '<div class="panel"><h2>Models</h2><table><thead><tr><th>Model</th><th>Requests</th><th>Tokens</th><th>Est. cost</th><th>Avg</th></tr></thead><tbody>' +
      models + "</tbody></table></div>";
}

function renderRecent() {
  var list = (snap.recent || []).filter(function (e) { return inRange(e.at); });
  el("recent-count").textContent = list.length ? String(list.length) : "";
  var box = el("recent");
  if (!list.length) {
    box.innerHTML = '<div class="empty-state">No requests in this range</div>';
    return;
  }
  box.innerHTML = list.map(function (e) {
    return '<div class="event"><div class="title">' + esc(e.providerId) + "/" + esc(e.model) + "</div>" +
      '<div class="meta">' + esc(timeAgo(e.at)) + " · " + esc(e.wire) + (e.streamed ? " · stream" : "") +
      " · " + fmtI(e.totalTokens) + " tok · " + fmtMoney(e.costUsd) + " · " + fmtMs(e.latencyMs) + "</div></div>";
  }).join("");
}

function renderFails() {
  var STALE_MS = 60 * 60 * 1000;
  var list = (snap.failovers.recent || []).filter(function (f) { return inRange(f.at); });
  el("fail-count").textContent = snap.failovers.total ? String(snap.failovers.total) + " total" : "";
  var box = el("fails");
  if (!list.length) {
    box.innerHTML = '<div class="empty-state">No failovers in this range</div>';
    return;
  }
  box.innerHTML = list.map(function (f) {
    var code = (f.error && f.error.code) || "other";
    var pill = code === "rate-limited" ? "warn" : (code === "provider-error" || code === "network-error" ? "bad" : "muted");
    var stale = Date.now() - new Date(f.at).getTime() > STALE_MS;
    var status = f.error && f.error.status ? " " + f.error.status : "";
    return '<div class="event' + (stale ? " stale" : "") + '"><div class="title">' +
      esc(f.from.providerId) + "/" + esc(f.from.model) + " → " + esc(f.to.providerId) + "/" + esc(f.to.model) +
      '</div><div class="meta">' + esc(timeAgo(f.at)) + ' <span class="pill ' + pill + '">' + esc(code) + esc(status) + "</span></div></div>";
  }).join("");
}

function render() {
  if (!snap) return;
  var key = range + JSON.stringify(snap);
  if (key === lastPaint) return;
  lastPaint = key;
  renderRanges();
  renderDetail();
  renderRecent();
  renderFails();
}

async function tick() {
  try {
    var res = await fetch("/v1/usage");
    if (!res.ok) throw new Error("HTTP " + res.status);
    snap = await res.json();
    el("errors").style.display = "none";
    render();
  } catch (e) {
    var box = el("errors");
    box.style.display = "block";
    box.textContent = "Bridge unreachable: " + e;
  }
}

el("clear-history").addEventListener("click", async function () {
  if (!confirm("Clear all usage stats and failover history? This cannot be undone.")) return;
  var btn = el("clear-history");
  btn.disabled = true;
  try {
    await fetch("/v1/usage/reset", { method: "POST" });
    lastPaint = "";
  } finally {
    btn.disabled = false;
    tick();
  }
});

tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;
}

