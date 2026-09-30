/**
 * The plaintext renderer.
 *
 * This is what a run looks like when the TUI cannot take the terminal: piped
 * into a file, run from CI, or on a machine without bun. It is not a lesser
 * view of the same information — the same header facts, the same tool cards,
 * the same status vocabulary — but it never draws anything that needs a cursor
 * address, because its output is very often being redirected into a log.
 *
 * Two rules follow from that, and both are deliberate:
 *
 *   1. Nothing is erased or rewritten. A status meter that redraws itself with
 *      `\r` turns a log file into noise, so progress is reported by appending
 *      a line at the *end* of a tool call, where it is also more useful.
 *   2. Colour is decided once, from `NO_COLOR` / `FORCE_COLOR` / TTY, and every
 *      escape goes through `Painter`. Setting `NO_COLOR=1` has to produce a
 *      clean file, not a file full of `[38;2;...m`.
 */

import { Painter, PALETTE, colorCapability, type PaletteKey } from './theme.js';
import {
  clip,
  formatCount,
  formatDiffStat,
  formatDuration,
  headTail,
  looksLikeDiff,
  diffStat,
  strWidth,
  toolArgsSummary,
  toolLabel,
} from './format.js';
import { approvalLabel, type RunEnvironment } from './ui/environment.js';
import type { NoticeLevel } from './ui/transcript.js';
import { isFailure, outcomeLabel, type ToolOutcome } from './result.js';
import { riskTone, type RiskAssessment } from './risk.js';
import { summarizeUndo, type UndoResult } from './snapshot.js';
import { confirm, ask } from './readline.js';

/**
 * The first line of a result worth showing on a folded card.
 *
 * A diff's first line is `--- a/path`, which says nothing the `+n -n` badge does
 * not already say, so a diff previews as nothing rather than as noise.
 */
function firstLine(output: string): string {
  if (looksLikeDiff(output)) return '';
  const line = output.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : line.trim();
}

export interface RendererOptions {
  /** Where the transcript goes. */
  output?: NodeJS.WriteStream;
  /** Where diagnostics go. Kept apart so `> run.log` still captures warnings. */
  error?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  /** Lines of tool output in the default view. */
  toolLines?: number;
  /** Show the full tool output. */
  verbose?: boolean;
}

const GLYPH = {
  ok: '✔',
  info: '›',
  warn: '!',
  error: '✖',
} as const;

const OUTCOME_MARK: Record<ToolOutcome, string> = {
  ok: '✔',
  error: '✖',
  // Deliberately its own mark and colour: "it did not finish" is not "it broke",
  // and a cancelled command is usually the human's doing, not the tool's fault.
  timeout: '◼',
  truncated: '⋯',
  declined: '⊘',
  'dry-run': '◇',
};

const OUTCOME_TONE: Record<ToolOutcome, PaletteKey> = {
  ok: 'ok',
  error: 'error',
  timeout: 'warn',
  truncated: 'info',
  declined: 'accent',
  'dry-run': 'faint',
};

const NOTICE_TONE: Record<NoticeLevel, PaletteKey> = {
  info: 'info',
  ok: 'ok',
  warn: 'warn',
  error: 'error',
};

export class TerminalRenderer {
  private readonly out: NodeJS.WriteStream;
  private readonly err: NodeJS.WriteStream;
  private readonly painter: Painter;
  private readonly toolLines: number;
  readonly verbose: boolean;
  private streaming = false;
  private tools = 0;

  constructor(options: RendererOptions = {}) {
    this.out = options.output ?? process.stdout;
    this.err = options.error ?? process.stderr;
    const capability = colorCapability({ stream: this.out, ...(options.env ? { env: options.env } : {}) });
    this.painter = new Painter(capability);
    this.toolLines = options.toolLines ?? 16;
    this.verbose = options.verbose === true;
  }

  private write(text: string): void {
    this.out.write(text);
  }

  private line(text = ''): void {
    this.write(`${text}\n`);
  }

  /** A section heading with a rule the width of the terminal. */
  section(title: string, tone: PaletteKey = 'accent'): void {
    const width = this.columns();
    const label = ` ${title} `;
    const rule = '─'.repeat(Math.max(0, width - strWidth(label) - 3));
    this.line();
    this.line(`${this.painter.color(tone, '──')}${this.painter.bold(this.painter.color(tone, label))}${this.painter.color('border', rule)}`);
  }

  columns(): number {
    const width = this.out.columns ?? 100;
    return Math.max(40, Math.min(width, 200));
  }

