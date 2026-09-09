import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModelHitchServer,
  ModelHitchError,
  type OpenAICompatibleServer,
  type Provider,
} from '../src/index.js';
import type { ChatParams, ChatResult, StreamChunk } from '../src/core/types.js';

/** Provider that always 429s (simulates an exhausted rate limit). */
const alwaysRated: Provider = {
  id: 'rated',
  name: 'Always 429',
  defaultModel: 'rated-model',
  capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
  async chat(): Promise<ChatResult> {
    throw new ModelHitchError('rate-limited', 'primary failed: HTTP 429 rate-limited', { status: 429 });
  },
  async *stream(): AsyncGenerator<StreamChunk> {
    throw new ModelHitchError('rate-limited', 'primary failed: HTTP 429 rate-limited', { status: 429 });
  },
};

/** Provider that succeeds with a distinct echo so we can see which lane served. */
const laneProvider = (id: string, model: string): Provider => ({
  id,
  name: `Lane ${id}`,
  defaultModel: model,
  capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
  async chat(params: ChatParams): Promise<ChatResult> {
    const last = [...params.messages].reverse().find((m) => m.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : '';
    return {
      message: { role: 'assistant', content: `${id} served: ${text}` },
      finishReason: 'stop',
      usage: { inputTokens: 7, outputTokens: 5 },
    };
  },
  async *stream(params: ChatParams): AsyncGenerator<StreamChunk> {
    const last = [...params.messages].reverse().find((m) => m.role === 'user');
    const text = typeof last?.content === 'string' ? last.content : '';
    yield { type: 'text-delta', text: `${id} stream: ${text}` };
    yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 5 } };
  },
});

const fallbackA = laneProvider('lane-a', 'lane-a-model');
const fallbackB = laneProvider('lane-b', 'lane-b-model');

let server: OpenAICompatibleServer;
let base: string;
const failovers: any[] = [];
const usageEvents: any[] = [];

beforeAll(async () => {
  server = createModelHitchServer({
    providers: [alwaysRated, fallbackA, fallbackB],
    defaultProviderId: 'rated',
    autoMode: {
      lanes: [
        { providerId: 'lane-a', model: 'lane-a-model' },
        { providerId: 'lane-b', model: 'lane-b-model' },
      ],
    },
    onFailover: (ev) => failovers.push(ev),
    onUsage: (ev) => usageEvents.push(ev),
  });
  const info = await server.listen(0, '127.0.0.1');
  base = info.url;
});

afterAll(async () => {
  await server.close();
});

