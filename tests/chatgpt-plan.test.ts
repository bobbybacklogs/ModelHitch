import { describe, expect, it } from 'vitest';
import {
  CHATGPT_PLAN_PROVIDER_ID,
  CHATGPT_PLAN_USAGE_SCOPE,
  applyChatGptPlanPlan,
  chatGptPlanAccountKey,
  chatGptPlanModelSlug,
  describeChatGptPlan,
  hasChatGptPlanScope,
  isTokenExpired,
  parseScopeValue,
  resolveChatGptPlan,
  type ChatGptPlanToken,
  type ChatGptPlanTokenSource,
} from '../src/chatgpt-plan.js';
import { chatGptPlanProviders, isChatGptPlanProviderId, listChatGptPlanAccountModels } from '../src/chatgpt-plan-lane.js';
import { validateConfig } from '../src/config.js';
import { chatGptPlanRequestBody, createChatGptPlanProvider } from '../src/providers/chatgpt-plan.js';
import type { ChatParams } from '../src/core/types.js';
import { ModelHitchError } from '../src/core/errors.js';

/**
 * The ChatGPT plan lane, pinned at the levels that carry the risk:
 *
 * - the request body must satisfy a route that rejects fields the ordinary
 *   OpenAI API accepts, so the omissions are asserted as absences
 * - success requires `response.completed`, so a truncated stream must fail
 *   rather than look like a finished answer
 * - a plan-limit failure must arrive as a 429 so the existing failover walk
 *   rotates on it
 * - the routing plan must be able to lead, trail, or pin the lane
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseConfig(overrides: Record<string, unknown> = {}) {
  return { version: 1 as const, ...overrides };
}

const enabled = (block: Record<string, unknown> = {}) =>
  baseConfig({ chatgptPlan: { enabled: true, models: ['gpt-5.1', 'gpt-5.1-mini'], ...block } });

function params(overrides: Partial<ChatParams> = {}): ChatParams {
  return { model: 'gpt-5.1', messages: [{ role: 'user', content: 'hi' }], ...overrides };
}

/** A token source that records how often it was asked for a fresh token. */
function fakeTokens(): ChatGptPlanTokenSource & { calls: number; refreshes: number } {
  const token: ChatGptPlanToken = {
    accessToken: 'oauth-access-token',
    accountKey: 'sub::oaiapp_x',
    expiresAt: Date.now() + 3_600_000,
    planUsage: true,
  };
  return {
    calls: 0,
    refreshes: 0,
    async getToken() {
      this.calls += 1;
      return token;
    },
    async refreshToken() {
      this.refreshes += 1;
      return { ...token, accessToken: 'oauth-access-token-refreshed' };
    },
    describeAccount() {
      return 'user@example.com';
    },
  };
}

/** A `fetch` stub that records the request and answers with one response. */
function stubFetch(response: Response | ((url: string, init?: RequestInit) => Response)) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown>; authorization?: string }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body,
      ...(headers.Authorization ? { authorization: headers.Authorization } : {}),
    });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { calls, impl };
}

