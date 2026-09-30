import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ModelHitchError,
  createModelHitchServer,
  type OpenAICompatibleServer,
  type Provider,
} from '../src/index.js';
import type { ChatParams, ChatResult, StreamChunk } from '../src/core/types.js';

/**
 * `bridge --provider <id>` — the runtime pin.
 *
 * The contract under test: the pinned provider serves every request (even one
 * that names a different provider), the route the pin displaced is tried next,
 * and a pin that is depleted or erroring still rotates on to a working lane.
 * Without a pin, routing is byte-for-byte what it was before.
 */

/** Provider that always 429s — an exhausted pinned provider. */
const alwaysRated: Provider = {
  id: 'lane-dead',
  name: 'Always 429',
  defaultModel: 'dead-model',
  capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
  async chat(): Promise<ChatResult> {
    throw new ModelHitchError('rate-limited', 'pinned lane exhausted: HTTP 429', { status: 429 });
  },
  async *stream(): AsyncGenerator<StreamChunk> {
    throw new ModelHitchError('rate-limited', 'pinned lane exhausted: HTTP 429', { status: 429 });
  },
};

/** Provider that succeeds with a distinct echo so the serving lane is visible. */
function laneProvider(id: string, model: string): Provider {
  return {
    id,
    name: `Lane ${id}`,
    defaultModel: model,
    capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
    async chat(params: ChatParams): Promise<ChatResult> {
      const last = [...params.messages].reverse().find((m) => m.role === 'user');
      const text = typeof last?.content === 'string' ? last.content : '';
      return {
        message: { role: 'assistant', content: `${id} served ${params.model}: ${text}` },
        finishReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 5 },
      };
    },
    async *stream(params: ChatParams): AsyncGenerator<StreamChunk> {
      yield { type: 'text-delta', text: `${id} streamed ${params.model}` };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 7, outputTokens: 5 } };
    },
  };
}

const laneA = laneProvider('lane-a', 'lane-a-model');
const laneB = laneProvider('lane-b', 'lane-b-model');
const providers = [laneA, laneB, alwaysRated];

let pinned: OpenAICompatibleServer;
let pinnedBase: string;
let dead: OpenAICompatibleServer;
let deadBase: string;
let unpinned: OpenAICompatibleServer;
let unpinnedBase: string;

const failovers: Array<{ from: { providerId: string }; to: { providerId: string } }> = [];

beforeAll(async () => {
  pinned = createModelHitchServer({
    providers,
    pinnedProviderId: 'lane-a',
    defaultProviderId: 'lane-b',
    defaultModel: 'lane-b-model',
    policy: { trusted: [{ providerId: 'lane-b', models: ['lane-b-model'] }], fallback: [] },
  });
  pinnedBase = (await pinned.listen(0, '127.0.0.1')).url;

  dead = createModelHitchServer({
    providers,
    pinnedProviderId: 'lane-dead',
    defaultProviderId: 'lane-b',
    defaultModel: 'lane-b-model',
    policy: { trusted: [{ providerId: 'lane-b', models: ['lane-b-model'] }], fallback: [] },
    onFailover: (event) => failovers.push(event),
  });
  deadBase = (await dead.listen(0, '127.0.0.1')).url;

  unpinned = createModelHitchServer({
    providers,
    defaultProviderId: 'lane-b',
    defaultModel: 'lane-b-model',
    policy: { trusted: [{ providerId: 'lane-b', models: ['lane-b-model'] }], fallback: [] },
  });
  unpinnedBase = (await unpinned.listen(0, '127.0.0.1')).url;
});

afterAll(async () => {
  await Promise.all([pinned.close(), dead.close(), unpinned.close()]);
});

async function chat(base: string, body: unknown): Promise<{ status: number; content: string }> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return { status: res.status, content: json.choices?.[0]?.message?.content ?? '' };
}

describe('bridge --provider pin', () => {
  it('serves an explicitly-requested other provider from the pin', async () => {
    const { status, content } = await chat(pinnedBase, {
      model: 'lane-b/lane-b-model',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(status).toBe(200);
    expect(content).toBe('lane-a served lane-b-model: hello');
  });

  it('redirects a bare request to the pinned provider, keeping the configured model', async () => {
    const { status, content } = await chat(pinnedBase, {
      messages: [{ role: 'user', content: 'bare' }],
    });
    expect(status).toBe(200);
    // The configured default model is never provider-namespaced, so it is
    // carried across to the pin (the pin moves the provider, not the model).
    expect(content).toBe('lane-a served lane-b-model: bare');
  });

  it('uses the pinned provider default when the configured model belongs to another provider', async () => {
    const namespaced = createModelHitchServer({
      providers,
      pinnedProviderId: 'lane-a',
      defaultProviderId: 'lane-b',
      defaultModel: 'lane-b/lane-b-model',
    });
    const base = (await namespaced.listen(0, '127.0.0.1')).url;
    try {
      const { content } = await chat(base, { messages: [{ role: 'user', content: 'bare' }] });
      expect(content).toBe('lane-a served lane-a-model: bare');
    } finally {
      await namespaced.close();
    }
  });

  it('keeps the pinned provider for an explicit route that names the pin itself', async () => {
    const { content } = await chat(pinnedBase, {
      model: 'lane-a/lane-a-model',
      messages: [{ role: 'user', content: 'self' }],
    });
    expect(content).toBe('lane-a served lane-a-model: self');
  });

  it('falls back to the displaced route when the pinned provider is exhausted', async () => {
    failovers.length = 0;
    const { status, content } = await chat(deadBase, {
      model: 'lane-b/lane-b-model',
      messages: [{ role: 'user', content: 'depleted' }],
    });
    expect(status).toBe(200);
    expect(content).toBe('lane-b served lane-b-model: depleted');
    expect(failovers[0]).toMatchObject({ from: { providerId: 'lane-dead' }, to: { providerId: 'lane-b' } });
  });

  it('pins the streaming wires too', async () => {
    const res = await fetch(`${pinnedBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'lane-b/lane-b-model', stream: true, messages: [{ role: 'user', content: 'go' }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('lane-a streamed lane-b-model');
    expect(text).not.toContain('lane-b streamed');
  });

  it('routes by the requested provider when nothing is pinned', async () => {
    const { content } = await chat(unpinnedBase, {
      model: 'lane-a/lane-a-model',
      messages: [{ role: 'user', content: 'unpinned' }],
    });
    expect(content).toBe('lane-a served lane-a-model: unpinned');
  });

  it('reports the pin on /healthz and omits it when unpinned', async () => {
    const pinnedHealth = (await (await fetch(`${pinnedBase}/healthz`)).json()) as { status: string; pinnedProviderId?: string };
    expect(pinnedHealth).toMatchObject({ status: 'ok', pinnedProviderId: 'lane-a' });
    const plainHealth = (await (await fetch(`${unpinnedBase}/healthz`)).json()) as { pinnedProviderId?: string };
    expect(plainHealth.pinnedProviderId).toBeUndefined();
  });

  it('falls back to the configured default when the pinned provider is unknown', async () => {
    const ghost = createModelHitchServer({
      providers,
      pinnedProviderId: 'no-such-provider',
      defaultProviderId: 'lane-b',
      defaultModel: 'lane-b-model',
    });
    const base = (await ghost.listen(0, '127.0.0.1')).url;
    try {
      const { content } = await chat(base, { messages: [{ role: 'user', content: 'ghost' }] });
      expect(content).toBe('lane-b served lane-b-model: ghost');
    } finally {
      await ghost.close();
    }
  });
});
