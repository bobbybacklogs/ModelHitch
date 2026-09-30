/**
 * Transcript blocks as OpenTUI renderables.
 *
 * Kept apart from `tui.ts` so the app file is about layout, keys, and the
 * event loop, while "what does a tool call look like" lives in one place.
 *
 * Two rendering decisions are worth stating, because both were wrong before:
 *
 *   1. A tool result is not one undifferentiated grey paragraph. The outcome
 *      drives a status stripe and a badge, a unified diff renders through
 *      `DiffRenderable` (real add/remove backgrounds, line numbers), and the
 *      summarizer's marker or a trailing usage line is dimmed rather than
 *      buried in the body.
 *   2. A long result is head/tail clipped, not truncated at 1500 characters.
 *      The tail of a command's output is usually the part that matters, and a
 *      mid-line cut can decapitate a diff header.
 */

import {
  BoxRenderable,
  DiffRenderable,
  StyledText,
  TextRenderable,
  bold,
  dim,
  fg,
  italic,
  type CliRenderer,
  type Renderable,
  type SyntaxStyle,
  type TextChunk,
} from '@opentui/core';
import { markdownChunks } from './markdown-text.js';
import { PALETTE, type PaletteKey } from '../theme.js';
import {
  clip,
  diffStat,
  diffWindow,
  formatDiffStat,
  formatDuration,
  headTail,
  looksLikeDiff,
  toolArgsSummary,
  toolLabel,
} from '../format.js';
import type { ApprovalBlock, NoticeBlock, TranscriptBlock, ToolBlock, UserBlock } from './transcript.js';
import type { ToolOutcome } from '../result.js';
import { riskTone } from '../risk.js';

export interface BlockContext {
  renderer: CliRenderer;
  syntax: SyntaxStyle;
  workspaceDir: string;
  /** Show full tool output instead of the head/tail window. */
  verbose: boolean;
  /** Render streamed reasoning above the answer. */
  showReasoning: boolean;
  /** The tool card the keyboard is pointed at, if any. */
  focusedToolId?: number;
}

export interface BlockView {
  readonly view: Renderable;
  update(block: TranscriptBlock): void;
}

/** Body lines shown for an expanded tool result: a window, or nearly everything. */
const EXPANDED_LINES = 400;

/** Characters of a collapsed card's first output line. */
const PREVIEW_CHARS = 90;

/** Ledger of which palette color a tool's name gets. */
const TOOL_TONE: Record<string, PaletteKey> = {
  read: 'info',
  read_file: 'info',
  grep_search: 'info',
  grep: 'info',
  list_files: 'info',
  gh: 'info',
  write: 'accent',
  write_file: 'accent',
  edit: 'accent',
  replace_file_content: 'accent',
  bash: 'warn',
  run_command: 'warn',
  subagent: 'agent',
  manage_task: 'agent',
  find_subagent: 'agent',
  opencode: 'agent',
  agy: 'agent',
};

const OUTCOME_TONE: Record<ToolOutcome, PaletteKey> = {
  ok: 'ok',
  error: 'error',
  timeout: 'warn',
  truncated: 'info',
  declined: 'accent',
  'dry-run': 'faint',
};

const OUTCOME_BADGE: Record<ToolOutcome, string> = {
  ok: '',
  error: 'error',
  timeout: 'did not finish',
  truncated: 'partial',
  declined: 'declined',
  'dry-run': 'dry run',
};

const NOTICE_TONE: Record<NoticeBlock['level'], PaletteKey> = {
  info: 'info',
  ok: 'ok',
  warn: 'warn',
  error: 'error',
};

const glyph = (key: PaletteKey, text: string): TextChunk => fg(PALETTE[key])(text);

/** An unstyled chunk. `TextChunk` is branded, so plain strings need a shape. */
export const plainChunk = (text: string): TextChunk => ({ __isChunk: true, text, attributes: 0 });
const plain = plainChunk;

/** A 1-column coloured stripe, the visual anchor every block shares. */
function stripe(renderer: CliRenderer, tone: PaletteKey, height: number | 'auto' = 'auto'): BoxRenderable {
  return new BoxRenderable(renderer, {
    width: 1,
    height,
    flexShrink: 0,
    backgroundColor: PALETTE[tone],
  });
}

function row(renderer: CliRenderer, children: Renderable[], options: Record<string, unknown> = {}): BoxRenderable {
  const box = new BoxRenderable(renderer, {
    flexDirection: 'row',
    width: '100%',
    ...options,
  });
  for (const child of children) box.add(child);
  return box;
}

