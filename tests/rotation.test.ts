import { describe, expect, it } from 'vitest';
import { detectRotatedLanes, suggestReplacement } from '../src/index.js';

/**
 * Rotation detection for configured lanes.
 *
 * Providers retire model ids constantly — version bumps are the common shape
 * (`mimo-v2.5-free` → `mimo-v2.6-free`) — and a bridge configured with the old
 * id keeps failing on that lane behind the user's back. These tests pin the
 * two halves of the answer: when a lane counts as rotated, and how a
 * replacement is picked (same family first, deterministic otherwise).
 */

describe('detectRotatedLanes', () => {
  it('does not flag a lane whose model id is still served', () => {
    const rotated = detectRotatedLanes(
      [{ providerId: 'zen', model: 'kimi-k2.6' }],
      new Map([['zen', ['kimi-k2.6', 'glm-5.1']]]),
    );
    expect(rotated).toEqual([]);
  });

  it('flags a lane whose model id is gone, with the provider list and a suggestion', () => {
    const rotated = detectRotatedLanes(
      [{ providerId: 'zen', model: 'mimo-v2.5-free' }],
      new Map([['zen', ['mimo-v2.6-free', 'kimi-k2.6']]]),
    );
    expect(rotated).toEqual([
      {
        providerId: 'zen',
        model: 'mimo-v2.5-free',
        available: ['mimo-v2.6-free', 'kimi-k2.6'],
        suggestion: 'mimo-v2.6-free',
      },
    ]);
  });

  it('skips lanes on a provider with no known list — transport failure means unknown, not rotated', () => {
    const rotated = detectRotatedLanes(
      [
        { providerId: 'zen', model: 'mimo-v2.5-free' },
        { providerId: 'gone', model: 'anything' },
        { providerId: 'gone', model: 'other' },
      ],
      new Map([['zen', ['kimi-k2.6']]]),
    );
    // Only the lane on the provider whose list is known can be judged at all.
    expect(rotated.map((lane) => lane.providerId)).toEqual(['zen']);
  });

  it('ignores lanes that name no model and dedupes the configured set', () => {
    const rotated = detectRotatedLanes(
      [
        { providerId: 'zen', model: 'kimi-k2.6' },
        { providerId: 'zen', model: 'kimi-k2.6' },
        { providerId: 'zen', model: '' },
        { providerId: '', model: 'kimi-k2.6' },
      ],
      new Map([['zen', ['glm-5.1']]]),
    );
    expect(rotated).toEqual([
      { providerId: 'zen', model: 'kimi-k2.6', available: ['glm-5.1'], suggestion: undefined },
    ]);
  });
});

describe('suggestReplacement', () => {
  it('prefers the longest same-family token overlap — a version bump beats a loose cousin', () => {
    expect(suggestReplacement('gpt-5-mini', ['gpt-5', 'gpt-5-mini-free'])).toBe('gpt-5-mini-free');
  });

  it('never suggests the input itself', () => {
    expect(suggestReplacement('foo-v2', ['foo-v2', 'bar-v2'])).toBeUndefined();
  });

  it('returns undefined when no candidate shares the first token', () => {
    expect(suggestReplacement('kimi-k2.6', ['glm-5.1', 'deepseek-v4-pro'])).toBeUndefined();
  });

  it('breaks score ties by shorter id, then alphabetically, deterministically', () => {
    // 'kimi-k2.6' and 'kimi-notes' both share only the 'kimi' token; the same
    // score resolves by shorter id — not by list order.
    expect(suggestReplacement('kimi-k2.5', ['kimi-notes', 'kimi-k2.6'])).toBe('kimi-k2.6');
    expect(suggestReplacement('kimi-k2.5', ['kimi-k2.6', 'kimi-notes'])).toBe('kimi-k2.6');
    // Equal ids too: alphabetical decides — the result is stable either way.
    const equal = ['kimi-twin-a', 'kimi-twin-b'];
    expect(suggestReplacement('kimi-old', equal.reverse())).toBe(suggestReplacement('kimi-old', equal));
  });
});
