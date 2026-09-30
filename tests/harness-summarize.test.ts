import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_SUMMARIZE_THRESHOLD,
  SUMMARIZE_EXEMPT_TOOLS,
  parseSummarizeThreshold,
  resetSummarizeState,
  summarizeToolOutput,
} from '../harness/summarize.js';

/**
 * Tool output lands in `messages` and stays there for the rest of the run, so
 * one grep over a big tree can cost more context than the task. These tests pin
 * the parts that must not be summarized, and the fallback that keeps a failed
 * digest from dropping the output entirely.
 */

const SHORT = 'a short result';
const LONG = `head-marker\n${'x'.repeat(9_000)}\ntail-marker`;

beforeEach(() => {
  resetSummarizeState();
});

describe('parseSummarizeThreshold', () => {
  it('defaults when absent and on garbage', () => {
    expect(parseSummarizeThreshold(undefined)).toBe(DEFAULT_SUMMARIZE_THRESHOLD);
    expect(parseSummarizeThreshold('later')).toBe(DEFAULT_SUMMARIZE_THRESHOLD);
  });

  it('keeps 0 as a real value, because 0 means disabled', () => {
    expect(parseSummarizeThreshold('0')).toBe(0);
  });

  it('accepts a number', () => {
    expect(parseSummarizeThreshold('1500')).toBe(1_500);
  });
});

describe('summarizeToolOutput', () => {
  it('returns short output untouched', async () => {
    const out = await summarizeToolOutput(SHORT, { tool: 'grep_search', threshold: 8_000 });
    expect(out).toBe(SHORT);
  });

  it('returns anything untouched when the threshold is 0', async () => {
    const out = await summarizeToolOutput(LONG, {
      tool: 'grep_search',
      threshold: 0,
      deps: { digest: async () => 'should not be called' },
    });
    expect(out).toBe(LONG);
  });

  it('returns anything untouched when summarization is switched off', async () => {
    const out = await summarizeToolOutput(LONG, { tool: 'grep_search', threshold: 8_000, enabled: false });
    expect(out).toBe(LONG);
  });

  it('never summarizes a failure, so the model can still read it', async () => {
    const failure = `Error: ${'y'.repeat(9_000)}`;
    const out = await summarizeToolOutput(failure, {
      tool: 'bash',
      threshold: 1_000,
      deps: { digest: async () => 'nope' },
    });
    expect(out).toBe(failure);
  });

  it('exempts whole-file reads', async () => {
    expect(SUMMARIZE_EXEMPT_TOOLS).toContain('read');
    const out = await summarizeToolOutput(LONG, {
      tool: 'read',
      threshold: 1_000,
      deps: { digest: async () => 'nope' },
    });
    expect(out).toBe(LONG);
  });

  it('keeps the head and tail verbatim, labels the change, and includes the digest', async () => {
    const out = await summarizeToolOutput(LONG, {
      tool: 'grep_search',
      threshold: 1_000,
      deps: { digest: async () => 'DIGEST TEXT' },
    });
    expect(out.startsWith('head-marker\n')).toBe(true);
    expect(out.endsWith('tail-marker')).toBe(true);
    expect(out).toContain('DIGEST TEXT');
    expect(out).toMatch(/\[summarized: \d+ chars -> \d+\]/);
    expect(out.length).toBeLessThan(LONG.length);
  });

  it('falls back to plain head/tail truncation when the digest throws', async () => {
    const warnings: string[] = [];
    const out = await summarizeToolOutput(LONG, {
      tool: 'grep_search',
      threshold: 1_000,
      deps: {
        digest: async () => {
          throw new Error('provider down');
        },
        log: (message) => warnings.push(message),
      },
    });
    expect(out).toContain('head-marker');
    expect(out).toContain('tail-marker');
    expect(out).toContain('[summarized:');
    expect(warnings.join(' ')).toContain('digest failed');
  });

  it('works with no digest function at all', async () => {
    const out = await summarizeToolOutput(LONG, { tool: 'grep_search', threshold: 1_000 });
    expect(out).toContain('head-marker');
    expect(out).toContain('tail-marker');
  });

  it('dedupes identical repeated output instead of summarizing twice', async () => {
    let calls = 0;
    const deps = {
      digest: async (): Promise<string> => {
        calls++;
        return 'once';
      },
    };
    const first = await summarizeToolOutput(LONG, { tool: 'grep_search', threshold: 1_000, deps });
    const second = await summarizeToolOutput(LONG, { tool: 'grep_search', threshold: 1_000, deps });
    expect(calls).toBe(1);
    expect(second).toBe(first);
  });

  it('warns once per process when the digest keeps failing', async () => {
    const warnings: string[] = [];
    const deps = {
      digest: async (): Promise<string> => {
        throw new Error('down');
      },
      log: (message: string): void => void warnings.push(message),
    };
    await summarizeToolOutput(`${LONG}one`, { tool: 'grep_search', threshold: 1_000, deps });
    await summarizeToolOutput(`${LONG}two`, { tool: 'grep_search', threshold: 1_000, deps });
    expect(warnings.length).toBe(1);
  });
});
