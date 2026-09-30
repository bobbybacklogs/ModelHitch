import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPACT_THRESHOLD,
  KEEP_RECENT_UNITS,
  buildCompactionRequest,
  compactMessages,
  historySize,
  messageSize,
  planCompaction,
  splitUnits,
  validatePairing,
} from '../harness/compact.js';
import type { ModelMessage } from '../src/index.js';

/**
 * Compaction's failure mode is a *malformed request*, not a worse answer: an
 * assistant message carrying tool calls is only valid next to the `tool`
 * messages that answer it, and dropping one half makes the provider reject the
 * whole call. So most of these cases assert on `validatePairing` rather than on
 * the digest text.
 */

/** One completed turn: an assistant that called tools, and their results. */
function toolTurn(text: string, ids: string[]): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: text,
      toolCalls: ids.map((id) => ({ id, name: 'read', arguments: { path: `${id}.ts` } })),
    },
    ...ids.map((id) => ({ role: 'tool' as const, content: `body of ${id}`, toolCallId: id })),
  ];
}

/** A history shaped the way `runToolLoop` builds one, with `turns` tool turns. */
function history(turns: number, filler = 200): ModelMessage[] {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'you are an engineer' },
    { role: 'user', content: 'do the thing' },
  ];
  for (let index = 1; index <= turns; index++) {
    messages.push(...toolTurn(`turn ${index} reasoning ${'x'.repeat(filler)}`, [`c${index}a`, `c${index}b`]));
    messages.push({ role: 'assistant', content: `turn ${index} answer ${'y'.repeat(filler)}` });
  }
  return messages;
}

const stubDigest = async (): Promise<string> => 'earlier work: read c1a and c1b, then answered.';

describe('messageSize and historySize', () => {
  it('counts string content', () => {
    expect(messageSize({ role: 'user', content: 'abcd' })).toBe(4);
  });

  it('counts text parts and ignores an inline image', () => {
    // An image is large in a way that has nothing to do with the context budget;
    // counting its base64 would let one screenshot trigger compaction alone.
    const message: ModelMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'abcd' },
        { type: 'image-data', data: 'x'.repeat(50_000), mimeType: 'image/png' },
      ],
    };
    expect(messageSize(message)).toBe(4);
  });

  it('counts a tool call\u2019s name and arguments', () => {
    const message: ModelMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
    };
    expect(messageSize(message)).toBeGreaterThan('read'.length);
  });

  it('sums a whole history', () => {
    expect(historySize(history(2))).toBeGreaterThan(800);
  });
});

describe('splitUnits', () => {
  it('keeps an assistant with its tool results, whatever their count', () => {
    const units = splitUnits(history(1));
    // [system, user, assistant+2 tool results, assistant]
    expect(units).toHaveLength(4);
    expect(units[2]?.messages.map((message) => message.role)).toEqual(['assistant', 'tool', 'tool']);
  });

  it('marks the system message and the task as not droppable', () => {
    const units = splitUnits(history(1));
    // A digest of the task is a paraphrase of the thing everything else is
    // measured against, so the original wording always survives.
    expect(units[0]?.droppable).toBe(false);
    expect(units[1]?.droppable).toBe(false);
    expect(units[1]?.messages[0]?.content).toBe('do the thing');
    expect(units.slice(2).every((unit) => unit.droppable)).toBe(true);
  });

  it('covers every message exactly once, in order', () => {
    const messages = history(3);
    const units = splitUnits(messages);
    const flat = units.flatMap((unit) => unit.messages);
    expect(flat).toEqual(messages);
    units.forEach((unit, index) => {
      if (index > 0) expect(unit.start).toBe(units[index - 1]?.end);
    });
  });

  it('does not attach an orphan tool result to whatever came before it', () => {
    // Guessing the owner is how a mismatched pairing gets produced in the first
    // place, so an orphan stays its own unit.
    const messages: ModelMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'tool', content: 'orphan', toolCallId: 'ghost' },
    ];
    const units = splitUnits(messages);
    expect(units).toHaveLength(3);
    expect(units[2]?.messages).toHaveLength(1);
  });
});

