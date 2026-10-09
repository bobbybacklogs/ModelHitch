import type { CustomLaneConfig, CustomLanesConfig, ModelHitchConfig } from './config.js';
import type { Policy, TrustListEntry } from './core/policy.js';
import type { Provider } from './providers/types.js';
import {
  createCustomLaneProvider,
  customLaneKeyEnvVar,
  customLaneProviderId,
  customLaneSlug,
} from './providers/custom-lane.js';

/**
 * Custom BYOK lane runtime wiring.
 *
 * The provider factory (`providers/custom-lane.ts`) turns one config lane into
 * one `Provider`. This module decides *how those providers join the lane plan*,
 * which is the part the user actually opts into:
 *
 *   placement: lead      every enabled lane × typed model sits at the FRONT of
 *                        `trusted`; the configured policy follows as the safety
 *                        net, and the primary route is the first custom lane.
 *   placement: fallback  the configured lanes stay primary and the custom lanes
 *                        are appended to `fallback` — used only when the buffet
 *                        is depleted or erroring.
 *
 * Per lane, `onLimit` decides what a limit *means*:
 *
 *   rotate (default)  a 429/402/5xx rotates to the next lane, like every lane.
 *   stop              the lane is terminal: the error surfaces instead of
 *                     spending another provider's quota, and it stays terminal
 *                     while the lane is parked (see `FailoverTarget.terminal`).
 *
 * Everything here is plain data + pure functions so the settings page, the
 * bridge, and the tests all compute the same plan — no `node:*` imports.
 */

/** A custom lane that survived resolution (enabled, with an id and models). */
export interface ResolvedCustomLane extends CustomLaneConfig {
  /** Provider id (`custom-<slug>`). */
  providerId: string;
  /** Slug used for the provider id. */
  slug: string;
  /** Display label; defaults to the lane id. */
  label: string;
  /** Typed, de-duplicated model slots (never empty after resolution). */
  models: string[];
  /** Env var consulted when the lane has no key in the config `keys` map. */
  apiKeyEnvVar: string;
  /** True when this lane stops the walk instead of rotating. */
  stopOnLimit: boolean;
}

/** Tolerant config accessor: the document may predate the custom-lanes block. */
export function customLanesConfig(config: ModelHitchConfig | undefined): CustomLanesConfig | undefined {
  return config?.customLanes;
}

/** True when the block is on and at least one lane is usable. */
export function isCustomLanesEnabled(config: ModelHitchConfig | undefined): boolean {
  const custom = customLanesConfig(config);
  return !!custom?.enabled && resolveCustomLanes(config).length > 0;
}

/** Where the custom lanes sit in the plan. Default: `lead`. */
export function customLanesPlacement(config: ModelHitchConfig | undefined): 'lead' | 'fallback' {
  return customLanesConfig(config)?.placement === 'fallback' ? 'fallback' : 'lead';
}

/**
 * Resolve the config block into ready-to-serve lanes.
 *
 * A lane needs an id, a base URL, and at least one model slot to be usable —
 * there is no catalog to fill in the blanks, so an incomplete lane is dropped
 * rather than served with a guessed model. `validateConfig` reports those as
 * errors/warnings at edit time; this keeps the runtime safe if one slips
 * through.
 */
export function resolveCustomLanes(config: ModelHitchConfig | undefined): ResolvedCustomLane[] {
  const custom = customLanesConfig(config);
  if (!custom?.enabled) return [];
  const out: ResolvedCustomLane[] = [];
  for (const lane of custom.lanes ?? []) {
    if (!lane || lane.enabled === false) continue;
    if (typeof lane.id !== 'string' || !lane.id.trim()) continue;
    if (typeof lane.baseUrl !== 'string' || !lane.baseUrl.trim()) continue;
    const models = [...new Set((lane.models ?? []).map((m) => m.trim()).filter(Boolean))];
    if (!models.length) continue;
    out.push({
      ...lane,
      id: lane.id.trim(),
      models,
      providerId: customLaneProviderId(lane.id, lane.label),
      slug: customLaneSlug(lane.id, lane.label),
      label: lane.label?.trim() || lane.id.trim(),
      apiKeyEnvVar: lane.apiKeyEnvVar?.trim() || customLaneKeyEnvVar(lane.id, lane.label),
      stopOnLimit: lane.onLimit === 'stop',
    });
  }
  return out;
}

export interface CustomLaneProviderOptions {
  fetchImpl?: typeof fetch;
}

/** One Provider per enabled custom lane. */
export function customLaneProviders(
  config: ModelHitchConfig | undefined,
  options: CustomLaneProviderOptions = {},
): Provider[] {
  return resolveCustomLanes(config).map((lane) =>
    createCustomLaneProvider(lane, {
      id: lane.providerId,
      defaultModel: lane.models[0],
      fetchImpl: options.fetchImpl,
    }),
  );
}

