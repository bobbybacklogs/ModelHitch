#!/usr/bin/env node
/**
 * hitch-openai — OpenAI-compat Hitch API MCP server (stdio NDJSON JSON-RPC).
 * Zero npm deps. Node 18+ `fetch`. Logs on stderr only.
 */
"use strict";

const readline = require("readline");

const SERVER_NAME = "hitch-openai";
const SERVER_VERSION = "1.0.0";
const DEFAULT_BASE_URL = "https://hitch.genoventures.com/v1";
const USER_AGENT = `${SERVER_NAME}-mcp/${SERVER_VERSION}`;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const ALLOWED_TOOLS = ["hitch_list_models", "hitch_chat_completions"];

// ---------------------------------------------------------------------------
// Config / auth
// ---------------------------------------------------------------------------

function isUnsetToken(raw) {
  if (raw == null) return true;
  const token = String(raw).trim();
  if (!token) return true;
  if (
    token === "${HITCH_API_KEY}" ||
    token === "${OPENAI_API_KEY}" ||
    token === "${env:HITCH_API_KEY}" ||
    token === "${env:OPENAI_API_KEY}"
  ) {
    return true;
  }
  return false;
}

function resolveApiKey() {
  const hitch = process.env.HITCH_API_KEY;
  if (!isUnsetToken(hitch)) return String(hitch).trim();
  const openai = process.env.OPENAI_API_KEY;
  if (!isUnsetToken(openai)) return String(openai).trim();
  return "";
}

function requireApiKey() {
  const key = resolveApiKey();
  if (!key) {
    throw new Error(
      "Missing Hitch API key. Set HITCH_API_KEY (preferred) or OPENAI_API_KEY to a real Bearer token. Unexpanded ${HITCH_API_KEY} is treated as missing. Chat is never called without a token."
    );
  }
  return key;
}

function resolveBaseUrl() {
  let raw = process.env.HITCH_BASE_URL;
  if (
    raw == null ||
    String(raw).trim() === "" ||
    String(raw).trim() === "${HITCH_BASE_URL}"
  ) {
    raw = DEFAULT_BASE_URL;
  }
  // Strip trailing slashes. Caller supplies a full OpenAI-compat base that
  // already includes /v1 once — we never append another /v1.
  return String(raw).trim().replace(/\/+$/, "");
}

function apiUrl(pathname) {
  const base = resolveBaseUrl();
  const path = String(pathname || "").replace(/^\//, "");
  return `${base}/${path}`;
}

// ---------------------------------------------------------------------------
// Shape mappers
// ---------------------------------------------------------------------------

function coerceContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          if (typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function toModelSummary(model) {
  const row = model && typeof model === "object" ? model : {};
  return {
    id: typeof row.id === "string" ? row.id : String(row.id || ""),
    object: typeof row.object === "string" ? row.object : "model",
    created: Number.isFinite(Number(row.created)) ? Number(row.created) : 0,
    owned_by:
      typeof row.owned_by === "string" ? row.owned_by : String(row.owned_by || ""),
  };
}

function clampLimit(value) {
  if (value == null || value === "") return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
}

function filterAndLimitModels(rawList, ownedBy, limit) {
  const all = Array.isArray(rawList) ? rawList.map(toModelSummary) : [];
  let filtered = all;
  if (ownedBy != null && String(ownedBy).trim() !== "") {
    const needle = String(ownedBy).trim();
    filtered = all.filter((m) => m.owned_by === needle);
  }
  const total = filtered.length;
  const lim = clampLimit(limit);
  const models = filtered.slice(0, lim);
  return { models, total, returned: models.length };
}

function toChoiceSummary(choice, index) {
  const c = choice && typeof choice === "object" ? choice : {};
  const msg = c.message && typeof c.message === "object" ? c.message : {};
  const idx = Number.isInteger(c.index) ? c.index : index;
  return {
    index: idx,
    finish_reason: c.finish_reason == null ? null : String(c.finish_reason),
    message: {
      role: typeof msg.role === "string" ? msg.role : "assistant",
      content: coerceContent(msg.content),
    },
  };
}

function toUsageSummary(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens);
  const total = Number(usage.total_tokens);
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(total) ? total : 0,
  };
}

