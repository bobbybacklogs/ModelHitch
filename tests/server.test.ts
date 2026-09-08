import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModelHitchServer,
  createOpenAICompatibleProvider,
  mockProvider,
  type OpenAICompatibleServer,
} from '../src/index.js';

/** A provider that requires a key, so we can test 401s without real network. */
const needsKey = createOpenAICompatibleProvider({
  id: 'needs-key',
  name: 'Needs Key',
  defaultModel: 'x',
  baseUrl: 'http://127.0.0.1:9/v1', // unreachable — key check throws first
  requiresKey: true,
});

let server: OpenAICompatibleServer;
let base: string;

beforeAll(async () => {
  server = createModelHitchServer({
    providers: [mockProvider, needsKey],
    defaultProviderId: 'mock',
    staticModels: { mock: ['extra-model'] },
  });
  const info = await server.listen(0, '127.0.0.1');
  base = info.url;
});

afterAll(async () => {
  await server.close();
});

function chat(body: unknown): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('bridge GET /v1/models', () => {
  it('advertises the default provider with bare ids and others with prefixes', async () => {
    const res = await fetch(`${base}/v1/models`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { data: Array<{ id: string; owned_by: string }> };
    const ids = data.data.map((m) => m.id);
    expect(ids).toContain('mock-model'); // default provider: bare id
    expect(ids).toContain('extra-model'); // static catalog, bare for default provider
    expect(ids).toContain('needs-key/x'); // non-default: prefixed
  });

  it('returns a single model by id and 404s for unknown ids', async () => {
    const ok = await fetch(`${base}/v1/models/mock-model`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toBe('mock-model');

    const missing = await fetch(`${base}/v1/models/does-not-exist`);
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { error: { code: string } };
    expect(body.error.code).toBe('model-not-found');
  });

  it('includes session headers in Access-Control-Allow-Headers on OPTIONS', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    const allowHeaders = res.headers.get('access-control-allow-headers') ?? '';
    expect(allowHeaders).toContain('x-opencode-session');
  });
});

describe('bridge POST /v1/chat/completions (non-streaming)', () => {
  it('returns an OpenAI chat.completion from the mock provider', async () => {
    const res = await chat({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'hi there' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('mock-model');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toContain('Mock reply: hi there');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it('emits tool_calls when the model asks for a tool', async () => {
    const res = await chat({
      model: 'mock-model',
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'x', parameters: { type: 'object', properties: {} } } }],
      messages: [{ role: 'user', content: '!tool get_weather' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    const toolCall = body.choices[0].message.tool_calls[0];
    expect(toolCall.type).toBe('function');
    expect(toolCall.function.name).toBe('get_weather');
    expect(JSON.parse(toolCall.function.arguments)).toEqual({ q: 'mock query' });
  });

  it('round-trips multi-turn tool roles (assistant tool_calls + tool result)', async () => {
    const res = await chat({
      model: 'mock-model',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '4' },
        { role: 'user', content: 'thanks' },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toContain('Mock reply: thanks');
  });
});

describe('bridge POST /v1/chat/completions (streaming)', () => {
  it('streams SSE deltas, finish reason, usage, and [DONE]', async () => {
    const res = await chat({
      model: 'mock-model',
      stream: true,
      messages: [{ role: 'user', content: 'stream me' }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain('"usage"');
    expect(text).toContain('data: [DONE]');

    // Reassemble the streamed content from the SSE deltas.
    let streamed = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      const payload = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> };
      streamed += payload.choices?.[0]?.delta?.content ?? '';
    }
    expect(streamed).toContain('Mock reply: stream me');
  });

  it('streams tool_calls with index-keyed argument deltas', async () => {
    const res = await chat({
      model: 'mock-model',
      stream: true,
      messages: [{ role: 'user', content: '!tool get_weather' }],
    });
    const text = await res.text();
    expect(text).toContain('"type":"function"');
    expect(text).toContain('"name":"get_weather"');
    expect(text).toContain('{\\"q\\":\\"mock query\\"}'); // args delta, JSON-escaped
    expect(text).toContain('"finish_reason":"tool_calls"');
  });
});

describe('bridge model routing', () => {
  it('routes provider-prefixed model ids to the right provider', async () => {
    const res = await chat({
      model: 'mock/mock-model',
      messages: [{ role: 'user', content: 'routed' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe('mock-model');
  });

  it('routes bare model ids to the default provider', async () => {
    const res = await chat({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'bare' }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).model).toBe('mock-model');
  });
});

describe('bridge error handling', () => {
  it('rejects requests without messages with 400', async () => {
    const res = await chat({ model: 'mock-model' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('bad-request');
    expect(body.error.message).toContain('messages');
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad-request');
  });

  it('maps missing-api-key to 401 with an OpenAI-style error', async () => {
    const res = await chat({
      model: 'needs-key/x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.code).toBe('missing-api-key');
  });

  it('returns OpenAI-style 404 JSON for unknown endpoints', async () => {
    const res = await fetch(`${base}/v1/embeddings`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unknown_endpoint');
  });
});

describe('bridge health', () => {
  it('answers /healthz', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('rejects cleanly when the listen address is already occupied', async () => {
    const first = createModelHitchServer();
    const second = createModelHitchServer();
    const listening = await first.listen(0, '127.0.0.1');
    await expect(second.listen(listening.port, '127.0.0.1')).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await first.close();
    await second.close();
  });
});

describe('bridge onUsage hook', () => {
  let usageServer: OpenAICompatibleServer;
  let usageBase: string;
  const events: any[] = [];

  beforeAll(async () => {
    usageServer = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: 'mock',
      onUsage: (ev) => events.push(ev),
    });
    const info = await usageServer.listen(0, '127.0.0.1');
    usageBase = info.url;
  });

  afterAll(async () => {
    await usageServer.close();
  });

  it('reports usage + cost for non-stream calls', async () => {
    const res = await fetch(`${usageBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi there' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.providerId).toBe('mock');
    expect(ev.model).toBe('mock-model');
    expect(ev.wire).toBe('chat-completions');
    expect(ev.streamed).toBe(false);
    expect(ev.inputTokens).toBe(10);
    expect(ev.outputTokens).toBeGreaterThan(0);
    expect(ev.totalTokens).toBe(ev.inputTokens + ev.outputTokens);
    expect(typeof ev.costUsd).toBe('number');
    expect(ev.latencyMs).toBeGreaterThanOrEqual(0);
    expect(new Date(ev.at).getTime()).not.toBeNaN();
  });

  it('reports streamed calls with streamed: true', async () => {
    const res = await fetch(`${usageBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        stream: true,
        messages: [{ role: 'user', content: 'stream me' }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const ev = events[events.length - 1];
    expect(ev.streamed).toBe(true);
    expect(ev.inputTokens).toBe(10);
  });

  it('skips events when the provider reports no usage (tool-only turns)', async () => {
    const before = events.length;
    const res = await fetch(`${usageBase}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        stream: true,
        messages: [{ role: 'user', content: '!tool get_weather' }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    // The mock's tool-call stream carries no usage on its finish chunk.
    expect(events).toHaveLength(before);
  });

  it('fires for the gemini wire with wire: "gemini"', async () => {
    const res = await fetch(`${usageBase}/v1beta/models/mock-model:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi gemini' }] }] }),
    });
    expect(res.status).toBe(200);
    const ev = events[events.length - 1];
    expect(ev.wire).toBe('gemini');
    expect(ev.model).toBe('mock-model');
    expect(ev.streamed).toBe(false);
  });
});
