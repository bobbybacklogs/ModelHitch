import { resolveLanes, type AutoModeOptions, type FailoverTarget } from '../core/failover.js';
import type { Policy, TrustListEntry } from '../core/policy.js';

/**
 * The bridge's routing plan, published as selectable models.
 *
 * A client that points at the bridge as a custom endpoint — "Add model" in VS
 * Code, a Cline/Cursor provider entry, Codex `model_providers` — builds its
 * picker from `GET /v1/models`. That list describes what the bridge can
 * *reach* (one entry per provider/model) and said nothing about what the bridge
 * will *do* with the choice. The plan is the bigger object: the trusted lane,
 * the rotation behind it, and the fallback that only spends once the rest are
 * depleted. This module projects that plan into catalog entries, so the picker
 * offers the lanes the user actually configured, in order, by name.
 *
 * Three rules keep the published plan honest:
 *
 * - Entries carry the real route (`providerId/modelId`), never an alias. A lane
 *   picked from a picker and a lane reached by rotation are the same request,
 *   so nothing has to translate between the two, and `GET /v1/models/:id`
 *   answers for a lane exactly as it does for any other model.
 * - Ids are always fully qualified, even for the default provider. A bare id
 *   means "the default provider" to the router, which is not what a lane says —
 *   and a bare id can be shadowed by a provider of the same name (the default
 *   config's gateway lane `openai/gpt-5.4` would route to the `openai`
 *   provider).
 * - Order and membership mirror `resolvePolicyLanes`: trusted first, then
 *   fallback, deduped, trusted wins. The catalog is a view of the plan, not a
 *   second opinion about it.
 *
 * Pure data + pure functions (no `node:*`, no config, no HTTP) so the server
 * and the tests compute the same entries.
 */

/** Where a lane sits in the plan. */
export type PlanTier =
  /** A policy `trusted` lane: tried first. */
  | 'trusted'
  /** A policy `fallback` lane: tried after every trusted lane fails. */
  | 'fallback'
  /** auto-mode's first lane — the one an unqualified request lands on. */
  | 'primary';

/** One lane of the plan, before it is projected into a catalog entry. */
export interface PlanLane extends FailoverTarget {
  tier: PlanTier;
  /** 1-based position among the lanes in the same tier. */
  laneIndex: number;
}

export interface PlanLanesInput {
  /** The configured plan. When set, it is the only source of lanes. */
  policy?: Policy;
  /** auto-mode lineup, used only when no policy is configured. */
  autoMode?: AutoModeOptions | boolean;
  /** The lane an unqualified request lands on — auto-mode's first lane. */
  primary?: FailoverTarget;
  /**
   * The provider's default model, used to expand a policy entry that lists no
   * `models` (`{ providerId: 'openai' }`). Returns undefined for a provider the
   * bridge cannot reach, which drops the lane.
   */
  defaultModelFor?: (providerId: string) => string | undefined;
}

/**
 * Expand a plan into ordered lanes. Empty when the bridge has no plan at all
 * (neither a policy nor auto-mode), because a catalog with no routing decision
 * behind it has nothing extra to say.
 *
 * `maxProviders` is deliberately not applied here. It caps one request's walk
 * (and exempts the primary), so trimming it into the advertised list would hide
 * lanes the user can still legitimately pick. The cap still governs every
 * request the bridge serves.
 */
export function planLanes(input: PlanLanesInput): PlanLane[] {
  if (input.policy) return policyPlanLanes(input.policy, input.defaultModelFor);
  if (!input.autoMode || !input.primary) return [];
  return autoModePlanLanes(input.primary, input.autoMode);
}

function policyPlanLanes(
  policy: Policy,
  defaultModelFor?: (providerId: string) => string | undefined,
): PlanLane[] {
  const lanes: PlanLane[] = [];
  const seen = new Set<string>();

  const add = (entries: readonly TrustListEntry[] | undefined, tier: 'trusted' | 'fallback') => {
    let laneIndex = 0;
    for (const entry of entries ?? []) {
      if (!entry || typeof entry.providerId !== 'string' || !entry.providerId) continue;
      for (const model of modelsOfEntry(entry, defaultModelFor)) {
        const key = `${entry.providerId}/${model}`;
        if (seen.has(key)) continue; // one lane, one entry — trusted wins
        seen.add(key);
        laneIndex += 1;
        lanes.push({
          providerId: entry.providerId,
          model,
          tier,
          laneIndex,
          ...(entry.terminal ? { terminal: true } : {}),
        });
      }
    }
  };

  add(policy.trusted, 'trusted');
  add(policy.fallback, 'fallback');
  return lanes;
}

/** An entry's models, or its provider's default model when it names none. */
function modelsOfEntry(
  entry: TrustListEntry,
  defaultModelFor?: (providerId: string) => string | undefined,
): string[] {
  if (entry.models && entry.models.length > 0) {
    return entry.models.filter((model) => typeof model === 'string' && model.length > 0);
  }
  const fallback = defaultModelFor?.(entry.providerId);
  return fallback ? [fallback] : [];
}

