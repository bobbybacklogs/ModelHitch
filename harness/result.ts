/**
 * What a tool call produced.
 *
 * The harness used to communicate a call's outcome only through the text of its
 * result, so every consumer guessed: `classifyToolResult` looked for an
 * `Error:` prefix, an `Exit <n>:` prefix, a "timed out" substring, and the
 * decline message. That works until a tool legitimately prints the word it is
 * being matched on, and it cannot express a call that succeeded but was cut
 * short, which is exactly what a truncated `grep_search` is.
 *
 * `executeHarnessTool` now returns an explicit envelope. Two things follow:
 *
 *   1. The text is still the text. `result.text` is byte-for-byte what goes
 *      into the model's message, so `session.ts`, the `done` event, and the
 *      transcript are unchanged by this.
 *   2. `outcomeFromText` stays, because the `tool` event on the wire carries
 *      only `output: string` (it is a core `ToolLoopEvent`, and the harness
 *      does not get to widen it). Renderers use the fallback; the harness
 *      itself uses the envelope.
 */

/**
 * `truncated` is a success that was cut short — a capped match list, a clipped
 * command output. It is deliberately not a failure: the model still got a
 * usable answer. `timeout` covers every abort, including Ctrl-C, because from
 * the model's side "this did not finish" is the only distinction that matters.
 */
export type ToolOutcome = 'ok' | 'error' | 'timeout' | 'truncated' | 'declined' | 'dry-run';

export interface ToolResult {
  /** Exactly what goes into the model's message. Never empty. */
  text: string;
  outcome: ToolOutcome;
  /**
   * Context for the UI that is *not* sent to the model: "the listing was a
   * sample", "the snapshot could not capture this path". Keeping it out of
   * `text` is the point — the model should not be billed for a UI concern.
   */
  note?: string;
}

const wrap = (outcome: ToolOutcome, text: string, note?: string): ToolResult =>
  note === undefined ? { text, outcome } : { text, outcome, note };

/** The call did what it said it would. */
export const ok = (text: string, note?: string): ToolResult => wrap('ok', text, note);

/** The call failed. `text` must already start with `Error:` for the fallback. */
export const error = (text: string, note?: string): ToolResult => wrap('error', text, note);

/** The call did not finish: a budget expired, or the human interrupted it. */
export const timeout = (text: string, note?: string): ToolResult => wrap('timeout', text, note);

/** The call succeeded but its result is a sample, not the whole answer. */
export const truncated = (text: string, note?: string): ToolResult => wrap('truncated', text, note);

/** The human said no. Distinct from `error` on purpose: the tool did not fail,
 * and telling the model its tool broke would send it chasing a phantom bug. */
export const declined = (text: string, note?: string): ToolResult => wrap('declined', text, note);

/** Nothing was changed because the call was asked not to change anything. */
export const dryRun = (text: string, note?: string): ToolResult => wrap('dry-run', text, note);

/**
 * Read an outcome back out of a result's text.
 *
 * This is the fallback, not the preferred path: it exists for a caller that
 * legitimately only has a string — a subagent result from `subagents.execute`,
 * a value crossing the `tool` event, a stored transcript being replayed.
 */
export function outcomeFromText(text: string): ToolOutcome {
  const head = text.trimStart();
  if (head.startsWith('Declined by user')) return 'declined';
  // The cancellation form `cancel.ts` writes. Checked before the generic
  // `Error:` case, which would otherwise claim it.
  if (/^Error: .*timed out after \d+ms/m.test(head)) return 'timeout';
  if (/^Error: .*was interrupted before it finished/m.test(head)) return 'timeout';
  if (head.startsWith('Error:')) return 'error';
  // A shell command that exited non-zero did not succeed, however the model
  // chooses to interpret it. `Exit 0` never reaches here.
  if (/^Exit [1-9]\d*:/.test(head)) return 'error';
  if (/^! opencode error/.test(head)) return 'error';
  // A capped or clipped result says so in its own text; see `grep.ts`.
  if (/\(results truncated/.test(head) || /before the search was cancelled/.test(head)) return 'truncated';
  return 'ok';
}

/** Build an envelope from a bare string, classifying it through the fallback. */
export function resultFromText(text: string, note?: string): ToolResult {
  return wrap(outcomeFromText(text), text, note);
}

/** Outcomes the UI should open by default, and colour as a problem. */
export function isFailure(outcome: ToolOutcome): boolean {
  return outcome === 'error' || outcome === 'timeout';
}

/** One word for a badge. Kept here so every renderer spells them the same. */
export function outcomeLabel(outcome: ToolOutcome): string {
  switch (outcome) {
    case 'ok':
      return '';
    case 'error':
      return 'error';
    case 'timeout':
      return 'did not finish';
    case 'truncated':
      return 'partial';
    case 'declined':
      return 'declined';
    case 'dry-run':
      return 'dry run';
  }
}