function column(renderer: CliRenderer, children: Renderable[], options: Record<string, unknown> = {}): BoxRenderable {
  const box = new BoxRenderable(renderer, { flexDirection: 'column', width: '100%', ...options });
  for (const child of children) box.add(child);
  return box;
}

/**
 * Colour a tool result line by line: diff markers, error prefixes, and the
 * harness's own out-of-band markers each get their own treatment so the eye can
 * skip the body and still catch what matters.
 */
export function toolOutputChunks(text: string, outcome: ToolOutcome): TextChunk[] {
  const chunks: TextChunk[] = [];
  const body = text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
  const lines = body.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) chunks.push(plain('\n'));
    let color: PaletteKey = outcome === 'ok' ? 'muted' : OUTCOME_TONE[outcome];
    if (/^\[summarized:/.test(line) || /^\[(opencode|agy) /.test(line)) color = 'faint';
    else if (/^\[stderr\]/.test(line)) color = 'warn';
    else if (/^(Error|Exit \d)/.test(line)) color = 'error';
    else if (/^! /.test(line)) color = 'warn';
    else if (/^\+/.test(line)) color = 'added';
    else if (/^-/.test(line)) color = 'removed';
    else if (/^(Wrote|Edited) /.test(line)) color = 'ok';
    chunks.push(fg(PALETTE[color])(line));
  });
  return chunks;
}

function userView(renderer: CliRenderer): BlockView {
  const label = new TextRenderable(renderer, {
    content: new StyledText([bold(glyph('accent', 'You'))]),
    height: 1,
  });
  const body = new TextRenderable(renderer, { content: '', fg: PALETTE.text, wrapMode: 'word' });
  const inner = column(renderer, [label, body]);
  const view = row(renderer, [stripe(renderer, 'accent'), inner]);
  return {
    view,
    update(block) {
      if (block.kind !== 'user') return;
      body.content = (block as UserBlock).text;
    },
  };
}

function assistantView(ctx: BlockContext): BlockView {
  const reasoning = new TextRenderable(ctx.renderer, {
    content: '',
    wrapMode: 'word',
    visible: ctx.showReasoning,
  });
  /*
   * A `TextRenderable`, not a `MarkdownRenderable`.
   *
   * The markdown renderable paints nothing in this environment — it lays out and
   * parses and then draws an empty frame — so the assistant's answer, the one
   * thing a transcript exists to show, was invisible. `markdownChunks` styles the
   * same constructs into chunks this renderable can actually draw.
   */
  const answer = new TextRenderable(ctx.renderer, {
    content: '',
    fg: PALETTE.text,
    wrapMode: 'word',
  });
  const inner = column(ctx.renderer, [reasoning, answer]);
  const view = row(ctx.renderer, [stripe(ctx.renderer, 'info'), inner]);
  return {
    view,
    update(block) {
      if (block.kind !== 'assistant') return;
      answer.content = new StyledText(markdownChunks(block.text, { color: PALETTE.text }));
      const show = ctx.showReasoning && block.reasoning.trim() !== '';
      reasoning.visible = show;
      if (show) {
        const budget = ctx.verbose ? 24 : 6;
        const { text } = headTail(block.reasoning.trim(), budget);
        reasoning.content = new StyledText([
          dim(italic(fg(PALETTE.faint)(`thinking · ${text}`))),
        ]);
      }
    },
  };
}

const OUTCOME_MARK: Record<ToolOutcome, string> = {
  ok: '⏺',
  error: '✖',
  timeout: '◼',
  truncated: '⋯',
  declined: '⊘',
  'dry-run': '◇',
};

/**
 * The first line of a result worth previewing.
 *
 * A diff's first line is `--- a/path`, which says nothing the card's `+n -n`
 * badge does not already say, so a diff previews as nothing rather than as
 * noise. Blank lines are skipped for the same reason.
 */
function firstOutputLine(block: ToolBlock): string {
  if (looksLikeDiff(block.output)) return '';
  const line = block.output.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : line.trim();
}

