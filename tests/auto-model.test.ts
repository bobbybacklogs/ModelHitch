import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTO_MODEL_ID,
  autoModelEntry,
  autoModelLabel,
  createModelHitchServer,
  createRegistrySource,
  isAutoModelId,
  isAutoModelMeta,
  mockProvider,
  ModelHitchError,
  planLanes,
  planModelEntries,
  type ChatParams,
  type ChatResult,
  type OpenAICompatibleServer,
  type Provider,
  type StreamChunk,
} from '../src/index.js';

/**
 * The auto id: one model name that stands for the whole plan.
 *
 * A custom-endpoint client (VS Code "Add model", Cline, Cursor, Codex
 * `model_providers`) demands a model name, and any name it saves is one lane —
 * so picking a model and getting failover used to be mutually exclusive. The
 * auto id is the bridge's own answer to that: send it and the request routes
 * exactly as an unqualified one does, with the rotation behind it.
 */

/** Provider that always 429s, so the rotation behind the auto id is visible. */
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

/** Provider that succeeds, naming itself and the model it was asked for. */
const laneProvider = (id: string, model: string): Provider => ({
  id,
  name: `Lane ${id}`,
  defaultModel: model,
  capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
  async chat(params: ChatParams): Promise<ChatResult> {
    return {
      message: { role: 'assistant', content: `${id} served: ${params.model}` },
      finishReason: 'stop',
      usage: { inputTokens: 7, outputTokens: 5 },
    };
  },
  async *stream(params: ChatParams): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', text: `${id} stream: ${params.model}` };
    yield { type: 'finish', finishReason: 'stop' };
  },
});

const laneA = laneProvider('lane-a', 'lane-a-model');
const laneB = laneProvider('lane-b', 'lane-b-model');

describe('the auto id is the plan, not a lane (pure data)', () => {
  it('recognizes itself and nothing adjacent to it', () => {
    expect(isAutoModelId(AUTO_MODEL_ID)).toBe(true);
    expect(isAutoModelId(`  ${AUTO_MODEL_ID}  `)).toBe(true);
    expect(isAutoModelId(AUTO_MODEL_ID.toUpperCase())).toBe(true);

    for (const notIt of ['', '  ', 'auto', 'rotation', 'modelhitch', 'modelhitch/other', 'modelhitch/auto/1', 'mock/mock-model', undefined, null, 7]) {
      expect(isAutoModelId(notIt)).toBe(false);
    }
  });

  it('labels itself by how much plan sits behind it', () => {
    expect(autoModelLabel(0)).toBe('ModelHitch Auto · the bridge default');
    expect(autoModelLabel(1)).toBe('ModelHitch Auto · whole rotation · 1 lane');
    expect(autoModelLabel(4)).toBe('ModelHitch Auto · whole rotation · 4 lanes');
  });

  it('publishes the plan rows it stands for, in order', () => {
    const source = createRegistrySource([alwaysRated, laneA, laneB]);
    const lanes = planLanes({
      autoMode: { lanes: [{ providerId: 'lane-a', model: 'lane-a-model' }, { providerId: 'lane-b', model: 'lane-b-model' }] },
      primary: { providerId: 'rated', model: 'rated-model' },
      defaultModelFor: (providerId) => source.defaultModel(providerId),
    });
    const entry = autoModelEntry(planModelEntries(lanes));

    expect(entry.id).toBe(AUTO_MODEL_ID);
    expect(entry.name).toBe('ModelHitch Auto · whole rotation · 3 lanes');
    expect(entry.modelhitch.kind).toBe('auto');
    expect(entry.modelhitch.lanes.map((lane) => lane.id)).toEqual([
      'rated/rated-model',
      'lane-a/lane-a-model',
      'lane-b/lane-b-model',
    ]);
    // A copy: the caller's list is the caller's.
    expect(entry.modelhitch.lanes).not.toBe(lanes);
  });

  it('tells its own metadata apart from a lane\u2019s', () => {
    const lane = { id: 'mock-model', providerId: 'mock', model: 'mock-model', tier: 'primary', laneIndex: 1, terminal: false, name: 'x' };
    expect(isAutoModelMeta(autoModelEntry([]).modelhitch)).toBe(true);
    expect(isAutoModelMeta(lane)).toBe(false);
    expect(isAutoModelMeta(undefined)).toBe(false);
    expect(isAutoModelMeta('auto')).toBe(false);
  });
});