function chat(body: unknown): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('bridge auto-mode failover', () => {
  it('fails over a 429 non-stream call to the first healthy lane', async () => {
    const res = await chat({
      model: 'rated-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toContain('lane-a served');
    expect(failovers.length).toBeGreaterThan(0);
    const ev = failovers[failovers.length - 1]!;
    expect(ev.from.providerId).toBe('rated');
    expect(ev.from.model).toBe('rated-model');
    expect(ev.to.providerId).toBe('lane-a');
    expect(ev.to.model).toBe('lane-a-model');
    expect(ev.error.code).toBe('rate-limited');
  });

  it('fails over a 429 stream call before emitting SSE, and reports the actual lane', async () => {
    const res = await chat({
      model: 'rated-model',
      stream: true,
      messages: [{ role: 'user', content: 'stream me' }],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // First fallback lane serves: lane-a. It must never come from the rated lane.
    expect(text).toContain('lane-a stream');
    expect(text).not.toContain('429');
    const last = usageEvents[usageEvents.length - 1];
    expect(last.streamed).toBe(true);
    expect(last.providerId).toBe('lane-a');
    expect(last.model).toBe('lane-a-model');
  });

  it('fails over to the second lane when the first lane also fails', async () => {
    const secondServer = createModelHitchServer({
      providers: [alwaysRated, alwaysRated2, fallbackB],
      defaultProviderId: 'rated',
      autoMode: {
        lanes: [
          { providerId: 'rated2', model: 'rated2-model' },
          { providerId: 'lane-b', model: 'lane-b-model' },
        ],
      },
      onFailover: (ev) => secondFailovers.push(ev),
    });
    const info = await secondServer.listen(0, '127.0.0.1');
    const res = await fetch(`${info.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'rated-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toContain('lane-b served');
    expect(secondFailovers.map((f: any) => ({ providerId: f.to.providerId, model: f.to.model }))).toEqual([
      { providerId: 'rated2', model: 'rated2-model' },
      { providerId: 'lane-b', model: 'lane-b-model' },
    ]);
    await secondServer.close();
  });
});

describe('bridge usage endpoints', () => {
  it('GET /v1/usage returns a JSON snapshot', async () => {
    const res = await fetch(`${base}/v1/usage`);
    expect(res.status).toBe(200);
    const s = (await res.json()) as any;
    expect(s.totals.requests).toBeGreaterThan(0);
    expect(s.perProvider['lane-a']).toBeDefined();
    expect(s.failovers.total).toBeGreaterThan(0);
    expect(s.windows['5h'].capUsd).toBe(12);
    expect(typeof s.windows['5h'].fraction).toBe('number');
  });

  it('GET /usage serves the HTML dashboard', async () => {
    const res = await fetch(`${base}/usage`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('/v1/usage');
  });
});

const alwaysRated2: Provider = {
  id: 'rated2',
  name: 'Always 429 too',
  defaultModel: 'rated2-model',
  capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
  async chat(): Promise<ChatResult> {
    throw new ModelHitchError('provider-error', 'upstream 502', { status: 502 });
  },
  async *stream(): AsyncGenerator<StreamChunk> {
    throw new ModelHitchError('provider-error', 'upstream 502', { status: 502 });
  },
};
const secondFailovers: any[] = [];

describe('bridge capability-aware routing', () => {
  let noToolsCalls = 0;
  const noTools: Provider = {
    id: 'no-tools',
    name: 'No tool calling',
    defaultModel: 'no-tools-model',
    capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
    async chat(): Promise<ChatResult> {
      noToolsCalls++;
      return { message: { role: 'assistant', content: 'served by no-tools' }, finishReason: 'stop' };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      noToolsCalls++;
      yield { type: 'text-delta', text: 'served by no-tools' };
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
  const withTools: Provider = {
    id: 'with-tools',
    name: 'Tool calling',
    defaultModel: 'with-tools-model',
    capabilities: { streaming: true, toolCalling: true, vision: false, embeddings: false },
    async chat(): Promise<ChatResult> {
      return { message: { role: 'assistant', content: 'served by with-tools' }, finishReason: 'stop' };
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', text: 'served by with-tools' };
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
  const TOOLS = [{ type: 'function', function: { name: 'get_weather', description: 'x', parameters: { type: 'object', properties: {} } } }];

  let capServer: OpenAICompatibleServer;
  let capBase: string;

  beforeAll(async () => {
    capServer = createModelHitchServer({
      providers: [noTools, withTools],
      defaultProviderId: 'no-tools',
      autoMode: { lanes: [{ providerId: 'with-tools', model: 'with-tools-model' }] },
    });
    const info = await capServer.listen(0, '127.0.0.1');
    capBase = info.url;
  });

  afterAll(async () => {
    await capServer.close();
  });

  it('skips a tool-incapable primary lane and serves from the capable fallback, without attempting the primary', async () => {
    noToolsCalls = 0;
    const res = await fetch(`${capBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'no-tools-model',
        tools: TOOLS,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toContain('with-tools');
    expect(noToolsCalls).toBe(0);
  });

  it('returns a capability-unavailable error when no lane can serve the request', async () => {
    const soloServer = createModelHitchServer({ providers: [noTools], defaultProviderId: 'no-tools' });
    const info = await soloServer.listen(0, '127.0.0.1');
    const res = await fetch(`${info.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'no-tools-model',
        tools: TOOLS,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('capability-unavailable');
    await soloServer.close();
  });

  it('does not affect requests that need no special capability', async () => {
    noToolsCalls = 0;
    const res = await fetch(`${capBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'no-tools-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toContain('no-tools');
    expect(noToolsCalls).toBe(1);
  });
});