/**
 * Per-lane credentials for the server's `apiKeys` map.
 *
 * A lane's key normally lives in `config.keys['custom-<slug>']`, which the
 * bridge already forwards (the config `keys` map *is* the apiKeys map). This
 * adds the documented env fallback so a key can stay out of the config document
 * entirely without the bridge having to guess where to look for it.
 */
export function customLaneApiKeys(config: ModelHitchConfig | undefined): Record<string, string> {
  const keys = config?.keys ?? {};
  const out: Record<string, string> = {};
  for (const lane of resolveCustomLanes(config)) {
    const stored = keys[lane.providerId];
    if (stored) {
      out[lane.providerId] = stored;
      continue;
    }
    const fromEnv = (typeof process !== 'undefined' && process.env?.[lane.apiKeyEnvVar]) as string | undefined;
    if (fromEnv) out[lane.providerId] = fromEnv;
  }
  return out;
}

export interface CustomLanesPlanInput {
  config: ModelHitchConfig | undefined;
  /** Plan to merge into — the OpenCode BYOK plan, when that block is on. */
  policy?: Policy;
  defaultProviderId?: string;
  defaultModel?: string;
}

export interface CustomLanesPlan {
  policy?: Policy;
  defaultProviderId?: string;
  defaultModel?: string;
  /** Ordered provider/model lanes this block contributed, for logging. */
  lanes: Array<{ providerId: string; model: string }>;
  placement: 'lead' | 'fallback';
  /** Provider ids whose lanes stop the walk instead of rotating. */
  stopping: string[];
}

/**
 * Merge the custom lanes into the routing plan.
 *
 * `lead` prepends the lanes to `trusted` and makes the first lane × model the
 * primary route — adding a lane is a request to use it. `fallback` appends them
 * to `fallback`, leaving the primary route exactly as configured. In both cases
 * the returned plan is plain JSON data, and a lane with `onLimit: 'stop'`
 * carries `terminal: true` so the failover walk knows where to stop.
 *
 * Returns the input untouched when the block is off or has no usable lane.
 */
export function applyCustomLanesPlan(input: CustomLanesPlanInput): CustomLanesPlan {
  const custom = customLanesConfig(input.config);
  const lanes = resolveCustomLanes(input.config);
  const placement = customLanesPlacement(input.config);
  const untouched: CustomLanesPlan = {
    policy: input.policy,
    defaultProviderId: input.defaultProviderId,
    defaultModel: input.defaultModel,
    lanes: [],
    placement,
    stopping: [],
  };
  if (!custom?.enabled || lanes.length === 0) return untouched;

  const entries: TrustListEntry[] = lanes.map((lane) => ({
    providerId: lane.providerId,
    models: lane.models,
    ...(lane.stopOnLimit ? { terminal: true } : {}),
  }));
  const flat = lanes.flatMap((lane) => lane.models.map((model) => ({ providerId: lane.providerId, model })));
  const stopping = lanes.filter((lane) => lane.stopOnLimit).map((lane) => lane.providerId);
  const base: Policy = input.policy ?? { trusted: [], fallback: [] };

  if (placement === 'fallback') {
    return {
      policy: {
        ...base,
        trusted: [...(base.trusted ?? [])],
        // Custom lanes are the last resort: behind every configured lane,
        // trusted and fallback alike.
        fallback: [...(base.fallback ?? []), ...entries],
      },
      // The primary route is unchanged: these lanes are for when it is depleted.
      defaultProviderId: input.defaultProviderId,
      defaultModel: input.defaultModel,
      lanes: flat,
      placement,
      stopping,
    };
  }

  const first = lanes[0]!;
  return {
    policy: {
      ...base,
      trusted: [...entries, ...(base.trusted ?? [])],
      fallback: [...(base.fallback ?? [])],
    },
    defaultProviderId: first.providerId,
    defaultModel: first.models[0],
    lanes: flat,
    placement,
    stopping,
  };
}

/** One-line summary of the custom-lane plan, for the bridge banner and the log. */
export function describeCustomLanesPlan(plan: CustomLanesPlan): string | undefined {
  if (!plan.lanes.length) return undefined;
  const where = plan.placement === 'fallback' ? 'as fallback' : 'leading';
  const head = plan.lanes.slice(0, 4).map((lane) => `${lane.providerId}/${lane.model}`).join(', ');
  const more = plan.lanes.length > 4 ? ` (+${plan.lanes.length - 4} more)` : '';
  const stops = plan.stopping.length ? ` · stop-on-limit: ${plan.stopping.join(', ')}` : '';
  return `Custom lanes ${where}: ${plan.lanes.length} lane${plan.lanes.length === 1 ? '' : 's'} — ${head}${more}${stops}`;
}
