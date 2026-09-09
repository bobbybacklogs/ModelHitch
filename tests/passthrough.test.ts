import { describe, expect, it } from 'vitest';
import { createOpenAICompatibleProvider, mapHTTPError } from '../src/providers/openai-compatible.js';
import type { ChatParams, ProviderCredentials } from '../src/core/types.js';
import { isRetryableError } from '../src/core/failover.js';
import { toModelHitchResponseFormat, toModelHitchToolChoice } from '../src/server/mapping.js';
import { mockProvider } from '../src/providers/mock.js';

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
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetchImpl, calls };
}

const baseParams: ChatParams = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('OpenAI-compatible error mapping', () => {
  it('retries an upstream model-unavailable failure wrapped in HTTP 400', () => {
    const body = JSON.stringify({
      error: {
        message: 'Provider "vercel-ai-gateway" rejected the request. ({"error":{"type":"server_error","message":"Error from provider (Console): Upstream request failed: Model is unavailable."}})',
        type: 'invalid_request_error',
        code: 'bad-request',
      },
    });

    const error = mapHTTPError(400, 'openai', body);

    expect(error).toMatchObject({ code: 'provider-error', status: 400, providerId: 'openai' });
    expect(isRetryableError(error)).toBe(true);
  });

  it('keeps genuine HTTP 400 request errors non-retryable', () => {
    const error = mapHTTPError(400, 'openai', '{"error":{"message":"messages is required"}}');

    expect(error.code).toBe('bad-request');
    expect(isRetryableError(error)).toBe(false);
  });
});

describe('tool_choice / response_format passthrough (OpenAI-compatible adapter)', () => {
  it('forwards tool_choice and response_format in the request body', async () => {
    const { fetchImpl, calls } = mockFetch();
    const provider = createOpenAICompatibleProvider({
      id: 'test',
      name: 'Test',
      defaultModel: 'test-model',
      baseUrl: 'https://example.com/v1',
      requiresKey: false,
      fetchImpl,
    });
    await provider.chat(
      {
        ...baseParams,
        toolChoice: { type: 'function', name: 'get_weather' },
        responseFormat: {
          type: 'json_schema',
          name: 'weather',
          strict: true,
          schema: { type: 'object', properties: { temp: { type: 'number' } } },
        },
      },
      {},
    );
    expect(calls[0]!.body.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    expect(calls[0]!.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'weather', strict: true, schema: { type: 'object', properties: { temp: { type: 'number' } } } },
    });
  });

  it('omits response_format when normalized value is text', async () => {
    const { fetchImpl, calls } = mockFetch();
    const provider = createOpenAICompatibleProvider({
      id: 'test',
      name: 'Test',
      defaultModel: 'test-model',
      baseUrl: 'https://example.com/v1',
      requiresKey: false,
      fetchImpl,
    });
    await provider.chat({ ...baseParams, responseFormat: 'text' }, {});
    expect(calls[0]!.body.response_format).toBeUndefined();
  });

  it('forwards simple tool_choice strings', async () => {
    const { fetchImpl, calls } = mockFetch();
    const provider = createOpenAICompatibleProvider({
      id: 'test',
      name: 'Test',
      defaultModel: 'test-model',
      baseUrl: 'https://example.com/v1',
      requiresKey: false,
      fetchImpl,
    });
    await provider.chat({ ...baseParams, toolChoice: 'none' }, {});
    expect(calls[0]!.body.tool_choice).toBe('none');
  });

  it('coerces non-string tool content to a string before sending (GLM 5.2 regression)', async () => {
    // GLM's pydantic backend rejects tool messages whose `content` is not a
    // string (`ChatCompletionToolMessage.content` "Input should be a valid
    // string"). The adapter must never forward a non-string tool message.
    const { fetchImpl, calls } = mockFetch();
    const provider = createOpenAICompatibleProvider({
      id: 'test',
      name: 'Test',
      defaultModel: 'test-model',
      baseUrl: 'https://example.com/v1',
      requiresKey: false,
      fetchImpl,
    });
    await provider.chat(
      {
        ...baseParams,
        messages: [
          { role: 'user', content: 'read the image' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_image', arguments: {} }] },
          // Simulate a tool message whose content somehow is not a plain
          // string at runtime (e.g. an array/object left over from mapping).
          { role: 'tool', content: [{ type: 'output_image', image_url: 'data:image/png;base64,abc' }] as unknown as string, toolCallId: 'call_1' },
        ],
      },
      {},
    );
    const messages = calls[0]!.body.messages as Array<Record<string, unknown>>;
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(typeof toolMsg!.content).toBe('string');
    expect(toolMsg!.content).toContain('image');
  });

  it('keeps plain string tool content untouched', async () => {
    const { fetchImpl, calls } = mockFetch();
    const provider = createOpenAICompatibleProvider({
      id: 'test',
      name: 'Test',
      defaultModel: 'test-model',
      baseUrl: 'https://example.com/v1',
      requiresKey: false,
      fetchImpl,
    });
    await provider.chat(
      {
        ...baseParams,
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', arguments: {} }] },
          { role: 'tool', content: '{"temp": 21}', toolCallId: 'call_1' },
        ],
      },
      {},
    );
    const messages = calls[0]!.body.messages as Array<Record<string, unknown>>;
    const toolMsg = messages.find((m) => m.role === 'tool');
    expect(toolMsg!.content).toBe('{"temp": 21}');
  });
});

