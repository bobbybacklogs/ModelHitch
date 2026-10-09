import type { Capabilities } from '../core/types.js';
import type { ModelInfo, Provider } from './types.js';
import { createMultiWireProvider, type OpenCodeWire } from './opencode.js';

/**
 * Custom BYOK lanes.
 *
 * ModelHitch ships a buffet of providers, but a user holding a key for
 * something that is not on it should still be able to hitch it up. A custom
 * lane is a hand-written slot: a base URL, a key, and the exact model ids the
 * user wants to route to.
 *
 * Deliberately no catalog and no `GET /models` poll. We cannot know what an
 * arbitrary endpoint serves, so asking would produce either an empty list or a
 * wrong one; the typed slots are the authority, and they are all the bridge
 * advertises for the lane.
 *
 * One lane becomes one `Provider`, so it is a first-class lane: its own provider
 * id, its own lane health, its own place in the rotation, and it works with
 * `bridge --provider custom-<slug>` like any built-in provider. The wire comes
 * from `schema` (`auto` detects the family) because an unlisted endpoint can be
 * OpenAI-shaped, Anthropic-shaped, or Google-shaped.
 */

/** Provider id prefix — one provider per custom lane (`custom-<slug>`). */
export const CUSTOM_LANE_PROVIDER_PREFIX = 'custom-';

/** Prefix of the derived env-var fallback (`MODELHITCH_CUSTOM_<SLUG>_API_KEY`). */
export const CUSTOM_LANE_KEY_ENV_PREFIX = 'MODELHITCH_CUSTOM_';

/** API schemas a custom lane can speak. */
export type CustomLaneSchema = 'auto' | 'chat-completions' | 'responses' | 'anthropic' | 'google';

export const CUSTOM_LANE_SCHEMAS: readonly CustomLaneSchema[] = [
  'auto',
  'chat-completions',
  'responses',
  'anthropic',
  'google',
];

/** Schema -> engine wire. `auto` (and anything unknown) keeps family detection. */
export function customLaneWire(schema: CustomLaneSchema | undefined): OpenCodeWire | undefined {
  switch (schema) {
    case 'chat-completions':
      return 'chat-completions';
    case 'responses':
      return 'responses';
    case 'anthropic':
      return 'messages';
    case 'google':
      return 'gemini';
    default:
      return undefined;
  }
}

/**
 * URL-safe slug for a lane id or label, so `providerId/model` routing, shell
 * quoting, and the lane-health table all work without escaping.
 */
export function customLaneSlug(value: string, fallback = 'lane'): string {
  const clean = (input: string): string =>
    (input ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  return clean(value) || clean(fallback) || 'lane';
}

/** Provider id for a custom lane (`custom-<slug>`). */
export function customLaneProviderId(laneId: string, fallback?: string): string {
  return `${CUSTOM_LANE_PROVIDER_PREFIX}${customLaneSlug(laneId, fallback)}`;
}

/** True when a provider id belongs to a custom BYOK lane. */
export function isCustomLaneProviderId(providerId: string): boolean {
  return providerId.startsWith(CUSTOM_LANE_PROVIDER_PREFIX);
}

/**
 * Env var consulted when a lane has no key in the config `keys` map. Derived
 * from the lane id so a user can keep the key out of the config document
 * entirely without inventing a name we would not look for.
 */
export function customLaneKeyEnvVar(laneId: string, label?: string): string {
  const slug = customLaneSlug(laneId, label ?? 'lane').replace(/-/g, '_').toUpperCase();
  return `${CUSTOM_LANE_KEY_ENV_PREFIX}${slug}_API_KEY`;
}

/** Base URL without a trailing slash (the engine appends `/chat/completions`, …). */
export function customLaneBaseUrl(baseUrl: string): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '');
}

/** One custom lane, as stored in the config document. */
export interface CustomLaneInput {
  /** Stable id — becomes the provider id (`custom-<slug>`). */
  id: string;
  /** Display label for the lane; defaults to the id. */
  label?: string;
  /** Endpoint root, e.g. "https://api.example.com/v1". */
  baseUrl: string;
  /** API schema; `auto` (default) detects it from the model family. */
  schema?: CustomLaneSchema;
  /** The model slots the user typed. The lane advertises exactly these. */
  models?: string[];
  /** Extra headers sent with every request (e.g. an org id). */
  headers?: Record<string, string>;
  /** Env var holding the key; defaults to `MODELHITCH_CUSTOM_<SLUG>_API_KEY`. */
  apiKeyEnvVar?: string;
  /** Set false for a keyless endpoint (a self-hosted gateway). Default: true. */
  requiresKey?: boolean;
  /** Honest capability claims for an endpoint that cannot do tools/vision. */
  capabilities?: Partial<Capabilities>;
  /** Off = configured but out of the provider set and out of the rotation. */
  enabled?: boolean;
  /** Stop-on-limit / rotate — read by the routing plan, not by the adapter. */
  onLimit?: 'rotate' | 'stop';
}

export interface CreateCustomLaneProviderOptions {
  /** Provider id override; defaults to `custom-<slug>`. */
  id?: string;
  /** Default model; defaults to the first typed slot. */
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Build the `Provider` for one custom lane.
 *
 * The lane's typed slots are also its `listModels()` result, so `GET /v1/models`
 * on the bridge and the workspace model picker show exactly what the user
 * declared, with no request to the upstream endpoint.
 */
export function createCustomLaneProvider(
  lane: CustomLaneInput,
  options: CreateCustomLaneProviderOptions = {},
): Provider {
  const models = (lane.models ?? []).map((m) => m.trim()).filter(Boolean);
  const id = options.id ?? customLaneProviderId(lane.id, lane.label);
  const defaultModel = options.defaultModel ?? models[0] ?? '';
  const label = lane.label?.trim() || lane.id;
  const envVar = lane.apiKeyEnvVar?.trim() || customLaneKeyEnvVar(lane.id, lane.label);

  return createMultiWireProvider({
    id,
    name: label,
    baseUrl: customLaneBaseUrl(lane.baseUrl),
    defaultModel,
    apiKeyEnvVar: envVar,
    // Names the lane in the missing-key error, which is the one place a user
    // finds out that the key never made it into the config.
    providerLabel: `Custom lane "${label}"`,
    requiresKey: lane.requiresKey,
    capabilities: lane.capabilities,
    headers: lane.headers,
    forceWire: customLaneWire(lane.schema),
    snapshotModels: models,
    listModels: async (): Promise<ModelInfo[]> => models.map((modelId) => ({ id: modelId, name: modelId })),
    fetchImpl: options.fetchImpl,
  });
}
