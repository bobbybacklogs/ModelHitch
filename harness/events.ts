/**
 * NDJSON run events, for CI and log tooling.
 *
 * A transcript is written for a person: it folds cards, colours a diff, and
 * redraws a status line. None of that survives being piped into a parser. So
 * `--json-events` makes stdout a record stream — one JSON object per line, in
 * the order the run produced them — and the human-readable view moves to
 * stderr, where an operator watching the terminal still sees it.
 *
 * Two rules the format has to keep:
 *
 *   1. **One event per line, always.** A tool body is multi-line by nature, and
 *      a record containing a raw newline would split into two lines that both
 *      fail to parse. `JSON.stringify` escapes it, which is exactly why the
 *      body goes through JSON rather than being interpolated.
 *   2. **A summarized body says so.** `--summarize-tools` replaces a long result
 *      with a head/digest/tail form before the model sees it. A consumer that
 *      treated that as the raw output would be reading a summary as evidence.
 */

import type { ToolOutcome } from './result.js';
import type { RiskLevel } from './risk.js';

/**
 * Bumped when the shape of an event changes incompatibly. Consumers pin it
 * rather than guessing from the presence of fields.
 */
export const EVENTS_SCHEMA_VERSION = 1;

/**
 * Characters of a failed tool's output carried on its `tool` event.
 *
 * Generous enough for a stack trace or a compiler error, small enough that a
 * tool which failed by dumping a log cannot turn one NDJSON record into a
 * payload. The cut is marked in the text itself, so a reader is never shown a
 * truncated message as if it were the whole one.
 */
export const TOOL_EVENT_OUTPUT_CHARS = 4000;

/**
 * Outcomes whose output a consumer cannot reconstruct from anything else.
 *
 * `ok` and `dry-run` are excluded on purpose, not by omission: their output is
 * the work itself, it is already in the model's history and the session file,
 * and duplicating it on stdout would cost every reader the bytes of every file
 * the run touched. `declined` is excluded because the decline message is the
 * harness's own and is already stated in the `approval` event.
 */
const OUTCOMES_WITH_OUTPUT = new Set<ToolOutcome>(['error', 'timeout', 'truncated']);

/** The output to attach for an outcome, already capped, or undefined for none. */
export function toolOutputFor(body: string, outcome: ToolOutcome): string | undefined {
  if (!OUTCOMES_WITH_OUTPUT.has(outcome)) return undefined;
  const text = String(body ?? '');
  if (text.trim() === '') return undefined;
  if (text.length <= TOOL_EVENT_OUTPUT_CHARS) return text;
  const omitted = text.length - TOOL_EVENT_OUTPUT_CHARS;
  return `${text.slice(0, TOOL_EVENT_OUTPUT_CHARS)}\n[output truncated: ${omitted} more characters]`;
}

export interface RunStartEvent {
  type: 'run-start';
  schema: number;
  at: string;
  task: string;
  model: string;
  provider: string;
  sessionId: string;
  workspace: string;
  playbook: string;
  approvals: string;
}

export interface TextEvent {
  type: 'text';
  at: string;
  turn: number;
  text: string;
}

export interface ToolEvent {
  type: 'tool';
  at: string;
  turn: number;
  name: string;
  args: Record<string, unknown>;
  outcome: ToolOutcome;
  durationMs: number;
  /** True when `body` is not the raw output: summarized, or a capped match list. */
  truncated: boolean;
  /** Characters in `body`, so a consumer can size a record without reading it. */
  bytes: number;
  /** Extra context from the tool envelope, when there is any. */
  note?: string;
  /**
   * Why a failed call failed — the tool's own output, verbatim.
   *
   * Present only for `error`, `timeout`, and `truncated`, and absent for a call
   * that worked. Two reasons for that asymmetry:
   *
   *   1. A successful result already reaches the consumer as the model's work,
   *      and copying every file body and command output into the event stream
   *      would put megabytes on stdout for a reader that rarely wants them.
   *   2. A failure is the case a transcript cannot reconstruct. "subagent error
   *      in 4ms" is a mystery; the sentence the tool wrote is the answer, and it
   *      is the model, not the operator, who currently gets to see it.
   *
   * Capped at `TOOL_EVENT_OUTPUT_CHARS` with an explicit omission marker, so a
   * tool that dumps a build log cannot turn one record into a payload.
   */
  output?: string;
}

