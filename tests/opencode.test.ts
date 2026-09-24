import { describe, expect, it } from 'vitest';
import {
  createOpenCodeProvider,
  detectOpenCodeWire,
  opencode,
  opencodeGo,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_GO_BASE_URL,
  OPENCODE_SNAPSHOT_MODELS,
  OPENCODE_ZEN_BASE_URL,
} from '../src/providers/opencode.js';
import { estimateCost, pricingFor } from '../src/core/cost.js';
import { ModelHitchError } from '../src/core/errors.js';
import type { ChatParams } from '../src/core/types.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function mockOpenCodeFetch(opts: {
  status?: number;
  errorBody?: string;
  responseBody?: unknown;
  sseLines?: string[];
} = {}) {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const bodyStr = String(init?.body ?? '{}');
    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = JSON.parse(bodyStr);
    } catch {
      parsedBody = { raw: bodyStr };
    }

    calls.push({
      url,
      init: init ?? {},
      body: parsedBody,
      headers: rawHeaders,
    });

    if (opts.status && opts.status >= 400) {
      return new Response(opts.errorBody ?? '{"error":{"message":"boom"}}', {
        status: opts.status,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (opts.sseLines) {
      const stream = new ReadableStream({
        start(controller) {
          for (const line of opts.sseLines!) {
            controller.enqueue(new TextEncoder().encode(line + '\n\n'));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    if (opts.responseBody !== undefined) {
      return new Response(JSON.stringify(opts.responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Default responses based on endpoint pattern
    if (url.includes('/messages')) {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Anthropic wire response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 6 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.includes('/responses')) {
      return new Response(
        JSON.stringify({
          id: 'resp_123',
          object: 'response',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Responses API response' }],
            },
          ],
          usage: { input_tokens: 15, output_tokens: 8, total_tokens: 23 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    if (url.includes(':generateContent')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Gemini wire response' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }

    // Chat completions default
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Chat completions response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  return { fetchImpl, calls };
}

describe('OpenCode wire detection', () => {
  it('routes GPT models to responses wire', () => {
    expect(detectOpenCodeWire('gpt-5.5')).toBe('responses');
    expect(detectOpenCodeWire('gpt-5.3-codex')).toBe('responses');
    expect(detectOpenCodeWire('gpt-6-astra')).toBe('responses');
    expect(detectOpenCodeWire('opencode/gpt-5.5')).toBe('responses');
    expect(detectOpenCodeWire('opencode-go/gpt-5.4-mini')).toBe('responses');
  });

  it('routes Grok and Muse Spark to responses wire', () => {
    expect(detectOpenCodeWire('grok-4.7')).toBe('responses');
    expect(detectOpenCodeWire('muse-spark-1.3')).toBe('responses');
    expect(detectOpenCodeWire('muse-spark-1.3-contributor-free')).toBe('responses');
  });

  it('routes Claude and Qwen to messages wire', () => {
    expect(detectOpenCodeWire('claude-sonnet-4-6')).toBe('messages');
    expect(detectOpenCodeWire('claude-opus-4-6')).toBe('messages');
    expect(detectOpenCodeWire('claude-haiku-4-5')).toBe('messages');
    expect(detectOpenCodeWire('qwen3.7-max')).toBe('messages');
    expect(detectOpenCodeWire('qwen3.8-flash')).toBe('messages');
    expect(detectOpenCodeWire('opencode/claude-sonnet-4-6')).toBe('messages');
  });

  it('routes Gemini models to gemini wire', () => {
    expect(detectOpenCodeWire('gemini-3-flash')).toBe('gemini');
    expect(detectOpenCodeWire('gemini-3.7-flash')).toBe('gemini');
    expect(detectOpenCodeWire('gemini-3.5-flash-lite')).toBe('gemini');
    expect(detectOpenCodeWire('opencode/gemini-3-flash')).toBe('gemini');
  });

  it('routes DeepSeek, GLM, Kimi, MiniMax, and freebies to chat-completions wire', () => {
    expect(detectOpenCodeWire('deepseek-v4-pro')).toBe('chat-completions');
    expect(detectOpenCodeWire('deepseek-v4-flash')).toBe('chat-completions');
    expect(detectOpenCodeWire('glm-5.1')).toBe('chat-completions');
    expect(detectOpenCodeWire('kimi-k2.6')).toBe('chat-completions');
    expect(detectOpenCodeWire('minimax-m2.7')).toBe('chat-completions');
    expect(detectOpenCodeWire('big-pickle')).toBe('chat-completions');
    expect(detectOpenCodeWire('space-bunny-free')).toBe('chat-completions');
  });
});

describe('OpenCode default providers', () => {
  it('exposes opencode (Zen) with correct base and defaults', () => {
    expect(opencode.id).toBe('opencode');
    expect(opencode.name).toBe('OpenCode Zen');
    expect(opencode.defaultModel).toBe(OPENCODE_DEFAULT_MODEL);
    expect(OPENCODE_ZEN_BASE_URL).toBe('https://opencode.ai/zen/v1');
  });

  it('exposes opencode-go (Go) with correct base and defaults', () => {
    expect(opencodeGo.id).toBe('opencode-go');
    expect(opencodeGo.name).toBe('OpenCode Go');
    expect(opencodeGo.defaultModel).toBe(OPENCODE_DEFAULT_MODEL);
    expect(OPENCODE_GO_BASE_URL).toBe('https://opencode.ai/zen/go/v1');
  });
});

describe('OpenCode multi-wire request routing', () => {
  it('routes chat-completions to /chat/completions with Bearer auth', async () => {
    const { fetchImpl, calls } = mockOpenCodeFetch();
    const provider = createOpenCodeProvider({ fetchImpl });

    const result = await provider.chat(
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hello' }] },
      { apiKey: 'zen-test-key' },
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(calls[0]!.headers['Authorization'] ?? calls[0]!.headers['authorization']).toBe('Bearer zen-test-key');
    expect(calls[0]!.body.model).toBe('deepseek-v4-pro');
    expect(result.message.content).toBe('Chat completions response');
    expect(result.usage?.inputTokens).toBe(8);
  });

  it('routes messages to /messages with Bearer auth', async () => {
    const { fetchImpl, calls } = mockOpenCodeFetch();
    const provider = createOpenCodeProvider({ fetchImpl });

    const result = await provider.chat(
      { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello Claude' }] },
      { apiKey: 'zen-test-key' },
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/messages');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer zen-test-key');
    expect(calls[0]!.body.model).toBe('claude-sonnet-4-6');
    expect(result.message.content).toBe('Anthropic wire response');
    expect(result.usage?.inputTokens).toBe(12);
  });

  it('routes responses wire to /responses with Bearer auth', async () => {
    const { fetchImpl, calls } = mockOpenCodeFetch();
    const provider = createOpenCodeProvider({ fetchImpl });

    const result = await provider.chat(
      {
        model: 'gpt-5.5',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hello GPT' },
        ],
      },
      { apiKey: 'zen-test-key' },
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/responses');
    expect(calls[0]!.headers['Authorization']).toBe('Bearer zen-test-key');
    expect(calls[0]!.body.model).toBe('gpt-5.5');
    expect(calls[0]!.body.instructions).toBe('You are helpful.');
    expect(result.message.content).toBe('Responses API response');
    expect(result.usage?.totalTokens).toBe(23);
  });

  it('routes gemini wire to :generateContent with x-goog-api-key', async () => {
    const { fetchImpl, calls } = mockOpenCodeFetch();
    const provider = createOpenCodeProvider({ fetchImpl });

    const result = await provider.chat(
      { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hello Gemini' }] },
      { apiKey: 'zen-test-key' },
    );

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://opencode.ai/zen/v1/models/gemini-3-flash:generateContent');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('zen-test-key');
    expect(result.message.content).toBe('Gemini wire response');
    expect(result.usage?.inputTokens).toBe(10);
  });

  it('strips opencode/ and opencode-go/ prefixes before forwarding', async () => {
    const { fetchImpl, calls } = mockOpenCodeFetch();
    const provider = createOpenCodeProvider({ fetchImpl });

    await provider.chat(
      { model: 'opencode/gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'zen-test-key' },
    );

    expect(calls[0]!.body.model).toBe('gpt-5.5');
  });

  it('throws missing-api-key if no key is provided', async () => {
    const provider = createOpenCodeProvider();
    const origEnv = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;

    try {
      await expect(
        provider.chat({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] }, {}),
      ).rejects.toThrow(ModelHitchError);
    } finally {
      if (origEnv) process.env.OPENCODE_API_KEY = origEnv;
    }
  });
});

describe('OpenCode streaming', () => {
  it('streams responses wire SSE deltas', async () => {
    const sseLines = [
      'data: {"type":"response.output_text.delta","delta":"Hello "}',
      'data: {"type":"response.output_text.delta","delta":"world!"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}',
    ];
    const { fetchImpl } = mockOpenCodeFetch({ sseLines });
    const provider = createOpenCodeProvider({ fetchImpl });

    const chunks = [];
    for await (const chunk of provider.stream(
      { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'zen-key' },
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'text-delta', text: 'Hello ' },
      { type: 'text-delta', text: 'world!' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } },
    ]);
  });
});

describe('OpenCode cost and pricing', () => {
  it('resolves exact Zen model pricing', () => {
    const sonnet = pricingFor('claude-sonnet-4-6');
    expect(sonnet.inputPerMillion).toBe(3.0);
    expect(sonnet.outputPerMillion).toBe(15.0);

    const gpt55 = pricingFor('gpt-5.5');
    expect(gpt55.inputPerMillion).toBe(5.0);
    expect(gpt55.outputPerMillion).toBe(30.0);

    const deepseek = pricingFor('deepseek-v4-pro');
    expect(deepseek.inputPerMillion).toBe(1.74);
    expect(deepseek.outputPerMillion).toBe(3.48);
  });

  it('resolves free-tier models to 0 cost', () => {
    const pickle = pricingFor('big-pickle');
    expect(pickle.inputPerMillion).toBe(0);
    expect(pickle.outputPerMillion).toBe(0);

    const bunny = pricingFor('space-bunny-free');
    expect(bunny.inputPerMillion).toBe(0);
    expect(bunny.outputPerMillion).toBe(0);
  });

  it('treats opencode-go provider as $0 flat rate regardless of model', () => {
    const cost = estimateCost('claude-sonnet-4-6', { inputTokens: 100_000, outputTokens: 50_000 }, 'opencode-go');
    expect(cost.priced).toBe(true);
    expect(cost.totalCostUsd).toBe(0);
  });

  it('calculates USD cost accurately for opencode Zen pay-per-use', () => {
    const cost = estimateCost('deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'opencode');
    expect(cost.priced).toBe(true);
    expect(cost.inputCostUsd).toBeCloseTo(1.74);
    expect(cost.outputCostUsd).toBeCloseTo(3.48);
    expect(cost.totalCostUsd).toBeCloseTo(5.22);
  });
});

describe('OpenCode model listing', () => {
  it('falls back to snapshot models when network is unavailable or without key', async () => {
    const provider = createOpenCodeProvider();
    const models = await provider.listModels!({});
    expect(models.length).toBeGreaterThan(20);
    expect(models.map((m) => m.id)).toContain('deepseek-v4-pro');
    expect(models.map((m) => m.id)).toContain('gpt-5.5');
    expect(models.map((m) => m.id)).toContain('claude-sonnet-4-6');
  });
});