/** Build an SSE `Response` from Responses-stream events. */
function sseResponse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(text, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const completed = (usage = { input_tokens: 11, output_tokens: 4, total_tokens: 15 }) => ({
  type: 'response.completed',
  response: { id: 'resp_1', usage },
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

describe('chatGPT plan request body', () => {
  it('always sets store:false and stream:true, which this route requires', () => {
    const body = chatGptPlanRequestBody(params());
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
  });

  it('omits every field the preview route rejects', () => {
    const body = chatGptPlanRequestBody(
      params({
        temperature: 0.2,
        maxTokens: 512,
        stop: ['STOP'],
        previousResponseId: 'resp_previous',
        sessionId: 'session-1',
      }),
    );
    // Rejected outright on this route. Sending them is a 400, not a soft ignore.
    for (const rejected of [
      'temperature',
      'top_p',
      'max_output_tokens',
      'metadata',
      'user',
      'truncation',
      'prompt',
      'prompt_cache_retention',
      'safety_identifier',
      'top_logprobs',
      'background',
      'conversation',
      'max_tool_calls',
      'moderation',
      'multi_agent',
    ]) {
      expect(body).not.toHaveProperty(rejected);
    }
    // `previous_response_id` is unavailable over HTTP on this route.
    expect(body).not.toHaveProperty('previous_response_id');
    // No Responses equivalent, so a caller's stop list is dropped rather than sent.
    expect(body).not.toHaveProperty('stop');
  });

  it('sends system prompts as instructions, never as a system input item', () => {
    const body = chatGptPlanRequestBody(
      params({
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'system', content: 'Answer in English.' },
          { role: 'user', content: 'hi' },
        ],
      }),
    );
    expect(body.instructions).toBe('Be terse.\n\nAnswer in English.');
    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(JSON.stringify(input)).not.toContain('system');
  });

  it('maps the full message history into input items', () => {
    const body = chatGptPlanRequestBody(
      params({
        messages: [
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: 'checking',
            toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }],
          },
          { role: 'tool', content: 'sunny', toolCallId: 'call_1' },
        ],
      }),
    );
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ]);
  });

  it('maps image parts onto input_image', () => {
    const body = chatGptPlanRequestBody(
      params({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image', imageUrl: 'https://example.test/a.png' },
              { type: 'image-data', data: 'AAAA', mimeType: 'image/png' },
            ],
          },
        ],
      }),
    );
    expect(body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this' },
          { type: 'input_image', image_url: { url: 'https://example.test/a.png' } },
          { type: 'input_image', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
  });

  it('maps function tools and a named tool choice', () => {
    const body = chatGptPlanRequestBody(
      params({
        tools: [{ name: 'get_weather', description: 'Look up weather', parameters: { type: 'object' } }],
        toolChoice: { type: 'function', name: 'get_weather' },
      }),
    );
    expect(body.tools).toEqual([
      { type: 'function', name: 'get_weather', description: 'Look up weather', parameters: { type: 'object' } },
    ]);
    expect(body.tool_choice).toEqual({ type: 'function', name: 'get_weather' });
  });

  it('maps a JSON-schema response format onto text.format', () => {
    const body = chatGptPlanRequestBody(
      params({ responseFormat: { type: 'json_schema', name: 'answer', strict: true, schema: { type: 'object' } } }),
    );
    expect(body.text).toEqual({
      format: { type: 'json_schema', name: 'answer', strict: true, schema: { type: 'object' } },
    });
  });

  it('strips a chatgpt-plan/ route prefix from the model', () => {
    expect(chatGptPlanRequestBody(params({ model: 'chatgpt-plan/gpt-5.1' })).model).toBe('gpt-5.1');
    expect(chatGptPlanModelSlug('chatgpt-plan/gpt-5.1')).toBe('gpt-5.1');
    expect(chatGptPlanModelSlug('gpt-5.1')).toBe('gpt-5.1');
  });
});

// ---------------------------------------------------------------------------
// Provider: streaming
// ---------------------------------------------------------------------------

