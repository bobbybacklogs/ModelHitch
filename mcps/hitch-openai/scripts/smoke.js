#!/usr/bin/env node
/**
 * Protocol smoke test for hitch-openai.
 * Spawns the stdio MCP server; no network unless --live and a real key is set.
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SERVER = path.join(ROOT, "server", "index.js");
const EXPECTED_TOOLS = ["hitch_list_models", "hitch_chat_completions"];
const LIVE = process.argv.includes("--live");

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function tokenPresent(env) {
  const src = env || process.env;
  for (const name of ["HITCH_API_KEY", "OPENAI_API_KEY"]) {
    const t = src[name];
    if (
      t &&
      String(t).trim() &&
      t !== `\${${name}}` &&
      t !== `\${env:${name}}`
    ) {
      return true;
    }
  }
  return false;
}

function attachRpc(child) {
  let buf = "";
  const queue = [];
  const waiters = [];

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        const error = new Error(`Non-JSON stdout from server: ${line}`);
        if (waiters.length) waiters.shift().reject(error);
        else queue.push(error);
        continue;
      }
      if (waiters.length) waiters.shift().resolve(msg);
      else queue.push(msg);
    }
  });

  return {
    send(obj) {
      child.stdin.write(JSON.stringify(obj) + "\n");
    },
    wait(predicate, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`Timed out waiting for MCP response (${timeoutMs}ms)`)
          );
        }, timeoutMs);

        const tryOne = (msg) => {
          if (msg instanceof Error) {
            clearTimeout(timer);
            reject(msg);
            return true;
          }
          if (predicate(msg)) {
            clearTimeout(timer);
            resolve(msg);
            return true;
          }
          return false;
        };

        while (queue.length) {
          const next = queue.shift();
          if (tryOne(next)) return;
        }

        waiters.push({
          resolve(msg) {
            if (!tryOne(msg)) {
              waiters.push(this);
            }
          },
          reject(err) {
            clearTimeout(timer);
            reject(err);
          },
        });
      });
    },
  };
}

function toolText(msg) {
  const c = msg && msg.result && msg.result.content;
  if (Array.isArray(c) && c[0] && typeof c[0].text === "string") return c[0].text;
  return "";
}

async function withServer(env, fn) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });
  const rpc = attachRpc(child);
  const exitPromise = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    await fn(rpc);
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    await Promise.race([
      exitPromise,
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }
  return stderr;
}

async function main() {
  const noTokenEnv = { ...process.env };
  delete noTokenEnv.HITCH_API_KEY;
  delete noTokenEnv.OPENAI_API_KEY;

  await withServer(noTokenEnv, async (rpc) => {
    rpc.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "hitch-openai-smoke", version: "1.0.0" },
      },
    });
    const init = await rpc.wait((m) => m.id === 1, 5000);
    assert(init.result, "initialize missing result");
    assert(
      init.result.serverInfo && init.result.serverInfo.name === "hitch-openai",
      "bad serverInfo.name"
    );
    assert(
      init.result.capabilities && init.result.capabilities.tools,
      "initialize must advertise tools"
    );
    process.stderr.write("ok  initialize\n");

    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    rpc.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await rpc.wait((m) => m.id === 2, 5000);
    const tools = listed.result && listed.result.tools;
    assert(Array.isArray(tools), "tools/list must return tools[]");
    const names = tools.map((t) => t.name);
    assert(
      names.length === EXPECTED_TOOLS.length,
      `expected exactly ${EXPECTED_TOOLS.length} tools, got ${names.join(", ")}`
    );
    for (const expected of EXPECTED_TOOLS) {
      assert(names.includes(expected), `missing tool: ${expected}`);
    }
    for (const tool of tools) {
      assert(
        tool.inputSchema && tool.inputSchema.type === "object",
        `${tool.name} missing inputSchema`
      );
    }
    const chat = tools.find((t) => t.name === "hitch_chat_completions");
    assert(
      Array.isArray(chat.inputSchema.required) &&
        chat.inputSchema.required.includes("model") &&
        chat.inputSchema.required.includes("messages"),
      "hitch_chat_completions must require model and messages"
    );
    process.stderr.write("ok  tools/list (exactly 2)\n");

    rpc.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "hitch_delete_everything", arguments: {} },
    });
    const rejected = await rpc.wait((m) => m.id === 3, 5000);
    assert(rejected.result && rejected.result.isError, "fake tool must be rejected");
    assert(
      /unknown|disallowed/i.test(toolText(rejected)),
      "rejection text should mention unknown/disallowed"
    );
    process.stderr.write("ok  fake tool rejected\n");

    rpc.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "hitch_chat_completions",
        arguments: {
          model: "deepseek-chat",
          messages: [{ role: "user", content: "ping" }],
        },
      },
    });
    const missing = await rpc.wait((m) => m.id === 4, 5000);
    assert(missing.result && missing.result.isError, "missing token must isError");
    assert(
      /HITCH_API_KEY|Missing Hitch API key/i.test(toolText(missing)),
      "missing-token text must mention HITCH_API_KEY"
    );
    process.stderr.write("ok  missing-token on hitch_chat_completions\n");
  });

  if (LIVE) {
    if (!tokenPresent(process.env)) {
      throw new Error(
        "--live requires HITCH_API_KEY or OPENAI_API_KEY in the environment"
      );
    }
    await withServer({ ...process.env }, async (rpc) => {
      rpc.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "hitch-openai-smoke-live", version: "1.0.0" },
        },
      });
      await rpc.wait((m) => m.id === 1, 5000);
      rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });

      rpc.send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "hitch_list_models", arguments: { limit: 3 } },
      });
      const modelsMsg = await rpc.wait((m) => m.id === 5, 30000);
      assert(modelsMsg.result, "list_models missing result");
      if (modelsMsg.result.isError) {
        throw new Error(`live hitch_list_models failed: ${toolText(modelsMsg)}`);
      }
      const modelsBody = JSON.parse(toolText(modelsMsg));
      assert(Array.isArray(modelsBody.models), "models[] missing");
      assert(typeof modelsBody.total === "number", "total missing");
      assert(typeof modelsBody.returned === "number", "returned missing");
      assert(modelsBody.returned <= 3, "limit 3 exceeded");
      process.stderr.write(
        `ok  live hitch_list_models (returned=${modelsBody.returned}, total=${modelsBody.total})\n`
      );

      rpc.send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "hitch_chat_completions",
          arguments: {
            model: "deepseek-chat",
            messages: [{ role: "user", content: "Say hi in one word." }],
            max_tokens: 16,
          },
        },
      });
      const chatMsg = await rpc.wait((m) => m.id === 6, 60000);
      if (chatMsg.result.isError) {
        throw new Error(
          `live hitch_chat_completions failed: ${toolText(chatMsg)}`
        );
      }
      const chatBody = JSON.parse(toolText(chatMsg));
      assert(typeof chatBody.id === "string", "chat id");
      assert(Array.isArray(chatBody.choices), "chat choices");
      assert(chatBody.choices[0] && chatBody.choices[0].message, "chat message");
      process.stderr.write(
        `ok  live hitch_chat_completions model=${chatBody.model} finish=${chatBody.choices[0].finish_reason}\n`
      );
    });
  } else if (tokenPresent(process.env)) {
    process.stderr.write("skip live Hitch calls (pass --live to enable)\n");
  } else {
    process.stderr.write("skip live Hitch calls (no HITCH_API_KEY)\n");
  }

  process.stderr.write("smoke passed\n");
}

main().catch((err) => {
  process.stderr.write(`smoke failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
