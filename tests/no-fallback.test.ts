import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModelHitchServer,
  extractNoFallback,
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
const laneA: Provider = {
  id: 'lane-a',
  name: 'Lane A',
  defaultModel: 'lane-a-model',
  capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
  async chat(params: ChatParams): Promise<ChatResult> {
    return {
      message: { role: 'assistant', content: 'lane-a served' },
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
  async *stream(): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', text: 'lane-a stream' };
    yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  },
};

let server: OpenAICompatibleServer;
let base: string;
const failovers: unknown[] = [];

beforeAll(async () => {
  server = createModelHitchServer({
    providers: [alwaysRated, laneA],
    defaultProviderId: 'rated',
    autoMode: { lanes: [{ providerId: 'lane-a', model: 'lane-a-model' }] },
    onFailover: (ev) => failovers.push(ev),
  });
  const info = await server.listen(0, '127.0.0.1');
  base = info.url;
});

afterAll(async () => {
  await server.close();
});

function chat(body: unknown, noFallback: boolean): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(noFallback ? { 'x-hitch-no-fallback': '1' } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('extractNoFallback', () => {
  it('is true for 1/true/yes (case-insensitive), false otherwise', () => {
    expect(extractNoFallback({ 'x-hitch-no-fallback': '1' })).toBe(true);
    expect(extractNoFallback({ 'x-hitch-no-fallback': 'TRUE' })).toBe(true);
    expect(extractNoFallback({ 'x-hitch-no-fallback': ' yes ' })).toBe(true);
    expect(extractNoFallback({ 'x-hitch-no-fallback': '0' })).toBe(false);
    expect(extractNoFallback({ 'x-hitch-no-fallback': '' })).toBe(false);
    expect(extractNoFallback({})).toBe(false);
    expect(extractNoFallback(undefined)).toBe(false);
  });
});

describe('x-hitch-no-fallback', () => {
  it('without the header, a 429 fails over to the fallback lane', async () => {
    const res = await chat({ model: 'rated-model', messages: [{ role: 'user', content: 'hi' }] }, false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toContain('lane-a served');
  });

  it('with the header, a 429 propagates instead of failing over (non-stream)', async () => {
    const before = failovers.length;
    const res = await chat({ model: 'rated-model', messages: [{ role: 'user', content: 'hi' }] }, true);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('rate-limited');
    expect(body.error.message).not.toContain('lane-a');
    // No failover walk ran for this request.
    expect(failovers.length).toBe(before);
  });

  it('with the header, a 429 propagates instead of failing over (stream)', async () => {
    const res = await chat(
      { model: 'rated-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      true,
    );
    expect(res.status).toBe(429);
    const text = await res.text();
    expect(text).not.toContain('lane-a stream');
  });
});