function toChatCompletionSummary(body) {
  const row = body && typeof body === "object" ? body : {};
  const rawChoices = Array.isArray(row.choices) ? row.choices : [];
  return {
    id: typeof row.id === "string" ? row.id : String(row.id || ""),
    object: typeof row.object === "string" ? row.object : "chat.completion",
    created: Number.isFinite(Number(row.created)) ? Number(row.created) : 0,
    model: typeof row.model === "string" ? row.model : String(row.model || ""),
    choices: rawChoices.map((c, i) => toChoiceSummary(c, i)),
    usage: toUsageSummary(row.usage),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function hitchFetch(method, pathname, { body } = {}) {
  const key = requireApiKey();
  const url = apiUrl(pathname);
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${key}`,
    "User-Agent": USER_AGENT,
  };
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }
  if (!res.ok) {
    let msg = `Hitch API ${res.status} ${res.statusText}`;
    if (parsed) {
      if (parsed.error && parsed.error.message) msg = parsed.error.message;
      else if (typeof parsed.message === "string") msg = parsed.message;
    }
    const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "hitch_list_models",
    description:
      "List models from the Hitch OpenAI-compat API (GET /models). Optional owned_by filter and limit (default 50, max 200). Returns { models: ModelSummary[], total, returned } where ModelSummary = { id, object, created, owned_by }. Call this before inventing model ids for chat.",
    inputSchema: {
      type: "object",
      properties: {
        owned_by: {
          type: "string",
          description:
            "Optional exact owned_by filter (e.g. openai, anthropic, deepseek, openrouter).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max models to return after filter. Default 50, max 200.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "hitch_chat_completions",
    description:
      "Create a chat completion via Hitch (POST /chat/completions). Requires Bearer auth (HITCH_API_KEY or OPENAI_API_KEY). Streaming is not supported in L1 — if stream is true, returns an error without calling the network. Returns ChatCompletionSummary: { id, object, created, model, choices: [{ index, finish_reason, message: { role, content } }], usage }.",
    inputSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "Model id from hitch_list_models. Do not invent ids.",
        },
        messages: {
          type: "array",
          description: "Chat messages as [{ role, content }, ...].",
          items: {
            type: "object",
            properties: {
              role: { type: "string" },
              content: {},
            },
            required: ["role", "content"],
            additionalProperties: true,
          },
          minItems: 1,
        },
        temperature: {
          type: "number",
          description: "Optional sampling temperature.",
        },
        max_tokens: {
          type: "integer",
          minimum: 1,
          description: "Optional max completion tokens.",
        },
        top_p: {
          type: "number",
          description: "Optional nucleus sampling top_p.",
        },
        stream: {
          type: "boolean",
          description: "Must be omitted or false. Streaming is not supported in L1.",
        },
      },
      required: ["model", "messages"],
      additionalProperties: false,
    },
  },
];

function requireString(args, key) {
  const v = args && args[key];
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return v.trim();
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1) {
    throw new Error("messages must be a non-empty array of { role, content }");
  }
  return messages.map((m, i) => {
    if (!m || typeof m !== "object") {
      throw new Error(`messages[${i}] must be an object`);
    }
    if (typeof m.role !== "string" || !m.role.trim()) {
      throw new Error(`messages[${i}].role must be a non-empty string`);
    }
    if (!Object.prototype.hasOwnProperty.call(m, "content")) {
      throw new Error(`messages[${i}].content is required`);
    }
    return { role: m.role.trim(), content: m.content };
  });
}

async function hitchListModels(args) {
  requireApiKey();
  const owned_by =
    args && args.owned_by != null && String(args.owned_by).trim() !== ""
      ? String(args.owned_by).trim()
      : undefined;
  const limit = args && args.limit;
  const payload = await hitchFetch("GET", "models");
  const data = Array.isArray(payload && payload.data)
    ? payload.data
    : Array.isArray(payload)
      ? payload
      : [];
  return filterAndLimitModels(data, owned_by, limit);
}

async function hitchChatCompletions(args) {
  // Auth before any network — and before stream check so missing-token is
  // reported consistently; stream still never hits the wire.
  requireApiKey();
  if (args && args.stream === true) {
    throw new Error(
      "stream=true is not supported in hitch-openai L1. Omit stream or set stream=false for a non-streaming chat completion."
    );
  }
  const model = requireString(args, "model");
  const messages = normalizeMessages(args && args.messages);
  const body = { model, messages, stream: false };
  if (args && args.temperature != null && args.temperature !== "") {
    const t = Number(args.temperature);
    if (!Number.isFinite(t)) throw new Error("temperature must be a number");
    body.temperature = t;
  }
  if (args && args.max_tokens != null && args.max_tokens !== "") {
    const n = Number(args.max_tokens);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error("max_tokens must be a positive integer");
    }
    body.max_tokens = n;
  }
  if (args && args.top_p != null && args.top_p !== "") {
    const p = Number(args.top_p);
    if (!Number.isFinite(p)) throw new Error("top_p must be a number");
    body.top_p = p;
  }
  const payload = await hitchFetch("POST", "chat/completions", { body });
  return toChatCompletionSummary(payload);
}

async function callTool(name, args) {
  switch (name) {
    case "hitch_list_models":
      return hitchListModels(args || {});
    case "hitch_chat_completions":
      return hitchChatCompletions(args || {});
    default:
      throw new Error(
        `Unknown or disallowed tool '${name}'. Allowed: ${ALLOWED_TOOLS.join(", ")}.`
      );
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC over newline-delimited stdio
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function pickProtocolVersion(requested) {
  if (typeof requested === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    return requested;
  }
  return "2024-11-05";
}

function handleInitialize(id, params) {
  ok(id, {
    protocolVersion: pickProtocolVersion(params && params.protocolVersion),
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions:
      "Hitch OpenAI-compat. Set HITCH_API_KEY (or OPENAI_API_KEY). Tools: hitch_list_models, hitch_chat_completions. Prefer list before inventing model ids. Streaming not supported in L1. Some Hitch models need provider session headers — L1 does not set them; prefer models that work with plain Bearer.",
  });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      handleInitialize(id, params);
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (typeof name !== "string" || !name) {
        fail(id, -32602, "tools/call requires params.name");
        return;
      }
      try {
        const result = await callTool(name, args);
        const text = JSON.stringify(result, null, 2);
        ok(id, {
          content: [{ type: "text", text }],
          structuredContent: result,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        ok(id, {
          content: [{ type: "text", text }],
          isError: true,
        });
      }
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const method = msg.method;
  if (!method) {
    if (Object.prototype.hasOwnProperty.call(msg, "id")) {
      fail(msg.id, -32600, "Invalid Request");
    }
    return;
  }
  const isNotification = !Object.prototype.hasOwnProperty.call(msg, "id");
  if (isNotification) {
    // notifications/initialized and others: ack-free
    return;
  }
  return handleRequest(msg);
}

function startStdio() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed || /^Content-Length:/i.test(trimmed)) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      fail(null, -32700, "Parse error");
      return;
    }
    Promise.resolve(handleMessage(msg)).catch((err) => {
      process.stderr.write(
        `${SERVER_NAME}: ${err && err.stack ? err.stack : err}\n`
      );
    });
  });
  rl.on("close", () => {
    process.exit(0);
  });
}

function printToolsAndExit() {
  process.stdout.write(
    JSON.stringify(
      {
        server: { name: SERVER_NAME, version: SERVER_VERSION },
        tools: TOOLS,
      },
      null,
      2
    ) + "\n"
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Self-test (fixtures only — no network)
// ---------------------------------------------------------------------------

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function runSelfTest() {
  const modelFixture = {
    id: "deepseek-chat",
    object: "model",
    created: 1700000000,
    owned_by: "deepseek",
    extra: "drop-me",
  };
  const summary = toModelSummary(modelFixture);
  assert(summary.id === "deepseek-chat", "model id");
  assert(summary.object === "model", "model object");
  assert(summary.created === 1700000000, "model created");
  assert(summary.owned_by === "deepseek", "model owned_by");
  assert(!Object.prototype.hasOwnProperty.call(summary, "extra"), "strip extra");

  const listed = filterAndLimitModels(
    [
      modelFixture,
      { id: "gpt-4o", object: "model", created: 1, owned_by: "openai" },
      { id: "claude", object: "model", created: 2, owned_by: "anthropic" },
      { id: "o1", object: "model", created: 3, owned_by: "openai" },
    ],
    "openai",
    1
  );
  assert(listed.total === 2, "filter total");
  assert(listed.returned === 1, "limit returned");
  assert(listed.models[0].id === "gpt-4o", "first openai model");
  assert(clampLimit(999) === 200, "limit max 200");
  assert(clampLimit(undefined) === 50, "limit default 50");

  const chatFixture = {
    id: "chatcmpl-abc",
    object: "chat.completion",
    created: 1700000001,
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "hello" },
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    system_fingerprint: "x",
  };
  const chat = toChatCompletionSummary(chatFixture);
  assert(chat.id === "chatcmpl-abc", "chat id");
  assert(chat.object === "chat.completion", "chat object");
  assert(chat.model === "deepseek-chat", "chat model");
  assert(chat.choices.length === 1, "choices len");
  assert(chat.choices[0].message.role === "assistant", "choice role");
  assert(chat.choices[0].message.content === "hello", "choice content");
  assert(chat.choices[0].finish_reason === "stop", "finish_reason");
  assert(chat.usage && chat.usage.total_tokens === 4, "usage");
  assert(
    !Object.prototype.hasOwnProperty.call(chat, "system_fingerprint"),
    "no fingerprint"
  );

  const noUsage = toChatCompletionSummary({
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [],
  });
  assert(noUsage.usage === null, "usage null when absent");

  const parts = toChatCompletionSummary({
    id: "x",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      },
    ],
  });
  assert(parts.choices[0].message.content === "a\nb", "array content coerce");

  const prevH = process.env.HITCH_API_KEY;
  const prevO = process.env.OPENAI_API_KEY;
  const prevB = process.env.HITCH_BASE_URL;
  try {
    process.env.HITCH_API_KEY = "${HITCH_API_KEY}";
    delete process.env.OPENAI_API_KEY;
    assert(resolveApiKey() === "", "unexpanded HITCH_API_KEY is missing");

    process.env.HITCH_API_KEY = "";
    process.env.OPENAI_API_KEY = "${OPENAI_API_KEY}";
    assert(resolveApiKey() === "", "unexpanded OPENAI_API_KEY is missing");

    process.env.OPENAI_API_KEY = "sk-test";
    assert(resolveApiKey() === "sk-test", "OPENAI_API_KEY fallback");

    process.env.HITCH_API_KEY = "hitch-key";
    assert(resolveApiKey() === "hitch-key", "HITCH_API_KEY preferred");

    process.env.HITCH_BASE_URL = "https://hitch.genoventures.com/v1/";
    assert(
      resolveBaseUrl() === "https://hitch.genoventures.com/v1",
      "strip trailing slash"
    );
    assert(
      apiUrl("models") === "https://hitch.genoventures.com/v1/models",
      "no double /v1"
    );
    delete process.env.HITCH_BASE_URL;
    assert(resolveBaseUrl() === DEFAULT_BASE_URL, "default base");

    // stream rejection with a fake key — must not hit the network
    process.env.HITCH_API_KEY = "test-token-for-self-test";
    delete process.env.OPENAI_API_KEY;
    let streamRejected = false;
    try {
      await hitchChatCompletions({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
    } catch (err) {
      streamRejected = /stream/i.test(err && err.message ? err.message : "");
    }
    assert(streamRejected, "stream=true must error without network");

    // missing token before network
    delete process.env.HITCH_API_KEY;
    delete process.env.OPENAI_API_KEY;
    let missing = false;
    try {
      await hitchChatCompletions({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hi" }],
      });
    } catch (err) {
      missing = /HITCH_API_KEY|Missing Hitch API key/i.test(
        err && err.message ? err.message : ""
      );
    }
    assert(missing, "missing token must error before network");
  } finally {
    if (prevH === undefined) delete process.env.HITCH_API_KEY;
    else process.env.HITCH_API_KEY = prevH;
    if (prevO === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevO;
    if (prevB === undefined) delete process.env.HITCH_BASE_URL;
    else process.env.HITCH_BASE_URL = prevB;
  }

  process.stderr.write("ok  shape mapper self-test\n");
  process.exit(0);
}

function main() {
  if (process.argv.includes("--print-tools")) {
    printToolsAndExit();
    return;
  }
  if (process.argv.includes("--self-test")) {
    runSelfTest().catch((err) => {
      process.stderr.write(
        `self-test failed: ${err && err.stack ? err.stack : err}\n`
      );
      process.exit(1);
    });
    return;
  }
  startStdio();
}

main();
