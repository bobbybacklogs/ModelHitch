import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CURSOR_CLOUD_API_BASE,
  cancelCursorCloudAgent,
  getCursorCloudAgent,
  listCursorCloudAgents,
} from '../src/providers/cursor-cloud.js';
import { createModelHitchServer } from '../src/server/server.js';
import { mockProvider } from '../src/providers/mock.js';
import type { OpenAICompatibleServer } from '../src/server/server.js';
import { ModelHitchError } from '../src/core/errors.js';

const agents = new Map<string, { id: string; status: string }>([
  ['bc-running-1', { id: 'bc-running-1', status: 'RUNNING' }],
  ['bc-done-1', { id: 'bc-done-1', status: 'FINISHED' }],
]);

function manageFetchStub() {
  const calls: Array<{ method: string; url: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    const method = init?.method ?? 'GET';
    calls.push({ method, url });

    if (method === 'GET' && url.endsWith('/agents')) {
      return new Response(JSON.stringify({ items: [...agents.values()] }), { status: 200 });
    }
    const getMatch = url.match(/\/agents\/([^/]+)$/);
    if (method === 'GET' && getMatch) {
      const id = decodeURIComponent(getMatch[1] ?? '');
      const agent = agents.get(id);
      if (!agent) {
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'not found' } }), { status: 404 });
      }
      return new Response(JSON.stringify({ agent }), { status: 200 });
    }
    const cancelMatch = url.match(/\/agents\/([^/]+)\/cancel$/);
    if (method === 'POST' && cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1] ?? '');
      const agent = agents.get(id);
      if (!agent) {
        return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'not found' } }), { status: 404 });
      }
      const cancelled = { ...agent, status: 'CANCELLED' };
      agents.set(id, cancelled);
      return new Response(JSON.stringify({ agent: cancelled }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `unmocked ${method} ${url}` } }), { status: 400 });
  };
  return { fetchImpl, calls };
}

describe('cursor-cloud manage client', () => {
  it('lists agents via GET /agents', async () => {
    const { fetchImpl, calls } = manageFetchStub();
    const listed = await listCursorCloudAgents('test-key', { fetchImpl });
    expect(listed.map((a) => a.id)).toEqual(['bc-running-1', 'bc-done-1']);
    expect(calls.some((c) => c.method === 'GET' && c.url === `${CURSOR_CLOUD_API_BASE}/agents`)).toBe(true);
  });

  it('gets one agent by id', async () => {
    const { fetchImpl } = manageFetchStub();
    const agent = await getCursorCloudAgent('test-key', 'bc-running-1', { fetchImpl });
    expect(agent).toEqual({ id: 'bc-running-1', status: 'RUNNING' });
  });

  it('cancels an agent via POST /agents/:id/cancel', async () => {
    const { fetchImpl, calls } = manageFetchStub();
    const cancelled = await cancelCursorCloudAgent('test-key', 'bc-running-1', { fetchImpl });
    expect(cancelled.status).toBe('CANCELLED');
    expect(calls.some((c) => c.method === 'POST' && c.url === `${CURSOR_CLOUD_API_BASE}/agents/bc-running-1/cancel`)).toBe(true);
    const after = await getCursorCloudAgent('test-key', 'bc-running-1', { fetchImpl });
    expect(after.status).toBe('CANCELLED');
  });

  it('maps a missing id to model-not-found', async () => {
    const { fetchImpl } = manageFetchStub();
    const err = await getCursorCloudAgent('test-key', 'bc-missing', { fetchImpl }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelHitchError);
    expect((err as ModelHitchError).code).toBe('model-not-found');
    expect((err as ModelHitchError).message).toContain('bc-missing');
  });
});

describe('cloud-agents bridge routes', () => {
  let server: OpenAICompatibleServer;
  let base: string;
  let calls: Array<{ method: string; url: string }>;

  beforeAll(async () => {
    agents.set('bc-running-1', { id: 'bc-running-1', status: 'RUNNING' });
    agents.set('bc-done-1', { id: 'bc-done-1', status: 'FINISHED' });
    const stub = manageFetchStub();
    calls = stub.calls;
    server = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      cloudAgent: { enabled: true, repos: [{ url: 'https://github.com/org/repo' }] },
      apiKeys: { 'cursor-cloud': 'test-key' },
      imageFetch: stub.fetchImpl,
    });
    const info = await server.listen(0, '127.0.0.1');
    base = info.url;
  });

  afterAll(async () => {
    await server.close();
  });

  it('lists agents at GET /v1/cloud-agents', async () => {
    const res = await fetch(`${base}/v1/cloud-agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ id: string }> };
    expect(body.agents.map((a) => a.id)).toContain('bc-running-1');
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/agents'))).toBe(true);
  });

  it('gets one agent at GET /v1/cloud-agents/:id', async () => {
    const res = await fetch(`${base}/v1/cloud-agents/bc-running-1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe('bc-running-1');
    expect(body.status).toBe('RUNNING');
  });

  it('cancels via POST /v1/cloud-agents/:id/cancel', async () => {
    agents.set('bc-bridge-cancel', { id: 'bc-bridge-cancel', status: 'RUNNING' });
    const res = await fetch(`${base}/v1/cloud-agents/bc-bridge-cancel/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('CANCELLED');
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/agents/bc-bridge-cancel/cancel'))).toBe(true);
  });

  it('returns JSON error for a missing id', async () => {
    const res = await fetch(`${base}/v1/cloud-agents/bc-does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('bc-does-not-exist');
  });

  it('returns JSON error when the lane is disabled', async () => {
    const disabled = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      cloudAgent: { enabled: false, repos: [{ url: 'https://github.com/org/repo' }] },
      apiKeys: { 'cursor-cloud': 'test-key' },
    });
    const { url } = await disabled.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/disabled/i);
    await disabled.close();
  });

  it('returns JSON error when the API key is missing', async () => {
    const saved = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    const noKey = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      cloudAgent: { enabled: true, repos: [{ url: 'https://github.com/org/repo' }] },
    });
    const { url } = await noKey.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/cloud-agents`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/CURSOR_API_KEY/i);
    await noKey.close();
    if (saved) process.env.CURSOR_API_KEY = saved;
  });

  it('workspace HTML does not embed an API key', async () => {
    const res = await fetch(`${base}/workspace`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('test-key');
    expect(html).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{8,}/);
    expect(html).toContain('cloud-agents-list');
  });
});