describe('chatGPT plan provider streaming', () => {
  it('streams text and finishes on response.completed with usage and the response id', async () => {
    const tokens = fakeTokens();
    const { calls, impl } = stubFetch(
      sseResponse([
        { type: 'response.created', response: { id: 'resp_1' } },
        { type: 'response.output_text.delta', delta: 'Hel' },
        { type: 'response.output_text.delta', delta: 'lo' },
        completed(),
      ]),
    );
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });

    const chunks = [];
    for await (const chunk of provider.stream(params(), {})) chunks.push(chunk);

    expect(chunks).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 }, responseId: 'resp_1' },
    ]);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.authorization).toBe('Bearer oauth-access-token');
    expect(calls[0]!.body.store).toBe(false);
    expect(calls[0]!.body.stream).toBe(true);
  });

  it('assembles function-call arguments across deltas and reports tool-calls', async () => {
    const tokens = fakeTokens();
    const { impl } = stubFetch(
      sseResponse([
        {
          type: 'response.output_item.added',
          item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'get_weather' },
        },
        { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"city"' },
        { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: ':"Paris"}' },
        { type: 'response.output_item.done', item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'get_weather' } },
        completed(),
      ]),
    );
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });

    const result = await provider.chat(params(), {});
    expect(result.message).toMatchObject({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } }],
    });
    expect(result.finishReason).toBe('tool-calls');
  });

  it('replays a whole argument string delivered only on the done item', async () => {
    const tokens = fakeTokens();
    const { impl } = stubFetch(
      sseResponse([
        { type: 'response.output_item.added', item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'f' } },
        {
          type: 'response.output_item.done',
          item: { id: 'item_1', type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"a":1}' },
        },
        completed(),
      ]),
    );
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });
    const result = await provider.chat(params(), {});
    expect(result.message).toMatchObject({ toolCalls: [{ id: 'call_1', name: 'f', arguments: { a: 1 } }] });
  });

  it('emits reasoning deltas from the reasoning-summary events', async () => {
    const tokens = fakeTokens();
    const { impl } = stubFetch(
      sseResponse([
        { type: 'response.reasoning_summary_text.delta', delta: 'thinking' },
        { type: 'response.output_text.delta', delta: 'answer' },
        completed(),
      ]),
    );
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });
    const result = await provider.chat(params(), {});
    expect(result.message).toMatchObject({ content: 'answer', reasoningContent: 'thinking' });
  });

  it('fails a stream that ends without response.completed instead of reporting a clean stop', async () => {
    // The spec is explicit: only response.completed means the answer is whole.
    // A truncated stream that looked like a finish would hand the caller half
    // an answer with no signal that it was cut off.
    const tokens = fakeTokens();
    const { impl } = stubFetch(
      sseResponse([{ type: 'response.output_text.delta', delta: 'partial' }]),
    );
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });

    await expect(provider.chat(params(), {})).rejects.toThrowError(/without response\.completed/);
  });

  it('treats response.incomplete as a terminal, non-clean finish', async () => {
    const tokens = fakeTokens();
    const { impl } = stubFetch(
      sseResponse([
        { type: 'response.output_text.delta', delta: 'cut' },
        { type: 'response.incomplete', response: { id: 'resp_2', incomplete_details: { reason: 'max_output_tokens' } } },
      ]),
    );
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });
    const result = await provider.chat(params(), {});
    expect(result.finishReason).toBe('length');
    expect(result.message).toMatchObject({ content: 'cut' });
  });
});

// ---------------------------------------------------------------------------
// Provider: failure mapping
// ---------------------------------------------------------------------------

