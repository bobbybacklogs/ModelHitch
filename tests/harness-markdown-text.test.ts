import { TextAttributes } from '@opentui/core';
import { describe, expect, it } from 'vitest';
import { inlineChunks, markdownChunks } from '../harness/ui/markdown-text.js';
import { PALETTE } from '../harness/theme.js';

/**
 * This module exists because `MarkdownRenderable` paints nothing in this
 * environment — every variant lays out and parses and then draws an empty frame,
 * which left the assistant's answer invisible in the TUI. So these cases assert
 * on the two things that matter: the text survives, and the constructs a coding
 * transcript contains come out styled.
 *
 * Flattening a chunk list back to text is the first assertion everywhere,
 * because losing characters is the failure mode that made the original bug so
 * hard to see.
 */

const textOf = (chunks: ReturnType<typeof markdownChunks>): string =>
  chunks.map((chunk) => chunk.text).join('');

const styleAt = (chunks: ReturnType<typeof markdownChunks>, needle: string) =>
  chunks.find((chunk) => chunk.text.includes(needle));

/** `RGBA.toInts()` — the chunk carries an RGBA, not the hex it was built from. */
const rgbOf = (hex: string): [number, number, number] => {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
};

const expectColour = (chunk: { fg?: { toInts(): [number, number, number, number] } } | undefined, hex: string): void => {
  const [r, g, b] = rgbOf(hex);
  expect(chunk?.fg?.toInts().slice(0, 3)).toEqual([r, g, b]);
};

describe('inlineChunks', () => {
  it('keeps the text and drops the markers', () => {
    expect(textOf(inlineChunks('plain text', PALETTE.text))).toBe('plain text');
    expect(textOf(inlineChunks('a **bold** word', PALETTE.text))).toBe('a bold word');
    expect(textOf(inlineChunks('some `code` here', PALETTE.text))).toBe('some code here');
  });

  it('marks the bold span bold, and only that span', () => {
    const chunks = inlineChunks('a **bold** word', PALETTE.text);
    expect(styleAt(chunks, 'bold')?.attributes).toBe(TextAttributes.BOLD);
    expect(styleAt(chunks, 'a ')?.attributes ?? 0).toBe(0);
  });

  it('colours inline code rather than leaving it as plain prose', () => {
    expectColour(styleAt(inlineChunks('run `npm test` now', PALETTE.text), 'npm test'), PALETTE.info);
  });

  it('leaves underscores alone, because they are almost always identifiers', () => {
    // `_` used to be an emphasis marker here, and it silently ate the
    // underscores out of `snake_case_name`. A construct that mangles real code
    // is not worth its coverage.
    expect(textOf(inlineChunks('uses snake_case_name here', PALETTE.text))).toBe('uses snake_case_name here');
    expect(textOf(inlineChunks('2 * 3 = 6', PALETTE.text))).toBe('2 * 3 = 6');
    expect(textOf(inlineChunks('a _leading underscore', PALETTE.text))).toBe('a _leading underscore');
  });

  it('emits an unmatched marker literally rather than swallowing it', () => {
    expect(textOf(inlineChunks('an **unclosed bold', PALETTE.text))).toBe('an unclosed bold');
    expect(textOf(inlineChunks('a lone `backtick', PALETTE.text))).toBe('a lone backtick');
  });

  it('marks a single-asterisk span italic, which used to never flip', () => {
    // The old rule required a non-space on both sides of `*`, which rejected
    // the opener (`*note` follows a space) and the closer (`note*` ends one) —
    // so prose emphasis rendered as literal asterisks.
    const chunks = inlineChunks('a *note* here', PALETTE.text);
    expect(textOf(chunks)).toBe('a note here');
    expect(styleAt(chunks, 'note')?.attributes).toBe(TextAttributes.ITALIC);
    expect(styleAt(chunks, 'here')?.attributes ?? 0).toBe(0);
  });

  it('leaves arithmetic asterisks literal in every spacing', () => {
    expect(textOf(inlineChunks('2 * 3 = 6', PALETTE.text))).toBe('2 * 3 = 6');
    expect(textOf(inlineChunks('a* b c', PALETTE.text))).toBe('a* b c');
    expect(styleAt(inlineChunks('2 * 3 = 6', PALETTE.text), '3')?.attributes ?? 0).toBe(0);
  });

  it('does not style emphasis markers inside inline code', () => {
    const chunks = markdownChunks('run `x **y*` now');
    expect(textOf(chunks)).toBe('run x **y* now');
    const body = chunks.find((chunk) => chunk.text.includes('**y'));
    expect(body?.attributes ?? 0).toBe(0);
  });
});

describe('markdownChunks', () => {
  it('reproduces the text with its line structure', () => {
    const source = 'first line\nsecond line\n\nfourth line';
    expect(textOf(markdownChunks(source))).toBe(source);
  });

  it('styles a heading and keeps its text', () => {
    const chunks = markdownChunks('# Title\n\nbody');
    expect(textOf(chunks)).toBe('Title\n\nbody');
    expect(styleAt(chunks, 'Title')?.attributes).toBe(TextAttributes.BOLD);
  });

  it('turns list markers into bullets without losing the item', () => {
    const chunks = markdownChunks('- one\n- two');
    expect(textOf(chunks)).toBe('• one\n• two');
  });

  it('keeps an ordered list numbered', () => {
    expect(textOf(markdownChunks('1. first\n2. second'))).toBe('1. first\n2. second');
  });

  it('hides fence markers but keeps the code', () => {
    const chunks = markdownChunks('before\n```ts\nconst x = 1;\n```\nafter');
    expect(textOf(chunks)).toBe('before\nconst x = 1;\nafter');
    expect(textOf(chunks)).not.toContain('```');
  });

  it('does not style a fence body as prose', () => {
    // `**` inside code is code, not emphasis.
    const chunks = markdownChunks('```\nx ** y\n```');
    expect(textOf(chunks)).toBe('x ** y');
  });

  it('marks a blockquote', () => {
    const chunks = markdownChunks('> a note');
    expect(textOf(chunks)).toBe('│ a note');
  });

  it('draws a horizontal rule as a rule, not as three dashes', () => {
    const chunks = markdownChunks('---', { columns: 30 });
    const text = textOf(chunks);
    expect(text).toContain('─');
    expect(text).not.toBe('---');
  });

  it('keeps a blank line blank, so paragraphs do not collapse together', () => {
    expect(textOf(markdownChunks('a\n\nb'))).toBe('a\n\nb');
  });

  it('handles an empty answer without producing stray chunks', () => {
    expect(textOf(markdownChunks(''))).toBe('');
  });

  it('survives a half-received line, which streaming guarantees will happen', () => {
    // Nothing here may throw: the block is re-rendered on every delta.
    for (const partial of ['**', '`', '#', '- ', '> ', '```', '1. ', 'a **b']) {
      expect(() => markdownChunks(partial)).not.toThrow();
      expect(typeof textOf(markdownChunks(partial))).toBe('string');
    }
  });

  it('colours with the palette rather than a hard-coded hex', () => {
    expectColour(styleAt(markdownChunks('# Title'), 'Title'), PALETTE.accent);
  });
});