describe('planCompaction', () => {
  it('does nothing below the threshold', () => {
    expect(planCompaction(history(2), { threshold: 1_000_000 })).toBeNull();
  });

  it('does nothing when the threshold is off', () => {
    expect(planCompaction(history(20), { threshold: 0 })).toBeNull();
  });

  it('drops the oldest units and keeps the newest verbatim', () => {
    const messages = history(8);
    const plan = planCompaction(messages, { threshold: 500, keepRecent: 2 });
    expect(plan).not.toBeNull();
    expect(plan?.keep).toHaveLength(2);
    expect(plan?.drop.length).toBeGreaterThan(0);
    // The dropped ones come first; the kept ones are the tail.
    const firstKept = plan?.keep[0]?.start ?? -1;
    for (const unit of plan?.drop ?? []) expect(unit.end).toBeLessThanOrEqual(firstKept);
  });

  it('never plans to drop the system message or the task', () => {
    const plan = planCompaction(history(8), { threshold: 500, keepRecent: 2 });
    for (const unit of plan?.drop ?? []) {
      expect(unit.messages[0]?.role).not.toBe('system');
      expect(unit.messages[0]?.content).not.toBe('do the thing');
    }
  });

  it('refuses when there is no completed turn to drop', () => {
    // A run that is over budget with nothing but the task in hand has no
    // history to shrink; digesting the task itself would be the worse failure.
    const messages: ModelMessage[] = [
      { role: 'system', content: 'you are an engineer' },
      { role: 'user', content: 'do the thing' },
    ];
    expect(planCompaction(messages, { threshold: 1, keepRecent: 2 })).toBeNull();
  });

  it('still compacts when nothing needs keeping', () => {
    const plan = planCompaction(history(6), { threshold: 100, keepRecent: 0 });
    expect(plan).not.toBeNull();
    expect(plan?.keep).toHaveLength(0);
  });
});

