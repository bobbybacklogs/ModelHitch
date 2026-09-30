import type { ModelHitchConfig, OpenCodeByokConfig, OpenCodeByokConnection } from './config.js';
import type { Policy, TrustListEntry } from './core/policy.js';
import type { Provider } from './providers/types.js';
import {
  createOpenCodeByokProvider,
  isOpenCodeByokProviderId,
  openCodeByokBaseUrl,
  openCodeByokProviderId,
  openCodeByokSlug,
  OPENCODE_BYOK_KEY_ENV,
  OPENCODE_BYOK_KEY_ID,
} from './providers/opencode-byok.js';

/**
 * Console BYOK runtime wiring.
 *
 * The provider factory (`providers/opencode-byok.ts`) turns one Console
 * connection into one `Provider`. This module decides *how those providers
 * join the lane plan* — the rotation and pin behavior the settings UI exposes:
 *
 *   rotation  every enabled connection × model is a lane at the front of the
 *             plan; the configured policy follows as the safety net.
 *   pinned    one connection (and model) is the lane for every request; the
 *             rest of that connection's models, then the configured policy,
 *             are the fallback when it is depleted or erroring.
 *
 * Everything here is plain data + pure functions so the settings page, the
 * bridge, and the tests all compute the same plan — no `node:*` imports.
 */

/** A Console connection that survived resolution (enabled, with a lane id). */
export interface ResolvedOpenCodeByokConnection extends OpenCodeByokConnection {
  /** Provider id (`opencode-byok-<slug>`). */
  providerId: string;
  /** Slug used for the provider id and the key lookup. */
  slug: string;
  /** Gateway URL, resolved from `baseUrl` or the connection id. */
  url: string;
  /** Model rotation pool (never empty after resolution). */
  models: string[];
  /** True when the model list was seeded from the local OpenCode install. */
  modelsFromOpenCode?: boolean;
}

/** One provider/model entry discovered in the local OpenCode install. */
export interface OpenCodeLocalProvider {
  /** OpenCode provider id (`opencode-go`, `deepseek`, …). */
  providerId: string;
  /** Models this provider was actually asked for, most recent first. */
  models: string[];
  /** `api` / `oauth` when the credential store reported it. */
  credentialType?: string;
  /** Epoch ms of the most recent use, when known. */
  lastUsedAt?: number;
}

/** Snapshot of the local OpenCode install (see `opencode-state.ts`). */
export interface OpenCodeLocalState {
  /** True when an OpenCode install was found and parsed. */
  found: boolean;
  /** Files/databases that contributed, for display in the UI. */
  sources: string[];
  /** Provider -> models the user runs in OpenCode, most recently used first. */
  providers: OpenCodeLocalProvider[];
  /** The model OpenCode currently has selected, when discoverable. */
  selected?: { providerId: string; modelId: string };
  /** Non-fatal problems (unreadable files, locked databases, …). */
  warnings: string[];
}

/** Tolerant config accessor: the document may predate the BYOK block. */
export function openCodeByokConfig(config: ModelHitchConfig | undefined): OpenCodeByokConfig | undefined {
  return config?.opencodeByok;
}

/** True when the block is on and at least one connection is usable. */
export function isOpenCodeByokEnabled(config: ModelHitchConfig | undefined): boolean {
  const byok = openCodeByokConfig(config);
  return !!byok?.enabled && enabledConnections(byok).length > 0;
}

function enabledConnections(byok: OpenCodeByokConfig): OpenCodeByokConnection[] {
  return (byok.connections ?? []).filter(
    (connection) => connection && connection.enabled !== false && typeof connection.id === 'string' && !!connection.id.trim(),
  );
}

/**
 * Models the user runs in OpenCode for a connection, matched by provider name.
 *
 * A connection is matched on its explicit label, its slug, and the connection
 * id itself, so `conn_deepseek` / `DeepSeek` / a label of "deepseek" all line
 * up with OpenCode's `deepseek` provider. Console connection ids are opaque,
 * so the label is the practical join key.
 */