function toolView(ctx: BlockContext, block: ToolBlock): BlockView {
  const tone = OUTCOME_TONE[block.outcome];
  const nameTone: PaletteKey = TOOL_TONE[block.name] ?? 'accent';

  const head = new TextRenderable(ctx.renderer, { content: '', height: 1, wrapMode: 'none' });
  const badge = new TextRenderable(ctx.renderer, { content: '', height: 1, wrapMode: 'none' });

  const diff = new DiffRenderable(ctx.renderer, {
    diff: '',
    syntaxStyle: ctx.syntax,
    view: 'unified',
    showLineNumbers: true,
    wrapMode: 'none',
    addedBg: '#12261e',
    removedBg: '#2b1416',
    contextBg: PALETTE.panel,
    addedSignColor: PALETTE.added,
    removedSignColor: PALETTE.removed,
    lineNumberFg: PALETTE.faint,
    selectionBg: '#264f78',
  });
  diff.visible = false;
  diff.height = 0;

  const body = new TextRenderable(ctx.renderer, { content: '', wrapMode: 'word', visible: false });

  const inner = column(ctx.renderer, [row(ctx.renderer, [head, badge], { justifyContent: 'space-between' }), diff, body]);
  const view = row(ctx.renderer, [stripe(ctx.renderer, tone), inner]);

  const render = (current: ToolBlock): void => {
    const args = toolArgsSummary(current.name, current.args);
    const focused = ctx.focusedToolId === current.id;
    // Ctrl+O (`verbose`) forces every body open: a reader toggling it wants
    // all of the run's output, not only the cards they unfolded by hand. The
    // per-card fold state is untouched, so toggling off undoes exactly that.
    const expanded = current.expanded || ctx.verbose;
    const parts: TextChunk[] = [
      // A cursor marker, so a keyboard user can see which card the keys will act
      // on. The stripe already carries the status, so this only has to be a
      // position indicator.
      focused ? glyph('accent', '▸ ') : plain('  '),
      bold(glyph(nameTone, `${OUTCOME_MARK[current.outcome]} ${toolLabel(current.name)}`)),
    ];
    if (args !== '') parts.push(glyph('faint', `  ${clip(args, 140)}`));
    // The one-line form carries a preview of the result: a header with no hint
    // of what came back is a header a reader has to open to evaluate.
    const preview = expanded ? '' : firstOutputLine(current);
    if (preview !== '') parts.push(glyph('faint', `  · ${clip(preview, PREVIEW_CHARS)}`));
    head.content = new StyledText(parts);

    const output = current.output.trimEnd();
    const isDiffOutput = looksLikeDiff(output);
    // Verbose drops the window entirely (up to the view cap); otherwise an
    // expanded card shows at most `EXPANDED_LINES` lines.
    const budget = ctx.verbose ? Number.MAX_SAFE_INTEGER : EXPANDED_LINES;
    const window = isDiffOutput ? diffWindow(output, budget) : null;
    // A single hunk too large for the budget has no valid short form, so it
    // falls back to coloured text rather than an unparseable diff view.
    const useDiff = expanded && window !== null && !window.tooLarge;

    const badgeText = OUTCOME_BADGE[current.outcome];
    const stat = isDiffOutput ? diffStat(current.output) : { added: 0, removed: 0 };
    const meta: TextChunk[] = [];
    if (badgeText !== '') meta.push(fg(PALETTE[tone])(badgeText));
    if (stat.added > 0 || stat.removed > 0) {
      if (meta.length > 0) meta.push(glyph('faint', '  '));
      meta.push(glyph('added', `+${stat.added}`), plain(' '), glyph('removed', `-${stat.removed}`));
    }
    if (current.omittedBytes > 0) {
      if (meta.length > 0) meta.push(glyph('faint', '  '));
      meta.push(glyph('warn', `view -${current.omittedBytes}b`));
    }
    if (isDiffOutput && window !== null && window.total > 0 && (useDiff ? window.kept < window.total : window.tooLarge)) {
      // A dropped hunk is a hunk the reader cannot see, so the count has to say
      // so rather than letting a truncated diff read as the whole change. The
      // too-large case renders as text instead of a diff — but a card whose
      // diff does not fit must still say why, not silently show prose.
      if (meta.length > 0) meta.push(glyph('faint', '  '));
      meta.push(glyph('warn', window.kept === 0 ? 'diff too large' : `${window.kept}/${window.total} hunks`));
    }
    if (!expanded && output !== '') {
      const lines = output.split('\n').length;
      if (lines > 1) {
        if (meta.length > 0) meta.push(glyph('faint', '  '));
        meta.push(glyph('faint', `${lines} lines`));
      }
    }
    if (current.durationMs !== undefined) {
      if (meta.length > 0) meta.push(glyph('faint', '  '));
      meta.push(glyph('faint', formatDuration(current.durationMs)));
    }
    badge.content = new StyledText(meta);

    diff.visible = useDiff;
    body.visible = expanded && !useDiff && output !== '';
    if (useDiff && window !== null) {
      const rows = window.text.split('\n').length;
      diff.height = Math.min(rows + 1, budget + 1);
      diff.diff = window.text;
    } else if (body.visible) {
      const { text } = headTail(output, budget);
      body.height = text.split('\n').length;
      body.content = new StyledText(toolOutputChunks(text, current.outcome));
    }
  };

  render(block);
  return {
    view,
    update(next) {
      if (next.kind === 'tool') render(next);
    },
  };
}

