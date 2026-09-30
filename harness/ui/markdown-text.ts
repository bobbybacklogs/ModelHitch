/**
 * Markdown, rendered as styled text.
 *
 * The obvious choice is `MarkdownRenderable`, and this module exists because it
 * does not work here: every variant of it — default, `top-level`, with and
 * without concealment, with content at construction and set afterwards — lays
 * out (it reports the right width and height) and parses (one block, one child)
 * and then paints nothing. Its child is a `CodeRenderable` that renders its
 * content happily on its own, so the failure is in the composition, and it is
 * not something the harness can patch from outside.
 *
 * The consequence was not cosmetic: the assistant's answer is a markdown block,
 * so the single most important thing in a transcript was invisible. A run showed
 * its tool cards and its notices and no prose at all.
 *
 * So this builds `TextChunk`s for a `TextRenderable` — the one primitive that
 * demonstrably renders everywhere in this app — and styles the constructs a
 * coding transcript actually contains. It is line-oriented rather than a real
 * parser, which is the right trade here: it is streaming-safe (a half-received
 * line styles correctly, it just may not be a complete construct yet), it cannot
 * fail, and it has no dependency that can be missing.
 */

import { TextAttributes, fg, bold, italic, type TextChunk } from '@opentui/core';
import { PALETTE } from '../theme.js';

export interface MarkdownTextOptions {
  /** Columns available, for horizontal rules. */
  columns?: number;
  /** Base text colour. */
  color?: string;
}

/** An unadorned chunk. `TextChunk` is branded, so a plain string needs a shape. */
const plain = (text: string): TextChunk => ({ __isChunk: true, text, attributes: 0 });

/** Colour plus attributes, built through the helper so the RGBA is correct. */
function styled(text: string, color: string, attributes = 0): TextChunk {
  const chunk = fg(color)(text);
  chunk.attributes = attributes;
  return chunk;
}

const BOLD = TextAttributes.BOLD;
const ITALIC = TextAttributes.ITALIC;
const DIM = TextAttributes.DIM;

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Style one line's inline spans: `**bold**`, `` `code` ``, `*italic*`.
 *
 * A small scanner rather than a regex sweep, because the markers nest and
 * overlap in ways regexes handle badly — and because an unmatched marker has to
 * come out as the literal character the model typed rather than vanishing.
 *
 * `_` is deliberately *not* an emphasis marker. In a coding transcript it is
 * overwhelmingly part of an identifier, and treating it as markup silently ate
 * the underscores out of `snake_case_name`. `*italic*` covers the need; a
 * construct that mangles real code is not worth the coverage.
 */
export function inlineChunks(text: string, baseColor: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let buffer = '';
  let boldOn = false;
  let italicOn = false;
  let codeOn = false;

  const flush = (): void => {
    if (buffer === '') return;
    const attributes = (boldOn ? BOLD : 0) | (italicOn ? ITALIC : 0);
    chunks.push(styled(buffer, codeOn ? PALETTE.info : baseColor, attributes));
    buffer = '';
  };

  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    if (char === '`') {
      flush();
      codeOn = !codeOn;
      continue;
    }
    if (codeOn) {
      // Inside inline code nothing is markup: `a ** b` in a command arrives
      // here and must come out exactly as the model wrote it.
      buffer += char;
      continue;
    }
    if (text.startsWith('**', index)) {
      flush();
      boldOn = !boldOn;
      index++;
      continue;
    }
    if (char === '*') {
      // A delimiter run matters only on its own flanks: an opener has a word
      // after it (`*best*`), a closer has a word before it, and `2 * 3` is
      // surrounded by spaces on both sides, which is neither. Without this
      // distinction the common `*note* sentence` opened italics it never closed.
      const previous = text[index - 1] ?? ' ';
      const next = text[index + 1] ?? ' ';
      const canFlip = italicOn ? previous !== ' ' : next !== ' ';
      if (canFlip) {
        flush();
        italicOn = !italicOn;
        continue;
      }
    }
    buffer += char;
  }
  flush();
  return chunks;
}

/**
 * Turn markdown into styled chunks for one `TextRenderable`.
 *
 * Rendered line by line and joined afterwards, rather than emitting a newline
 * per source line: a fence delimiter is structure and must not leave the blank
 * line its removal would otherwise create around a code block.
 *
 * Newlines are emitted as plain chunks, so the caller needs nothing but
 * `wrapMode: 'word'` to get a correct paragraph.
 */
export function markdownChunks(source: string, options: MarkdownTextOptions = {}): TextChunk[] {
  const columns = Math.max(20, options.columns ?? 80);
  const base = options.color ?? PALETTE.text;
  const rendered: TextChunk[][] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence !== null) {
      if (!inFence) {
        inFence = true;
        fenceMarker = (fence[1] as string).slice(0, 3);
      } else if (line.trim().startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      rendered.push([styled(line === '' ? ' ' : line, PALETTE.info)]);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = (heading[1] as string).length;
      rendered.push([styled(heading[2] as string, level === 1 ? PALETTE.accent : PALETTE.info, BOLD)]);
      continue;
    }
    if (RULE.test(line)) {
      rendered.push([styled('─'.repeat(Math.min(columns, 60)), PALETTE.border)]);
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      rendered.push([
        styled('│ ', PALETTE.faint),
        styled(quote[1] as string, PALETTE.muted, ITALIC),
      ]);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      rendered.push([
        plain(bullet[1] as string),
        styled('• ', PALETTE.accent),
        ...inlineChunks(bullet[2] as string, base),
      ]);
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered !== null) {
      rendered.push([
        plain(ordered[1] as string),
        styled(`${ordered[2]}. `, PALETTE.accent, DIM),
        ...inlineChunks(ordered[3] as string, base),
      ]);
      continue;
    }
    rendered.push(inlineChunks(line, base));
  }

  return rendered.flatMap((line, index) => (index === 0 ? line : [plain('\n'), ...line]));
}
