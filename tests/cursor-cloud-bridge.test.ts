import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModelHitchServer } from '../src/server/server.js';
import { mockProvider } from '../src/providers/mock.js';
import { createCursorCloudProvider } from '../src/providers/cursor-cloud.js';
import { CursorCloudSessionStore } from '../src/providers/cursor-cloud-session.js';
import type { OpenAICompatibleServer } from '../src/server/server.js';

function sseResponse(text: string): Response {
  const body = [
    'event: assistant',
    `data: ${JSON.stringify({ text })}`,
    '',
    'event: result',
    `data: ${JSON.stringify({ status: 'FINISHED', text })}`,
    '',
  ].join('\n');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function mockCursorFetch() {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    const method = init?.method ?? 'GET';
    if (url.endsWith('/agents') && method === 'POST') {
      return new Response(JSON.stringify({ agent: { id: 'bc-bridge-1' }, run: { id: 'run-bridge-1' } }), { status: 200 });
    }
    if (url.includes('/stream')) return sseResponse('cloud agent reply');
    if (url.includes('/runs/')) {
      return new Response(JSON.stringify({ id: 'run-bridge-1', status: 'FINISHED', result: 'cloud agent reply' }), {
        status: 200,
      });
    }
    return new Response('{}', { status: 200 });
  };
}

describe('cursor-cloud bridge integration', () => {
  let server: OpenAICompatibleServer;
  let baseUrl: string;

  beforeAll(async () => {
    const sessionStore = new CursorCloudSessionStore();
    const cursorCloud = createCursorCloudProvider({
      config: {
        enabled: true,
        defaultModel: 'composer-2.5',
        repos: [{ url: 'https://github.com/org/repo', startingRef: 'main' }],
        autoCreatePR: false,
        sessionReuse: 'per-bridge-session',
      },
      sessionStore,
      fetchImpl: mockCursorFetch(),
    });
    server = createModelHitchServer({
      providers: [mockProvider, cursorCloud],
      defaultProviderId: 'mock',
      cloudAgent: { enabled: true, repos: [{ url: 'https://github.com/org/repo' }] },
      apiKeys: { 'cursor-cloud': 'test-key' },
    });
    const listened = await server.listen(0, '127.0.0.1');
    baseUrl = `${listened.url}/v1`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('advertises cursor-cloud models when the lane is enabled', async () => {
    const res = await fetch(`${baseUrl}/models`);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((m) => m.id === 'cursor-cloud/composer-2.5')).toBe(true);
  });

  it('routes explicit cursor-cloud/composer-2.5 and drops client tools', async () => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': 'bridge-test-1' },
      body: JSON.stringify({
        model: 'cursor-cloud/composer-2.5',
        messages: [{ role: 'user', content: 'Ship the feature' }],
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object' } } }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message?.content).toContain('cloud agent reply');
  });

  it('rejects cursor-cloud routes when the lane is disabled', async () => {
    const disabled = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      cloudAgent: { enabled: false, repos: [{ url: 'https://github.com/org/repo' }] },
    });
    const { url } = await disabled.listen(0, '127.0.0.1');
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'cursor-cloud/composer-2.5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(400);
    await disabled.close();
  });

  it('mock provider still works unchanged', async () => {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock/mock-model',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message?.content).toContain('Mock reply');
  });
});
