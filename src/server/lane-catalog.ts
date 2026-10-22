import { resolveLanes, type AutoModeOptions, type FailoverTarget } from '../core/failover.js';
import type { Policy, TrustListEntry } from '../core/policy.js';
import { INTENT_NAMES, isIntentName, type IntentName } from '../core/intent.js';

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
 *   answers for a lane exactly as it does for any other model. The deliberate
 *   exceptions are the plan ids: `AUTO_MODEL_ID` and `FREE_MODEL_ID` below.
 *   Neither is an alias for a lane — each is the plan itself (the free id is a
 *   filtered view of it) — and the router resolves each the same way on every
 *   wire.
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

/**
 * The id that stands for the whole plan.
 *
 * A client that points at the bridge as a custom endpoint has to send *some*
 * model name — VS Code "Add model", Cline/Cursor provider entries and Codex
 * `model_providers` all require one — and every name it could send picks one
 * lane. This id picks the plan instead: the bridge routes it exactly as it
 * routes a request that omits `model`, so the default lane leads and the whole
 * rotation sits behind it. One id, however many lanes the user configured.
 *
 * The id is fixed rather than configurable because it is the one thing a
 * client's saved config can rely on: a bridge whose plan changed under it, or
 * a client copied between bridges, still means the same request.
 */
export const AUTO_MODEL_ID = 'modelhitch/auto';

/** True when a client asked for the plan rather than for one lane. */
export function isAutoModelId(modelInput: unknown): boolean {
  return typeof modelInput === 'string' && modelInput.trim().toLowerCase() === AUTO_MODEL_ID;
}

/**
 * The id that stands for the plan's free lanes only.
 *
 * Same idea as the auto id — a plan published as a pickable model, not a lane —
 * but where the auto id filters nothing, this one filters everything: the walk
 * keeps only lanes that cost nothing marginal (`isFreeLaneModel` in
 * `core/cost.ts`). It answers "send my work where it cannot bill anyone", which
 * a regular lane list cannot express without merging every free provider into
 * one row.
 *
 * Fixed for the same reason the auto id is: a client's saved config keeps
 * meaning the same request across bridge changes. Empty when the plan has no
 * free lane at all — the router refuses it rather than silently billing.
 */
export const FREE_MODEL_ID = 'modelhitch/free';

/** True when a client asked for the plan's free lanes rather than one lane. */
export function isFreeModelId(modelInput: unknown): boolean {
  return typeof modelInput === 'string' && modelInput.trim().toLowerCase() === FREE_MODEL_ID;
}

/** Separates the auto id from the intent it pins: `modelhitch/auto:coding`. */
export const INTENT_MODEL_SEPARATOR = ':';

const INTENT_MODEL_PREFIX = `${AUTO_MODEL_ID}${INTENT_MODEL_SEPARATOR}`;

/**
 * The auto id pinned to one intent: `modelhitch/auto:coding`.
 *
 * The plain auto id means "whichever plan the request's shape selects", which
 * is the right default and the wrong thing to hand a client that has a lane
 * choice to make. The pinned form is how a *picker* offers that choice: every
 * configured profile gets a row, the row's id names the profile, and sending it
 * back routes to exactly that plan with nothing inferred.
 *
 * The name is fixed rather than configurable for the same reason the auto id is:
 * a client's saved config has to keep meaning the same request after the bridge
 * behind it changes.
 */
export function intentModelId(intent: IntentName): string {
  return `${INTENT_MODEL_PREFIX}${intent}`;
}

/** The intent an id pins, when it pins one from the vocabulary. */
export function intentFromModelId(modelInput: unknown): IntentName | undefined {
  const name = intentModelSuffix(modelInput);
  return name !== undefined && isIntentName(name) ? name : undefined;
}

/**
 * True for anything shaped like an intent id, known name or not — so an unknown
 * one can be refused by name (with the vocabulary) instead of being passed to a
 * provider as if it were a model.
 */
export function isIntentModelIdShape(modelInput: unknown): boolean {
  return intentModelSuffix(modelInput) !== undefined;
}

/** The text after `modelhitch/auto:`, or undefined when the id is not shaped that way. */
function intentModelSuffix(modelInput: unknown): string | undefined {
  if (typeof modelInput !== 'string') return undefined;
  const trimmed = modelInput.trim().toLowerCase();
  if (!trimmed.startsWith(INTENT_MODEL_PREFIX)) return undefined;
  const suffix = trimmed.slice(INTENT_MODEL_PREFIX.length);
  return suffix.length > 0 ? suffix : undefined;
}