function noticeView(ctx: BlockContext, block: NoticeBlock): BlockView {
  const title = new TextRenderable(ctx.renderer, { content: '', height: 1, wrapMode: 'none' });
  const body = new TextRenderable(ctx.renderer, { content: '', fg: PALETTE.muted, wrapMode: 'word', visible: false });
  const inner = column(ctx.renderer, [title, body]);
  const view = row(ctx.renderer, [stripe(ctx.renderer, NOTICE_TONE[block.level]), inner]);
  const render = (next: NoticeBlock): void => {
    const tone = NOTICE_TONE[next.level];
    const mark = next.level === 'error' ? '✖' : next.level === 'warn' ? '!' : next.level === 'ok' ? '✔' : '›';
    title.content = new StyledText([bold(glyph(tone, `${mark} ${next.title}`))]);
    body.content = next.body;
    body.visible = next.body !== '';
  };
  render(block);
  return {
    view,
    update(next) {
      if (next.kind === 'notice') render(next);
    },
  };
}

function approvalView(ctx: BlockContext, block: ApprovalBlock): BlockView {
  const title = new TextRenderable(ctx.renderer, { content: '', height: 1, wrapMode: 'none' });
  const riskLine = new TextRenderable(ctx.renderer, { content: '', height: 1, wrapMode: 'none', visible: false });
  const diff = new DiffRenderable(ctx.renderer, {
    diff: '',
    syntaxStyle: ctx.syntax,
    view: 'unified',
    showLineNumbers: true,
    wrapMode: 'none',
    addedBg: '#12261e',
    removedBg: '#2b1416',
    contextBg: PALETTE.panel,
    addedSignColor: PALETTE.added,
    removedSignColor: PALETTE.removed,
    lineNumberFg: PALETTE.faint,
  });
  const plain = new TextRenderable(ctx.renderer, { content: '', wrapMode: 'word', visible: false });
  const inner = column(ctx.renderer, [title, riskLine, diff, plain], { paddingLeft: 1 });
  const view = row(ctx.renderer, [stripe(ctx.renderer, 'accent'), inner]);

  const render = (next: ApprovalBlock): void => {
    const isDiff = looksLikeDiff(next.preview);
    const decision =
      next.decision === 'approved'
        ? glyph('ok', '  approved')
        : next.decision === 'declined'
          ? glyph('error', '  declined')
          : glyph('accent', '  y approve   n decline');
    title.content = new StyledText([bold(glyph('accent', `Approve ${toolLabel(next.tool)}?`)), decision]);
    if (next.risk !== undefined) {
      const tone = riskTone(next.risk.level);
      riskLine.visible = true;
      riskLine.content = new StyledText([
        glyph(tone, `risk: ${next.risk.level}`),
        glyph('muted', `  ${next.risk.reason}`),
      ]);
    } else {
      riskLine.visible = false;
    }
    const body = next.preview.trimEnd();
    const window = isDiff ? diffWindow(body, 24) : null;
    const useDiff = window !== null && !window.tooLarge;
    diff.visible = useDiff;
    plain.visible = !useDiff && body !== '';
    if (useDiff && window !== null) {
      diff.height = Math.min(window.text.split('\n').length + 1, 25);
      diff.diff = window.text;
    } else if (plain.visible) {
      const { text } = headTail(body, 24);
      plain.content = new StyledText(toolOutputChunks(text, 'declined'));
    }
  };
  render(block);
  return {
    view,
    update(next) {
      if (next.kind === 'approval') render(next);
    },
  };
}

export function createBlockView(block: TranscriptBlock, ctx: BlockContext): BlockView {
  switch (block.kind) {
    case 'user':
      return userView(ctx.renderer);
    case 'assistant':
      return assistantView(ctx);
    case 'tool':
      return toolView(ctx, block);
    case 'notice':
      return noticeView(ctx, block);
    case 'approval':
      return approvalView(ctx, block);
  }
}

/** `+12 -3` for the status bar, from the run's diff-shaped tool results. */
export function transcriptDiffStat(blocks: ToolBlock[]): string {
  let added = 0;
  let removed = 0;
  for (const block of blocks) {
    if (!looksLikeDiff(block.output)) continue;
    const stat = diffStat(block.output);
    added += stat.added;
    removed += stat.removed;
  }
  if (added === 0 && removed === 0) return '';
  return formatDiffStat({ added, removed });
}
