import { describe, expect, it } from 'vitest';
import { createModelHitchServer } from '../src/server/server.js';
import { createOpenCodeProvider } from '../src/providers/opencode.js';

// Exercise the actual HTTP bridge, request mapping, routing and wire delegates.
// Only the hosted OpenCode transport is replaced; no keys or live accounts.
const completion = {
  choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
  content: [{ type: 'text', text: 'OK' }],
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
  candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }],
};

describe('HTTP bridge preserves OpenCode sessions across every upstream wire', () => {
  for (const [model, path] of [
    ['deepseek-v4.1-flash', '/chat/completions'],
    ['claude-sonnet-4-6', '/messages'],
    ['gpt-5.5', '/responses'],
    ['gemini-3-flash', '/models/gemini-3-flash:generateContent'],
  ]) {
    for (const supplied of [false, true]) {
      it(`${model}: ${supplied ? 'forwards client session' : 'derives a session without a client header'}`, async () => {
        const calls: Array<{ url: string; headers: Headers }> = [];
        const provider = createOpenCodeProvider({
          id: 'opencode-go',
          baseUrl: 'https://opencode.test/v1',
          fetchImpl: async (input, init) => {
            calls.push({ url: String(input), headers: new Headers(init?.headers) });
            return Response.json(completion);
          },
        });
        const server = createModelHitchServer({
          providers: [provider],
          defaultProviderId: provider.id,
          apiKeys: { 'opencode-go': 'fixture-key' },
        });
        const { url } = await server.listen(0, '127.0.0.1');
        try {
          for (let turn = 0; turn < 2; turn++) {
            const res = await fetch(`${url}/v1/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(supplied ? { 'X-OpenCode-Session': 'client-conversation-42' } : {}),
              },
              body: JSON.stringify({ model: `opencode-go/${model}`, messages: [{ role: 'user', content: 'Review the release.' }] }),
            });
            expect(res.status, await res.text()).toBe(200);
          }
          expect(calls).toHaveLength(2);
          for (const call of calls) {
            expect(call.url).toBe(`https://opencode.test/v1${path}`);
            const session = call.headers.get('x-opencode-session');
            if (supplied) expect(session).toBe('client-conversation-42');
            else expect(session).toMatch(/^mh-sess-/);
          }
          expect(calls[0]!.headers.get('x-opencode-session')).toBe(calls[1]!.headers.get('x-opencode-session'));
        } finally {
          await server.close();
        }
      });
    }
  }
});
