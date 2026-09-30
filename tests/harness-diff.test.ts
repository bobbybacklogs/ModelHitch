import { describe, expect, it } from 'vitest';
import { DIFF_MAX_BYTES, unifiedDiff } from '../harness/diff.js';

describe('unifiedDiff', () => {
  it('returns nothing for identical text', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n')).toBe('');
    expect(unifiedDiff('', '')).toBe('');
  });

  it('marks a new file with /dev/null', () => {
    const diff = unifiedDiff('', 'one\ntwo\n', { path: 'new.txt' });
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/new.txt');
    expect(diff).toContain('+one');
    expect(diff).toContain('+two');
  });

  it('marks a deleted file with /dev/null', () => {
    expect(unifiedDiff('gone\n', '', { path: 'old.txt' })).toContain('+++ /dev/null');
  });

  it('shows a one-line change with context', () => {
    const before = 'keep1\nkeep2\nold line\nkeep3\nkeep4\n';
    const after = 'keep1\nkeep2\nnew line\nkeep3\nkeep4\n';
    const diff = unifiedDiff(before, after, { path: 'x.ts' });
    expect(diff).toContain('-old line');
    expect(diff).toContain('+new line');
    expect(diff).toContain(' keep2');
    expect(diff).toContain(' keep3');
    // The hunk header counts the lines a patch would need.
    expect(diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
  });

  it('counts line numbers from the first changed hunk, not from one', () => {
    const before = Array.from({ length: 40 }, (_v, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 30', 'line 30 changed');
    const diff = unifiedDiff(before, after, { path: 'x.ts' });
    const header = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(diff);
    expect(header).not.toBeNull();
    // 30 changed lines minus 3 of context means the hunk starts at 27.
    expect(Number(header?.[1])).toBe(27);
  });

  it('reports an oversized comparison instead of a meaningless wall of lines', () => {
    const before = Array.from({ length: 2_000 }, (_v, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 2_000 }, (_v, i) => `b${i}`).join('\n');
    const diff = unifiedDiff(before, after);
    expect(diff).toContain('[diff skipped');
  });

  it('truncates an output that exceeds maxLines', () => {
    const before = Array.from({ length: 500 }, (_v, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 500 }, (_v, i) => `b${i}`).join('\n');
    const diff = unifiedDiff(before, after, { maxLines: 20, maxMiddleLines: 5_000 });
    expect(diff).toContain('diff truncated at 20 lines');
  });

  it('keeps the large-file limit available to callers', () => {
    expect(DIFF_MAX_BYTES).toBe(1_000_000);
  });
});
