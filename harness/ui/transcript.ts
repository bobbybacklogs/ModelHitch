/**
 * The run transcript, as data.
 *
 * Both renderers need the same picture of a run — what the human asked, what
 * the model said, which tools ran and how they ended — and neither should own
 * it. Keeping the model here means the TUI can rebuild a view, the plaintext
 * renderer can print as events arrive, and a test can assert on the shape of a
 * run without a terminal or a provider.
 *
 * The model also owns the two things a live view needs and a naive one gets
 * wrong: text deltas arriving faster than a renderer wants to redraw (see
 * `pendingRevision`), and reasoning that streams alongside the answer but must
 * not be spliced into it.
 */

import { isFailure, outcomeFromText, outcomeLabel, type ToolOutcome } from '../result.js';
import type { RiskLevel } from '../risk.js';

export type { ToolOutcome };

export type NoticeLevel = 'info' | 'ok' | 'warn' | 'error';

export interface UserBlock {
  kind: 'user';
  id: number;
  at: number;
  text: string;
}

export interface AssistantBlock {
  kind: 'assistant';
  id: number;
  at: number;
  turn: number;
  text: string;
  /** Streamed `reasoning-delta` text, kept out of `text` on purpose. */
  reasoning: string;
  streaming: boolean;
}

export interface ToolBlock {
  kind: 'tool';
  id: number;
  at: number;
  turn: number;
  name: string;
  args: Record<string, unknown>;
  output: string;
  outcome: ToolOutcome;
  /** Extra context from the envelope. Not part of the model's message. */
  note?: string;
  /** Wall time from the previous event to this one, when the caller knows it. */
  durationMs?: number;
  /**
   * Whether the body is shown. A failure opens by default — the reason a call
   * broke is the thing a reader is looking for — and a success stays folded to
   * one line, because a run with forty successful reads is forty screens of
   * file contents nobody asked to see.
   */
  expanded: boolean;
  /** Bytes dropped by the view cap. Zero for anything that fits. */
  omittedBytes: number;
}

/**
 * How much of one tool result the view keeps.
 *
 * A `bash` call can return 20 000 characters and a `read` is bounded only by
 * the file, so a long run would otherwise hold every byte it ever saw in memory
 * for the whole session. The untruncated body still reaches the model and still
 * reaches `--tool-log`; this cap is only about what stays on screen.
 */
export const TOOL_VIEW_CAP_BYTES = 256 * 1024;

/** Keep the head and the tail, and say how much was dropped. */
export function clampForView(text: string, cap = TOOL_VIEW_CAP_BYTES): { text: string; omittedBytes: number } {
  if (text.length <= cap) return { text, omittedBytes: 0 };
  const half = Math.floor(cap / 2);
  const head = text.slice(0, half);
  const tail = text.slice(text.length - half);
  const omitted = text.length - (head.length + tail.length);
  return {
    text: `${head}\n[view truncated: ${omitted} bytes omitted]\n${tail}`,
    omittedBytes: omitted,
  };
}

export interface NoticeBlock {
  kind: 'notice';
  id: number;
  at: number;
  level: NoticeLevel;
  title: string;
  body: string;
}

export interface ApprovalBlock {
  kind: 'approval';
  id: number;
  at: number;
  tool: string;
  preview: string;
  decision: 'pending' | 'approved' | 'declined';
  /** Advisory risk label, when a classifier is configured. */
  risk?: { level: RiskLevel; reason: string };
}

export type TranscriptBlock = UserBlock | AssistantBlock | ToolBlock | NoticeBlock | ApprovalBlock;

export interface TranscriptListener {
  added?(block: TranscriptBlock): void;
  updated?(block: TranscriptBlock): void;
}

export interface TranscriptOptions {
  /** Injected so tests and the TUI agree on time. */
  now?: () => number;
}

