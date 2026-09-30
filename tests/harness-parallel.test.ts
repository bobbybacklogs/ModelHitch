import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_CONCURRENCY, runToolBatch, type BatchCall } from '../harness/batch.js';
import { createToolCanceller } from '../harness/cancel.js';
import { isMutatingToolCall } from '../harness/approval.js';

/**
 * A turn's read-only calls may overlap; its mutating calls may not, and an
 * approval prompt must never land while other work is in flight.
 *
 * The tests below are mostly about order rather than speed: a parallel run whose
 * transcript comes out differently from the serial one is not a faster run, it
 * is a different run, and a session saved from it cannot be replayed.
 */

const NO_MUTATION = (): boolean => false;

/** Records when each call starts and ends, so overlap is measurable. */
function trace(): {
  events: string[];
  run: (call: BatchCall, index: number) => Promise<string>;
  release: (name: string) => void;
  gate: Map<string, () => void>;
} {
  const events: string[] = [];
  const gate = new Map<string, () => void>();
  return {
    events,
    gate,
    release: (name: string) => gate.get(name)?.(),
    run: async (call: BatchCall, index: number): Promise<string> => {
      events.push(`start:${call.name}:${index}`);
      await new Promise<void>((resolve) => {
        gate.set(call.name, resolve);
        // A short fallback so a test that forgets to release still finishes.
        setTimeout(resolve, 200);
      });
      events.push(`end:${call.name}:${index}`);
      return `result:${call.name}`;
    },
  };
}

const call = (name: string): BatchCall => ({ name, args: {} });

describe('runToolBatch', () => {
  it('returns one result per call, in the original order', async () => {
    const calls = [call('read'), call('grep_search'), call('read')];
    const results = await runToolBatch(calls, async (item) => `result:${item.name}`, {
      isMutating: NO_MUTATION,
    });
    expect(results).toEqual(['result:read', 'result:grep_search', 'result:read']);
  });

  it('returns results in call order even when they complete out of order', async () => {
    const completion: number[] = [];
    const results = await runToolBatch(
      [call('a'), call('b'), call('c')],
      async (_item, index) => {
        // The later the call, the sooner it finishes.
        await new Promise((resolve) => setTimeout(resolve, (3 - index) * 10));
        completion.push(index);
        return `result:${index}`;
      },
      { isMutating: NO_MUTATION },
    );
    // Completion order really was reversed…
    expect(completion).toEqual([2, 1, 0]);
    // …and the results are still in call order.
    expect(results).toEqual(['result:0', 'result:1', 'result:2']);
  });

  it('overlaps read-only calls up to the concurrency cap', async () => {
    const t = trace();
    const calls = [call('a'), call('b'), call('c'), call('d')];
    const pending = runToolBatch(calls, t.run, { isMutating: NO_MUTATION, concurrency: 2 });
    // Give the workers a tick to claim their slots.
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Two started, two are still queued behind the cap.
    expect(t.events.filter((event) => event.startsWith('start:'))).toHaveLength(2);
    t.release('a');
    t.release('b');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.events.filter((event) => event.startsWith('start:'))).toHaveLength(4);
    t.release('c');
    t.release('d');
    await pending;
    expect(await pending).toHaveLength(4);
  });

  it('never overlaps mutating calls, whatever the cap says', async () => {
    const t = trace();
    const calls = [call('write'), call('edit'), call('bash')];
    const pending = runToolBatch(calls, t.run, {
      isMutating: () => true,
      concurrency: 8,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Exactly one mutating call is in flight, and it is the first one asked for.
    expect(t.events).toEqual(['start:write:0']);

    t.release('write');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.events).toEqual(['start:write:0', 'end:write:0', 'start:edit:1']);

    t.release('edit');
    await new Promise((resolve) => setTimeout(resolve, 20));
    t.release('bash');
    await pending;
    expect(t.events).toEqual([
      'start:write:0',
      'end:write:0',
      'start:edit:1',
      'end:edit:1',
      'start:bash:2',
      'end:bash:2',
    ]);
  });

  it('finishes every read-only call before the first mutating one starts', async () => {
    const t = trace();
    const calls = [call('read'), call('write'), call('grep_search')];
    const pending = runToolBatch(calls, t.run, { isMutating: isMutatingToolCall, concurrency: 4 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Both read-only calls are in flight; the write has not started, so no
    // approval prompt can appear while reads are outstanding.
    expect(t.events).toContain('start:read:0');
    expect(t.events).toContain('start:grep_search:2');
    expect(t.events).not.toContain('start:write:1');

    t.release('read');
    t.release('grep_search');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.events).toContain('start:write:1');
    t.release('write');
    await pending;
  });

  it('confines a failing call to its own result', async () => {
    const results = await runToolBatch(
      [call('read'), call('grep_search'), call('read')],
      async (item, index) => {
        if (index === 1) throw new Error('regex is invalid');
        return `ok:${item.name}`;
      },
      { isMutating: NO_MUTATION },
    );
    expect(results[0]).toBe('ok:read');
    expect(results[2]).toBe('ok:read');
    expect(results[1]).toContain('Error: grep_search failed: regex is invalid');
  });

  it('handles an empty batch and a single call without ceremony', async () => {
    expect(await runToolBatch([], async () => 'never', { isMutating: NO_MUTATION })).toEqual([]);
    const one = await runToolBatch([call('read')], async () => 'only', { isMutating: NO_MUTATION });
    expect(one).toEqual(['only']);
  });

  it('treats a non-positive or fractional cap as one, not as zero workers', async () => {
    for (const concurrency of [0, -3, 0.4]) {
      const results = await runToolBatch([call('a'), call('b')], async (item) => item.name, {
        isMutating: NO_MUTATION,
        concurrency,
      });
      expect(results).toEqual(['a', 'b']);
    }
  });

  it('announces each group, so a UI can say what is happening', async () => {
    const groups: string[] = [];
    await runToolBatch([call('read'), call('grep_search'), call('write')], async () => 'x', {
      isMutating: isMutatingToolCall,
      onGroup: (group, size) => groups.push(`${group}:${size}`),
    });
    expect(groups).toEqual(['read-only:2', 'mutating:1']);
  });

  it('defaults to a documented cap', () => {
    expect(DEFAULT_TOOL_CONCURRENCY).toBe(4);
  });
});

describe('the canceller under a batch', () => {
  it('aborts every in-flight call, not just the last one to start', async () => {
    const canceller = createToolCanceller(30_000);
    const aborted: string[] = [];
    const hold = async (name: string, signal: AbortSignal): Promise<string> => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          aborted.push(name);
          resolve();
        });
      });
      return `never:${name}`;
    };
    const first = canceller.run('read', (signal) => hold('read', signal), (message) => message);
    const second = canceller.run('grep_search', (signal) => hold('grep_search', signal), (message) => message);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(canceller.activeCount).toBe(2);
    expect(canceller.abortActive()).toBe(true);
    expect(await first).toContain('read was interrupted');
    expect(await second).toContain('grep_search was interrupted');
    // Both were reached — the whole point of keying the registry rather than
    // holding one slot.
    expect(aborted.sort()).toEqual(['grep_search', 'read']);
    expect(canceller.activeCount).toBe(0);
  });

  it('reports the most recently started call as activeTool', async () => {
    const canceller = createToolCanceller(30_000);
    const pending = canceller.run(
      'read',
      async (signal) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        return 'x';
      },
      (message) => message,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(canceller.activeTool).toBe('read');
    canceller.abortActive();
    await pending;
    expect(canceller.activeTool).toBeUndefined();
  });
});
