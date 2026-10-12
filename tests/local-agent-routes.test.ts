import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelHitchServer } from '../src/server/server.js';
import { mockProvider } from '../src/providers/mock.js';
import { CursorCloudSessionStore } from '../src/providers/cursor-cloud-session.js';
import type { OpenAICompatibleServer } from '../src/server/server.js';

const dirs: string[] = [];
let server: OpenAICompatibleServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh-local-routes-'));
  dirs.push(dir);
  return dir;
}

/** The local lane needs no vendor: only a provider for the tool loop. */
function localServer() {
  return createModelHitchServer({
    providers: [mockProvider],
    defaultProviderId: 'mock',
    defaultModel: 'mock-model',
    localAgent: { enabled: true, workspaceDir: tempDir(), maxTurns: 1 },
  });
}

describe('GET /v1/cloud-agents with the local lane', () => {
  it('serves the local backend on the same route as the remote one', async () => {
    server = localServer();
    const { url } = await server.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents?: unknown[] };
    expect(Array.isArray(body.agents)).toBe(true);
  });

  it('404s for an unknown agent id when the lane is enabled', async () => {
    server = localServer();
    const { url } = await server.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents/does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('does-not-exist');
  });

  it('404s cancel for an unknown id rather than reporting success', async () => {
    server = localServer();
    const { url } = await server.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents/ghost/cancel`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('both agent lanes disabled', () => {
  it('answers 403 with a reason rather than an empty agent list', async () => {
    server = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      defaultModel: 'mock-model',
      // Neither lane configured: the routes must say so.
    });
    const { url } = await server.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/disabled/i);
  });
});

describe('POST /v1/cloud-agents/run', () => {
  it('rejects a run with no prompt', async () => {
    server = localServer();
    const { url } = await server.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('prompt');
  });

  it('accepts a run and returns a session handle', async () => {
    server = localServer();
    const { url } = await server.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'say hi', sessionId: 'conv-route-1' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { sessionId?: string };
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId).not.toBe('');
  });

  it('reports the run through GET once it has started', async () => {
    server = localServer();
    const { url } = await server.listen(0, '127.0.0.1');
    const started = await fetch(`${url}/v1/cloud-agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', sessionId: 'conv-route-2' }),
    });
    const { sessionId } = (await started.json()) as { sessionId: string };

    const res = await fetch(`${url}/v1/cloud-agents/${encodeURIComponent(sessionId)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBe(sessionId);
  });

  it('is a 400 (not a silent no-op) when only a non-driver lane is enabled', async () => {
    server = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      defaultModel: 'mock-model',
      cloudAgent: { enabled: true, repos: [{ url: 'https://github.com/org/repo' }] },
      apiKeys: { 'cursor-cloud': 'test-key' },
      imageFetch: async () =>
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
    });
    const { url } = await server.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/does not start runs over HTTP/);
  });
});

describe('local lane with a durable session store', () => {
  it('accepts the store without changing the route contract', async () => {
    server = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      defaultModel: 'mock-model',
      localAgent: { enabled: true, workspaceDir: tempDir() },
      cloudAgentSessionStore: new (await import('../src/providers/cloud-agent-session-store.js'))
        .CloudAgentSessionStore(tempDir()),
    });
    const { url } = await server.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents`);
    expect(res.status).toBe(200);
  });

  it('cursor lane still works alongside the local lane', async () => {
    server = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      defaultModel: 'mock-model',
      localAgent: { enabled: true, workspaceDir: tempDir() },
      cloudAgent: { enabled: true, repos: [{ url: 'https://github.com/org/repo' }] },
      apiKeys: { 'cursor-cloud': 'test-key' },
      imageFetch: async () =>
        new Response(JSON.stringify({ items: [{ id: 'bc-remote-1', status: 'RUNNING' }] }), { status: 200 }),
    });
    const { url } = await server.listen(0, '127.0.0.1');

    const res = await fetch(`${url}/v1/cloud-agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents?: Array<{ id?: string }> };
    // The remote agent is merged into the same list as the local ones.
    expect(body.agents?.some((a) => a.id === 'bc-remote-1')).toBe(true);
  });

  it('routes a remote id to the vendor even when the local lane is enabled', async () => {
    const calls: string[] = [];
    server = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      defaultModel: 'mock-model',
      localAgent: { enabled: true, workspaceDir: tempDir() },
      cloudAgent: { enabled: true, repos: [{ url: 'https://github.com/org/repo' }] },
      apiKeys: { 'cursor-cloud': 'test-key' },
      imageFetch: async (input) => {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
        calls.push(url);
        if (url.endsWith('/agents/bc-remote-1')) {
          return new Response(JSON.stringify({ agent: { id: 'bc-remote-1', status: 'RUNNING' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'nope' } }), {
          status: 404,
        });
      },
    });
    const { url } = await server.listen(0, '127.0.0.1');

    const res = await fetch(`${url}/v1/cloud-agents/bc-remote-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string; status?: string };
    expect(body.id).toBe('bc-remote-1');
    expect(body.status).toBe('RUNNING');
    // The vendor was actually consulted, i.e. it dispatched to the remote lane.
    expect(calls.some((c) => c.endsWith('/agents/bc-remote-1'))).toBe(true);
  });
});