/**
 * A run in progress.
 *
 * Blocks are append-only and never renumbered, so a view can hold a renderable
 * per id and trust it. The only mutable block is the streaming assistant one,
 * and updates to it are counted rather than broadcast per delta: a Markdown
 * renderable re-parses its whole body on every content assignment, and a fast
 * provider emits hundreds of deltas per second.
 */
export class Transcript {
  readonly blocks: TranscriptBlock[] = [];
  private readonly listeners = new Set<TranscriptListener>();
  private readonly now: () => number;
  private nextId = 1;
  private active: AssistantBlock | null = null;
  /** Bumped on every delta; a view flushes when it changes. */
  pendingRevision = 0;

  constructor(options: TranscriptOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  subscribe(listener: TranscriptListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitAdded(block: TranscriptBlock): void {
    for (const listener of this.listeners) listener.added?.(block);
  }

  private emitUpdated(block: TranscriptBlock): void {
    for (const listener of this.listeners) listener.updated?.(block);
  }

  get last(): TranscriptBlock | undefined {
    return this.blocks[this.blocks.length - 1];
  }

  addUser(text: string): UserBlock {
    const block: UserBlock = { kind: 'user', id: this.nextId++, at: this.now(), text };
    this.blocks.push(block);
    this.emitAdded(block);
    return block;
  }

  addNotice(level: NoticeLevel, title: string, body = ''): NoticeBlock {
    const block: NoticeBlock = { kind: 'notice', id: this.nextId++, at: this.now(), level, title, body };
    this.blocks.push(block);
    this.emitAdded(block);
    return block;
  }

  addApproval(tool: string, preview: string, risk?: { level: RiskLevel; reason: string }): ApprovalBlock {
    const block: ApprovalBlock = {
      kind: 'approval',
      id: this.nextId++,
      at: this.now(),
      tool,
      preview,
      decision: 'pending',
      ...(risk !== undefined ? { risk } : {}),
    };
    this.blocks.push(block);
    this.emitAdded(block);
    return block;
  }

  decideApproval(id: number, decision: 'approved' | 'declined'): void {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (block?.kind !== 'approval') return;
    block.decision = decision;
    this.emitUpdated(block);
  }

  /**
   * A tool result. The block is created at the moment the result arrives, which
   * is also when its duration is known: the harness emits `tool` after the call
   * settles, so `durationMs` measures the gap since the previous event.
   *
   * `outcome` comes from the envelope when the caller has one, and from the
   * text otherwise — the `tool` event on the wire carries only `output`.
   */
  addTool(input: {
    turn: number;
    name: string;
    args: Record<string, unknown>;
    output: string;
    outcome?: ToolOutcome;
    durationMs?: number;
    note?: string;
  }): ToolBlock {
    const outcome = input.outcome ?? outcomeFromText(input.output);
    // The cap applies here, at the one place a result becomes a view model, so
    // no renderer has to remember to apply it.
    const clamped = clampForView(input.output);
    const block: ToolBlock = {
      kind: 'tool',
      id: this.nextId++,
      at: this.now(),
      turn: input.turn,
      name: input.name,
      args: input.args,
      output: clamped.text,
      outcome,
      expanded: isFailure(outcome),
      omittedBytes: clamped.omittedBytes,
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    };
    this.blocks.push(block);
    this.emitAdded(block);
    return block;
  }

  /** Open or close one card. Returns the card, or undefined if the id is not one. */
  setExpanded(id: number, expanded: boolean): ToolBlock | undefined {
    const block = this.blocks.find((candidate) => candidate.id === id);
    if (block?.kind !== 'tool' || block.expanded === expanded) return undefined;
    block.expanded = expanded;
    this.emitUpdated(block);
    return block;
  }

  /** Open or close every card. Returns how many actually changed. */
  setAllExpanded(expanded: boolean): number {
    let changed = 0;
    for (const block of this.blocks) {
      if (block.kind !== 'tool' || block.expanded === expanded) continue;
      block.expanded = expanded;
      changed++;
      this.emitUpdated(block);
    }
    return changed;
  }

  /** Append streamed answer text, starting a block for the turn when needed. */
  appendText(text: string, turn: number): AssistantBlock {
    const block = this.ensureAssistant(turn);
    block.text += text;
    this.pendingRevision++;
    return block;
  }

  /** Append streamed reasoning text. */
  appendReasoning(text: string, turn: number): AssistantBlock {
    const block = this.ensureAssistant(turn);
    block.reasoning += text;
    this.pendingRevision++;
    return block;
  }

  /**
   * Close the streaming block for a turn.
   *
   * A turn that ends with no text at all — a pure tool-calling turn — leaves an
   * empty block behind, which would render as a blank paragraph. Say what
   * happened instead of showing nothing.
   */
  endTurn(turn: number): void {
    const block = this.active;
    if (block === null) return;
    block.streaming = false;
    this.emitUpdated(block);
    if (block.text.trim() === '' && block.reasoning.trim() === '') {
      block.text = '_no answer text this turn_';
      this.emitUpdated(block);
    }
    this.active = null;
    void turn;
  }

  private ensureAssistant(turn: number): AssistantBlock {
    if (this.active !== null && this.active.turn === turn) return this.active;
    if (this.active !== null) {
      this.active.streaming = false;
      this.emitUpdated(this.active);
    }
    const block: AssistantBlock = {
      kind: 'assistant',
      id: this.nextId++,
      at: this.now(),
      turn,
      text: '',
      reasoning: '',
      streaming: true,
    };
    this.active = block;
    this.blocks.push(block);
    this.emitAdded(block);
    return block;
  }

  /** The assistant text of the whole run, for a final summary or a copy. */
  get assistantText(): string {
    return this.blocks
      .filter((block): block is AssistantBlock => block.kind === 'assistant')
      .map((block) => block.text)
      .filter((text) => text.trim() !== '' && text !== '_no answer text this turn_')
      .join('\n\n');
  }

  get toolBlocks(): ToolBlock[] {
    return this.blocks.filter((block): block is ToolBlock => block.kind === 'tool');
  }

  /** Counts per tool name, most used first — what the sidebar shows. */
  toolHistogram(): Array<{ name: string; count: number; failures: number }> {
    const counts = new Map<string, { name: string; count: number; failures: number }>();
    for (const block of this.toolBlocks) {
      const entry = counts.get(block.name) ?? { name: block.name, count: 0, failures: 0 };
      entry.count++;
      if (isFailure(block.outcome)) entry.failures++;
      counts.set(block.name, entry);
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /**
   * The run as Markdown: what a human would want in a file or on the clipboard
   * after a run. Reasoning is included only when asked for, because it is
   * often long and rarely what someone pastes into an issue.
   */
  toMarkdown(options: { reasoning?: boolean } = {}): string {
    const lines: string[] = [];
    for (const block of this.blocks) {
      switch (block.kind) {
        case 'user':
          lines.push(`## Task\n\n${block.text}`, '');
          break;
        case 'assistant':
          if (options.reasoning === true && block.reasoning.trim() !== '') {
            lines.push('<details><summary>reasoning</summary>', '', block.reasoning.trim(), '', '</details>', '');
          }
          if (block.text.trim() !== '' && block.text !== '_no answer text this turn_') lines.push(block.text.trim(), '');
          break;
        case 'tool': {
          const status = block.outcome === 'ok' ? '' : ` — ${outcomeLabel(block.outcome)}`;
          // The markdown transcript is a record, not a screen: it always carries
          // the whole body, whatever the view happened to be showing.
          lines.push(`### Tool: \`${block.name}\`${status}`, '', '```', block.output.trimEnd(), '```', '');
          break;
        }
        case 'notice':
          lines.push(`> ${block.level.toUpperCase()}: ${block.title}${block.body === '' ? '' : ` — ${block.body}`}`, '');
          break;
        case 'approval':
          lines.push(`> approval ${block.tool}: ${block.decision}`, '');
          break;
      }
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }
}
