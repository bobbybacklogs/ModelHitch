import { describe, expect, it } from 'vitest';
import {
  clip,
  clipEnd,
  diffStat,
  diffWindow,
  displayPath,
  formatClock,
  formatCount,
  formatDiffStat,
  formatDuration,
  headTail,
  looksLikeDiff,
  strWidth,
  toolArgsSummary,
  toolLabel,
} from '../harness/format.js';

describe('strWidth', () => {
  it('counts plain ASCII as one column each', () => {
    expect(strWidth('hello')).toBe(5);
    expect(strWidth('')).toBe(0);
  });

  it('counts wide glyphs as two columns', () => {
    expect(strWidth('日本語')).toBe(6);
    expect(strWidth('aあb')).toBe(4);
  });
});

describe('clip', () => {
  it('leaves short text alone', () => {
    expect(clip('abc', 10)).toBe('abc');
    expect(clip('abc', 3)).toBe('abc');
  });

  it('marks a cut with an ellipsis inside the budget', () => {
    const cut = clip('abcdefghij', 5);
    expect(cut.endsWith('…')).toBe(true);
    expect(strWidth(cut)).toBeLessThanOrEqual(5);
  });

  it('degrades to a bare ellipsis when there is no room', () => {
    expect(clip('abcdef', 1)).toBe('…');
    expect(clip('abcdef', 0)).toBe('');
  });

  it('respects wide glyphs when cutting', () => {
    const cut = clip('日本語です', 5);
    expect(strWidth(cut)).toBeLessThanOrEqual(5);
  });
});

describe('clipEnd', () => {
  it('keeps the deepest tail, which is where a path or an error code lives', () => {
    const cut = clipEnd('a/very/long/path/file.ts', 12);
    expect(strWidth(cut)).toBe(12);
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.endsWith('file.ts')).toBe(true);
  });

  it('leaves short text alone', () => {
    expect(clipEnd('short', 20)).toBe('short');
  });
});

describe('headTail', () => {
  it('keeps both ends of a long result and counts the gap', () => {
    const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
    const { text: clipped, dropped } = headTail(text, 5);
    expect(dropped).toBe(15);
    expect(clipped).toContain('line 0');
    expect(clipped).toContain('line 19');
    expect(clipped).toContain('… 15 lines omitted …');
    expect(clipped.split('\n').length).toBe(5);
  });

  it('passes short text through untouched', () => {
    expect(headTail('a\nb', 5)).toEqual({ text: 'a\nb', dropped: 0 });
  });
});

describe('formatCount', () => {
  it('shortens thousands and millions', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1_234)).toBe('1.2k');
    expect(formatCount(42_000)).toBe('42k');
    expect(formatCount(2_400_000)).toBe('2.4M');
  });
});

describe('formatDuration', () => {
  it('picks a unit that fits the magnitude', () => {
    expect(formatDuration(820)).toBe('820ms');
    expect(formatDuration(4_200)).toBe('4.2s');
    expect(formatDuration(125_000)).toBe('2m05s');
    expect(formatDuration(3_600_000)).toBe('1h00m');
  });
});

describe('formatClock', () => {
  it('renders a ticking clock', () => {
    expect(formatClock(4_000)).toBe('0:04');
    expect(formatClock(62_000)).toBe('1:02');
    expect(formatClock(3_750_000)).toBe('1:02:30');
  });
});

describe('displayPath', () => {
  it('makes a path workspace-relative', () => {
    expect(displayPath('C:\\work\\project\\src\\app.ts', 'C:\\work\\project')).toBe('src/app.ts');
    expect(displayPath('/home/dev/proj/a.ts', '/home/dev/proj')).toBe('a.ts');
  });

  it('leaves a path outside the workspace absolute', () => {
    expect(displayPath('/etc/hosts', '/home/dev/proj')).toBe('/etc/hosts');
  });
});

