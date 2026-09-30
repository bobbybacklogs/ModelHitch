/**
 * Running a turn's tool calls concurrently — but only the ones that can't hurt.
 *
 * A model that wants to read six files emits six calls, and the loop ran them
 * one after another for no reason: they touch nothing, so their only shared
 * resource is the network and the disk read cache. Mutating calls are the
 * opposite — two writes to the same file in parallel is a race, and an approval
 * prompt appearing while other work is in flight is a prompt answered by
 * accident.
 *
 * So a batch is split, not scheduled:
 *
 *   1. every read-only call runs first, with a bounded concurrency;
 *   2. then the mutating calls run strictly one at a time, in the order the
 *      model asked for them.
 *
 * Read-only work therefore never overlaps a prompt. That ordering is the reason
 * this is a partition rather than a priority queue: a queue would let a mutating
 * call start while readers were still in flight, which is the case worth
 * ruling out entirely.
 *
 * Results come back in the *original* call order regardless of completion
 * order, so a run's transcript is the same whether the calls were fast or slow.
 */

/** Classifies one call. `approval.ts`'s `isMutatingToolCall` is the authority. */
export type MutatingPredicate = (name: string, args: Record<string, unknown>) => boolean;

/**
 * Read-only calls allowed in flight at once.
 *
 * Four is where the returns flatten out: past it the calls are usually waiting
 * on the same disk or the same provider, and the cost is more concurrent
 * handles and a noisier failure story.
 */
export const DEFAULT_TOOL_CONCURRENCY = 4;

export interface BatchCall {
  name: string;
  args: Record<string, unknown>;
}

export interface BatchOptions {
  concurrency?: number;
  isMutating?: MutatingPredicate;
  /** Called when a read-only group starts, for a UI that wants to say so. */
  onGroup?: (group: 'read-only' | 'mutating', size: number) => void;
}

/**
 * Run `calls` and return one result per call, in input order.
 *
 * `run` is expected to resolve to a result string for every call and never to
 * reject — the harness's executor turns failures into strings so the model can
 * read them. A rejection is still caught here, because one broken read must not
 * take its siblings down with it.
 */
export async function runToolBatch(
  calls: readonly BatchCall[],
  run: (call: BatchCall, index: number) => Promise<string>,
  options: BatchOptions = {},
): Promise<string[]> {
  const results = new Array<string>(calls.length).fill('');
  if (calls.length === 0) return results;

  const isMutating = options.isMutating ?? ((): boolean => false);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_TOOL_CONCURRENCY));

  const readOnly: number[] = [];
  const mutating: number[] = [];
  calls.forEach((call, index) => {
    (isMutating(call.name, call.args) ? mutating : readOnly).push(index);
  });

  /** Run one index, capturing a throw as that call's result rather than the batch's. */
  const one = async (index: number): Promise<void> => {
    const call = calls[index] as BatchCall;
    try {
      results[index] = await run(call, index);
    } catch (err) {
      results[index] = `Error: ${call.name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  if (readOnly.length > 0) {
    options.onGroup?.('read-only', readOnly.length);
    // A fixed-size worker pool: `concurrency` workers pull from the queue until
    // it drains, which keeps the in-flight count bounded without a scheduler.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, readOnly.length) }, async () => {
      for (;;) {
        const next = cursor++;
        const index = readOnly[next];
        if (index === undefined) return;
        await one(index);
      }
    });
    await Promise.all(workers);
  }

  if (mutating.length > 0) {
    options.onGroup?.('mutating', mutating.length);
    for (const index of mutating) {
      // Serial by construction: the loop awaits each call before starting the
      // next, so an approval prompt can never overlap another call.
      await one(index);
    }
  }

  return results;
}
