import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ModelHitch,
  ModelHitchError,
  createModelHitchServer,
  type ChatInput,
  type IntentsConfig,
  type OpenAICompatibleServer,
  type Policy,
  type Provider,
} from '../src/index.js';

/**
 * Intent-aware rotation through the bridge.
 *
 * The unit suite proves the classifier; this suite proves the *routing*: the
 * same default route with the same config lands on a different lane depending
 * only on the shape of the request, and a request that matches nothing (or that
 * names a lane, or that runs with inference off) keeps the plan it always had.
 *
 * The default route always answers 429, so every request has to walk into the
 * plan behind it and the lane that ends up serving is observable in the
 * response body. That is the whole point: intent selection is only real if it
 * changes which provider eventually answers.
 */

type Body = {
  choices?: Array<{ message: { content: string } }>;
  error?: { message: string; code?: string };
};

/** One `GET /v1/models` row, as far as these tests read it. */
type CatalogEntry = {
  id: string;
  name?: string;
  modelhitch?: { kind?: string; intent?: string; lanes?: Array<{ id: string }> };
};

/** A lane that names itself in its answer, so the reply identifies the server. */
function servingProvider(id: string, capabilities: Partial<Provider['capabilities']> = {}): Provider {
  return {
    id,
    name: id,
    defaultModel: `${id}-model`,
    capabilities: { streaming: true, toolCalling: true, vision: true, embeddings: false, ...capabilities },
    async chat() {
      return {
        message: { role: 'assistant', content: `served:${id}` },
        finishReason: 'stop',
        // Reported so these requests reach the usage tracker: attribution is
        // only observable on an event that carries usage.
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
    async *stream() {
      yield { type: 'text-delta', text: `served:${id}` };
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
}

/** A lane that is always rate-limited — it forces the walk into the plan. */
function limitedProvider(id: string): Provider {
  const error = new ModelHitchError('rate-limited', `${id} is rate limited`, { status: 429 });
  return {
    id,
    name: id,
    defaultModel: `${id}-model`,
    capabilities: { streaming: true, toolCalling: true, vision: true, embeddings: false },
    async chat() {
      throw error;
    },
    async *stream() {
      throw error;
    },
  };
}

const primary = limitedProvider('primary');
const defaultLane = servingProvider('default-lane');
const codingLane = servingProvider('coding-lane');
const bulkLane = servingProvider('bulk-lane');
const visionLane = servingProvider('vision-lane');
const namedLane = limitedProvider('named-lane');

const providers = [primary, defaultLane, codingLane, bulkLane, visionLane, namedLane];

/** The plan every request falls back to when no intent applies. */
const policy: Policy = { trusted: [{ providerId: 'default-lane' }], fallback: [] };

const intents: IntentsConfig = {
  profiles: {
    coding: { trusted: [{ providerId: 'coding-lane' }], fallback: [] },
    bulk: { trusted: [{ providerId: 'bulk-lane' }], fallback: [] },
    vision: { trusted: [{ providerId: 'vision-lane' }], fallback: [] },
  },
};

async function startServer(options: Parameters<typeof createModelHitchServer>[0]): Promise<{
  server: OpenAICompatibleServer;
  base: string;
}> {
  const server = createModelHitchServer(options);
  const info = await server.listen(0, '127.0.0.1');
  return { server, base: info.url };
}

// ---------------------------------------------------------------------------
// Request shapes — one per intent, plus the ambiguous ones
// ---------------------------------------------------------------------------

/** A tool loop already in flight: the only shape that establishes coding work. */
const codingRequest = {
  messages: [
    { role: 'user', content: 'fix the failing test' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
  ],
};

const visionRequest = {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    },
  ],
};

const bulkRequest = { messages: [{ role: 'user', content: 'translate: hello' }], max_tokens: 64 };

/** Short, but nothing declares it cheap work — so it is not bulk. */
const plainRequest = { messages: [{ role: 'user', content: 'hello there' }] };

/** Tools offered, no loop yet: a capability signal, not proof of coding work. */
const toolsOnlyRequest = {
  messages: [{ role: 'user', content: 'what is the weather?' }],
  tools: [{ type: 'function', function: { name: 'get_weather', description: 'weather' } }],
};

/** A coding request that also needs a lane capable of calling tools. */
const toolUsingCodingRequest = {
  ...codingRequest,
  tools: [{ type: 'function', function: { name: 'read_file', description: 'read a file' } }],
};

// ---------------------------------------------------------------------------
// The plan a request's shape selects
// ---------------------------------------------------------------------------

describe('intent rotation through the bridge', () => {
  let server: OpenAICompatibleServer;
  let base: string;
  const log: string[] = [];

  async function post(body: unknown): Promise<{ status: number; json: Body }> {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Body };
  }

  /** The lane that ended up serving the request. */
  async function served(body: unknown): Promise<string> {
    const { status, json } = await post(body);
    expect(status).toBe(200);
    return json.choices?.[0]?.message.content ?? '';
  }

  async function models(): Promise<CatalogEntry[]> {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: CatalogEntry[] }).data;
  }

  const baseOptions = (overrides: Partial<Parameters<typeof createModelHitchServer>[0]> = {}) => ({
    providers,
    defaultProviderId: 'primary',
    defaultModel: 'primary-model',
    policy,
    intents,
    logger: (line: string) => log.push(line),
    ...overrides,
  });

  /** Swap the whole configuration, the way a settings Apply does. */
  async function configure(options: Parameters<typeof createModelHitchServer>[0]): Promise<void> {
    await server.close();
    ({ server, base } = await startServer(options));
  }

  beforeAll(async () => {
    ({ server, base } = await startServer(baseOptions()));
  });

  afterAll(async () => {
    await server.close();
  });

  it('routes a request with a tool loop in flight to the coding plan', async () => {
    await configure(baseOptions());
    expect(await served(codingRequest)).toBe('served:coding-lane');
  });

  it('routes a request carrying an image to the vision plan', async () => {
    await configure(baseOptions());
    expect(await served(visionRequest)).toBe('served:vision-lane');
  });

  it('routes a one-shot, explicitly capped request to the bulk plan', async () => {
    await configure(baseOptions());
    expect(await served(bulkRequest)).toBe('served:bulk-lane');
  });

  it('leaves a request that matches no intent on the base plan', async () => {
    await configure(baseOptions());
    expect(await served(plainRequest)).toBe('served:default-lane');
  });

  it('does not route a request that merely offers tools to the coding plan', async () => {
    await configure(baseOptions());
    expect(await served(toolsOnlyRequest)).toBe('served:default-lane');
  });

  it('does not route a short request without a declared cap to the bulk plan', async () => {
    await configure(baseOptions());
    expect(await served({ messages: [{ role: 'user', content: 'yes' }] })).toBe('served:default-lane');
  });

  it('logs the intent only when inference actually steered the request', async () => {
    await configure(baseOptions());
    log.length = 0;

    await served(plainRequest);
    expect(log.some((line) => line.includes('intent='))).toBe(false);

    await served(visionRequest);
    expect(log.some((line) => line.includes('intent=vision -> 2 lanes'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Decisions that keep the feature additive
  // -------------------------------------------------------------------------

  it('gives a request that names a lane the base plan, not an inferred one', async () => {
    await configure(baseOptions());
    // The named lane is rate-limited, so the walk continues — and it continues
    // into the base plan even though the body is unmistakably coding-shaped.
    const { status, json } = await post({
      model: 'named-lane/named-lane-model',
      messages: codingRequest.messages,
    });
    expect(status).toBe(200);
    expect(json.choices?.[0]?.message.content).toBe('served:default-lane');
  });

  it('falls back to the base plan when the inferred profile is not configured', async () => {
    await configure(
      baseOptions({
        intents: { profiles: { coding: { trusted: [{ providerId: 'coding-lane' }], fallback: [] } } },
      }),
    );
    // vision is inferred but has no profile, so it degrades instead of erroring.
    expect(await served(visionRequest)).toBe('served:default-lane');
    expect(await served(codingRequest)).toBe('served:coding-lane');
  });

  it('reproduces the pre-intent lanes exactly when inference is off', async () => {
    await configure(baseOptions({ intents: { ...intents, infer: false } }));
    // Same coding-shaped body, no profile inference — and no intent log line.
    log.length = 0;
    expect(await served(codingRequest)).toBe('served:default-lane');
    expect(await served(visionRequest)).toBe('served:default-lane');
    expect(log.some((line) => line.includes('intent='))).toBe(false);
  });

  it('behaves exactly as before when there is no intents block at all', async () => {
    await configure(baseOptions({ intents: undefined }));
    expect(await served(codingRequest)).toBe('served:default-lane');
    expect(await served(visionRequest)).toBe('served:default-lane');
  });

  it('walks an intent-only config that has no base policy', async () => {
    await configure(
      baseOptions({
        policy: undefined,
        intents: { profiles: { coding: { trusted: [{ providerId: 'coding-lane' }], fallback: [] } } },
      }),
    );
    // No base policy: the intent's plan is the only plan, and it still has to be
    // walked in full — the primary lane is attempted first, then the profile.
    expect(await served(codingRequest)).toBe('served:coding-lane');
  });

  it('applies the capability filter to the plan an intent selected', async () => {
    await configure({
      providers: [servingProvider('no-tools', { toolCalling: false }), servingProvider('with-tools')],
      defaultProviderId: 'no-tools',
      defaultModel: 'no-tools-model',
      // The default route cannot call tools at all, so a tool-using request has
      // to be routed past it rather than onto it.
      policy: { trusted: [{ providerId: 'no-tools' }], fallback: [] },
      intents: { profiles: { coding: { trusted: [{ providerId: 'with-tools' }], fallback: [] } } },
    });

    // No tools in the request, so nothing to filter and the default lane answers.
    expect(await served({ messages: [{ role: 'user', content: 'hello' }] })).toBe('served:no-tools');

    // With tools the incapable lane is skipped — not attempted, not cooled — and
    // the intent's own lane answers instead.
    expect(await served(toolUsingCodingRequest)).toBe('served:with-tools');
  });

  // -------------------------------------------------------------------------
  // The pinned id: the plan a client chooses on purpose
  // -------------------------------------------------------------------------

  it('routes a pinned intent id to that plan, whatever the body looks like', async () => {
    await configure(baseOptions());
    // A vision-shaped body under a coding id: the id is the instruction, so the
    // request must not be re-classified from what it happens to carry.
    expect(await served({ ...visionRequest, model: 'modelhitch/auto:coding' })).toBe('served:coding-lane');
  });

  it('still infers behind the plain auto id', async () => {
    await configure(baseOptions());
    expect(await served({ ...visionRequest, model: 'modelhitch/auto' })).toBe('served:vision-lane');
  });

  it('logs a pinned intent the same way it logs an inferred one', async () => {
    await configure(baseOptions());
    log.length = 0;
    await served({ ...plainRequest, model: 'modelhitch/auto:coding' });
    expect(log.some((line) => line.includes('intent=coding -> 2 lanes'))).toBe(true);
  });

  it('degrades a pinned id for an unconfigured profile to the base plan', async () => {
    await configure(baseOptions());
    // reasoning is a real intent with no profile here, so the id is honoured as
    // "the plan named reasoning" and that plan is the base one.
    expect(await served({ ...plainRequest, model: 'modelhitch/auto:reasoning' })).toBe('served:default-lane');
  });

  it('refuses an unknown intent id by name instead of calling a provider', async () => {
    await configure(baseOptions());
    const { status, json } = await post({ ...plainRequest, model: 'modelhitch/auto:refactor' });
    expect(status).toBe(404);
    expect(json.error?.code).toBe('model-not-found');
    expect(json.error?.message).toContain('Known intents: coding, reasoning, vision, bulk');
  });

  // -------------------------------------------------------------------------
  // The pinned id in `GET /v1/models`
  // -------------------------------------------------------------------------

  it('publishes one row per configured profile, right after the plain auto id', async () => {
    await configure(baseOptions());
    // Vocabulary order among the configured profiles, so the list is stable no
    // matter which order the config document happened to name them in.
    expect((await models()).slice(0, 4).map((entry) => entry.id)).toEqual([
      'modelhitch/auto',
      'modelhitch/auto:coding',
      'modelhitch/auto:vision',
      'modelhitch/auto:bulk',
    ]);
  });

  it('carries the profile\'s own lanes and label on the row', async () => {
    await configure(baseOptions());
    const row = (await models()).find((entry) => entry.id === 'modelhitch/auto:coding');
    expect(row?.modelhitch?.kind).toBe('auto');
    expect(row?.modelhitch?.intent).toBe('coding');
    expect(row?.modelhitch?.lanes?.map((lane) => lane.id)).toEqual(['coding-lane/coding-lane-model']);
    expect(row?.name).toBe('ModelHitch Auto · coding · 1 lane');
  });

  it('leaves the plain auto id without an intent, so it keeps meaning "you decide"', async () => {
    await configure(baseOptions());
    const row = (await models()).find((entry) => entry.id === 'modelhitch/auto');
    expect(row?.modelhitch?.kind).toBe('auto');
    expect(row?.modelhitch?.intent).toBeUndefined();
  });

  it('publishes nothing for a profile the config does not define', async () => {
    await configure(baseOptions());
    expect((await models()).map((entry) => entry.id)).not.toContain('modelhitch/auto:reasoning');
  });

  it('answers for a pinned id exactly as it does for any other model', async () => {
    await configure(baseOptions());
    const res = await fetch(`${base}/v1/models/modelhitch/auto:coding`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('modelhitch/auto:coding');
  });

  it('publishes no intent rows at all without an intents block', async () => {
    await configure(baseOptions({ intents: undefined }));
    const ids = (await models()).map((entry) => entry.id);
    expect(ids).toContain('modelhitch/auto');
    expect(ids.some((id) => id.startsWith('modelhitch/auto:'))).toBe(false);
  });

  it('attributes each request to the plan it routed through', async () => {
    const seen: Array<string | undefined> = [];
    await configure(baseOptions({ onUsage: (event) => seen.push(event.intent) }));

    await served(codingRequest);
    await served(plainRequest);
    await served({ ...visionRequest, model: 'modelhitch/auto:coding' });

    expect(seen).toEqual(['coding', 'default', 'coding']);

    // And the same attribution reaches the dashboard, not just the hook.
    const usage = (await (await fetch(`${base}/v1/usage`)).json()) as {
      perIntent: Record<string, { requests: number }>;
    };
    expect(usage.perIntent.coding?.requests).toBe(2);
    expect(usage.perIntent.default?.requests).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The library client — the path the workspace composer actually takes
// ---------------------------------------------------------------------------

/** A tool loop in flight: the only shape that establishes coding work. */
const codingMessages: ChatInput['messages'] = [
  { role: 'user', content: 'fix the failing test' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] },
  { role: 'tool', content: 'file contents', toolCallId: 'c1' },
];

const plainMessages: ChatInput['messages'] = [{ role: 'user', content: 'hello' }];

describe('intent plans in the library client', () => {
  const options = {
    providers: [limitedProvider('limited'), servingProvider('base-lane'), servingProvider('coding-lane')],
    defaultProviderId: 'limited',
    defaultModel: 'limited-model',
    policy: { trusted: [{ providerId: 'base-lane' }], fallback: [] } as Policy,
    intents: {
      profiles: { coding: { trusted: [{ providerId: 'coding-lane' }], fallback: [] } },
    } as IntentsConfig,
  };

  /** The lane that answered. The default route always 429s, so this is the plan. */
  async function reply(input: ChatInput): Promise<string> {
    const result = await new ModelHitch(options).chat(input);
    const content = result.message.content;
    return typeof content === 'string' ? content : '';
  }

  it('infers an intent from the call shape', async () => {
    expect(await reply({ messages: codingMessages })).toBe('served:coding-lane');
  });

  it('leaves a call that matches nothing on the base plan', async () => {
    expect(await reply({ messages: plainMessages })).toBe('served:base-lane');
  });

  it('honours an explicit intent over the call shape', async () => {
    expect(await reply({ messages: plainMessages, intent: 'coding' })).toBe('served:coding-lane');
  });

  it('treats an explicit "default" as do-not-guess', async () => {
    // What a caller that has already named a lane passes, so its rotation cannot
    // change under it because the body happened to carry tools.
    expect(await reply({ messages: codingMessages, intent: 'default' })).toBe('served:base-lane');
  });

  it('routes no call through inference when infer is off', async () => {
    const mh = new ModelHitch({ ...options, intents: { ...options.intents, infer: false } });
    const result = await mh.chat({ messages: codingMessages });
    expect(result.message.content).toBe('served:base-lane');
  });

  it('rejects an invalid intents block when the client is built', () => {
    expect(
      () =>
        new ModelHitch({
          providers: options.providers,
          policy: options.policy,
          intents: { profiles: { refactor: { trusted: [{ providerId: 'base-lane' }], fallback: [] } } } as never,
        }),
    ).toThrow(/Invalid intents:[\s\S]*intents\.profiles\.refactor/);
  });
});
