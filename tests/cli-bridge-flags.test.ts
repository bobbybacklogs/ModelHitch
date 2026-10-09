import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end proof that the two bridge flags do what they claim, through the
 * built CLI:
 *
 *   --provider <id>            a pinned bridge serves the pinned provider even
 *                              when the request names another one
 *   --opencode-byok            a Console BYOK connection becomes a real lane,
 *                              authenticating with the OpenCode key
 *
 * Offline by construction: the BYOK "Console" is a local HTTP server, the env
 * is stripped of provider keys, and the child runs with a temp cwd so it never
 * picks up the repository's `.env`.
 */

const repoRoot = join(import.meta.dirname, '..');
const builtCli = join(repoRoot, 'dist/cli.js');

const KEY_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AI_GATEWAY_API_KEY',
  'VERCEL_OIDC_TOKEN',
  'VERCEL_TOKEN',
  'OPENCODE_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'MISTRAL_API_KEY',
  'MOONSHOT_API_KEY',
  'ZAI_API_KEY',
  'TOGETHER_API_KEY',
  'HF_TOKEN',
  'CURSOR_API_KEY',
];

const children: ChildProcess[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of KEY_VARS) delete env[name];
  return { ...env, ...extra };
}

afterAll(async () => {
  // Await the exits: on Windows a killed child keeps a handle on its cwd for a
  // moment, which makes the temp-dir cleanup fail with EPERM.
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await Promise.race([exited, sleep(3000)]);
    }
  }
  for (const server of servers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }
});

