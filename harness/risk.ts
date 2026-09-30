/**
 * An advisory risk label on an approval request.
 *
 * The gate already shows a human exactly what is about to happen — a unified
 * diff, or the command verbatim — and then asks yes or no. That is the right
 * shape and it puts the judgement where it belongs. What it does not do is help
 * someone who is approving their fortieth call of the run decide how carefully
 * to read *this* one.
 *
 * So a second model reads the preview and answers with one word and one
 * sentence. Three design rules follow from that being advice and not a gate:
 *
 *   1. **Absent means unchanged.** No classifier, a timeout, a thrown client
 *      error, or output that is not the requested JSON all degrade to
 *      `caution` with the reason `unclassified` — never to `safe`. The feature
 *      cannot make a run more permissive than it was without it.
 *   2. **It never blocks past the tool budget.** Classification shares the
 *      timeout the call itself is under, so a slow classifier costs a label,
 *      not a run.
 *   3. **It is cached per `(tool, normalized args)` for the run**, because the
 *      model writes the same file twice with the same content more often than
 *      anyone expects, and each classification is a paid round trip.
 */

import { createHash } from 'node:crypto';
import { clip } from './format.js';

/** How dangerous a call looks. `safe` is the only level that may auto-approve. */
export type RiskLevel = 'safe' | 'caution' | 'dangerous';

export interface RiskAssessment {
  level: RiskLevel;
  /** One sentence. Always present, so a renderer never has to invent wording. */
  reason: string;
  /** True when this came from the fallback rather than from a model. */
  unclassified?: boolean;
}

/** Preview characters sent to the classifier. A diff is expensive to read twice. */
export const RISK_PREVIEW_CHARS = 3_000;

/**
 * Budget for the classification call itself.
 *
 * Short on purpose: a label that arrives after the human has already decided is
 * worth nothing, and the run is waiting on this.
 */
export const RISK_TIMEOUT_MS = 12_000;

export const UNCLASSIFIED: RiskAssessment = {
  level: 'caution',
  reason: 'unclassified',
  unclassified: true,
};

/** The exact answer shape asked for, so the parser and the prompt cannot drift. */
export function buildRiskRequest(tool: string, args: Record<string, unknown>, preview: string): string {
  return [
    'You are labelling a tool call that an automated coding agent is about to make, so a',
    'human can decide how carefully to read it. You are not deciding whether it may run.',
    '',
    `Tool: ${tool}`,
    `Arguments: ${clip(JSON.stringify(args), 600)}`,
    '',
    'Preview of the change:',
    clip(preview, RISK_PREVIEW_CHARS),
    '',
    'Answer with strict JSON and nothing else:',
    '{"level":"safe"|"caution"|"dangerous","reason":"one short sentence"}',
    '',
    'safe: cannot lose data, cannot reach the network, cannot affect anything outside this',
    'workspace. Reading a file. Running the test suite. Creating a file that does not exist.',
    'caution: changes state in a way a human should look at. Overwriting an existing file.',
    'Deleting a file. Rewriting many lines at once. Installing a dependency.',
    'dangerous: irreversible or far-reaching. Recursive delete, force push, a credential or',
    'key in the arguments, a command that reaches the network or another machine, anything',
    'that touches a path outside the workspace.',
  ].join('\n');
}

function normaliseArgs(args: Record<string, unknown>): string {
  // Key order is not meaningful and a model does not promise it, so sort before
  // hashing: the same call must not miss its own cache entry.
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      return Object.fromEntries(entries.map(([key, inner]) => [key, stable(inner)]));
    }
    return value;
  };
  try {
    return JSON.stringify(stable(args));
  } catch {
    return '[unserialisable]';
  }
}

/** `(tool, normalized args)` for this run. */
export function riskCacheKey(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(`${tool}\n${normaliseArgs(args)}`).digest('hex').slice(0, 32);
}

/**
 * Read a level out of whatever the model actually said.
 *
 * Models wrap JSON in prose and fences even when told not to, so the object is
 * located rather than assumed. Anything that is not one of the three levels is
 * `caution`: a typo must not become an approval.
 */
