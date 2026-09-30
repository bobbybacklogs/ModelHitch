import { createHash } from 'node:crypto';
import { isFailure, type ToolOutcome } from './result.js';

/**
 * Keeping long tool output out of the context window.
 *
 * `cli.ts` truncates tool output to 2000 characters for display, but display is
 * not the problem: the full result goes into `messages` and stays there for the
 * rest of the run. One grep over a large tree can cost more context than the
 * task itself.
 *
 * So a tool result over the threshold keeps its head and tail verbatim, and the
 * middle is replaced by a short digest from the same model the run is already
 * using. The digest call is injected (`deps.digest`) rather than reached for, so
 * this module stays provider-neutral and testable without a network.
 *
 * Three things must never be summarized: a failure (`Error: ...`), a file the
 * model explicitly asked for in full, and anything at all when the threshold is
 * 0. A digest that fails to arrive degrades to head/tail truncation, which is
 * still better than the whole blob.
 */

/** Tools whose output is deliberately whole. */
export const SUMMARIZE_EXEMPT_TOOLS: readonly string[] = ['read', 'read_file'];

/** Threshold used when `--summarize-threshold` is absent. */
export const DEFAULT_SUMMARIZE_THRESHOLD = 8_000;

/**
 * Parse `--summarize-threshold`. A non-numeric value falls back to the default
 * (the guard `maxTurns` already uses); `0` is a real value and disables
 * summarization outright, which is what a debugging run wants.
 */
export function parseSummarizeThreshold(
  raw: string | undefined,
  fallback = DEFAULT_SUMMARIZE_THRESHOLD,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

export interface SummarizeDeps {
  /** Ask a model for a short digest of the middle. Rejections fall back to truncation. */
  digest?: (request: string) => Promise<string>;
  /** Called at most once with a warning when a digest attempt fails. */
  log?: (message: string) => void;
}

export interface SummarizeOptions {
  /** Tool name, used for the exemption list and the digest request. */
  tool: string;
  /** Character count above which a result is summarized. `0` disables. */
  threshold: number;
  /** Set false to disable entirely, e.g. when `--summarize-tools` was not passed. */
  enabled?: boolean;
  deps?: SummarizeDeps;
  /** Characters kept verbatim at each end. Defaults to a third of the threshold, capped at 2000. */
  headChars?: number;
  /**
   * The tool's classification, when the caller has it.
   *
   * A failure must reach the model whole, and the envelope says so directly.
   * The text prefix check below stays as the fallback for callers that only
   * have a string — `runHarness`'s public surface, and a replayed transcript.
   */
  outcome?: ToolOutcome;
}

/** Bounded cache so a repeated identical result is not summarized twice. */
const CACHE_LIMIT = 50;
const summaryCache = new Map<string, string>();
let digestInFlight = false;
let warned = false;

/** Test hook: drop the dedupe cache and the once-per-process warning latch. */
export function resetSummarizeState(): void {
  summaryCache.clear();
  digestInFlight = false;
  warned = false;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function remember(key: string, value: string): void {
  if (summaryCache.size >= CACHE_LIMIT) {
    const oldest = summaryCache.keys().next();
    if (!oldest.done) summaryCache.delete(oldest.value);
  }
  summaryCache.set(key, value);
}

export function buildDigestRequest(tool: string, middle: string): string {
  return (
    `Summarize this output from the "${tool}" tool for another engineer. ` +
    'Keep file paths, identifiers, numbers, and error text exactly as written. ' +
    'Drop repetition and boilerplate. Answer in at most 12 short lines, no preamble.\n\n' +
    middle
  );
}

/**
 * Return `text` unchanged when it is short enough already, and a head/digest/tail
 * form when it is not. Never throws and never returns a non-string.
 */
export async function summarizeToolOutput(
  text: string,
  options: SummarizeOptions,
): Promise<string> {
  const { tool, threshold } = options;
  const deps = options.deps ?? {};

  if (options.enabled === false) return text;
  if (threshold <= 0) return text; // 0 turns summarization off
  if (text.length <= threshold) return text;
  if (SUMMARIZE_EXEMPT_TOOLS.includes(tool)) return text;
  // A failure the model cannot read is a failure it cannot act on. The
  // classification is authoritative when present; the prefix is the fallback
  // for a caller that only has text.
  if (options.outcome !== undefined ? isFailure(options.outcome) : text.startsWith('Error:')) return text;
  // A digest is a model call, not a tool call, but bail out anyway if one ever
  // re-entered: a summarizer that summarizes itself is an infinite loop.
  if (digestInFlight) return text;

  const key = `${tool}:${hash(text)}`;
  const cached = summaryCache.get(key);
  if (cached !== undefined) return cached;

  const headChars = options.headChars ?? Math.min(2_000, Math.floor(threshold / 3));
  const head = text.slice(0, headChars);
  const tail = text.slice(Math.max(headChars, text.length - headChars));
  const middle = text.slice(headChars, Math.max(headChars, text.length - headChars));

  let digest = '';
  if (deps.digest && middle.length > 0) {
    digestInFlight = true;
    try {
      digest = (await deps.digest(buildDigestRequest(tool, middle))).trim();
    } catch (err) {
      if (!warned) {
        warned = true;
        deps.log?.(
          `[harness] tool output digest failed (${err instanceof Error ? err.message : String(err)}); ` +
            'falling back to head/tail truncation',
        );
      }
    } finally {
      digestInFlight = false;
    }
  }

  const label = `[summarized: ${text.length} chars -> ${head.length + digest.length + tail.length}]`;
  const result = [head, label, digest, tail].filter((part) => part !== '').join('\n');
  remember(key, result);
  return result;
}