/** Spawn `modelhitch bridge` in the foreground and wait for /healthz. */
async function startBridge(port: number, args: string[], env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const home = tempDir('mh-e2e-home-');
  const cwd = tempDir('mh-e2e-cwd-');
  const child = spawn(process.execPath, [builtCli, 'bridge', '--config', join(home, 'config.json'), ...args], {
    cwd,
    env: { ...env, MODELHITCH_HOME: home, MODELHITCH_PORT: String(port), MODELHITCH_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(600) });
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('bridge did not become ready');
}

async function chat(port: number, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

describe('CLI bridge flags (built artifact)', () => {
  it.skipIf(!existsSync(builtCli))(
    '--provider pins routing and without it the same request takes the requested route',
    async () => {
      const pinnedPort = 4300 + Math.floor(Math.random() * 100);
      const plainPort = pinnedPort + 137;
      const env = cleanEnv();

      await startBridge(pinnedPort, ['--provider', 'mock'], env);
      const pinned = await chat(pinnedPort, {
        model: 'openai/gpt-5.4',
        messages: [{ role: 'user', content: 'pin me' }],
      });
      expect(pinned.status).toBe(200);
      // The mock lane served it even though the request named openai.
      expect(pinned.text).toContain('Mock reply: pin me');

      const health = (await (await fetch(`http://127.0.0.1:${pinnedPort}/healthz`)).json()) as { pinnedProviderId?: string };
      expect(health.pinnedProviderId).toBe('mock');

      // Control: with no pin the same request goes to the requested provider,
      // and this offline environment has no OpenAI key for it to succeed.
      await startBridge(plainPort, [], env);
      const unpinned = await chat(plainPort, {
        model: 'openai/gpt-5.4',
        messages: [{ role: 'user', content: 'pin me' }],
      });
      expect(unpinned.status).not.toBe(200);
      expect(unpinned.text).not.toContain('Mock reply');
    },
    60_000,
  );

  it.skipIf(!existsSync(builtCli))(
    '--opencode-byok serves a Console connection with the OpenCode key',
    async () => {
      const requests: Array<{ url: string; auth?: string; body: any }> = [];
      const upstream = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          requests.push({
            url: req.url ?? '',
            auth: req.headers.authorization as string | undefined,
            body: raw ? JSON.parse(raw) : {},
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-byok',
              object: 'chat.completion',
              created: 0,
              model: 'deepseek-chat',
              choices: [{ index: 0, message: { role: 'assistant', content: 'BYOK upstream reply' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
            }),
          );
        });
      });
      servers.push(upstream);
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
      const upstreamPort = (upstream.address() as { port: number }).port;

      const port = 4500 + Math.floor(Math.random() * 100);
      await startBridge(
        port,
        [
          '--opencode-byok',
          '--opencode-byok-connection',
          'conn_test',
          '--opencode-byok-models',
          'deepseek-chat',
          '--opencode-byok-schema',
          'chat-completions',
          '--opencode-byok-connection-url',
          `http://127.0.0.1:${upstreamPort}`,
        ],
        cleanEnv({ OPENCODE_API_KEY: 'console-service-account-key' }),
      );

      // No model in the request: the BYOK block is the plan's default.
      const result = await chat(port, { messages: [{ role: 'user', content: 'hello byok' }] });
      expect(result.status).toBe(200);
      expect(result.text).toContain('BYOK upstream reply');

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('/chat/completions');
      // The Console service-account key, reused from the OpenCode key setting.
      expect(requests[0]?.auth).toBe('Bearer console-service-account-key');
      expect(requests[0]?.body).toMatchObject({ model: 'deepseek-chat' });

      // The connection is a first-class provider: it shows up in the catalog,
      // and — being the plan's default provider — its models are advertised
      // with bare ids like every other default lane.
      const models = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as { data: Array<{ id: string }> };
      expect(models.data.map((m) => m.id)).toContain('deepseek-chat');
      const catalog = (await (await fetch(`http://127.0.0.1:${port}/v1/catalog`)).json()) as { providers: Array<{ id: string }> };
      expect(catalog.providers.map((p) => p.id)).toContain('opencode-byok-test');
    },
    60_000,
  );

  it.skipIf(!existsSync(builtCli))(
    'hot-reloads BYOK connections through PUT /v1/config',
    async () => {
      const seen: string[] = [];
      const upstream = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let model = '';
          try {
            model = String((JSON.parse(raw) as { model?: string }).model ?? '');
          } catch {
            /* ignore */
          }
          seen.push(`${req.url} ${model}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl-byok',
              object: 'chat.completion',
              created: 0,
              model,
              choices: [{ index: 0, message: { role: 'assistant', content: `served ${model}` }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        });
      });
      servers.push(upstream);
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
      const upstreamPort = (upstream.address() as { port: number }).port;

      const port = 4700 + Math.floor(Math.random() * 100);
      await startBridge(
        port,
        [
          '--opencode-byok',
          '--opencode-byok-connection',
          'conn_reload',
          '--opencode-byok-models',
          'byok-model-1',
          '--opencode-byok-schema',
          'chat-completions',
          '--opencode-byok-connection-url',
          `http://127.0.0.1:${upstreamPort}`,
        ],
        cleanEnv({ OPENCODE_API_KEY: 'reload-key' }),
      );

      const first = await chat(port, { model: 'byok-model-1', messages: [{ role: 'user', content: 'one' }] });
      expect(first.text).toContain('served byok-model-1');

      // Apply a new document the way /settings does: read the masked config,
      // add a model, PUT it back.
      const doc = (await (await fetch(`http://127.0.0.1:${port}/v1/config`)).json()) as Record<string, any>;
      expect(doc.opencodeByok.connections[0].id).toBe('conn_reload');
      doc.opencodeByok.connections[0].models = ['byok-model-1', 'byok-model-2'];
      const put = await fetch(`http://127.0.0.1:${port}/v1/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ ok: true });

      // The new model is live without a restart.
      const models = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as { data: Array<{ id: string }> };
      expect(models.data.map((m) => m.id)).toContain('byok-model-2');
      const second = await chat(port, { model: 'byok-model-2', messages: [{ role: 'user', content: 'two' }] });
      expect(second.text).toContain('served byok-model-2');

      // Turning the block off retires the lane.
      doc.opencodeByok.enabled = false;
      const putOff = await fetch(`http://127.0.0.1:${port}/v1/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });
      expect(putOff.status).toBe(200);
      const after = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as { data: Array<{ id: string }> };
      expect(after.data.map((m) => m.id)).not.toContain('byok-model-1');
      const catalog = (await (await fetch(`http://127.0.0.1:${port}/v1/catalog`)).json()) as { providers: Array<{ id: string }> };
      expect(catalog.providers.map((p) => p.id)).not.toContain('opencode-byok-reload');
    },
    60_000,
  );
});

/** An upstream that records every request and answers chat completions. */
async function recordingUpstream(
  status = 200,
  content = 'upstream reply',
): Promise<{ port: number; requests: Array<{ method: string; url: string; auth?: string; body: any }> }> {
  const requests: Array<{ method: string; url: string; auth?: string; body: any }> = [];
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      requests.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization as string | undefined, body });
      if (status !== 200) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'quota exhausted', type: 'insufficient_quota' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-custom',
          object: 'chat.completion',
          created: 0,
          model: String((body as { model?: string }).model ?? ''),
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
      );
    });
  });
  servers.push(upstream);
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  return { port: (upstream.address() as { port: number }).port, requests };
}