/** The default-provider lane, then the auto-mode rotation behind it. */
function autoModePlanLanes(primary: FailoverTarget, autoMode: AutoModeOptions | boolean): PlanLane[] {
  const lanes: PlanLane[] = [{ ...primary, tier: 'primary', laneIndex: 1 }];
  let laneIndex = 0;
  for (const target of resolveLanes(primary, autoMode)) {
    laneIndex += 1;
    lanes.push({ ...target, tier: 'fallback', laneIndex });
  }
  return lanes;
}

/** One lane as `GET /v1/models` publishes it. */
export interface PlanModelEntry {
  /** The real route, always fully qualified: `providerId/modelId`. */
  id: string;
  providerId: string;
  model: string;
  tier: PlanTier;
  laneIndex: number;
  /** A limit on this lane stops the walk instead of rotating to the next. */
  terminal: boolean;
  /** Picker label: "DeepSeek V4 Pro · OpenCode Go · trusted lane 1". */
  name: string;
}

export interface PlanModelEntriesOptions {
  /** Display name for a provider id (the provider's own `name` when it has one). */
  providerName?: (providerId: string) => string | undefined;
  /**
   * Route to publish for a lane. Defaults to the fully qualified
   * `providerId/modelId`; the bridge passes a bare id for the default
   * provider's own lanes, where bare is what the catalog already advertises.
   */
  routeFor?: (lane: PlanLane) => string;
}

/** Project plan lanes into the catalog entries a picker renders. */
export function planModelEntries(
  lanes: readonly PlanLane[],
  options: PlanModelEntriesOptions = {},
): PlanModelEntry[] {
  return lanes.map((lane) => ({
    id: options.routeFor?.(lane) ?? laneRoute(lane),
    providerId: lane.providerId,
    model: lane.model,
    tier: lane.tier,
    laneIndex: lane.laneIndex,
    terminal: lane.terminal === true,
    name: laneLabel(lane, options.providerName?.(lane.providerId)),
  }));
}

/** The route a client sends back after picking a lane: `providerId/modelId`. */
export function laneRoute(lane: FailoverTarget): string {
  return `${lane.providerId}/${lane.model}`;
}

/** Everything a label needs, loosened so callers can pass a partial lane. */
type LabeledLane = Pick<PlanLane, 'providerId' | 'model' | 'tier' | 'laneIndex'> & { terminal?: boolean };

/**
 * Picker label for a lane: the model, the provider, and where the lane sits.
 * A picker that renders only `name` can still tell `trusted lane 1` from
 * `fallback lane 1` when both serve the same model.
 */
export function laneLabel(lane: LabeledLane, providerName?: string): string {
  const parts = [
    displayModelName(lane.model, lane.providerId),
    providerDisplayName(lane.providerId, providerName),
    `${lane.tier} lane ${lane.laneIndex}`,
  ];
  if (lane.terminal) parts.push('stop on limit');
  return parts.join(' · ');
}

/** The provider's own name when the bridge has one, else a readable id. */
export function providerDisplayName(providerId: string, providerName?: string): string {
  const name = providerName?.trim();
  if (name) return name;
  return fixAcronyms(
    providerId
      .split(/[-_]/)
      .filter(Boolean)
      .map(capitalizeToken)
      .join(' '),
  );
}

/**
 * Best-effort readable name for a model id — not a catalog, just enough for a
 * picker row (`deepseek-v4-flash` -> `DeepSeek V4 Flash`). Version dots
 * survive (`claude-sonnet-4.5` -> `Claude Sonnet 4.5`) and a namespaced id
 * keeps its segments (`openai/gpt-5.4` -> `OpenAI / GPT 5.4`).
 */
export function displayModelName(modelId: string, providerId?: string): string {
  const qualified = providerId !== undefined && modelId.startsWith(`${providerId}/`);
  const route = qualified ? modelId.slice(providerId.length + 1) : modelId;
  return fixAcronyms(
    route
      .replace(/^~/, '')
      .replace(/:(free|batch|beta|extended|nitro)$/, '')
      .split('/')
      .map((segment) =>
        segment
          .split(/[-_]/)
          .filter(Boolean)
          .map(capitalizeToken)
          .join(' '),
      )
      .join(' / '),
  );
}

function capitalizeToken(token: string): string {
  if (!token) return token;
  // Already an acronym (GPT, VL, GGUF) — leave short all-caps tokens alone.
  if (token.length <= 3 && token === token.toUpperCase() && /^[A-Z]/.test(token)) return token;
  if (/^\d/.test(token)) return token; // versions and sizes keep their casing
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Re-spell tokens a naive title-case gets wrong. Ordered: the specific names
 * come before the bare acronyms that would otherwise claim them.
 */
const ACRONYM_FIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bOpenai\b/g, 'OpenAI'],
  [/\bOpencode\b/g, 'OpenCode'],
  [/\bDeepseek\b/g, 'DeepSeek'],
  [/\bXai\b/g, 'xAI'],
  [/\bGpt\b/g, 'GPT'],
  [/\bGlm\b/g, 'GLM'],
  [/\bVl\b/g, 'VL'],
  [/\bLlm\b/g, 'LLM'],
  [/\bOss\b/g, 'OSS'],
  [/\bMoe\b/g, 'MoE'],
  [/\bAi\b/g, 'AI'],
  [/\bApi\b/g, 'API'],
];

function fixAcronyms(value: string): string {
  let out = value;
  for (const [pattern, replacement] of ACRONYM_FIXES) out = out.replace(pattern, replacement);
  return out;
}
