import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_TIMEOUT_MS, createToolCanceller, parseToolTimeout } from '../harness/cancel.js';
import { formatGrepResult, grepWorkspace } from '../harness/grep.js';
import { executeHarnessTool } from '../harness/tools.js';
import { timeout } from '../harness/result.js';

/**
 * A tool that never returns is the one failure the loop cannot walk away from:
 * `runToolLoop` awaits the executor before it can advance a turn. So the budget,
 * the Ctrl-C path, and the interrupted-search bookkeeping all get pinned here.
 *
 * The canceller is generic in the result type — it knows nothing about tool
 * envelopes — so `asText` is the adapter these string-collecting cases use, and
 * the one real-tool case uses the same `timeout()` envelope `index.ts` does.
 */

const asText = (message: string): string => message;

const SANDBOX = resolve(__dirname, '.tmp-timeout-sandbox');
// Long enough to outlive the budget, short enough that a stray survivor exits on
// its own instead of holding the sandbox directory open for the whole suite.
const SLEEP = 'node -e "setTimeout(() => {}, 5000)"';

beforeAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  mkdirSync(join(SANDBOX, 'deep', 'deeper'), { recursive: true });
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(SANDBOX, 'deep', `f${i}.ts`), `const needle${i} = ${i};\n`);
  }
});

afterAll(async () => {
  // The killed `node` child releases its handle on the sandbox directory a
  // moment after the kill lands, and Windows refuses to remove a directory with
  // a live handle. Give it that moment, then retry.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe('parseToolTimeout', () => {
  it('defaults when the flag is absent or empty', () => {
    expect(parseToolTimeout(undefined)).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(parseToolTimeout('  ')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  it('accepts a real number and floors it', () => {
    expect(parseToolTimeout('2000')).toBe(2_000);
    expect(parseToolTimeout('1500.7')).toBe(1_500);
  });

  it('treats 0 as "no timeout", not as "fall back to the default"', () => {
    expect(parseToolTimeout('0')).toBe(0);
  });

  it('falls back on garbage and negatives, mirroring the maxTurns guard', () => {
    expect(parseToolTimeout('soon')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(parseToolTimeout('-5')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });
});

describe('createToolCanceller', () => {
  it('returns the result of a fast call untouched', async () => {
    const canceller = createToolCanceller(5_000);
    expect(await canceller.run('read', async () => 'done', asText)).toBe('done');
  });

  it('reports a timeout as a plain string the model can react to', async () => {
    const canceller = createToolCanceller(200);
    const started = Date.now();
    const out = await canceller.run('bash', async (signal) => {
      await new Promise<void>((resolveSleep) => {
        const timer = setTimeout(resolveSleep, 30_000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolveSleep();
        });
      });
      return 'never';
    }, asText);
    expect(out).toBe('Error: bash timed out after 200ms');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('does not wait for a tool that ignores its signal', async () => {
    const canceller = createToolCanceller(150);
    const out = await canceller.run('bash', async () => {
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 3_000));
      return 'late';
    }, asText);
    expect(out).toContain('timed out after 150ms');
  });

  it('reports Ctrl-C differently from a timeout', async () => {
    const canceller = createToolCanceller(30_000);
    const pending = canceller.run('bash', async (signal) => {
      await new Promise<void>((resolveSleep) => {
        signal.addEventListener('abort', () => resolveSleep());
      });
      return 'never';
    }, asText);
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(canceller.activeTool).toBe('bash');
    expect(canceller.abortActive()).toBe(true);
    expect(await pending).toBe('Error: bash was interrupted before it finished');
    // Nothing is running any more, so a second Ctrl-C has nothing to abort.
    expect(canceller.abortActive()).toBe(false);
  });

  it('treats a budget of 0 as no timeout at all', async () => {
    const canceller = createToolCanceller(0);
    const out = await canceller.run('read', async () => {
      await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 50));
      return 'slow but allowed';
    }, asText);
    expect(out).toBe('slow but allowed');
  });
});

describe('the budget reaches the real tool', () => {
  it('kills a hanging command and reports it as a timeout, not an error', async () => {
    const canceller = createToolCanceller(1_000);
    const started = Date.now();
    const out = await canceller.run(
      'bash',
      (signal) => executeHarnessTool('bash', { command: SLEEP }, { workspaceDir: SANDBOX, signal }),
      (message) => timeout(message),
    );
    expect(out.text).toBe('Error: bash timed out after 1000ms');
    // The whole point of the envelope: "it did not finish" is not "it broke".
    expect(out.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('refuses to start a tool whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort('interrupt');
    const out = await executeHarnessTool(
      'bash',
      { command: 'echo should-not-run' },
      { workspaceDir: SANDBOX, signal: controller.signal },
    );
    expect(out.text).toContain('cancelled before it started');
    expect(out.outcome).toBe('timeout');
  });
});

describe('an aborted grep is not a completed grep', () => {
  it('marks the result aborted and truncated, and says so in the text', () => {
    const controller = new AbortController();
    controller.abort('interrupt');
    const result = grepWorkspace({ pattern: 'needle', dir: SANDBOX, signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(result.truncated).toBe(true);
    const text = formatGrepResult(result, 'needle');
    expect(text).toContain('cancelled');
    expect(text).not.toMatch(/results truncated/);
  });

  it('leaves a completed search unmarked', () => {
    const result = grepWorkspace({ pattern: 'needle9', dir: SANDBOX });
    expect(result.aborted).toBeUndefined();
    expect(result.matches.length).toBe(1);
    expect(formatGrepResult(result, 'needle9')).not.toContain('cancelled');
  });
});