  /** The run's identity, before any work happens. */
  header(environment: RunEnvironment, prompt: string, resumed?: { id: string; turns: number }): void {
    const columns = this.columns();
    this.line();
    this.line(
      `  ${this.painter.bold(this.painter.color('accent', 'MODELHITCH'))}` +
        `${this.painter.color('faint', ' · harness')}`,
    );
    this.line(
      `  ${this.painter.color('muted', environment.target)}` +
        `${this.painter.color('faint', `  ·  playbook ${environment.playbook}`)}` +
        (environment.principles > 0 ? this.painter.color('faint', ` +${environment.principles} principles`) : ''),
    );
    this.line(`  ${this.painter.color('faint', environment.workspaceDir.replace(/\\/g, '/'))}`);
    if (resumed) {
      this.line(
        `  ${this.painter.color('warn', '↺ resumed')} ${this.painter.color('muted', `${resumed.id} (${resumed.turns} turns)`)}`,
      );
    }
    this.section('task', 'info');
    for (const line of wrapPlain(prompt, columns - 4)) this.line(`  ${this.painter.color('text', line)}`);
    this.line();
    this.line(
      `  ${this.painter.color('faint', 'writes   ')}` +
        this.painter.color(environment.approvals === 'auto' ? 'warn' : 'muted', approvalLabel(environment.approvals)),
    );
    this.line(
      `  ${this.painter.color('faint', 'limits   ')}` +
        this.painter.color('muted', `${environment.maxTurns} turns · ${environment.toolTimeoutMs === 0 ? 'no' : formatDuration(environment.toolTimeoutMs)} per tool`),
    );
    this.line(
      `  ${this.painter.color('faint', 'undo     ')}` +
        this.painter.color(environment.snapshots ? 'ok' : 'faint', environment.snapshots ? 'snapshots on (--undo)' : 'snapshots off'),
    );
    this.line(`  ${this.painter.color('faint', 'agents   ')}${this.painter.color('muted', clip(environment.agents, columns - 12))}`);
    // Labelled `detected` rather than `workspace` so the value starts in the
    // same column as the rows above it: a nine-character label here would leave
    // no gap before `typescript`.
    this.line(
      `  ${this.painter.color('faint', 'detected ')}` +
        this.painter.color('muted', clip(environment.workspaceFacts, columns - 12)),
    );
  }

  /** Streamed assistant text. Written verbatim; it is the model's words. */
  text(delta: string): void {
    this.streaming = true;
    this.write(delta);
  }

  /** Close an assistant turn so the next block starts on its own line. */
  endText(): void {
    if (!this.streaming) return;
    this.write('\n');
    this.streaming = false;
  }

  reasoning(delta: string, enabled: boolean): void {
    if (!enabled) return;
    this.endText();
    this.write(this.painter.dim(this.painter.color('faint', delta)));
  }

  /**
   * A tool call, as a card.
   *
   * The header line carries the tool, its argument summary, the outcome, a diff
   * stat when the result is a diff, and how long it took — everything a reader
   * skimming a log would otherwise have to reconstruct from the body.
   *
   * A successful call folds to that one line and a failed one prints its body.
   * That is the same rule the TUI applies, and it is what makes a long run
   * readable: forty successful reads are forty lines, while the one thing that
   * broke gets the space. `--verbose` unfolds everything, and `--tool-log` keeps
   * every untruncated body in a file regardless.
   */
  tool(input: {
    name: string;
    args: Record<string, unknown>;
    output: string;
    outcome: ToolOutcome;
    durationMs?: number;
    /** Extra context from the envelope. Never part of the model's message. */
    note?: string;
    /** Override the outcome-derived default. */
    expanded?: boolean;
  }): void {
    this.endText();
    this.tools++;
    const columns = this.columns();
    const tone = OUTCOME_TONE[input.outcome];
    const expanded = input.expanded ?? (this.verbose || isFailure(input.outcome));
    const summary = toolArgsSummary(input.name, input.args);
    const head = ` ${OUTCOME_MARK[input.outcome]} ${toolLabel(input.name)} `;
    const badge = outcomeLabel(input.outcome);
    const preview = expanded ? '' : firstLine(input.output);
    const room = Math.max(10, columns - strWidth(head) - strWidth(badge) - 30);
    const detail = summary === '' ? '' : ` ${clip(summary, room)}`;
    const meta: string[] = [];
    if (badge !== '') meta.push(this.painter.color(tone, badge));
    if (preview !== '') {
      meta.push(this.painter.color('faint', clip(preview, Math.max(20, columns - strWidth(head) - 30))));
    }
    if (input.durationMs !== undefined) meta.push(this.painter.color('faint', formatDuration(input.durationMs)));

    this.line();
    this.line(
      this.painter.color(tone, '▌') +
        this.painter.bold(this.painter.color(tone, head)) +
        this.painter.color('faint', detail) +
        (meta.length > 0 ? `  ${meta.join(this.painter.color('faint', '  ·  '))}` : ''),
    );
    if (input.note !== undefined && input.note !== '') {
      this.line(
        `${this.painter.color('faint', '▌')}  ${this.painter.color('faint', `(${input.note})`)}`,
      );
    }
    if (!expanded) return;

    const output = input.output.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').trimEnd();
    if (output === '') {
      this.line(`${this.painter.color('faint', '▌')}  ${this.painter.color('faint', '(no output)')}`);
      return;
    }

    const isDiff = looksLikeDiff(output);
    if (isDiff) {
      const stat = diffStat(output);
      this.line(
        `${this.painter.color('faint', '▌')}  ${this.painter.color('added', `+${stat.added}`)} ${this.painter.color('removed', `-${stat.removed}`)}`,
      );
    }
    const budget = this.verbose ? 400 : this.toolLines;
    const { text } = headTail(output, budget);
    for (const line of text.split('\n')) {
      this.line(`${this.painter.color(tone, '▌')}  ${this.styleOutputLine(line, input.outcome, isDiff)}`);
    }
  }