describe('the auto id in GET /v1/models', () => {
  let server: OpenAICompatibleServer;
  let base: string;

  beforeAll(async () => {
    server = createModelHitchServer({
      providers: [mockProvider, laneA],
      defaultProviderId: 'mock',
      autoMode: { lanes: [{ providerId: 'lane-a', model: 'lane-a-model' }] },
    });
    const info = await server.listen(0, '127.0.0.1');
    base = info.url;
  });

  afterAll(async () => {
    await server.close();
  });

  type Entry = { id: string; owned_by: string; name?: string; modelhitch?: Record<string, unknown> };

  async function models(): Promise<Entry[]> {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Entry[] }).data;
  }

  it('leads the list, named, on a provider of its own', async () => {
    const data = await models();
    expect(data[0]?.id).toBe(AUTO_MODEL_ID);
    expect(data[0]?.owned_by).toBe('modelhitch');
    expect(data[0]?.name).toBe('ModelHitch Auto · whole rotation · 2 lanes');
  });

  it('carries the plan rows it expands to, so the id is inspectable', async () => {
    const auto = (await models())[0];
    expect(isAutoModelMeta(auto?.modelhitch)).toBe(true);
    const lanes = (auto?.modelhitch as { lanes: Entry[] }).lanes;
    expect(lanes.map((lane) => lane.id)).toEqual(['mock-model', 'lane-a/lane-a-model']);
  });

  it('answers GET /v1/models/:id with the same entry', async () => {
    const res = await fetch(`${base}/v1/models/modelhitch/auto`);
    expect(res.status).toBe(200);
    const entry = (await res.json()) as Entry;
    expect(entry.id).toBe(AUTO_MODEL_ID);
    expect(isAutoModelMeta(entry.modelhitch)).toBe(true);
  });

  it('is published without a plan too, meaning "the bridge default"', async () => {
    const bare = createModelHitchServer({ providers: [mockProvider], defaultProviderId: 'mock' });
    const info = await bare.listen(0, '127.0.0.1');
    try {
      const data = ((await (await fetch(`${info.url}/v1/models`)).json()) as { data: Entry[] }).data;
      const auto = data.find((entry) => entry.id === AUTO_MODEL_ID);
      expect(auto?.name).toBe('ModelHitch Auto · the bridge default');
      expect((auto?.modelhitch as { lanes: unknown[] }).lanes).toEqual([]);
      // …and it is still the only entry carrying plan metadata.
      expect(data.filter((entry) => entry.modelhitch !== undefined)).toHaveLength(1);
    } finally {
      await bare.close();
    }
  });

  it('is not offered when there is no provider to decide with', async () => {
    const empty = createModelHitchServer({ providers: [] });
    const info = await empty.listen(0, '127.0.0.1');
    try {
      const data = ((await (await fetch(`${info.url}/v1/models`)).json()) as { data: Entry[] }).data;
      expect(data).toEqual([]);
    } finally {
      await empty.close();
    }
  });
});

describe('requests that name the auto id ride the whole rotation', () => {
  let server: OpenAICompatibleServer;
  let base: string;

  beforeAll(async () => {
    server = createModelHitchServer({
      providers: [alwaysRated, laneA, laneB],
      defaultProviderId: 'rated',
      autoMode: {
        lanes: [
          { providerId: 'lane-a', model: 'lane-a-model' },
          { providerId: 'lane-b', model: 'lane-b-model' },
        ],
      },
    });
    const info = await server.listen(0, '127.0.0.1');
    base = info.url;
  });

  afterAll(async () => {
    await server.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('fails over past the dead primary on /v1/chat/completions', async () => {
    const res = await post('/v1/chat/completions', {
      model: AUTO_MODEL_ID,
      messages: [{ role: 'user', content: 'who am i' }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe('lane-a served: lane-a-model');
  });

  it('fails over on the streaming path too', async () => {
    const res = await post('/v1/chat/completions', {
      model: AUTO_MODEL_ID,
      stream: true,
      messages: [{ role: 'user', content: 'who am i' }],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('lane-a stream: lane-a-model');
    expect(text).toContain('[DONE]');
  });

  it('works on the Responses wire (Codex CLI)', async () => {
    const res = await post('/v1/responses', {
      model: AUTO_MODEL_ID,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'who am i' }] }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { output: Array<{ content: Array<{ text: string }> }> };
    expect(body.output[0]?.content[0]?.text).toBe('lane-a served: lane-a-model');
  });

  it('works on the Anthropic Messages wire (Claude Code)', async () => {
    const res = await post(
      '/v1/messages',
      { model: AUTO_MODEL_ID, max_tokens: 64, messages: [{ role: 'user', content: 'who am i' }] },
      { Authorization: 'Bearer test-gateway-token', 'anthropic-version': '2023-06-01' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    expect(body.content[0]?.text).toBe('lane-a served: lane-a-model');
  });

  it('works on the Google-native wire (Gemini CLI), id in the path', async () => {
    const res = await post(`/v1beta/models/${AUTO_MODEL_ID}:generateContent`, {
      contents: [{ role: 'user', parts: [{ text: 'who am i' }] }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      modelVersion?: string;
      candidates: Array<{ content: { parts: Array<{ text?: string }> } }>;
    };
    expect(body.candidates[0]?.content.parts[0]?.text).toBe('lane-a served: lane-a-model');
  });
});

describe('the auto id gets the same treatment as an unnamed request', () => {
  it('routes a request identically to one that omits model entirely', async () => {
    const seen: string[] = [];
    const recorder: Provider = {
      ...mockProvider,
      id: 'mock',
      async chat(params: ChatParams): Promise<ChatResult> {
        seen.push(params.model);
        return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' };
      },
    };
    const server = createModelHitchServer({
      providers: [recorder],
      defaultProviderId: 'mock',
      defaultModel: 'pinned-default-model',
    });
    const info = await server.listen(0, '127.0.0.1');
    try {
      const send = async (model?: string) => {
        const res = await fetch(`${info.url}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(model ? { model } : {}), messages: [{ role: 'user', content: 'hi' }] }),
        });
        expect(res.status).toBe(200);
      };
      await send(AUTO_MODEL_ID);
      await send();
      // The id is a spelling of "no model named", not a lane of its own: the
      // same server answers both requests with the same route…
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
      // …and the id itself never reaches a provider.
      expect(seen[0]).not.toBe(AUTO_MODEL_ID);
    } finally {
      await server.close();
    }
  });

  it('routes through a --provider pin rather than around it', async () => {
    const server = createModelHitchServer({
      providers: [laneA, laneB],
      defaultProviderId: 'lane-a',
      pinnedProviderId: 'lane-b',
    });
    const info = await server.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${info.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: AUTO_MODEL_ID, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]?.message.content).toBe('lane-b served: lane-b-model');
    } finally {
      await server.close();
    }
  });
});
