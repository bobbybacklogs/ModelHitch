/**
 * Per-tool-call cancellation.
 *
 * `bash` can hang forever (a child that waits on a pipe, a test that blocks on
 * a prompt), and a harness run has no other way to stop it: the tool loop
 * awaits the executor before it can advance a turn. So every tool call gets its
 * own `AbortController`, a budget, and a race so the loop moves on even when the
 * tool never settles.
 *
 * Two sources of cancellation share one controller:
 *   - the timeout, which aborts with reason `'timeout'`;
 *   - Ctrl-C, which aborts through `abortActive()` with reason `'interrupt'`.
 * The reason decides the message the model sees, so a timed-out call does not
 * read like a call the human killed.
 */

/** Default budget for one tool call, in ms. Overridable with `--tool-timeout`. */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/**
 * Parse `--tool-timeout`. `0` disables the timeout explicitly, anything
 * non-numeric or negative falls back to the default, mirroring the
 * `Number.isFinite(maxTurns)` guard the CLI already uses.
 */
export function parseToolTimeout(raw: string | undefined, fallback = DEFAULT_TOOL_TIMEOUT_MS): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

export interface ToolCanceller {
  /** Budget applied to each call. `0` means no timeout. */
  readonly timeoutMs: number;
  /** Name of the most recently started call, for the Ctrl-C banner. */
  readonly activeTool: string | undefined;
  /** How many calls are in flight. Read-only batches can have several. */
  readonly activeCount: number;
  /**
   * Run one tool call under a fresh controller. Never rejects: cancellation is
   * a value, produced by `onCancel`.
   *
   * Generic in the result type so this module stays about cancellation and
   * knows nothing about tool envelopes. `onCancel` receives the message the
   * model should read ("timed out after 30000ms" / "was interrupted before it
   * finished") and returns whatever shape the caller is collecting.
   */
  run<T>(name: string, fn: (signal: AbortSignal) => Promise<T>, onCancel: (message: string) => T): Promise<T>;
  /** Abort every in-flight call. Returns false when nothing was running. */
  abortActive(): boolean;
}

function abortMessage(name: string, timeoutMs: number, reason: unknown): string {
  if (reason === 'timeout') return `Error: ${name} timed out after ${timeoutMs}ms`;
  return `Error: ${name} was interrupted before it finished`;
}

export function createToolCanceller(timeoutMs: number = DEFAULT_TOOL_TIMEOUT_MS): ToolCanceller {
  // Keyed rather than a single slot: a read-only batch has several calls in
  // flight at once, and one Ctrl-C has to reach all of them. A single slot
  // would have let the last call to start overwrite the others, leaving them
  // running with no way to stop them.
  const active = new Map<number, { name: string; controller: AbortController }>();
  let nextId = 1;
  let lastStarted: number | undefined;

  return {
    timeoutMs,
    get activeTool(): string | undefined {
      return lastStarted === undefined ? undefined : active.get(lastStarted)?.name;
    },
    get activeCount(): number {
      return active.size;
    },
    async run<T>(
      name: string,
      fn: (signal: AbortSignal) => Promise<T>,
      onCancel: (message: string) => T,
    ): Promise<T> {
      const controller = new AbortController();
      const id = nextId++;
      active.set(id, { name, controller });
      lastStarted = id;

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              controller.abort('timeout');
            }, timeoutMs)
          : undefined;

      const cancelled = new Promise<T>((resolve) => {
        const settle = (): void =>
          resolve(onCancel(abortMessage(name, timeoutMs, controller.signal.reason)));
        if (controller.signal.aborted) {
          settle();
          return;
        }
        controller.signal.addEventListener('abort', settle, { once: true });
      });

      try {
        const work = fn(controller.signal);
        // We may return before the tool settles. Attaching a handler here keeps a
        // late rejection from surfacing as an unhandled rejection after the run
        // has already moved on.
        void work.catch(() => undefined);
        return await Promise.race([work, cancelled]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        active.delete(id);
        if (lastStarted === id) lastStarted = undefined;
      }
    },
    abortActive(): boolean {
      let aborted = false;
      for (const entry of active.values()) {
        if (entry.controller.signal.aborted) continue;
        entry.controller.abort('interrupt');
        aborted = true;
      }
      return aborted;
    },
  };
}
