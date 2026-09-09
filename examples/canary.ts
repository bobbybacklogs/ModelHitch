/**
 * Canary — end-to-end agentic loop through the ModelHitch V2 bridge via
 * Vercel AI Gateway.
 *
 * Proves: agent loop -> bridge (/v1/chat/completions) -> gateway ->
 * streamed tool call -> normalized response -> tool result follow-up.
 *
 *   AI_GATEWAY_API_KEY=… npm run canary
 *   # or: vercel login / vercel env pull
 */
import { readFileSync } from 'node:fs';
import { createModelHitchServer, printAsciiLogo } from '../src/index.js';

function loadDotEnv(): void {
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // No .env file
  }
}
loadDotEnv();

const KEY =
  process.env.AI_GATEWAY_API_KEY ??
  process.env.VERCEL_OIDC_TOKEN ??
  process.env.VERCEL_TOKEN;

if (!KEY) {
  console.error('\n[canary] No Vercel AI Gateway credential found.\n');
  console.error('  Set AI_GATEWAY_API_KEY, run `vercel env pull`, or `vercel login`.\n');
  process.exit(2);
}

const TOOL_NAME = 'get_android_sdk';
const TOOL_DEF = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Fetch Android SDK configuration for the current project.',
    parameters: {
      type: 'object',
      properties: {
        sdkVersion: { type: 'string', description: "API level, e.g. '36'." },
      },
      required: ['sdkVersion'],
    },
  },
};

const MODEL = process.env.MODELHITCH_MODEL ?? 'openai/gpt-5.4';
const ROUTE = `vercel-ai-gateway/${MODEL}`;

async function runCase(baseUrl: string): Promise<void> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ROUTE,
      stream: true,
      tools: [TOOL_DEF],
      tool_choice: 'auto',
      messages: [
        {
          role: 'user',
          content: `Call ${TOOL_NAME} with sdkVersion "36", then answer with the result.`,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`chat/completions HTTP ${res.status}: ${await res.text()}`);
  }

  let toolCallId = '';
  let toolArgs = '';
  let assistantText = '';
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      const json = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{ id?: string; function?: { arguments?: string } }>;
          };
        }>;
      };
      const delta = json.choices?.[0]?.delta;
      if (delta?.content) assistantText += delta.content;
      const tc = delta?.tool_calls?.[0];
      if (tc?.id) toolCallId = tc.id;
      if (tc?.function?.arguments) toolArgs += tc.function.arguments;
    }
  }

  if (!toolCallId && !toolArgs) {
    throw new Error(`No tool call received. assistant=${assistantText.slice(0, 200)}`);
  }

  const follow = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ROUTE,
      messages: [
        { role: 'user', content: `Call ${TOOL_NAME} with sdkVersion "36".` },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: toolCallId || 'call_1',
              type: 'function',
              function: { name: TOOL_NAME, arguments: toolArgs || '{"sdkVersion":"36"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: toolCallId || 'call_1',
          content: JSON.stringify({ compileSdk: 36, minSdk: 24, targetSdk: 36 }),
        },
      ],
    }),
  });
  if (!follow.ok) {
    throw new Error(`follow-up HTTP ${follow.status}: ${await follow.text()}`);
  }
  const followJson = (await follow.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const finalText = followJson.choices?.[0]?.message?.content ?? '';
  if (!/36/.test(finalText)) {
    throw new Error(`Follow-up missing SDK evidence: ${finalText.slice(0, 200)}`);
  }
  console.log(`[ok] ${ROUTE} tool + follow-up`);
}

async function main(): Promise<void> {
  printAsciiLogo();
  const hitch = createModelHitchServer({
    defaultProviderId: 'vercel-ai-gateway',
    defaultModel: MODEL,
    apiKeys: { 'vercel-ai-gateway': KEY! },
  });
  const { url } = await hitch.listen(0, '127.0.0.1');
  try {
    await runCase(url);
    console.log('\nCanary passed.\n');
  } finally {
    await hitch.close();
  }
}

main().catch((err) => {
  console.error('\nCanary failed:', err);
  process.exitCode = 1;
});