  private styleOutputLine(line: string, outcome: ToolOutcome, isDiff: boolean): string {
    const tone = OUTCOME_TONE[outcome];
    if (isDiff) {
      if (line.startsWith('@@')) return this.painter.color('info', line);
      if (line.startsWith('+++') || line.startsWith('---')) return this.painter.bold(this.painter.color('muted', line));
      if (line.startsWith('+')) return this.painter.color('added', line);
      if (line.startsWith('-')) return this.painter.color('removed', line);
      return this.painter.color('muted', line);
    }
    if (/^\[summarized:/.test(line) || /^\[(opencode|agy) /.test(line)) return this.painter.dim(line);
    if (/^\[stderr\]/.test(line)) return this.painter.bold(this.painter.color('warn', line));
    if (/^(Error|Exit \d)/.test(line)) return this.painter.color('error', line);
    if (/^! /.test(line)) return this.painter.color('warn', line);
    if (/^(Wrote|Edited) /.test(line)) return this.painter.color('ok', line);
    return outcome === 'ok' ? line : this.painter.color(tone, line);
  }

  notice(level: NoticeLevel, title: string, body = ''): void {
    this.endText();
    const tone = NOTICE_TONE[level];
    this.line();
    this.line(
      `${this.painter.color(tone, '▌')} ${this.painter.bold(this.painter.color(tone, `${GLYPH[level]} ${title}`))}`,
    );
    if (body !== '') {
      for (const line of wrapPlain(body, this.columns() - 4)) {
        this.line(`${this.painter.color(tone, '▌')}   ${this.painter.color('muted', line)}`);
      }
    }
  }

  /**
   * A one-off progress line.
   *
   * Appended, never rewritten: a status meter that redraws itself with `\r`
   * turns `> run.log` into noise, and the same information is more useful as a
   * line in the transcript anyway.
   */
  progress(text: string, tone: PaletteKey = 'faint'): void {
    this.endText();
    this.line(`${this.painter.color(tone, '·')} ${this.painter.color(tone, text)}`);
  }

  /**
   * The approval card.
   *
   * The preview is the thing being authorized, so it gets the same treatment as
   * a tool result: a diff is coloured per line, a command is shown verbatim.
   * This replaces the old `[approval] <tool>` blob, which printed the diff
   * twice — once here and once from the handler's own logger.
   */
  approval(tool: string, preview: string, risk?: RiskAssessment): void {
    this.endText();
    const columns = this.columns();
    const title = ` Approve ${toolLabel(tool)}? `;
    const rule = '─'.repeat(Math.max(0, columns - strWidth(title) - 3));
    this.line();
    this.line(
      `${this.painter.color('accent', '──')}${this.painter.bold(this.painter.color('accent', title))}` +
        this.painter.color('border', rule),
    );
    if (risk !== undefined) {
      const tone = riskTone(risk.level);
      this.line(
        `${this.painter.color(tone, '▌')}  ${this.painter.bold(this.painter.color(tone, `risk: ${risk.level}`))}` +
          this.painter.color('muted', `  ${risk.reason}`),
      );
    }
    const body = preview.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').trimEnd();
    if (body === '') return;
    const isDiff = looksLikeDiff(body);
    const { text } = headTail(body, this.verbose ? 400 : 40);
    for (const line of text.split('\n')) {
      this.line(
        `${this.painter.color('accent', '▌')}  ${this.styleOutputLine(line, 'declined', isDiff)}`,
      );
    }
  }

  /** Ask the question the approval card is about. */
  ask(question: string, defaultYes = false): Promise<boolean> {
    return confirm(question, { defaultAnswer: defaultYes });
  }

  /**
   * Ask a question whose answer is more than yes or no.
   *
   * The approval gate needs four answers — once, always this session, always in
   * this workspace, no — so it reads the raw line and decides. A non-TTY stdin
   * returns empty, and the caller treats that as "nobody answered" rather than
   * as a default.
   */
  async askLine(question: string): Promise<string> {
    if (process.stdin.isTTY !== true) return '';
    return (await ask(question)).trim();
  }

  /**
   * The `--undo` report.
   *
   * Undo is a repair command, so it is worth showing exactly what it touched:
   * which files came back, which were deleted, and what it could not cover.
   */
  undo(result: UndoResult): void {
    this.endText();
    const failed = result.failures.length > 0;
    this.section(`undo ${result.runId}`, failed ? 'warn' : 'ok');
    for (const line of summarizeUndo(result)) {
      const tone: PaletteKey = line.startsWith('could not undo')
        ? 'error'
        : line.startsWith('not covered')
          ? 'warn'
          : 'muted';
      this.line(`  ${this.painter.color(tone, line)}`);
    }
  }

  /** The final summary: what happened, in one block. */
  summary(input: {
    turns: number;
    tokens: number;
    tools: number;
    elapsedMs: number;
    changes?: Array<{ name: string; added: number; removed: number }>;
    sessionId?: string;
    transcriptPath?: string;
    /** `--tool-log`: where the untruncated tool bodies went. */
    toolLogPath?: string;
    /** `--auto-approve-safe`: how many calls skipped the prompt, by risk level. */
    autoApproved?: Array<{ name: string; level: string }>;
  }): void {
    this.endText();
    const columns = this.columns();
    this.section('run complete', 'ok');
    const rows: Array<[string, string]> = [
      ['turns', `${input.turns}`],
      ['tokens', formatCount(input.tokens)],
      ['tool calls', `${input.tools}`],
      ['duration', formatDuration(input.elapsedMs)],
    ];
    if (input.changes !== undefined && input.changes.length > 0) {
      const added = input.changes.reduce((sum, entry) => sum + entry.added, 0);
      const removed = input.changes.reduce((sum, entry) => sum + entry.removed, 0);
      rows.push(['changes', formatDiffStat({ added, removed })]);
      rows.push(['by tool', input.changes.map((entry) => `${entry.name} +${entry.added}/-${entry.removed}`).join('  ')]);
    }
    if (input.sessionId !== undefined && input.sessionId !== '') {
      rows.push(['session', `${input.sessionId}  (--resume ${input.sessionId})`]);
    }
    if (input.transcriptPath !== undefined) rows.push(['transcript', input.transcriptPath]);
    if (input.toolLogPath !== undefined) {
      // Folded cards are a summary; say where the full bodies went, or a reader
      // will assume the console was all there was.
      rows.push(['tool log', input.toolLogPath]);
    }
    if (input.autoApproved !== undefined && input.autoApproved.length > 0) {
      // Grouped by level, and named: an auto-approved call is the one thing in
      // the run nobody looked at, so the summary has to say which they were.
      const byLevel = new Map<string, string[]>();
      for (const entry of input.autoApproved) {
        const names = byLevel.get(entry.level) ?? [];
        names.push(entry.name);
        byLevel.set(entry.level, names);
      }
      rows.push([
        'auto-approved',
        [...byLevel.entries()].map(([level, names]) => `${level}: ${names.join(', ')}`).join('   '),
      ]);
    }
    const labelWidth = Math.max(...rows.map(([label]) => strWidth(label)));
    for (const [label, value] of rows) {
      const room = Math.max(8, columns - labelWidth - 6);
      this.line(
        `  ${this.painter.color('faint', label.padEnd(labelWidth))}  ` +
          this.painter.color('text', clip(value, room)),
      );
    }
  }

  error(message: string): void {
    this.endText();
    const tone: PaletteKey = 'error';
    this.line();
    this.line(`${this.painter.color(tone, '▌')} ${this.painter.bold(this.painter.color(tone, `✖ ${message}`))}`);
  }

  /** Diagnostics, on stderr, so a redirected transcript stays clean. */
  diagnostic(message: string): void {
    const painter = new Painter(colorCapability({ stream: this.err }));
    this.err.write(`${painter.color('faint', '[harness]')} ${message}\n`);
  }

  get toolCount(): number {
    return this.tools;
  }
  /** Reset the open-color latch at the end of a streamed write. */
  end(): string {
    return this.painter.end();
  }
}

/** Wrap on word boundaries, for prose the terminal will not wrap for us. */
export function wrapPlain(text: string, columns: number): string[] {  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line === '') {
        line = word;
      } else if (strWidth(`${line} ${word}`) <= columns) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
    }
    if (line !== '') out.push(line);
  }
  return out;
}
