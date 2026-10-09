import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyChatGptPlanPlan, CHATGPT_PLAN_PROVIDER_ID, type ChatGptPlanTokenSource } from '../src/chatgpt-plan.js';
import { bridgeProviders } from '../src/bridge-providers.js';
import { createModelHitchServer, type OpenAICompatibleServer } from '../src/server/server.js';
import { CursorCloudSessionStore } from '../src/providers/cursor-cloud-session.js';
import { buildCooldownFromConfig, validateConfig } from '../src/config.js';
import { MemoryLaneCooldown } from '../src/core/cooldown.js';
import { mockProvider } from '../src/providers/mock.js';
import type { ModelHitchConfig } from '../src/config.js';

/**
 * The ChatGPT plan lane through the local bridge, on the OpenAI wire.
 *
 * The provider tests prove the adapter in isolation. This proves the part the
 * user actually asked for: that the lane is reachable "just like the others"
 * through the API and the bridge, and that a plan limit really does rotate to
 * the next lane instead of stopping.
 *
 * The lane's API root is pointed at a stub transport, so the whole path runs
 * offline: OpenAI chat-completions request in, Responses request out, stream
 * normalized back through the bridge.
 */

const sessionStore = new CursorCloudSessionStore();

/** Answers with a complete Responses SSE stream, recording what it received. */
function responsesUpstream(options: { failWith?: { status: number; detail: string } } = {}) {
  const requests: Array<Record<string, unknown>> = [];
  const impl: typeof fetch = async (_input, init) => {
    if (options.failWith) {
      return new Response(JSON.stringify({ detail: options.failWith.detail }), { status: options.failWith.status });
    }
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const events = [
      { type: 'response.created', response: { id: 'resp_bridge' } },
      { type: 'response.output_text.delta', delta: 'plan says hello' },
      { type: 'response.completed', response: { id: 'resp_bridge', usage: { input_tokens: 9, output_tokens: 3, total_tokens: 12 } } },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  return { requests, impl };
}

const tokens: ChatGptPlanTokenSource = {
  async getToken() {
    return { accessToken: 'oauth-access', accountKey: 'k', expiresAt: Date.now() + 3_600_000, planUsage: true };
  },
  async refreshToken() {
    return { accessToken: 'oauth-access-2', accountKey: 'k', expiresAt: Date.now() + 3_600_000, planUsage: true };
  },
  describeAccount: () => 'user@example.com',
};

/** The lane leading, with the built-in registry directly behind it. */
function laneConfig(overrides: Record<string, unknown> = {}): ModelHitchConfig {
  return {
    version: 1,
    chatgptPlan: { enabled: true, models: ['gpt-5.1', 'gpt-5.1-mini'], ...overrides },
  };
}

function buildBridge(config: ModelHitchConfig, upstream: typeof fetch, onFailover?: (event: unknown) => void) {
  const errors = validateConfig(config).errors;
  if (errors.length) throw new Error(errors.join('\n'));

  const plan = applyChatGptPlanPlan({
    config,
    policy: { trusted: [{ providerId: 'mock', models: ['mock-model'] }], fallback: [] },
  });
  const providers = bridgeProviders([mockProvider], config, sessionStore, {
    chatgptPlanTokens: tokens,
    chatgptPlanFetch: upstream,
    chatgptPlanBaseUrl: 'https://api.openai.test/v1',
  });
  return createModelHitchServer({
    providers,
    defaultProviderId: plan.defaultProviderId,
    defaultModel: plan.defaultModel,
    policy: plan.policy,
    // The failover walk only cools lanes when an engine is present, and cooling
    // is what stops the next request re-walking a plan lane that is out of quota.
    cooldown: buildCooldownFromConfig(config) ?? new MemoryLaneCooldown(),
    ...(onFailover ? { onFailover: onFailover as never } : {}),
  });
}

describe('chatgpt plan lane through the bridge', () => {
  let server: OpenAICompatibleServer;
  let base = '';
  let upstream: ReturnType<typeof responsesUpstream>;

  beforeAll(async () => {
    upstream = responsesUpstream();
    server = buildBridge(laneConfig(), upstream.impl);
    base = (await server.listen(0, '127.0.0.1')).url;
  });

  afterAll(async () => {
    await server.close();
  });

  it('advertises the lane like any other provider', async () => {
    const response = await fetch(`${base}/v1/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string; owned_by: string }> };
    // The lane leads, so its slots are advertised unprefixed (a bare id routes
    // to the default provider) and every other provider is prefixed.
    const laneModels = body.data.filter((model) => model.owned_by === CHATGPT_PLAN_PROVIDER_ID);
    expect(laneModels.map((model) => model.id)).toEqual(['gpt-5.1', 'gpt-5.1-mini']);
    expect(body.data.some((model) => model.id === 'mock/mock-model')).toBe(true);
  });

  it('serves a chat-completions request by calling the Responses route', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `${CHATGPT_PLAN_PROVIDER_ID}/gpt-5.1`, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { prompt_tokens: number; completion_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe('plan says hello');
    expect(body.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 3 });
  });

  it('sent exactly the body this preview route accepts', async () => {
    const sent = upstream.requests.at(-1)!;
    expect(sent.model).toBe('gpt-5.1');
    expect(sent.store).toBe(false);
    expect(sent.stream).toBe(true);
    expect(sent).not.toHaveProperty('temperature');
    expect(sent).not.toHaveProperty('max_output_tokens');
    expect(sent).not.toHaveProperty('previous_response_id');
  });

  it('streams the lane on the OpenAI wire', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `${CHATGPT_PLAN_PROVIDER_ID}/gpt-5.1`,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('plan says hello');
    expect(text).toContain('data: [DONE]');
  });

  it('serves the lane on the Responses wire too', async () => {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `${CHATGPT_PLAN_PROVIDER_ID}/gpt-5.1`, input: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { output: Array<{ content: Array<{ text: string }> }> };
    expect(body.output[0]?.content[0]?.text).toBe('plan says hello');
  });

  it('serves the lane as the default route when it leads', async () => {
    // A bare model id with no provider prefix goes to the default provider.
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'bare-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    // The plan lane leads, so the bare id reaches it as the configured default.
    expect((await response.json()) as unknown).toMatchObject({ choices: [{ message: { content: 'plan says hello' } }] });
  });
});

describe('chatgpt plan lane rotation', () => {
  it('rotates to the next lane when the plan reports a usage limit', async () => {
    // The whole point of mapping the plan limit onto a 429: a Plus account that
    // has spent its shared five-hour total is rested, not broken, so the bridge
    // keeps serving from the lane behind it.
    const limited = responsesUpstream({ failWith: { status: 429, detail: 'subscription_sharing_usage_limit_exceeded' } });
    const failovers: Array<{ from: { providerId: string }; to: { providerId: string } }> = [];
    const server = buildBridge(laneConfig(), limited.impl, (event) => failovers.push(event as never));
    const base = (await server.listen(0, '127.0.0.1')).url;
    try {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: `${CHATGPT_PLAN_PROVIDER_ID}/gpt-5.1`, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
      // The mock lane behind the plan served it.
      const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
      expect(body.choices[0]?.message.content).toMatch(/mock/i);

      // `rotation` tries every slot in the lane before leaving it, so the walk
      // is gpt-5.1 -> gpt-5.1-mini -> mock. A plan limit is account-wide and a
      // refused request spends nothing, so the extra hop costs latency only.
      // `onLimit: "stop"` skips it and surfaces the limit immediately.
      expect(failovers).toHaveLength(2);
      expect(failovers[0]!.from.providerId).toBe(CHATGPT_PLAN_PROVIDER_ID);
      expect(failovers[0]!.to.providerId).toBe(CHATGPT_PLAN_PROVIDER_ID);
      expect(failovers[1]!.from.providerId).toBe(CHATGPT_PLAN_PROVIDER_ID);
      expect(failovers[1]!.to.providerId).toBe('mock');
    } finally {
      await server.close();
    }
  });

  it('keeps serving from the fallback while the plan lane is parked', async () => {
    const limited = responsesUpstream({ failWith: { status: 429, detail: 'subscription_sharing_usage_limit_exceeded' } });
    let upstreamCalls = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      upstreamCalls += 1;
      return limited.impl(input, init);
    };
    const server = buildBridge(laneConfig({ onLimit: 'rotate' }), countingFetch);
    const base = (await server.listen(0, '127.0.0.1')).url;
    try {
      const send = () =>
        fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: `${CHATGPT_PLAN_PROVIDER_ID}/gpt-5.1`, messages: [{ role: 'user', content: 'hi' }] }),
        });
      await send();
      // Both slots of the rotation were attempted and both were parked.
      expect(upstreamCalls).toBe(2);
      // The slots cooled down, so the second request never re-walks them: a user
      // who is out of plan quota should not have every request retry the plan.
      const second = await send();
      expect(second.status).toBe(200);
      expect(upstreamCalls).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('surfaces the limit instead of spending another provider when onLimit is stop', async () => {
    const limited = responsesUpstream({ failWith: { status: 429, detail: 'subscription_sharing_usage_limit_exceeded' } });
    const server = buildBridge(laneConfig({ onLimit: 'stop' }), limited.impl);
    const base = (await server.listen(0, '127.0.0.1')).url;
    try {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: `${CHATGPT_PLAN_PROVIDER_ID}/gpt-5.1`, messages: [{ role: 'user', content: 'hi' }] }),
      });
      // Terminal: the 429 reaches the caller rather than being hidden behind a
      // different provider's bill. The bridge normalizes the upstream detail
      // into its own OpenAI error envelope, so the code is what carries through.
      expect(response.status).toBe(429);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('rate-limited');
      expect(body.error.message).toContain(CHATGPT_PLAN_PROVIDER_ID);
    } finally {
      await server.close();
    }
  });

  it('rotates on a 5xx from the lane', async () => {
    const down = responsesUpstream({ failWith: { status: 503, detail: 'direct routing is unavailable' } });
    const server = buildBridge(laneConfig(), down.impl);
    const base = (await server.listen(0, '127.0.0.1')).url;
    try {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: `${CHATGPT_PLAN_PROVIDER_ID}/gpt-5.1`, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]?.message.content).toMatch(/mock/i);
    } finally {
      await server.close();
    }
  });
});
