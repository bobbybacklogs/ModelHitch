import { describe, expect, it } from 'vitest';
import { ModelHitch, runToolLoop } from '../src/index.js';
import type { ChatParams, StreamChunk } from '../src/index.js';

const mh = new ModelHitch();
const TOOLS = [{ name: 'get_weather', description: 'weather lookup', parameters: { type: 'object' } }];

describe('runToolLoop', () => {
  it('streams a single text turn and reports done with totals', async () => {
    const events: string[] = [];
    let done: any;

    for await (const ev of runToolLoop(
      mh,
      { provider: 'mock', messages: [{ role: 'user', content: 'hello there' }] },
      async () => '',
    )) {
      if (ev.type === 'chunk') events.push(`chunk:${ev.chunk.type}`);
      if (ev.type === 'turn') events.push(`turn:${ev.turn}`);
      if (ev.type === 'done') done = ev;
    }

    expect(events.filter((e) => e.startsWith('chunk:text-delta')).length).toBeGreaterThan(0);
    expect(events).toContain('turn:1');
    expect(events[events.length - 1]).toBe('turn:1'); // turn always before done

    expect(done.turns).toBe(1);
    expect(done.messages).toEqual([
      { role: 'user', content: 'hello there' },
      { role: 'assistant', content: 'Mock reply: hello there ' }, // mock streams word + trailing space
    ]);
    expect(done.final.message.content).toBe('Mock reply: hello there ');
    expect(done.usage.inputTokens).toBe(10);
    expect(done.usage.outputTokens).toBeGreaterThan(0);
  });

  it('executes tool calls and feeds results back until the turn cap', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const events: string[] = [];
    let done: any;

    for await (const ev of runToolLoop(
      mh,
      {
        provider: 'mock',
        messages: [{ role: 'user', content: '!tool get_weather' }],
        tools: TOOLS,
      },
      async (name, args) => {
        calls.push({ name, args });
        return '{"temp":18,"condition":"Sunny"}';
      },
      { maxTurns: 2 },
    )) {
      if (ev.type === 'chunk') events.push(`chunk:${ev.chunk.type}`);
      if (ev.type === 'turn') events.push(`turn:${ev.turn}`);
      if (ev.type === 'tool') events.push(`tool:${ev.turn}:${ev.call.name}`);
      if (ev.type === 'done') done = ev;
    }

    // The mock re-triggers "!tool get_weather" every turn, so with maxTurns 2
    // we see exactly two tool rounds, then the loop stops at the cap.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ name: 'get_weather', args: { q: 'mock query' } });
    expect(calls[1]).toEqual({ name: 'get_weather', args: { q: 'mock query' } });

    // Per-turn order: chunks stream in, then turn result, then the tool event.
    expect(events).toContain('tool:1:get_weather');
    expect(events).toContain('tool:2:get_weather');
    expect(events.indexOf('chunk:finish')).toBeLessThan(events.indexOf('tool:1:get_weather'));

    expect(done.turns).toBe(2);
    expect(done.messages).toHaveLength(5); // user, assistant, tool, assistant, tool
    expect(done.messages[2]).toEqual({
      role: 'tool',
      content: '{"temp":18,"condition":"Sunny"}',
      toolCallId: 'call_mock_1',
    });
    // Tool-only turns in the mock stream carry no usage, so totals stay empty.
    expect(done.usage).toEqual({});
  });

  it('stops as soon as the model answers without tools', async () => {
    const events: string[] = [];
    let done: any;

    // A text-only prompt never triggers a tool call; exactly one turn.
    for await (const ev of runToolLoop(
      mh,
      { provider: 'mock', messages: [{ role: 'user', content: 'no tools here' }] },
      async () => '',
    )) {
      if (ev.type === 'turn') events.push(`turn:${ev.turn}`);
      if (ev.type === 'done') done = ev;
    }

    expect(events).toEqual(['turn:1']);
    expect(done.turns).toBe(1);
  });

  it('propagates executor errors out of the generator', async () => {
    const gen = runToolLoop(
      mh,
      { provider: 'mock', messages: [{ role: 'user', content: '!tool explode' }], tools: TOOLS },
      async () => {
        throw new Error('boom');
      },
    );

    await expect(async () => {
      for await (const _ of gen) {
        // consume
      }
    }).rejects.toThrowError('boom');
  });

  it('carries reasoning_content across tool-loop turns', async () => {
    // A reasoning model streams chain-of-thought, then calls a tool. The tool
    // result feeds a second turn — and the re-sent conversation must include
    // the prior assistant reasoning so the API doesn't reject it.
    const secondTurnMessages: unknown[] = [];
    const reasoningProvider = {
      id: 'reasoner',
      name: 'reasoner',
      defaultModel: 'reasoner-model',
      capabilities: { streaming: true, toolCalling: true, vision: false, embeddings: false },
      async chat() {
        throw new Error('unused');
      },
      async *stream(params: ChatParams): AsyncGenerator<StreamChunk> {
        const turn = params.messages.filter((m) => m.role === 'assistant').length;
        if (turn > 0) secondTurnMessages.push(...params.messages);
        if (turn === 0) {
          yield { type: 'reasoning-delta', text: 'one ' };
          yield { type: 'reasoning-delta', text: 'two' };
          yield { type: 'tool-call-start', id: 'call_r', name: 'get_weather' };
          yield { type: 'tool-call-args-delta', id: 'call_r', argsDelta: '{"q":"x"}' };
          yield { type: 'tool-call-end', id: 'call_r' };
          yield { type: 'finish', finishReason: 'tool-calls' };
        } else {
          yield { type: 'text-delta', text: 'answered' };
          yield { type: 'finish', finishReason: 'stop' };
        }
      },
    };
    const mhR = new ModelHitch({ providers: [reasoningProvider] });
    const done = await (async () => {
      let done: any;
      for await (const ev of runToolLoop(
        mhR,
        {
          provider: 'reasoner',
          messages: [{ role: 'user', content: 'check weather' }],
          tools: TOOLS,
        },
        async () => '{"temp":18}',
      )) {
        if (ev.type === 'done') done = ev;
      }
      return done;
    })();

    // Turn 1's assistant message kept the reasoning; the second request
    // carried it back to the wire.
    expect(done.messages[1]).toMatchObject({
      role: 'assistant',
      reasoningContent: 'one two',
    });
    const resent = secondTurnMessages.find((m) => (m as { role?: string }).role === 'assistant');
    expect(resent).toMatchObject({ role: 'assistant', reasoningContent: 'one two' });
    expect(done.messages.at(-1)).toEqual({ role: 'assistant', content: 'answered' });
  });

  it('surfaces a capability-unavailable error when tools are forwarded to a tool-incapable provider', async () => {
    const noTools = {
      id: 'no-tools',
      name: 'no-tools',
      defaultModel: 'no-tools-model',
      capabilities: { streaming: true, toolCalling: false, vision: false, embeddings: false },
      async chat() {
        throw new Error('should never be called — capability check must reject first');
      },
      async *stream(): AsyncGenerator<never> {
        throw new Error('should never be called — capability check must reject first');
      },
    };
    const mhNoTools = new ModelHitch({ providers: [noTools] });
    const gen = runToolLoop(
      mhNoTools,
      { provider: 'no-tools', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS },
      async () => '',
    );

    await expect(async () => {
      for await (const _ of gen) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'capability-unavailable' });
  });
});
