import { describe, expect, it } from 'vitest';
import {
  EVENTS_SCHEMA_VERSION,
  EventStream,
  TOOL_EVENT_OUTPUT_CHARS,
  isTruncatedBody,
  toolOutputFor,
  type RunEvent,
} from '../harness/events.js';

/**
 * The contract with a consumer is `JSON.parse` per line. So the cases that
 * matter are the ones where that could fail: a body with newlines, a body with
 * quotes and braces, and an empty body. Everything else is field naming.
 */

function capture(): { stream: NodeJS.WriteStream; lines: () => string[]; parsed: () => RunEvent[] } {
  let out = '';
  const stream = {
    isTTY: false,
    columns: 100,
    write(chunk: string) {
      out += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return {
    stream,
    lines: () => out.split('\n').filter((line) => line !== ''),
    parsed: () =>
      out
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as RunEvent),
  };
}

const streamAt = (): { events: EventStream; cap: ReturnType<typeof capture> } => {
  const cap = capture();
  let tick = 0;
  const events = new EventStream({
    output: cap.stream,
    // Fixed clock: a record stream is compared between runs, so a timestamp that
    // changes every time would make the comparison useless.
    now: () => new Date(Date.UTC(2026, 5, 1, 14, 30, tick++)),
  });
  return { events, cap };
};

describe('isTruncatedBody', () => {
  it('marks a summarized body, which is a summary and not evidence', () => {
    const summarized = 'head\n[summarized: 9000 chars -> 400]\ndigest\ntail';
    expect(isTruncatedBody(summarized, 'ok')).toBe(true);
  });

  it('marks a capped result even when its text says nothing', () => {
    expect(isTruncatedBody('3 matches', 'truncated')).toBe(true);
  });

  it('leaves a raw body alone', () => {
    expect(isTruncatedBody('Wrote src/app.ts (12 chars)', 'ok')).toBe(false);
  });
});

describe('EventStream', () => {
  it('writes one parseable line per record, in order', () => {
    const { events, cap } = streamAt();
    events.runStart({
      task: 'fix it',
      model: 'p/deepseek-v4-flash',
      provider: 'p',
      sessionId: 'sid',
      workspace: '/w',
      playbook: 'feature',
      approvals: 'prompt',
    });
    events.text(1, 'hello ');
    events.text(1, 'world');
    events.tool({
      turn: 1,
      name: 'read',
      args: { path: 'a.ts' },
      outcome: 'ok',
      durationMs: 12,
      body: 'const a = 1;',
    });
    events.approval({ tool: 'write', decision: 'approved', risk: 'caution', reason: 'overwrites a file' });
    events.turn({ turn: 1, tokens: 100, totalTokens: 100 });
    events.done({ turns: 2, tokens: 300, tools: 1, durationMs: 1_500, sessionId: 'sid' });

    // Every line parses on its own — that is the whole contract.
    const parsed = cap.parsed();
    expect(parsed.map((event) => event.type)).toEqual([
      'run-start',
      'text',
      'text',
      'tool',
      'approval',
      'turn',
      'done',
    ]);
    expect(cap.lines()).toHaveLength(7);
  });

  it('keeps a multi-line tool body on a single record', () => {
    const { events, cap } = streamAt();
    const body = ['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@', '-old "quoted" {brace}', '+new'].join('\n');
    events.tool({ turn: 1, name: 'edit', args: { path: 'x.ts' }, outcome: 'ok', durationMs: 1, body });

    // The body has five lines; the record still has one.
    expect(cap.lines()).toHaveLength(1);
    const record = cap.parsed()[0];
    expect(record?.type).toBe('tool');
    if (record?.type !== 'tool') throw new Error('expected a tool record');
    expect(record.bytes).toBe(body.length);
    expect(record.truncated).toBe(false);
  });

  it('survives a body that is itself JSON, brackets and all', () => {
    const { events, cap } = streamAt();
    const body = JSON.stringify({ nested: { deep: ['a', 'b'] }, newline: 'x\ny' });
    events.tool({ turn: 2, name: 'gh', args: { args: ['api'] }, outcome: 'ok', durationMs: 3, body });
    const line = cap.lines()[0] as string;
    expect(line.split('\n')).toHaveLength(1);
    const record = JSON.parse(line) as { bytes: number };
    expect(record.bytes).toBe(body.length);
  });

  it('marks a summarized body so a consumer knows it is not raw', () => {
    const { events, cap } = streamAt();
    events.tool({
      turn: 1,
      name: 'grep_search',
      args: { pattern: 'x' },
      outcome: 'ok',
      durationMs: 5,
      body: 'head\n[summarized: 9000 chars -> 400]\ndigest\ntail',
    });
    const record = cap.parsed()[0];
    if (record?.type !== 'tool') throw new Error('expected a tool record');
    expect(record.truncated).toBe(true);
  });

  it('carries the tool\'s own words when a call fails', () => {
    const { events, cap } = streamAt();
    events.tool({
      turn: 1,
      name: 'subagent',
      args: { agent: 'scout' },
      outcome: 'error',
      durationMs: 4,
      body: 'Error: subagent needs both "agent" and "task". Available: scout, builder.',
    });

    const record = cap.parsed()[0];
    if (record?.type !== 'tool') throw new Error('expected a tool record');
    // Without this, a consumer sees "subagent error in 4ms" and nothing else.
    expect(record.output).toBe('Error: subagent needs both "agent" and "task". Available: scout, builder.');
  });

  it('leaves the output off a call that worked', () => {
    const { events, cap } = streamAt();
    events.tool({
      turn: 1,
      name: 'read',
      args: { path: 'a.ts' },
      outcome: 'ok',
      durationMs: 2,
      body: 'x'.repeat(50_000),
    });

    const record = cap.parsed()[0];
    if (record?.type !== 'tool') throw new Error('expected a tool record');
    // A successful body is the work itself and is already in the session; copying
    // it here would put every file a run touched onto stdout.
    expect('output' in record).toBe(false);
    expect(record.bytes).toBe(50_000);
  });

  it('caps a failed call\'s output and says it was cut', () => {
    const { events, cap } = streamAt();
    events.tool({
      turn: 1,
      name: 'bash',
      args: { cmd: 'npm test' },
      outcome: 'error',
      durationMs: 900,
      body: 'e'.repeat(TOOL_EVENT_OUTPUT_CHARS + 250),
    });

    const record = cap.parsed()[0];
    if (record?.type !== 'tool') throw new Error('expected a tool record');
    expect(record.output).toContain('[output truncated: 250 more characters]');
    expect(record.output!.length).toBeLessThan(TOOL_EVENT_OUTPUT_CHARS + 100);
    // The record still fits on one line, which is the format's first rule.
    expect(cap.lines()).toHaveLength(1);
  });

  it('carries the risk level and reason on an approval decision', () => {
    const { events, cap } = streamAt();
    events.approval({ tool: 'bash', decision: 'declined', risk: 'dangerous', reason: 'recursive delete' });
    const record = cap.parsed()[0];
    if (record?.type !== 'approval') throw new Error('expected an approval record');
    expect(record.decision).toBe('declined');
    expect(record.risk).toBe('dangerous');
    expect(record.reason).toBe('recursive delete');
  });

  it('records an auto-approval distinctly from a human one', () => {
    const { events, cap } = streamAt();
    events.approval({ tool: 'read', decision: 'auto-approved', risk: 'safe', reason: 'reads a file' });
    const record = cap.parsed()[0];
    if (record?.type !== 'approval') throw new Error('expected an approval record');
    // A consumer auditing what nobody looked at needs these separated.
    expect(record.decision).toBe('auto-approved');
  });

  it('stamps a schema version on the first record so a consumer can pin it', () => {
    const { events, cap } = streamAt();
    events.runStart({
      task: 't',
      model: 'p/m',
      provider: 'p',
      sessionId: 's',
      workspace: '/w',
      playbook: 'none',
      approvals: 'auto',
    });
    const record = cap.parsed()[0];
    if (record?.type !== 'run-start') throw new Error('expected a run-start record');
    expect(record.schema).toBe(EVENTS_SCHEMA_VERSION);
    expect(record.approvals).toBe('auto');
  });

  it('counts what it wrote, so a caller can report the stream size', () => {
    const { events } = streamAt();
    events.text(1, 'a');
    events.text(1, 'b');
    expect(events.count).toBe(2);
  });

  it('emits a record for an empty tool body rather than dropping the call', () => {
    const { events, cap } = streamAt();
    events.tool({ turn: 1, name: 'bash', args: { command: 'true' }, outcome: 'ok', durationMs: 2, body: '' });
    const record = cap.parsed()[0];
    if (record?.type !== 'tool') throw new Error('expected a tool record');
    expect(record.bytes).toBe(0);
    expect(record.outcome).toBe('ok');
  });

  it('uses ISO timestamps, which sort lexically as well as parsing', () => {
    const { events, cap } = streamAt();
    events.text(1, 'x');
    const record = cap.parsed()[0];
    expect(record?.at).toBe('2026-06-01T14:30:00.000Z');
    expect(Number.isNaN(Date.parse(record?.at ?? ''))).toBe(false);
  });
});