describe('looksLikeDiff', () => {
  it('accepts the shape unifiedDiff emits', () => {
    expect(looksLikeDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,4 @@\n a\n+b')).toBe(true);
  });

  it('rejects prose that merely mentions a change', () => {
    expect(looksLikeDiff('Wrote x.ts (12 chars)')).toBe(false);
    expect(looksLikeDiff('@@ -1,2 +1,3 @@\n only a hunk header')).toBe(false);
    expect(looksLikeDiff('--- a/x.ts\n+++ b/x.ts\n but no hunk')).toBe(false);
  });
});

describe('diffStat', () => {
  it('counts body lines and ignores the file headers', () => {
    const stat = diffStat('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra');
    expect(stat).toEqual({ added: 2, removed: 1 });
  });

  it('formats as a compact badge', () => {
    expect(formatDiffStat({ added: 12, removed: 3 })).toBe('+12 -3');
    expect(formatDiffStat({ added: 0, removed: 0 })).toBe('');
  });
});

describe('diffWindow', () => {
  const hunk = (start: number, added: boolean): string[] => [
    `@@ -${start},3 +${start},3 @@`,
    ' context one',
    added ? '+added' : '-removed',
    ' context two',
  ];
  const diff = ['--- a/x.ts', '+++ b/x.ts', ...hunk(1, true), ...hunk(20, false), ...hunk(40, true)].join('\n');

  it('keeps a diff whole when it fits, so the viewer can parse it', () => {
    const window = diffWindow(diff, 100);
    expect(window.kept).toBe(3);
    expect(window.total).toBe(3);
    expect(window.text).toBe(diff);
    expect(window.tooLarge).toBe(false);
  });

  it('cuts between hunks rather than mid-hunk, which would be unparseable', () => {
    const window = diffWindow(diff, 10);
    // Two header lines plus two whole hunks of four lines each.
    expect(window.kept).toBe(2);
    expect(window.total).toBe(3);
    expect(window.text).toContain('--- a/x.ts');
    expect(window.text.endsWith(' context two')).toBe(true);
    // Every hunk header that survives has its full body with it.
    const lines = window.text.split('\n');
    const starts = lines.map((line, index) => (line.startsWith('@@') ? index : -1)).filter((index) => index >= 0);
    for (const start of starts) expect(lines[start + 3]).toBe(' context two');
  });

  it('flags a diff whose first hunk alone does not fit', () => {
    const window = diffWindow(diff, 4);
    expect(window.tooLarge).toBe(true);
    expect(window.kept).toBe(0);
    expect(window.text).toBe(diff);
  });

  it('passes text with no hunks through as not-a-diff', () => {
    const window = diffWindow('just some text', 10);
    expect(window.total).toBe(0);
    expect(window.tooLarge).toBe(false);
    expect(window.text).toBe('just some text');
  });
});

describe('toolArgsSummary', () => {
  it('picks the informative argument per tool', () => {
    expect(toolArgsSummary('read', { path: 'src/app.ts' })).toBe('src/app.ts');
    expect(toolArgsSummary('read', { path: 'src/app.ts', offset: 10, limit: 20 })).toBe('src/app.ts:10+20');
    expect(toolArgsSummary('bash', { command: 'npm test' })).toBe('npm test');
    expect(toolArgsSummary('edit', { path: 'a.ts', oldString: 'x', newString: 'y' })).toBe('a.ts');
    expect(toolArgsSummary('write', { path: 'a.ts', content: '1\n2\n3' })).toBe('a.ts  3 lines');
    expect(toolArgsSummary('gh', { args: ['pr', 'view', '12'] })).toBe('gh pr view 12');
  });

  it('collapses whitespace in a command so a header stays one line', () => {
    expect(toolArgsSummary('bash', { command: 'npm run\n  build' })).toBe('npm run build');
  });

  it('describes a delegation by agent and a clipped task', () => {
    const summary = toolArgsSummary('subagent', { agent: 'Scout', task: 'x'.repeat(200) });
    expect(summary.startsWith('Scout — ')).toBe(true);
    expect(summary.length).toBeLessThan(120);
  });

  it('falls back to key=value for an unknown tool', () => {
    expect(toolArgsSummary('mystery', { a: 1, b: 'two' })).toBe('a=1 b=two');
    expect(toolArgsSummary('mystery', {})).toBe('');
  });
});

describe('toolLabel', () => {
  it('turns a tool id into a readable label', () => {
    expect(toolLabel('read')).toBe('Read');
    expect(toolLabel('grep_search')).toBe('Grep search');
    expect(toolLabel('find_subagent')).toBe('Find subagent');
  });
});
