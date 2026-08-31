import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleProvider, deepseek } from '../src/providers/index.js';
import { ModelHitchError } from '../src/core/errors.js';
import type { ChatParams } from '../src/core/types.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function mockFetch(opts: { status?: number; errorBody?: string } = {}) {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    calls.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) });
    if (opts.status && opts.status >= 400) {
      return new Response(opts.errorBody ?? '{"error":{"message":"boom"}}', {
        status: opts.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, calls };
}

const baseParams: ChatParams = {
  model: 'deepseek-v4-pro',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('deepseek default provider', () => {
  it('exposes the DeepSeek config', () => {
    expect(deepseek.id).toBe('deepseek');
    expect(deepseek.name).toBe('DeepSeek');
    expect(deepseek.defaultModel).toBe('deepseek-v4-pro');
    expect(deepseek.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      vision: false,
      embeddings: false,
      maxContextTokens: 1_000_000,
    });
  });

  it('chats against the DeepSeek endpoint (no /v1) with an API key', async () => {
    // The exported default providers are singletons, so build an instance with
    // the same config plus an injected fetch to exercise the wire path offline.
    const { fetchImpl, calls } = mockFetch();
    const provider = createOpenAICompatibleProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-pro',
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
      fetchImpl,
    });
    const result = await provider.chat(baseParams, { apiKey: 'deepseek-test-key' });
    expect(calls[0]!.url).toBe('https://api.deepseek.com/chat/completions');
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: 'Bearer deepseek-test-key' });
    expect(result.message).toEqual({ role: 'assistant', content: 'ok' });
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  });

  it('throws missing-api-key when no DEEPSEEK_API_KEY is set', async () => {
    const saved = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const err = await deepseek.chat(baseParams, {}).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ModelHitchError);
      expect((err as ModelHitchError).code).toBe('missing-api-key');
      expect((err as ModelHitchError).message).toContain('DEEPSEEK_API_KEY');
    } finally {
      if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved;
      else delete process.env.DEEPSEEK_API_KEY;
    }
  });
});

describe('response_format rejection fallback', () => {
  // DeepSeek V4 rejects response_format outright:
  // "This response_format type is unavailable now". The provider must retry
  // once without the param, enforcing JSON via a system instruction instead.
  function rejectionThenOkFetch() {
    const calls: CapturedRequest[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      calls.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) });
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'This response_format type is unavailable now', type: 'invalid_request_error' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    return { fetchImpl, calls };
  }

  function providerWith(fetchImpl: typeof fetch) {
    return createOpenAICompatibleProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-flash',
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
      fetchImpl,
    });
  }

  const jsonParams: ChatParams = {
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'give me json' }],
    responseFormat: { type: 'json_object' },
  };

  it('chat retries once without response_format and appends the JSON instruction', async () => {
    const { fetchImpl, calls } = rejectionThenOkFetch();
    const result = await providerWith(fetchImpl).chat(jsonParams, { apiKey: 'k' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[1]!.body.response_format).toBeUndefined();
    const sys = calls[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(sys[0]!.role).toBe('system');
    expect(sys[0]!.content).toContain('Respond with valid JSON only');
    expect(result.message.content).toBe('{"ok":true}');
  });

  it('appends the instruction to an existing system message', async () => {
    const { fetchImpl, calls } = rejectionThenOkFetch();
    await providerWith(fetchImpl).chat(
      { ...jsonParams, messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'go' }] },
      { apiKey: 'k' },
    );
    const sys = (calls[1]!.body.messages as Array<{ role: string; content: string }>)[0]!;
    expect(sys.content).toContain('be terse');
    expect(sys.content).toContain('Respond with valid JSON only');
  });

  it('stream retries once with the degraded body', async () => {
    const calls: CapturedRequest[] = [];
    const sse = (obj: unknown) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`));
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      calls.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) });
      if (calls.length === 1) {
        return new Response('{"error":{"message":"This response_format type is unavailable now"}}', { status: 400 });
      }
      return sse({ choices: [{ delta: { content: '{}' }, finish_reason: null }] });
    };
    const chunks: string[] = [];
    for await (const c of providerWith(fetchImpl).stream(jsonParams, { apiKey: 'k' })) {
      if (c.type === 'text-delta') chunks.push(c.text);
    }
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.response_format).toBeUndefined();
    expect(chunks.join('')).toBe('{}');
  });

  it('unrelated 400s still throw immediately (no retry)', async () => {
    const calls: CapturedRequest[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls.push({ url: 'x', init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{"error":{"message":"context length exceeded"}}', { status: 400 });
    };
    const err = await providerWith(fetchImpl)
      .chat(jsonParams, { apiKey: 'k' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ModelHitchError);
    expect((err as ModelHitchError).code).toBe('bad-request');
    expect(calls).toHaveLength(1);
  });
});

describe('thinking mode: reasoning_content round-trip', () => {
  function providerWith(fetchImpl: typeof fetch) {
    return createOpenAICompatibleProvider({
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-flash',
      apiKeyEnvVar: 'DEEPSEEK_API_KEY',
      fetchImpl,
    });
  }

  const thinkingParams: ChatParams = {
    model: 'deepseek-v4-flash',
    messages: [
      // A prior assistant turn that produced reasoning content — DeepSeek
      // requires this exact string to be echoed back on every later request.
      {
        role: 'assistant',
        content: 'answer',
        reasoningContent: 'think it through',
      },
      { role: 'user', content: 'continue' },
    ],
  };

  it('echoes reasoning_content back on assistant messages in the request body', async () => {
    const calls: CapturedRequest[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      calls.push({ url, init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    await providerWith(fetchImpl).chat(thinkingParams, { apiKey: 'k' });
    const wire = calls[0]!.body.messages as Array<Record<string, unknown>>;
    expect(wire[0]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'think it through',
    });
  });

  it('captures reasoning_content from a non-streaming response', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'answer', reasoning_content: 'deep thoughts' },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const result = await providerWith(fetchImpl).chat(
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'k' },
    );
    expect(result.message).toMatchObject({
      role: 'assistant',
      content: 'answer',
      reasoningContent: 'deep thoughts',
    });
  });

  it('streams reasoning_content as reasoning-delta chunks', async () => {
    const events = [
      { choices: [{ delta: { reasoning_content: 'chain ' }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: 'of thought', content: '' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const obj of events) {
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`));
            }
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const chunks: Array<{ type: string; text?: string }> = [];
    for await (const c of providerWith(fetchImpl).stream(
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'k' },
    )) {
      chunks.push(c);
    }
    const reasoning = chunks
      .filter((c) => c.type === 'reasoning-delta')
      .map((c) => c.text)
      .join('');
    expect(reasoning).toBe('chain of thought');
    expect(chunks.some((c) => c.type === 'text-delta' && c.text === 'answer')).toBe(true);
  });
});