export function openCodeModelsForConnection(
  connection: Pick<OpenCodeByokConnection, 'id' | 'label'>,
  state: OpenCodeLocalState | undefined,
): string[] {
  if (!state?.found || !state.providers.length) return [];
  const candidates = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const slug = openCodeByokSlug(value, '');
    if (slug) candidates.add(slug);
  };
  add(connection.id);
  add(connection.label);
  // `conn_deepseek` -> `deepseek` (openCodeByokSlug already strips the prefix).
  if (!candidates.size) return [];
  for (const provider of state.providers) {
    const slug = openCodeByokSlug(provider.providerId, '');
    if (slug && candidates.has(slug)) return provider.models;
  }
  return [];
}

/** Effective rotation pool for a connection (explicit models, then OpenCode). */
export function openCodeByokModels(
  connection: OpenCodeByokConnection,
  state?: OpenCodeLocalState,
): { models: string[]; fromOpenCode: boolean } {
  const explicit = (connection.models ?? []).map((m) => m.trim()).filter(Boolean);
  if (explicit.length) return { models: explicit, fromOpenCode: false };
  const discovered = openCodeModelsForConnection(connection, state);
  const deduped = [...new Set(discovered.map((m) => m.trim()).filter(Boolean))];
  return { models: deduped, fromOpenCode: deduped.length > 0 };
}

/**
 * Resolve the config block into ready-to-serve connections.
 *
 * With `syncFromOpenCode` on, a connection whose model list is empty inherits
 * the models the user actually runs in OpenCode for the provider of the same
 * name — the "rotate the BYOK models you picked in OpenCode" behavior. An
 * explicit `models` list always wins. A connection that ends up with no models
 * still serves its provider default rather than being silently dropped.
 */
export function resolveOpenCodeByokConnections(
  config: ModelHitchConfig | undefined,
  state?: OpenCodeLocalState,
): ResolvedOpenCodeByokConnection[] {
  const byok = openCodeByokConfig(config);
  if (!byok?.enabled) return [];
  const canSync = state?.found === true && byok.syncFromOpenCode === true;
  const out: ResolvedOpenCodeByokConnection[] = [];
  for (const connection of enabledConnections(byok)) {
    const slug = openCodeByokSlug(connection.id, 'default');
    const synced = canSync
      ? openCodeByokModels(connection, state)
      : { models: (connection.models ?? []).map((m) => m.trim()).filter(Boolean), fromOpenCode: false };
    out.push({
      ...connection,
      providerId: openCodeByokProviderId(connection.id, connection.label),
      slug,
      url: openCodeByokBaseUrl(connection.baseUrl ?? connection.id),
      models: synced.models,
      modelsFromOpenCode: synced.fromOpenCode || undefined,
    });
  }
  return out;
}

export interface OpenCodeByokProviderOptions {
  fetchImpl?: typeof fetch;
  /** Local OpenCode snapshot used to seed empty model lists (`syncFromOpenCode`). */
  state?: OpenCodeLocalState;
}

/** One Provider per enabled Console BYOK connection. */
export function openCodeByokProviders(
  config: ModelHitchConfig | undefined,
  options: OpenCodeByokProviderOptions = {},
): Provider[] {
  return resolveOpenCodeByokConnections(config, options.state).map((connection) =>
    createOpenCodeByokProvider(connection, {
      id: connection.providerId,
      defaultModel: connection.models[0],
      fetchImpl: options.fetchImpl,
    }),
  );
}

/**
 * Per-connection credentials for the server's `apiKeys` map.
 *
 * Console BYOK runs off the Console service-account key — the same credential
 * as the OpenCode Zen/Go lanes — so the shared key is reused by default. A
 * dedicated `keys["opencode-byok"]` or a per-connection
 * `keys["opencode-byok-<slug>"]` overrides it when a workspace issues a
 * separate service-account key.
 */
export function openCodeByokApiKeys(
  config: ModelHitchConfig | undefined,
  options: OpenCodeByokProviderOptions = {},
): Record<string, string> {
  const keys = config?.keys ?? {};
  const shared =
    keys[OPENCODE_BYOK_KEY_ID] ??
    keys['opencode'] ??
    keys['opencode-go'] ??
    process.env[OPENCODE_BYOK_KEY_ENV];
  const out: Record<string, string> = {};
  for (const connection of resolveOpenCodeByokConnections(config, options.state)) {
    const key = keys[connection.providerId] ?? shared;
    if (key) out[connection.providerId] = key;
  }
  return out;
}