/** Every intent id the bridge can publish, in vocabulary order. */
export function intentModelIds(): string[] {
  return INTENT_NAMES.map(intentModelId);
}

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

/**
 * The `modelhitch` payload the auto id is published with. It carries the same
 * entries the catalog lists for the plan, so a client (or a person reading
 * `GET /v1/models/modelhitch/auto`) can see what the id expands to without
 * asking which lanes the plan holds.
 */
export interface AutoModelMeta {
  /**
   * Which plan product the id stands for. `'auto'` is the whole plan (the
   * plain auto id and every pinned intent); `'free'` is the plan filtered to
   * its zero-cost lanes. Both resolve through the same routing on every wire —
   * the kind only tells a client what the id filters, and keeps
   * `isAutoModelMeta` narrow so intent rows keep their one meaning.
   */
  kind: 'auto' | 'free';
  /**
   * The intent this id pins, when it pins one. Absent on the plain auto id,
   * which stands for "whichever plan the request selects".
   */
  intent?: IntentName;
  /** Every lane the id will try, in order — the plan rows themselves. */
  lanes: PlanModelEntry[];
}

/** The auto id as the catalog publishes it. */
export interface AutoModelEntry {
  /** Always `AUTO_MODEL_ID`. */
  id: string;
  name: string;
  modelhitch: AutoModelMeta;
}

/** Picker label for the auto id: "ModelHitch Auto · whole rotation · 4 lanes". */
export function autoModelLabel(laneCount: number): string {
  if (laneCount <= 0) return 'ModelHitch Auto · the bridge default';
  return `ModelHitch Auto · whole rotation · ${laneCount} lane${laneCount === 1 ? '' : 's'}`;
}

/** Build the auto id's catalog entry from the plan entries it stands for. */
export function autoModelEntry(lanes: readonly PlanModelEntry[]): AutoModelEntry {
  return {
    id: AUTO_MODEL_ID,
    name: autoModelLabel(lanes.length),
    modelhitch: { kind: 'auto', lanes: [...lanes] },
  };
}

/** Picker label for a pinned intent: "ModelHitch Auto · coding · 3 lanes". */
export function intentModelLabel(intent: IntentName, laneCount: number): string {
  const scope = laneCount > 0 ? `${laneCount} lane${laneCount === 1 ? '' : 's'}` : 'the bridge default';
  return `ModelHitch Auto · ${intent} · ${scope}`;
}

/**
 * Build a pinned-intent catalog entry from the lanes its profile resolves to.
 *
 * Same contract as `autoModelEntry`: a plan, not a lane, published under the id
 * a client saves, with the lanes it expands to in `modelhitch`.
 */
export function intentModelEntry(intent: IntentName, lanes: readonly PlanModelEntry[]): AutoModelEntry {
  return {
    id: intentModelId(intent),
    name: intentModelLabel(intent, lanes.length),
    modelhitch: { kind: 'auto', intent, lanes: [...lanes] },
  };
}

/** Picker label for the free id: "ModelHitch Free · free lanes only · 2 lanes". */
export function freeModelLabel(freeLaneCount: number): string {
  if (freeLaneCount <= 0) return 'ModelHitch Free · no free lanes';
  return `ModelHitch Free · free lanes only · ${freeLaneCount} lane${freeLaneCount === 1 ? '' : 's'}`;
}

/**
 * Build the free id's catalog entry from the plan lanes that cost nothing.
 *
 * Mirrors `autoModelEntry` but scoped: `freeLanes` receives only the lanes the
 * caller filtered with `isFreeLaneModel`, so `modelhitch.lanes` is exactly the
 * set the router will try — the same honesty the auto id gets. `totalLanes`
 * records the size of the *unfiltered* plan, purely for callers: the label
 * counts free lanes, and a caller that wants to know whether the plan has any
 * paid lane left compares the two. An empty list is allowed so a caller can
 * inspect what the id *would* be; the server only publishes the entry when
 * that list is non-empty.
 */
export function freeModelEntry(
  freeLanes: readonly PlanModelEntry[],
  totalLanes: number,
): AutoModelEntry {
  return {
    id: FREE_MODEL_ID,
    name: freeModelLabel(freeLanes.length),
    modelhitch: { kind: 'free', lanes: [...freeLanes] },
  };
}

/** Narrow a catalog entry's `modelhitch` payload to the auto id's. */
export function isAutoModelMeta(value: unknown): value is AutoModelMeta {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'auto';
}

/** Narrow a catalog entry's `modelhitch` payload to the free id's. */
export function isFreeModelMeta(value: unknown): value is AutoModelMeta {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'free';
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
