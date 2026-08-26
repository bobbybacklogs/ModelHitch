import type { Capabilities, ChatParams } from './types.js';
import type { FailoverTarget } from './failover.js';
import { ModelHitchError } from './errors.js';

/**
 * Capability-aware routing.
 *
 * Policy and auto-mode answer "which lanes are configured"; this answers
 * "which of those lanes can actually serve this request". A lane whose
 * provider lacks a capability the request needs (tool calling, ...) is never
 * attempted — it costs nothing (no cooldown, no counted failure), because it
 * was never a runtime failure in the first place, just a mismatch detected
 * before the call was made.
 *
 * Extensible by design: `vision`/`streaming`/`embeddings` are recognized
 * requirement keys (matching `Capabilities`) that callers can set explicitly
 * via `extra`; only `toolCalling` is currently auto-inferred from the request
 * shape (a request with `tools` needs a tool-calling-capable lane — that much
 * is unambiguous). Auto-inferring the others from message content would be a
 * behavior change for existing non-"vision-capable" providers that already
 * pass image content through fine (e.g. a text-only mock echoing it back).
 */
export interface CapabilityRequirements {
  toolCalling?: boolean;
  vision?: boolean;
  streaming?: boolean;
  embeddings?: boolean;
}

/** A lane that was never attempted because its provider can't meet a requirement. */
export interface SkippedCapabilityLane {
  target: FailoverTarget;
  reason: string;
}

const CAPABILITY_KEYS: readonly (keyof CapabilityRequirements)[] = [
  'toolCalling',
  'vision',
  'streaming',
  'embeddings',
];

/**
 * Infer the capabilities a request needs from its params. `extra` merges in
 * requirements the caller already knows about (e.g. `{ streaming: true }`
 * for a streaming call — the request shape alone doesn't say that).
 */
export function inferRequirements(
  params: Pick<ChatParams, 'tools'>,
  extra: CapabilityRequirements = {},
): CapabilityRequirements {
  const req: CapabilityRequirements = { ...extra };
  if (params.tools && params.tools.length > 0) req.toolCalling = true;
  return req;
}

/** True when `capabilities` satisfies every requirement set to `true`. */
export function satisfiesRequirements(capabilities: Capabilities, req: CapabilityRequirements): boolean {
  return CAPABILITY_KEYS.every((key) => !req[key] || capabilities[key]);
}

function describeRequirements(req: CapabilityRequirements): string {
  return CAPABILITY_KEYS.filter((key) => req[key]).join(', ') || 'none';
}

/**
 * Split a resolved lane list into the ones capable of serving the request and
 * the ones skipped for lacking a required capability. Skipped lanes are
 * removed from the walk entirely — they're never attempted, so they never
 * cool down and never count as a provider failure.
 */
export function filterEligibleLanes<L extends FailoverTarget>(
  targets: L[],
  req: CapabilityRequirements,
  capabilitiesFor: (target: L) => Capabilities | undefined,
): { eligible: L[]; skipped: SkippedCapabilityLane[] } {
  if (!CAPABILITY_KEYS.some((key) => req[key])) return { eligible: targets, skipped: [] };
  const eligible: L[] = [];
  const skipped: SkippedCapabilityLane[] = [];
  const reason = `missing required capability: ${describeRequirements(req)}`;
  for (const target of targets) {
    const capabilities = capabilitiesFor(target);
    if (!capabilities || satisfiesRequirements(capabilities, req)) {
      eligible.push(target);
    } else {
      skipped.push({ target: { providerId: target.providerId, model: target.model }, reason });
    }
  }
  return { eligible, skipped };
}

/**
 * Thrown when a request needs a capability that no resolved lane's provider
 * supports. Distinct from `ExhaustedError`: no call was ever attempted —
 * this is a configuration/routing mismatch, not a runtime failure.
 */
export class CapabilityUnavailableError extends ModelHitchError {
  readonly requirements: CapabilityRequirements;
  readonly skipped: SkippedCapabilityLane[];

  constructor(requirements: CapabilityRequirements, skipped: SkippedCapabilityLane[]) {
    const lanes = skipped.map((s) => `${s.target.providerId}/${s.target.model}`).join(', ') || 'none configured';
    super(
      'capability-unavailable',
      `No configured lane supports the required capability (${describeRequirements(requirements)}). Considered: ${lanes}.`,
      { status: 400 },
    );
    this.name = 'CapabilityUnavailableError';
    this.requirements = requirements;
    this.skipped = skipped;
  }
}

export function isCapabilityUnavailableError(err: unknown): err is CapabilityUnavailableError {
  return err instanceof CapabilityUnavailableError;
}