describe('compactMessages', () => {
  it('replaces the dropped turns and does not append to them', async () => {
    const messages = history(8);
    const outcome = await compactMessages({ messages, threshold: 500, keepRecent: 1, digest: stubDigest });

    expect(outcome.compacted).toBe(true);
    // The digest replaces: the history got smaller and the old text is gone.
    expect(outcome.after).toBeLessThan(outcome.before);
    expect(outcome.messages.length).toBeLessThan(messages.length);
    expect(outcome.messages.some((message) => typeof message.content === 'string' && message.content.includes('turn 1 reasoning'))).toBe(false);
    expect(outcome.messages.some((message) => typeof message.content === 'string' && message.content.includes('earlier work'))).toBe(true);
  });

  it('leaves a structurally valid conversation', async () => {
    const outcome = await compactMessages({ messages: history(8), threshold: 500, keepRecent: 1, digest: stubDigest });
    expect(validatePairing(outcome.messages)).toEqual([]);
  });

  it('stays valid across repeated compactions', async () => {
    // The real failure mode: compaction runs many times in one long run, and a
    // single dropped half leaves a request the provider rejects several turns
    // later, far from the cause.
    let messages = history(4);
    for (let round = 0; round < 6; round++) {
      // Grow the history the way a run does: another tool turn each round.
      messages = [...messages, ...toolTurn(`added round ${round} ${'z'.repeat(400)}`, [`r${round}`])];
      const outcome = await compactMessages({ messages, threshold: 500, keepRecent: 1, digest: stubDigest });
      messages = outcome.messages;
      expect(validatePairing(messages)).toEqual([]);
      expect(messages[0]?.role).toBe('system');
    }
  });

  it('never touches the system message', async () => {
    const outcome = await compactMessages({ messages: history(8), threshold: 500, keepRecent: 1, digest: stubDigest });
    expect(outcome.messages[0]).toEqual({ role: 'system', content: 'you are an engineer' });
  });

  it('keeps the most recent turns verbatim', async () => {
    const messages = history(8);
    const lastAssistant = messages[messages.length - 1];
    const outcome = await compactMessages({ messages, threshold: 500, keepRecent: 2, digest: stubDigest });
    expect(outcome.messages[outcome.messages.length - 1]).toEqual(lastAssistant);
  });

  it('does nothing when the digest fails, rather than losing the turns', async () => {
    const messages = history(8);
    const logs: string[] = [];
    const outcome = await compactMessages({
      messages,
      threshold: 500,
      digest: async () => {
        throw new Error('503 from provider');
      },
      log: (message) => logs.push(message),
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toEqual(messages);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('compaction skipped');
  });

  it('does nothing when the digest comes back empty', async () => {
    const messages = history(8);
    const logs: string[] = [];
    const outcome = await compactMessages({
      messages,
      threshold: 500,
      digest: async () => '   ',
      log: (message) => logs.push(message),
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toEqual(messages);
    expect(logs[0]).toContain('came back empty');
  });

  it('announces what it did, so a reader knows history was rewritten', async () => {
    const logs: string[] = [];
    const outcome = await compactMessages({
      messages: history(8),
      threshold: 500,
      keepRecent: 1,
      digest: stubDigest,
      log: (message) => logs.push(message),
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('compacted');
    expect(logs[0]).toContain(`${outcome.droppedUnits} turn`);
  });

  it('is a no-op on a history that fits', async () => {
    const messages = history(1);
    const outcome = await compactMessages({ messages, threshold: 1_000_000, digest: stubDigest });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toEqual(messages);
    expect(outcome.after).toBe(outcome.before);
  });

  it('refuses a compaction that would barely save anything', async () => {
    // A digest that is nearly as large as the turns it replaces costs a model
    // call and a history rewrite and buys neither. Observed in a live run: one
    // round reported `24492 chars -> 24480`.
    const logs: string[] = [];
    const outcome = await compactMessages({
      messages: history(8),
      threshold: 500,
      keepRecent: 1,
      // Deliberately enormous: the "digest" is the whole history back again.
      digest: async () => 'z'.repeat(historySize(history(8))),
      log: (message) => logs.push(message),
    });
    expect(outcome.compacted).toBe(false);
    expect(outcome.messages).toEqual(history(8));
    expect(logs[0]).toContain('compaction skipped');
    expect(logs[0]).toContain('below the');
  });

  it('accepts a compaction that clears the minimum gain', async () => {
    const logs: string[] = [];
    const outcome = await compactMessages({
      messages: history(12),
      threshold: 500,
      keepRecent: 1,
      digest: stubDigest,
      log: (message) => logs.push(message),
    });
    expect(outcome.compacted).toBe(true);
    expect(logs[0]).toContain('compacted');
  });

  it('handles a resumed history with several user messages', async () => {
    // A restored transcript appends a new user message to an existing history,
    // so `user` is a normal unit in the middle rather than only the second one.
    const messages: ModelMessage[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'a'.repeat(400) },
      { role: 'user', content: 'second task' },
      { role: 'assistant', content: 'b'.repeat(400) },
      { role: 'user', content: 'third task' },
    ];
    const outcome = await compactMessages({ messages, threshold: 100, keepRecent: 2, digest: stubDigest });
    expect(outcome.compacted).toBe(true);
    expect(outcome.messages[0]?.role).toBe('system');
    // The newest user message is what the model is answering, so it survives.
    expect(outcome.messages[outcome.messages.length - 1]).toEqual({ role: 'user', content: 'third task' });
    expect(validatePairing(outcome.messages)).toEqual([]);
  });

  it('places the digest where the dropped turns were, not at the end', async () => {
    const messages = history(8);
    const outcome = await compactMessages({ messages, threshold: 500, keepRecent: 2, digest: stubDigest });
    const digestAt = outcome.messages.findIndex(
      (message) => typeof message.content === 'string' && message.content.includes('earlier work'),
    );
    // Right after the system message and the original user task.
    expect(digestAt).toBe(2);
    expect(outcome.messages[2]?.role).toBe('user');
  });
});

describe('buildCompactionRequest', () => {
  it('asks for the things a continuation needs, and caps each message', () => {
    const request = buildCompactionRequest(splitUnits(history(3)).slice(1));
    expect(request).toContain('file paths');
    expect(request).toContain('assistant called: read, read');
    expect(request).toContain('tool result:');
    // Long bodies are truncated so the digest prompt cannot itself be the
    // context problem it was called to solve.
    expect(request.length).toBeLessThan(20_000);
  });
});

describe('validatePairing', () => {
  it('passes a well-formed history', () => {
    expect(validatePairing(history(3))).toEqual([]);
  });

  it('catches an orphaned tool result', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 's' },
      { role: 'tool', content: 'orphan', toolCallId: 'ghost' },
    ];
    expect(validatePairing(messages)[0]?.reason).toContain('no preceding call');
  });

  it('catches an unanswered tool call', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 's' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: {} }],
      },
    ];
    expect(validatePairing(messages)[0]?.reason).toContain('never answered');
  });

  it('catches a duplicated tool result', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 's' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', content: 'a', toolCallId: 'c1' },
      { role: 'tool', content: 'b', toolCallId: 'c1' },
    ];
    expect(validatePairing(messages).some((problem) => problem.reason.includes('duplicate'))).toBe(true);
  });
});

describe('the documented constants', () => {
  it('are stable, because a threshold change silently changes cost', () => {
    expect(DEFAULT_COMPACT_THRESHOLD).toBe(48_000);
    expect(KEEP_RECENT_UNITS).toBe(2);
  });
});