describe('chatGPT plan failure mapping', () => {
  const failure = (code: string, message = 'nope') =>
    sseResponse([{ type: 'response.failed', response: { error: { code, message } } }]);

  async function errorFor(code: string): Promise<ModelHitchError> {
    const tokens = fakeTokens();
    const { impl } = stubFetch(failure(code));
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });
    try {
      await provider.chat(params(), {});
    } catch (err) {
      return err as ModelHitchError;
    }
    throw new Error('expected the request to fail');
  }

  it('maps a plan usage limit onto a 429 so the failover walk rotates', async () => {
    // This is the failure a Plus account hits after the shared five-hour total
    // is spent. Without the status it would look like a hard error and the
    // rotation would stop on a lane that is merely rested.
    const err = await errorFor('subscription_sharing_usage_limit_exceeded');
    expect(err.code).toBe('rate-limited');
    expect(err.status).toBe(429);
    expect(err.message).toContain('subscription_sharing_usage_limit_exceeded');
  });

  it('maps a rejected subscriber identity onto invalid-api-key, which skips the lane', async () => {
    const err = await errorFor('subscription_sharing_invalid_user');
    expect(err.code).toBe('invalid-api-key');
    expect(err.status).toBe(401);
  });

  it('maps an ineligible account onto bad-request so the same request is not repeated', async () => {
    const err = await errorFor('subscription_sharing_user_not_eligible');
    expect(err.code).toBe('bad-request');
    expect(err.status).toBe(403);
  });

  it('maps temporarily unavailable usage onto a 5xx provider error', async () => {
    expect((await errorFor('subscription_sharing_usage_unavailable')).code).toBe('provider-error');
    expect((await errorFor('subscription_sharing_user_unavailable')).status).toBe(503);
  });

  it('maps an unsupported capability onto bad-request and keeps the offending param', async () => {
    const tokens = fakeTokens();
    const { impl } = stubFetch(
      sseResponse([
        {
          type: 'response.failed',
          response: { error: { code: 'subscription_sharing_unsupported_capability', message: 'no', param: 'tools' } },
        },
      ]),
    );
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });
    await expect(provider.chat(params(), {})).rejects.toThrowError(/param: tools/);
  });

  it('appends the plan-usage settings link to a rate limit so the caller can act', async () => {
    const err = await errorFor('subscription_sharing_usage_limit_exceeded');
    expect(err.message).toContain('https://chatgpt.com/settings/usage');
  });

  it('maps a pre-stream 401 onto invalid-api-key and retries once after a forced refresh', async () => {
    const tokens = fakeTokens();
    let attempt = 0;
    const impl: typeof fetch = async (_input, init) => {
      attempt += 1;
      const authorization = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      if (attempt === 1) {
        return new Response(JSON.stringify({ detail: 'unauthorized' }), { status: 401 });
      }
      expect(authorization).toBe('Bearer oauth-access-token-refreshed');
      return sseResponse([completed()]);
    };
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });

    const result = await provider.chat(params(), {});
    expect(result.finishReason).toBe('stop');
    expect(tokens.refreshes).toBe(1);
    expect(attempt).toBe(2);
  });

  it('reports a persistent pre-stream rejection without retrying forever', async () => {
    const tokens = fakeTokens();
    let attempt = 0;
    const impl: typeof fetch = async () => {
      attempt += 1;
      return new Response(JSON.stringify({ detail: 'not available in your region' }), { status: 503 });
    };
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });

    await expect(provider.chat(params(), {})).rejects.toThrowError(/not available in your region/);
    expect(attempt).toBe(1);
  });

  it('surfaces a helpful error when no account is signed in', async () => {
    const tokens: ChatGptPlanTokenSource = {
      async getToken() {
        throw new ModelHitchError('missing-api-key', 'no account', { providerId: CHATGPT_PLAN_PROVIDER_ID });
      },
      async refreshToken() {
        throw new ModelHitchError('missing-api-key', 'no account', { providerId: CHATGPT_PLAN_PROVIDER_ID });
      },
      describeAccount: () => 'no ChatGPT account',
    };
    const { impl } = stubFetch(new Response('{}', { status: 200 }));
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });
    await expect(provider.chat(params(), {})).rejects.toMatchObject({ code: 'missing-api-key' });
  });

  it('prefers an explicit per-call key over the credential source', async () => {
    const tokens = fakeTokens();
    const { calls, impl } = stubFetch(sseResponse([completed()]));
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });

    await provider.chat(params(), { apiKey: 'explicit-token' });
    expect(calls[0]!.authorization).toBe('Bearer explicit-token');
    expect(tokens.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provider: model listing
// ---------------------------------------------------------------------------

describe('chatGPT plan model listing', () => {
  it('reads the account catalogue shape and keeps only displayable models in order', async () => {
    // This route answers `{ models: [{ slug, display_name, visibility }] }`,
    // not the standard `{ data: [{ id }] }`.
    const tokens = fakeTokens();
    const { calls, impl } = stubFetch(
      new Response(
        JSON.stringify({
          models: [
            { slug: 'gpt-5.1', display_name: 'GPT-5.1', visibility: 'list' },
            { slug: 'internal-preview', display_name: 'Hidden', visibility: 'hidden' },
            { slug: 'gpt-5.1-mini', display_name: 'GPT-5.1 mini', visibility: 'list' },
          ],
        }),
        { status: 200 },
      ),
    );
    const provider = createChatGptPlanProvider({ tokens, models: [], fetchImpl: impl });

    expect(await provider.listModels!({})).toEqual([
      { id: 'gpt-5.1', name: 'GPT-5.1' },
      { id: 'gpt-5.1-mini', name: 'GPT-5.1 mini' },
    ]);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/models');
  });

  it('falls back to the standard data shape when the route answers that way', async () => {
    const tokens = fakeTokens();
    const { impl } = stubFetch(new Response(JSON.stringify({ data: [{ id: 'gpt-5.1' }] }), { status: 200 }));
    const provider = createChatGptPlanProvider({ tokens, models: [], fetchImpl: impl });
    expect(await provider.listModels!({})).toEqual([{ id: 'gpt-5.1' }]);
  });

  it('reports the configured slots when the catalogue cannot be read', async () => {
    const tokens = fakeTokens();
    const { impl } = stubFetch(new Response('nope', { status: 500 }));
    const provider = createChatGptPlanProvider({ tokens, models: ['gpt-5.1'], fetchImpl: impl });
    expect(await provider.listModels!({})).toEqual([{ id: 'gpt-5.1' }]);
  });

  it('returns nothing for a probe with no signed-in account instead of throwing', async () => {
    const tokens: ChatGptPlanTokenSource = {
      async getToken() {
        throw new ModelHitchError('missing-api-key', 'no account', { providerId: CHATGPT_PLAN_PROVIDER_ID });
      },
      async refreshToken() {
        throw new ModelHitchError('missing-api-key', 'no account', { providerId: CHATGPT_PLAN_PROVIDER_ID });
      },
      describeAccount: () => 'none',
    };
    const { impl } = stubFetch(new Response('{}', { status: 200 }));
    const provider = createChatGptPlanProvider({ tokens, models: [], fetchImpl: impl });
    expect(await provider.listModels!({})).toEqual([]);
  });

  it('exposes the lane id, name, and honest capabilities', () => {
    const provider = createChatGptPlanProvider({ tokens: fakeTokens(), models: ['gpt-5.1'] });
    expect(provider.id).toBe(CHATGPT_PLAN_PROVIDER_ID);
    expect(provider.name).toBe('ChatGPT plan');
    expect(provider.defaultModel).toBe('gpt-5.1');
    expect(provider.capabilities).toMatchObject({ streaming: true, toolCalling: true, embeddings: false });
  });
});

// ---------------------------------------------------------------------------
// Lane resolution and the routing plan
// ---------------------------------------------------------------------------

describe('chatGPT plan lane resolution', () => {
  it('does not serve a disabled block', () => {
    expect(resolveChatGptPlan(baseConfig({ chatgptPlan: { enabled: false, models: ['gpt-5.1'] } }))).toBeUndefined();
    expect(chatGptPlanProviders(baseConfig({ chatgptPlan: { enabled: false, models: ['gpt-5.1'] } }), { tokens: fakeTokens() })).toEqual([]);
  });

  it('refuses to invent a model slug when the config and the account both have none', () => {
    // ChatGPT plan slugs are account-specific. A guessed slug is a lane that
    // 404s, so an empty set means "not served" rather than a default.
    expect(resolveChatGptPlan(enabled({ models: [] }))).toBeUndefined();
    expect(resolveChatGptPlan(enabled({ models: [] }), { accountModels: [] })).toBeUndefined();
  });

  it('uses the account catalogue when the config lists no slots', () => {
    const lane = resolveChatGptPlan(enabled({ models: [] }), { accountModels: ['gpt-5.1', 'gpt-5.1-mini'] });
    expect(lane?.models).toEqual(['gpt-5.1', 'gpt-5.1-mini']);
  });

  it('lets an explicit config list win over the account catalogue', () => {
    const lane = resolveChatGptPlan(enabled({ models: ['chosen'] }), { accountModels: ['other'] });
    expect(lane?.models).toEqual(['chosen']);
  });

  it('de-duplicates and trims slots, and strips a route prefix', () => {
    const lane = resolveChatGptPlan(enabled({ models: ['chatgpt-plan/a', ' a ', 'b', '  '] }));
    expect(lane?.models).toEqual(['a', 'b']);
  });

  it('falls back to the first slot when the pin names a model outside the list', () => {
    const lane = resolveChatGptPlan(enabled({ mode: 'pinned', pinnedModel: 'absent' }));
    expect(lane?.pinnedModel).toBe('gpt-5.1');
  });

  it('needs a credential source to build a provider', () => {
    expect(chatGptPlanProviders(enabled(), {})).toEqual([]);
    expect(chatGptPlanProviders(enabled(), { tokens: fakeTokens() })).toHaveLength(1);
  });

  it('identifies its own providers so a rebuild can drop the stale one', () => {
    expect(isChatGptPlanProviderId('chatgpt-plan')).toBe(true);
    expect(isChatGptPlanProviderId('openai')).toBe(false);
  });

  it('lists account models through a probe without touching the config block', async () => {
    const { impl } = stubFetch(
      new Response(JSON.stringify({ models: [{ slug: 'gpt-5.1', display_name: 'GPT-5.1', visibility: 'list' }] }), {
        status: 200,
      }),
    );
    expect(await listChatGptPlanAccountModels({ tokens: fakeTokens(), fetchImpl: impl })).toEqual(['gpt-5.1']);
    expect(await listChatGptPlanAccountModels({})).toEqual([]);
  });
});

describe('chatGPT plan routing plan', () => {
  const basePolicy = { trusted: [{ providerId: 'openai', models: ['gpt-5.4'] }], fallback: [] };

  it('leads by default: the lane first, the configured plan directly behind it', () => {
    const plan = applyChatGptPlanPlan({ config: enabled(), policy: basePolicy });
    expect(plan.policy?.trusted[0]).toEqual({ providerId: CHATGPT_PLAN_PROVIDER_ID, models: ['gpt-5.1', 'gpt-5.1-mini'] });
    expect(plan.policy?.trusted[1]).toEqual({ providerId: 'openai', models: ['gpt-5.4'] });
    expect(plan.defaultProviderId).toBe(CHATGPT_PLAN_PROVIDER_ID);
    expect(plan.defaultModel).toBe('gpt-5.1');
    expect(plan.leads).toBe(true);
    expect(plan.lanes).toEqual([
      { providerId: CHATGPT_PLAN_PROVIDER_ID, model: 'gpt-5.1' },
      { providerId: CHATGPT_PLAN_PROVIDER_ID, model: 'gpt-5.1-mini' },
    ]);
  });

  it('trails when placement is fallback, leaving the primary route alone', () => {
    const plan = applyChatGptPlanPlan({
      config: enabled({ placement: 'fallback' }),
      policy: basePolicy,
      defaultProviderId: 'openai',
      defaultModel: 'gpt-5.4',
    });
    expect(plan.policy?.trusted).toEqual([{ providerId: 'openai', models: ['gpt-5.4'] }]);
    expect(plan.policy?.fallback).toEqual([
      { providerId: CHATGPT_PLAN_PROVIDER_ID, models: ['gpt-5.1', 'gpt-5.1-mini'] },
    ]);
    expect(plan.defaultProviderId).toBe('openai');
    expect(plan.leads).toBe(false);
  });

  it('pins the chosen model first and keeps its siblings as the first fallback', () => {
    const plan = applyChatGptPlanPlan({
      config: enabled({ mode: 'pinned', pinnedModel: 'gpt-5.1-mini' }),
      policy: basePolicy,
    });
    expect(plan.policy?.trusted[0]).toEqual({
      providerId: CHATGPT_PLAN_PROVIDER_ID,
      models: ['gpt-5.1-mini', 'gpt-5.1'],
    });
    expect(plan.defaultModel).toBe('gpt-5.1-mini');
    expect(plan.mode).toBe('pinned');
  });

  it('marks the lane terminal when onLimit is stop', () => {
    const plan = applyChatGptPlanPlan({ config: enabled({ onLimit: 'stop' }), policy: basePolicy });
    expect(plan.policy?.trusted[0]).toMatchObject({ terminal: true });
    expect(plan.stopping).toEqual([CHATGPT_PLAN_PROVIDER_ID]);
  });

  it('leaves the incoming plan untouched when the block is off or unservable', () => {
    const untouched = applyChatGptPlanPlan({ config: baseConfig(), policy: basePolicy, defaultProviderId: 'openai' });
    expect(untouched.policy).toBe(basePolicy);
    expect(untouched.defaultProviderId).toBe('openai');
    expect(untouched.lanes).toEqual([]);

    const empty = applyChatGptPlanPlan({ config: enabled({ models: [] }), policy: basePolicy });
    expect(empty.policy).toBe(basePolicy);
    expect(empty.lanes).toEqual([]);
  });

  it('describes an applied plan and stays silent about an unused one', () => {
    expect(describeChatGptPlan(applyChatGptPlanPlan({ config: enabled(), policy: basePolicy }))).toMatch(/leading/);
    expect(describeChatGptPlan(applyChatGptPlanPlan({ config: baseConfig() }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// credential helpers
// ---------------------------------------------------------------------------

describe('chatGPT plan credential helpers', () => {
  it('detects the plan-usage scope from a list or a raw scope value', () => {
    expect(hasChatGptPlanScope(['openid', CHATGPT_PLAN_USAGE_SCOPE])).toBe(true);
    expect(hasChatGptPlanScope('openid profile chatgpt.tokens.use.direct')).toBe(true);
    expect(hasChatGptPlanScope(['openid', 'profile'])).toBe(false);
    expect(hasChatGptPlanScope(undefined)).toBe(false);
  });

  it('parses and de-duplicates a space-separated scope value', () => {
    expect(parseScopeValue('openid  profile openid')).toEqual(['openid', 'profile']);
    expect(parseScopeValue(undefined)).toEqual([]);
  });

  it('keys an account by subject and issued client id together', () => {
    // Two registrations can share an email, and one registration can be
    // reissued; the pair is what identifies a registration.
    const a = chatGptPlanAccountKey('sub_1', 'oaiapp_a');
    const b = chatGptPlanAccountKey('sub_1', 'oaiapp_b');
    expect(a).not.toBe(b);
  });

  it('treats a token inside the skew window as expired', () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect(isTokenExpired({ expiresAt: soon })).toBe(true);
    expect(isTokenExpired({ expiresAt: later })).toBe(false);
    expect(isTokenExpired({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// config validation
// ---------------------------------------------------------------------------

describe('chatgptPlan config validation', () => {
  const errorsFor = (block: unknown) => validateConfig(baseConfig({ chatgptPlan: block })).errors.join('\n');
  const warningsFor = (block: unknown) => validateConfig(baseConfig({ chatgptPlan: block })).warnings.join('\n');

  it('accepts a minimal enabled block', () => {
    expect(errorsFor({ enabled: true, models: ['gpt-5.1'] })).toBe('');
  });

  it('rejects a non-boolean enabled and bad discriminators', () => {
    expect(errorsFor({ enabled: 'yes' })).toMatch(/enabled must be a boolean/);
    expect(errorsFor({ enabled: true, mode: 'round-robin' })).toMatch(/mode must be/);
    expect(errorsFor({ enabled: true, placement: 'middle' })).toMatch(/placement must be/);
    expect(errorsFor({ enabled: true, onLimit: 'explode' })).toMatch(/onLimit must be/);
  });

  it('rejects malformed model slots and an empty account key', () => {
    expect(errorsFor({ enabled: true, models: 'gpt-5.1' })).toMatch(/models must be an array/);
    expect(errorsFor({ enabled: true, models: [' '] })).toMatch(/models must be an array/);
    expect(errorsFor({ enabled: true, accountKey: '' })).toMatch(/accountKey must be a non-empty string/);
  });

  it('rejects a pin that names a model the lane does not serve', () => {
    // Routing to a model outside the slot list is a lane that cannot answer.
    expect(errorsFor({ enabled: true, mode: 'pinned', models: ['a'], pinnedModel: 'b' })).toMatch(
      /is not one of chatgptPlan\.models/,
    );
    expect(errorsFor({ enabled: true, mode: 'pinned', models: ['a'], pinnedModel: 'a' })).toBe('');
  });

  it('warns rather than fails when a pinned mode has no pin, and when slots are empty', () => {
    expect(warningsFor({ enabled: true, mode: 'pinned', models: ['a'] })).toMatch(/the first model slot leads/);
    expect(warningsFor({ enabled: true, models: [] })).toMatch(/reads the signed-in account/);
  });

  it('warns about duplicate slots', () => {
    expect(warningsFor({ enabled: true, models: ['a', ' a '] })).toMatch(/duplicate model slugs/);
  });
});