export interface ApprovalEvent {
  type: 'approval';
  at: string;
  tool: string;
  decision: 'approved' | 'auto-approved' | 'declined';
  /** Present when a risk classifier ran. */
  risk?: RiskLevel;
  reason?: string;
}

export interface TurnEvent {
  type: 'turn';
  at: string;
  turn: number;
  tokens: number;
  totalTokens: number;
}

export interface DoneEvent {
  type: 'done';
  at: string;
  turns: number;
  tokens: number;
  tools: number;
  durationMs: number;
  changes?: Array<{ name: string; added: number; removed: number }>;
  sessionId?: string;
}

export type RunEvent =
  | RunStartEvent
  | TextEvent
  | ToolEvent
  | ApprovalEvent
  | TurnEvent
  | DoneEvent;

/**
 * Whether a body reached the model unmodified.
 *
 * Two things make it not-raw: the summarizer's own marker, and a tool that
 * reported a capped result. Both are checked, because a consumer cannot tell a
 * summary from a short file by looking.
 */
export function isTruncatedBody(output: string, outcome: ToolOutcome): boolean {
  return outcome === 'truncated' || output.includes('[summarized:');
}

export interface EventStreamOptions {
  /** Where records go. Always the run's stdout. */
  output?: NodeJS.WriteStream;
  /** Injected so a test gets deterministic timestamps. */
  now?: () => Date;
}

/**
 * Writes the record stream.
 *
 * Deliberately not a class with a queue or a flush timer: a record that is
 * buffered is a record a crashed run never emitted, and the whole point of this
 * format is that a consumer can read what happened up to the failure.
 */
export class EventStream {
  private readonly out: NodeJS.WriteStream;
  private readonly now: () => Date;
  /** How many records have been written, for the closing `done` line. */
  count = 0;

  constructor(options: EventStreamOptions = {}) {
    this.out = options.output ?? process.stdout;
    this.now = options.now ?? ((): Date => new Date());
  }

  /** One record, one line. `JSON.stringify` is what makes a body safe here. */
  write(event: RunEvent): void {
    this.count++;
    this.out.write(`${JSON.stringify(event)}\n`);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  runStart(input: Omit<RunStartEvent, 'type' | 'schema' | 'at'>): void {
    this.write({ type: 'run-start', schema: EVENTS_SCHEMA_VERSION, at: this.stamp(), ...input });
  }

  text(turn: number, text: string): void {
    this.write({ type: 'text', at: this.stamp(), turn, text });
  }

  tool(input: Omit<ToolEvent, 'type' | 'at' | 'truncated' | 'bytes'> & { body: string }): void {
    const { body, ...rest } = input;
    const output = toolOutputFor(body, input.outcome);
    this.write({
      type: 'tool',
      at: this.stamp(),
      ...rest,
      truncated: isTruncatedBody(body, input.outcome),
      bytes: body.length,
      ...(output === undefined ? {} : { output }),
    });
  }

  approval(input: Omit<ApprovalEvent, 'type' | 'at'>): void {
    this.write({ type: 'approval', at: this.stamp(), ...input });
  }

  turn(input: Omit<TurnEvent, 'type' | 'at'>): void {
    this.write({ type: 'turn', at: this.stamp(), ...input });
  }

  done(input: Omit<DoneEvent, 'type' | 'at'>): void {
    this.write({ type: 'done', at: this.stamp(), ...input });
  }
}
