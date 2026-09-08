import { describe, expect, it } from 'vitest';
import { ModelHitchError } from '../src/core/errors.js';
import { OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS, createOpenCodeGoProvider, createOpenCodeZenProvider } from '../src/providers/opencode.js';
import type { ProviderCredentials } from '../src/core/types.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

/** Mock fetch that records requests and answers with a canned chat completion. */
function mockFetch(opts: {
  status?: number;
  errorBody?: string;
  stream?: boolean;
  chunks?: string[];
}) {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    calls.push({
      url,
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? '{}')),
    });

    if (opts.status && opts.status >= 400) {
      return new Response(opts.errorBody ?? '{"error":{"message":"boom"}}', {
        status: opts.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (opts.stream) {
      const encoder = new TextEncoder();
      const payload = (opts.chunks ?? []).join('\n\n') + '\n\n';
      return new Response(encoder.encode(payload), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl_test',
        model: 'test-model',
        choices: [
          {
            message: { role: 'assistant', content: 'Hello from the mock gateway!' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, calls };
}

const CREDENTIALS: ProviderCredentials = { apiKey: 'sk-test-123' };

describe('OpenCode Zen provider', () => {
  it('points at the Zen base URL with the right default model', () => {
    const zen = createOpenCodeZenProvider();
    expect(zen.id).toBe('opencode-zen');
    expect(zen.defaultModel).toBe('big-pickle');
  });

  it('sends OpenAI-compatible chat completions to https://opencode.ai/zen/v1', async () => {
    const { fetchImpl, calls } = mockFetch({});
    const zen = createOpenCodeZenProvider({ fetchImpl });
    const result = await zen.chat(
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hello' }] },
      CREDENTIALS,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer sk-test-123' });
    expect(calls[0]!.body).toMatchObject({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.message).toEqual({ role: 'assistant', content: 'Hello from the mock gateway!' });
    expect(result.usage?.totalTokens).toBe(18);
  });

  it('maps 401 to invalid-api-key (GPT models route to the Responses API)', async () => {
    const { fetchImpl, calls } = mockFetch({ status: 401 });
    const zen = createOpenCodeZenProvider({ fetchImpl });
    await expect(
      zen.chat({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }] }, CREDENTIALS),
    ).rejects.toMatchObject({ code: 'invalid-api-key', providerId: 'zen-responses' });
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/responses');
  });

  it('maps 404 to model-not-found', async () => {
    const { fetchImpl } = mockFetch({ status: 404, errorBody: '{"error":"model not found"}' });
    const zen = createOpenCodeZenProvider({ fetchImpl });
    const err = await zen
      .chat({ model: 'nope-404', messages: [{ role: 'user', content: 'hi' }] }, CREDENTIALS)
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ModelHitchError);
    expect((err as ModelHitchError).code).toBe('model-not-found');
  });

  it('normalizes streaming deltas from Zen', async () => {
    const { fetchImpl } = mockFetch({
      stream: true,
      chunks: [
        'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
        'data: [DONE]',
      ],
    });
    const zen = createOpenCodeZenProvider({ fetchImpl });
    const events = [];
    for await (const e of zen.stream(
      { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] },
      CREDENTIALS,
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      },
    ]);
  });

  it('lists models from https://opencode.ai/zen/v1/models', async () => {
    let url = '';
    const fetchImpl: typeof fetch = async (input) => {
      url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      return new Response(
        JSON.stringify({ data: [{ id: 'big-pickle' }, { id: 'gpt-5.6-luna' }] }),
        { status: 200 },
      );
    };
    const zen = createOpenCodeZenProvider({ fetchImpl });
    const models = await zen.listModels!(CREDENTIALS);
    expect(url).toBe('https://opencode.ai/zen/v1/models');
    expect(models.map((m) => m.id)).toEqual(['big-pickle', 'gpt-5.6-luna']);
  });

  it('throws missing-api-key without credentials', async () => {
    const savedZen = process.env.OPENCODE_ZEN_API_KEY;
    const savedGo = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_ZEN_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      const { fetchImpl } = mockFetch({});
      const zen = createOpenCodeZenProvider({ fetchImpl });
      await expect(
        zen.chat({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }, {}),
      ).rejects.toMatchObject({ code: 'missing-api-key' });
    } finally {
      if (savedZen !== undefined) process.env.OPENCODE_ZEN_API_KEY = savedZen;
      else delete process.env.OPENCODE_ZEN_API_KEY;
      if (savedGo !== undefined) process.env.OPENCODE_API_KEY = savedGo;
      else delete process.env.OPENCODE_API_KEY;
    }
  });

  it('curates non-empty Zen model list with the free models present', () => {
    expect(OPENCODE_ZEN_MODELS).toContain('big-pickle');
    expect(OPENCODE_ZEN_MODELS).toContain('deepseek-v4-flash-free');
    expect(OPENCODE_ZEN_MODELS).toContain('gpt-5.6-luna');
    expect(new Set(OPENCODE_ZEN_MODELS).size).toBe(OPENCODE_ZEN_MODELS.length);
  });
});

describe('OpenCode Go provider', () => {
  it('points at the Go base URL with a sensible default', () => {
    const go = createOpenCodeGoProvider();
    expect(go.id).toBe('opencode-go');
    expect(go.defaultModel).toBe('deepseek-v4-flash');
  });

  it('sends chat completions to https://opencode.ai/zen/go/v1 with session header and user agent', async () => {
    const { fetchImpl, calls } = mockFetch({});
    const go = createOpenCodeGoProvider({ fetchImpl });
    await go.chat({ model: 'kimi-k3', messages: [{ role: 'user', content: 'yo' }] }, CREDENTIALS);
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-opencode-session']).toMatch(/^mh-sess-/);
    expect(headers['User-Agent']).toBe('ModelHitch/0.15');
  });

  it('forwards caller session ID when provided in ChatParams', async () => {
    const { fetchImpl, calls } = mockFetch({});
    const go = createOpenCodeGoProvider({ fetchImpl });
    await go.chat({ model: 'kimi-k3', messages: [{ role: 'user', content: 'yo' }], sessionId: 'sess-custom-999' }, CREDENTIALS);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-opencode-session']).toBe('sess-custom-999');
    expect(headers['x-session-id']).toBe('sess-custom-999');
  });

  it('normalizes streaming tool calls from Go', async () => {
    const { fetchImpl } = mockFetch({
      stream: true,
      chunks: [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Tokyo\\"}"}}]},"finish_reason":null}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ],
    });
    const go = createOpenCodeGoProvider({ fetchImpl });
    const events = [];
    for await (const e of go.stream(
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'weather?' }] },
      CREDENTIALS,
    )) {
      events.push(e);
    }
    expect(events).toEqual([
      { type: 'tool-call-start', id: 'call_1', name: 'get_weather' },
      { type: 'tool-call-args-delta', id: 'call_1', argsDelta: '{"city":"Tokyo"}' },
      { type: 'tool-call-end', id: 'call_1' },
      { type: 'finish', finishReason: 'tool-calls' },
    ]);
  });

  it('curates non-empty Go model list', () => {
    expect(OPENCODE_GO_MODELS).toContain('grok-4.5');
    expect(OPENCODE_GO_MODELS).toContain('hy3');
    expect(new Set(OPENCODE_GO_MODELS).size).toBe(OPENCODE_GO_MODELS.length);
  });
});