describe('CLI custom BYOK lanes (built artifact)', () => {
  it.skipIf(!existsSync(builtCli))(
    '--custom-lane serves an endpoint ModelHitch does not ship, without ever polling it',
    async () => {
      const upstream = await recordingUpstream();
      const port = 4900 + Math.floor(Math.random() * 100);
      await startBridge(
        port,
        [
          '--custom-lanes',
          '--custom-lane',
          'upstream',
          '--custom-lane-url',
          `http://127.0.0.1:${upstream.port}/v1`,
          '--custom-lane-models',
          'fast-model,smart-model',
          '--custom-lane-schema',
          'chat-completions',
          '--custom-lane-on-limit',
          'rotate',
        ],
        cleanEnv({ MODELHITCH_CUSTOM_UPSTREAM_API_KEY: 'my-own-provider-key' }),
      );

      // No model in the request: the custom block leads the plan, so its first
      // lane × slot is the bridge's default route.
      const result = await chat(port, { messages: [{ role: 'user', content: 'hello custom' }] });
      expect(result.status).toBe(200);
      expect(result.text).toContain('upstream reply');

      expect(upstream.requests).toEqual([
        {
          method: 'POST',
          url: '/v1/chat/completions',
          auth: 'Bearer my-own-provider-key',
          body: expect.objectContaining({ model: 'fast-model' }),
        },
      ]);

      // The typed slots are the catalog: advertised, and no GET /models was
      // ever sent to the endpoint.
      const models = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as { data: Array<{ id: string }> };
      expect(models.data.map((m) => m.id)).toEqual(expect.arrayContaining(['fast-model', 'smart-model']));
      expect(upstream.requests.filter((r) => r.method === 'GET')).toEqual([]);
      expect(upstream.requests.some((r) => r.url.includes('/models'))).toBe(false);

      // …and it is a first-class lane for routing and the catalog.
      const catalog = (await (await fetch(`http://127.0.0.1:${port}/v1/catalog`)).json()) as { providers: Array<{ id: string }> };
      expect(catalog.providers.map((p) => p.id)).toContain('custom-upstream');
      const explicit = await chat(port, { model: 'custom-upstream/smart-model', messages: [{ role: 'user', content: 'second' }] });
      expect(explicit.status).toBe(200);
      expect(upstream.requests[1]?.body).toMatchObject({ model: 'smart-model' });
    },
    60_000,
  );

  it.skipIf(!existsSync(builtCli))(
    '--custom-lane-on-limit stop fails in the lane instead of spending the next one',
    async () => {
      const metered = await recordingUpstream(429);
      const spare = await recordingUpstream(200, 'spare lane reply');
      const port = 5100 + Math.floor(Math.random() * 100);
      await startBridge(
        port,
        [
          '--custom-lanes',
          '--custom-lane',
          'metered',
          '--custom-lane-url',
          `http://127.0.0.1:${metered.port}/v1`,
          '--custom-lane-models',
          'metered-model',
          '--custom-lane-schema',
          'chat-completions',
          '--custom-lane-on-limit',
          'stop',
          '--custom-lane',
          'spare',
          '--custom-lane-url',
          `http://127.0.0.1:${spare.port}/v1`,
          '--custom-lane-models',
          'spare-model',
          '--custom-lane-schema',
          'chat-completions',
        ],
        cleanEnv({
          MODELHITCH_CUSTOM_METERED_API_KEY: 'metered-key',
          MODELHITCH_CUSTOM_SPARE_API_KEY: 'spare-key',
        }),
      );

      // The metered lane is primary and terminal: its 429 surfaces to the
      // caller, and the lane behind it is never spent.
      const limited = await chat(port, { messages: [{ role: 'user', content: 'spend nothing else' }] });
      expect(limited.status).toBe(429);
      expect(metered.requests).toHaveLength(1);
      expect(spare.requests).toEqual([]);

      // Still parked from that failure: the stop holds on the next request too.
      const again = await chat(port, { messages: [{ role: 'user', content: 'still parked' }] });
      expect(again.status).toBe(429);
      expect(metered.requests).toHaveLength(1);
      expect(spare.requests).toEqual([]);

      // Routing to the spare lane directly still works — `stop` ends the walk,
      // it does not disable the other lanes.
      const direct = await chat(port, { model: 'custom-spare/spare-model', messages: [{ role: 'user', content: 'explicit' }] });
      expect(direct.status).toBe(200);
      expect(direct.text).toContain('spare lane reply');
    },
    60_000,
  );
});

describe('CLI bridge flag errors', () => {  it.skipIf(!existsSync(builtCli))('rejects an unknown --provider before listening', async () => {
    const home = tempDir('mh-e2e-badprov-');
    const cwd = tempDir('mh-e2e-badcwd-');
    const child = spawn(process.execPath, [builtCli, 'bridge', '--provider', 'no-such-provider'], {
      cwd,
      env: cleanEnv({ MODELHITCH_HOME: home, MODELHITCH_PORT: '4999' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(stderr).toContain('Unknown --provider "no-such-provider"');
    expect(stderr).toContain('mock');
  }, 30_000);
});