export function parseRiskResponse(text: string): RiskAssessment {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return UNCLASSIFIED;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return UNCLASSIFIED;
  }
  if (parsed === null || typeof parsed !== 'object') return UNCLASSIFIED;
  const record = parsed as Record<string, unknown>;
  const level = record['level'];
  if (level !== 'safe' && level !== 'caution' && level !== 'dangerous') return UNCLASSIFIED;
  const rawReason = record['reason'];
  const reason =
    typeof rawReason === 'string' && rawReason.trim() !== '' ? rawReason.trim() : 'no reason given';
  return { level, reason };
}

export interface RiskClassifierDeps {
  /** One chat call. Returns the model's raw text. */
  complete: (request: string, signal: AbortSignal) => Promise<string>;
  /** Called at most once per run with a warning, mirroring the summarizer's deps. */
  log?: (message: string) => void;
  timeoutMs?: number;
}

export interface RiskClassifier {
  /** Classify, or return `UNCLASSIFIED`. Never throws and never hangs past the budget. */
  classify(tool: string, args: Record<string, unknown>, preview: string): Promise<RiskAssessment>;
  /** How many classifications actually reached the model. */
  readonly calls: number;
  readonly cacheHits: number;
}

/**
 * A classifier bound to one run.
 *
 * The cache lives on the instance rather than at module scope: two runs in one
 * process must not share it, or a run that changed the policy would inherit the
 * previous run's verdicts.
 */
export function createRiskClassifier(deps: RiskClassifierDeps): RiskClassifier {
  const cache = new Map<string, RiskAssessment>();
  let calls = 0;
  let cacheHits = 0;
  let warned = false;

  return {
    get calls(): number {
      return calls;
    },
    get cacheHits(): number {
      return cacheHits;
    },
    async classify(tool, args, preview): Promise<RiskAssessment> {
      const key = riskCacheKey(tool, args);
      const cached = cache.get(key);
      if (cached !== undefined) {
        cacheHits++;
        return cached;
      }
      calls++;
      const timeoutMs = deps.timeoutMs ?? RISK_TIMEOUT_MS;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
        let text: string;
        try {
          const work = deps.complete(buildRiskRequest(tool, args, preview), controller.signal);
          // A client is free to resolve on abort rather than reject — a real one
          // does, returning whatever text it had. Racing the abort is the only
          // way to stop that late answer being read as a verdict, and a late
          // `safe` is the one that would auto-approve an unread call.
          void work.catch(() => undefined);
          const stopped = new Promise<string>((resolve) => {
            if (controller.signal.aborted) {
              resolve('');
              return;
            }
            controller.signal.addEventListener('abort', () => resolve(''), { once: true });
          });
          text = await Promise.race([work, stopped]);
        } finally {
          clearTimeout(timer);
        }
        if (controller.signal.aborted) {
          throw new Error(`no answer within ${timeoutMs}ms`);
        }
        const assessment = parseRiskResponse(text);
        // An unclassified verdict is not cached: the next identical call is a
        // fresh chance to get a real label, and caching a failure would make one
        // flaky response permanent for the run.
        if (!assessment.unclassified) cache.set(key, assessment);
        return assessment;
      } catch (err) {
        if (!warned) {
          warned = true;
          deps.log?.(
            `[harness] risk classification unavailable (${err instanceof Error ? err.message : String(err)}); ` +
              'approvals continue without a risk label',
          );
        }
        return UNCLASSIFIED;
      }
    },
  };
}

/**
 * Whether a classification may skip the prompt.
 *
 * `--auto-approve-safe` only ever skips `safe`, and only when a classifier
 * actually answered. An unclassified call is `caution` by construction, so this
 * cannot become a blanket yes.
 */
export function mayAutoApprove(assessment: RiskAssessment | undefined): boolean {
  return assessment !== undefined && assessment.unclassified !== true && assessment.level === 'safe';
}

/** The palette role a level maps to, so both renderers agree. */
export function riskTone(level: RiskLevel): 'ok' | 'warn' | 'error' {
  if (level === 'safe') return 'ok';
  if (level === 'dangerous') return 'error';
  return 'warn';
}