/** True when a lane belongs to a Console BYOK connection. */
export function isOpenCodeByokLane(providerId: string): boolean {
  return isOpenCodeByokProviderId(providerId);
}

export interface OpenCodeByokPlanInput {
  config: ModelHitchConfig | undefined;
  policy?: Policy;
  defaultProviderId?: string;
  defaultModel?: string;
  state?: OpenCodeLocalState;
}

export interface OpenCodeByokPlan {
  policy?: Policy;
  defaultProviderId?: string;
  defaultModel?: string;
  /** Ordered provider/model lanes the BYOK block contributed, for logging. */
  lanes: Array<{ providerId: string; model: string }>;
}

/**
 * Merge the BYOK block into the routing plan.
 *
 * Rotation puts every connection × model lane at the FRONT of `trusted` — the
 * primary is the first of them, so the pool really does rotate, and the user's
 * configured lanes stay directly behind it as the safety net. Pinned keeps one
 * connection's lane as the primary and its remaining models immediately after,
 * so a depleted connection still falls through to another provider.
 *
 * Returns the input untouched when the block is off or unusable.
 */
export function applyOpenCodeByokPlan(input: OpenCodeByokPlanInput): OpenCodeByokPlan {
  const byok = openCodeByokConfig(input.config);
  const connections = resolveOpenCodeByokConnections(input.config, input.state);
  if (!byok?.enabled || connections.length === 0) {
    return { policy: input.policy, defaultProviderId: input.defaultProviderId, defaultModel: input.defaultModel, lanes: [] };
  }

  const entries: TrustListEntry[] = connections.map((connection) => ({
    providerId: connection.providerId,
    ...(connection.models.length ? { models: connection.models } : {}),
  }));
  const lanes: Array<{ providerId: string; model: string }> = [];
  for (const connection of connections) {
    for (const model of connection.models) lanes.push({ providerId: connection.providerId, model });
  }

  const base: Policy = input.policy ?? { trusted: [], fallback: [] };
  const pinned = byok.mode === 'pinned';
  const pinnedIndex = pinned ? connections.findIndex((connection) => connection.id === byok.pinnedConnectionId) : -1;
  const pinnedConnection = pinned ? connections[pinnedIndex === -1 ? 0 : pinnedIndex] : undefined;

  // Pinned mode leads with the pinned connection; rotation leads with every
  // connection in document order.
  const orderedEntries = pinnedConnection
    ? [entries[connections.indexOf(pinnedConnection)]!, ...entries.filter((_, index) => index !== connections.indexOf(pinnedConnection))]
    : entries;

  const policy: Policy = {
    ...base,
    trusted: [...orderedEntries, ...(base.trusted ?? [])],
    fallback: [...(base.fallback ?? [])],
  };

  const primary = pinned && pinnedConnection
    ? {
        providerId: pinnedConnection.providerId,
        model: byok.pinnedModel?.trim() || pinnedConnection.models[0] || undefined,
      }
    : { providerId: connections[0]!.providerId, model: connections[0]!.models[0] || undefined };

  return {
    policy,
    defaultProviderId: primary.providerId,
    defaultModel: primary.model,
    lanes,
  };
}

/** One-line summary of the BYOK plan, for the bridge banner and the log. */
export function describeOpenCodeByokPlan(plan: OpenCodeByokPlan, config: ModelHitchConfig | undefined): string | undefined {
  if (!plan.lanes.length) return undefined;
  const mode = openCodeByokConfig(config)?.mode === 'pinned' ? 'pinned' : 'rotation';
  const head = plan.lanes.slice(0, 4).map((lane) => `${lane.providerId}/${lane.model}`).join(', ');
  const more = plan.lanes.length > 4 ? ` (+${plan.lanes.length - 4} more)` : '';
  return `OpenCode BYOK ${mode}: ${plan.lanes.length} lane${plan.lanes.length === 1 ? '' : 's'} — ${head}${more}`;
}
