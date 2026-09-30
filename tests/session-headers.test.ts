import { describe, expect, it, vi } from 'vitest';
import { createOpenAICompatibleProvider, applySessionHeaders, DEFAULT_SESSION_HEADERS } from '../src/providers/openai-compatible.js';
import { createOpenCodeProvider, OPENCODE_SESSION_HEADER, OPENCODE_SESSION_HEADERS } from '../src/providers/opencode.js';
import { resolveOutboundSessionId } from '../src/core/session.js';

function okResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const COMPLETION = {
  id: 'chatcmpl-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
};

describe('applySessionHeaders', () => {
  it('writes the session id into every configured header', () => {
    const headers: Record<string, string> = {};
    applySessionHeaders(headers, 'sess-1', ['x-opencode-session', 'x-session-id']);
    expect(headers).toEqual({ 'x-opencode-session': 'sess-1', 'x-session-id': 'sess-1' });
  });

  it('never overwrites an operator-pinned header', () => {
    const headers: Record<string, string> = { 'x-opencode-session': 'pinned' };
    applySessionHeaders(headers, 'sess-1', ['x-opencode-session']);
    expect(headers['x-opencode-session']).toBe('pinned');
  });

  it('does nothing without a session id', () => {
    const headers: Record<string, string> = {};
    applySessionHeaders(headers, undefined, ['x-opencode-session']);
    expect(headers).toEqual({});
  });

  it('defaults to the generic session header pair', () => {
    const headers: Record<string, string> = {};
    applySessionHeaders(headers, 'sess-2');
    expect(headers).toEqual({ 'x-session-id': 'sess-2', 'x-conversation-id': 'sess-2' });
    expect([...DEFAULT_SESSION_HEADERS]).toEqual(['x-session-id', 'x-conversation-id']);
  });
});

describe('resolveOutboundSessionId', () => {
  it('prefers a client-supplied session header', () => {
    expect(resolveOutboundSessionId({ 'x-session-id': 'from-client' }, [{ role: 'user', content: 'x' }])).toBe('from-client');
  });

  it('derives a stable id from the conversation when the client sends none', () => {
    const messages = [{ role: 'user' as const, content: 'list the files' }];
    const first = resolveOutboundSessionId({}, messages);
    const second = resolveOutboundSessionId(undefined, messages);

    expect(first).toMatch(/^mh-sess-/);
    expect(first).toBe(second);
  });

  it('derives different ids for different conversations', () => {
    const a = resolveOutboundSessionId({}, [{ role: 'user', content: 'conversation a' }]);
    const b = resolveOutboundSessionId({}, [{ role: 'user', content: 'conversation b' }]);
    expect(a).not.toBe(b);
  });
});

describe('OpenAI-compatible provider session headers', () => {
  it('omits session headers when the caller supplies no session', async () => {
    const fetchImpl = vi.fn(async () => okResponse(COMPLETION));
    const provider = createOpenAICompatibleProvider({
      id: 'test',
      name: 'Test',
      baseUrl: 'https://example.test/v1',
      defaultModel: 'm',
      headers: { Authorization: 'Bearer k' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { apiKey: 'test-key' });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-session-id']).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer test-key');
  });

  it('sends the standard session header pair when a session is supplied', async () => {
    const fetchImpl = vi.fn(async () => okResponse(COMPLETION));
    const provider = createOpenAICompatibleProvider({
      id: 'test',
      name: 'Test',
      baseUrl: 'https://example.test/v1',
      defaultModel: 'm',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.chat(
      { model: 'm', messages: [{ role: 'user', content: 'hi' }], sessionId: 'sess-9' },
      { apiKey: 'test-key' },
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-session-id']).toBe('sess-9');
    expect(headers['x-conversation-id']).toBe('sess-9');
  });

  it('uses a custom session header list when configured', async () => {
    const fetchImpl = vi.fn(async () => okResponse(COMPLETION));
    const provider = createOpenAICompatibleProvider({
      id: 'test',
      name: 'Test',
      baseUrl: 'https://example.test/v1',
      defaultModel: 'm',
      sessionHeaders: ['x-opencode-session'],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], sessionId: 'explicit' }, { apiKey: 'test-key' });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-opencode-session']).toBe('explicit');
    expect(headers['x-session-id']).toBeUndefined();
  });
});

describe('OpenCode provider session headers', () => {
  it('declares x-opencode-session first', () => {
    expect(OPENCODE_SESSION_HEADERS[0]).toBe(OPENCODE_SESSION_HEADER);
    expect(OPENCODE_SESSION_HEADER).toBe('x-opencode-session');
  });

  it('derives a session id when the caller supplies none', async () => {
    const fetchImpl = vi.fn(async () => okResponse(COMPLETION));
    const provider = createOpenCodeProvider({
      baseUrl: 'https://opencode.test/v1',
      apiKeyEnvVar: 'UNUSED_KEY_VAR',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.chat(
      { model: 'opencode-go/deepseek-v4-flash', messages: [{ role: 'user', content: 'list files' }] },
      { apiKey: 'k' },
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    // Go rejects a request without this header, so it must always be present.
    expect(headers['x-opencode-session']).toMatch(/^mh-sess-/);
  });

  it('sends x-opencode-session on the chat completions wire', async () => {
    const fetchImpl = vi.fn(async () => okResponse(COMPLETION));
    const provider = createOpenCodeProvider({
      baseUrl: 'https://opencode.test/v1',
      apiKeyEnvVar: 'UNUSED_KEY_VAR',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await provider.chat(
      { model: 'opencode-go/deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], sessionId: 'go-sess' },
      { apiKey: 'k' },
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-opencode-session']).toBe('go-sess');
    expect(headers['User-Agent']).toMatch(/ModelHitch/);
  });
});