describe('tool_choice / response_format normalization (bridge mapping)', () => {
  it('parses the OpenAI object forms', () => {
    expect(toModelHitchToolChoice('auto')).toBe('auto');
    expect(toModelHitchToolChoice('none')).toBe('none');
    expect(toModelHitchToolChoice('required')).toBe('required');
    expect(toModelHitchToolChoice({ type: 'function', function: { name: 'calc' } })).toEqual({
      type: 'function',
      name: 'calc',
    });
    expect(toModelHitchToolChoice({ type: 'function', name: 'calc' })).toEqual({ type: 'function', name: 'calc' });
    expect(toModelHitchToolChoice({ type: 'weird' })).toBeUndefined();
    expect(toModelHitchToolChoice(undefined)).toBeUndefined();
  });

  it('parses response_format object and string forms', () => {
    expect(toModelHitchResponseFormat('json')).toBe('json');
    expect(toModelHitchResponseFormat('text')).toBe('text');
    expect(toModelHitchResponseFormat({ type: 'text' })).toBe('text');
    expect(toModelHitchResponseFormat({ type: 'json_object' })).toBe('json');
    expect(
      toModelHitchResponseFormat({
        type: 'json_schema',
        json_schema: { name: 's', strict: true, schema: { type: 'object' } },
      }),
    ).toEqual({ type: 'json_schema', name: 's', strict: true, schema: { type: 'object' } });
    expect(toModelHitchResponseFormat({ type: 'json_schema' })).toBeUndefined();
    expect(toModelHitchResponseFormat(undefined)).toBeUndefined();
  });
});

describe('toolChoice on the mock provider', () => {
  it('suppresses tool simulation when toolChoice is none', async () => {
    const result = await mockProvider.chat(
      {
        ...baseParams,
        messages: [{ role: 'user', content: '!tool get_weather' }],
        toolChoice: 'none',
      },
      {},
    );
    expect(result.finishReason).toBe('stop');
    const toolCalls = result.message.role === 'assistant' ? result.message.toolCalls : undefined;
    expect(toolCalls).toBeUndefined();
    expect(typeof result.message.content).toBe('string');
    expect((result.message.content as string).includes('Mock reply')).toBe(true);
  });

  it('still simulates tools when toolChoice is required', async () => {
    const result = await mockProvider.chat(
      {
        ...baseParams,
        messages: [{ role: 'user', content: '!tool get_weather' }],
        toolChoice: 'required',
      },
      {},
    );
    expect(result.finishReason).toBe('tool-calls');
    const toolCalls = result.message.role === 'assistant' ? result.message.toolCalls : undefined;
    expect(toolCalls?.[0]?.name).toBe('get_weather');
  });
});

describe('bridge tool_choice passthrough to provider', () => {
  it('routes normalized tool_choice into ChatParams', async () => {
    // A recording provider captures the ChatParams it receives.
    const capture: { params: ChatParams | null } = { params: null };
    const recording: typeof mockProvider = {
      ...mockProvider,
      async chat(params: ChatParams, _creds: ProviderCredentials) {
        capture.params = params;
        return mockProvider.chat(params, _creds);
      },
    };

    // Spin a server with the recording provider and hit /v1/chat/completions.
    const { OpenAICompatibleServer } = await import('../src/index.js');
    const server = new OpenAICompatibleServer({
      providers: [recording],
      defaultProviderId: 'mock',
    });
    const { url } = await server.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mock-model',
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(200);
      expect(capture.params?.toolChoice).toEqual({ type: 'function', name: 'get_weather' });
      expect(capture.params?.responseFormat).toBe('json');
    } finally {
      await server.close();
    }
  }, 30_000);
});
