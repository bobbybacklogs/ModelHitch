import { ModelsDevClient } from 'mdev-sdk';
import type {
  Provider as MdevProvider,
  Model as MdevModel,
  ModelCost,
  Limit,
} from 'mdev-sdk';
import type { Capabilities } from '../core/types.js';
import type { Provider } from '../providers/types.js';
import type { ProviderSource } from '../core/policy.js';
import { createOpenAICompatibleProvider, type OpenAICompatibleConfig } from '../providers/openai-compatible.js';
import { OPENCODE_SNAPSHOT_MODELS } from '../providers/opencode.js';

/**
 * Milestone 2 — models.dev catalog integration.
 *
 * ModelHitch consumes mdev-sdk (GV-owned, published independently); the
 * catalog is the *model discovery* layer, and ModelHitch's registry remains
 * the *executable* layer:
 *
 * - Providers with ids in the registry: the curated ModelHitch adapter wins
 *   (tuned base URLs, capabilities, Zen wires). The catalog still supplies
 *   their full model inventory via `modelsFor`.
 * - Catalog-only providers that carry a models.dev `api` URL: an
 *   OpenAI-compatible adapter is auto-built (base URL + env var names from
 *   the catalog), so they are callable without writing provider code.
 * - Catalog-only providers WITHOUT an `api` URL: metadata-only — known to the
 *   catalog, their models and env vars are discoverable, but they are not
 *   directly executable unless a base URL is supplied via `baseUrls`.
 *
 * Why not shape-based adapter selection? models.dev only marks 33 of ~6,700
 * models with a provider `shape` ("responses" | "completions") — the other
 * ~6,657 carry nothing. The OpenAI-compatible chat-completions adapter is the
 * correct default; shape-aware adaptation can be layered on later.
 */

/** Model metadata surfaced from the catalog (pricing + limits live here). */
export interface CatalogModelMeta {
  id: string;
  name?: string;
  contextLength?: number;
  maxOutput?: number;
  inputCostPer1M?: number;
  outputCostPer1M?: number;
  reasoning?: boolean;
  toolCall?: boolean;
  status?: 'alpha' | 'beta' | 'deprecated';
}

export interface CatalogProviderMeta {
  id: string;
  name: string;
  /** Env var names the provider accepts for API keys (models.dev `env`). */
  env: string[];
  /** models.dev base URL, when the provider exposes one. */
  api?: string;
  models: CatalogModelMeta[];
}

export interface CatalogSourceOptions {
  /** Reuse an mdev-sdk client (defaults to one built from baseUrl/fetch/ttlMs). */
  client?: ModelsDevClient;
  /** models.dev base URL (default "https://models.dev"). */
  baseUrl?: string;
  /** Injectable fetch for the mdev-sdk catalog client (tests, workers). */
  fetch?: typeof fetch;
  /** Catalog cache lifetime in ms (default 1h). */
  ttlMs?: number;
  /** The curated executable layer. On id conflicts the registry provider wins. */
  registry?: readonly Provider[];
  /** BYO base URLs for catalog providers that lack a models.dev `api`. */
  baseUrls?: Record<string, string>;
  /**
   * Optional catalog id allowlist — the "pick your providers" knob. Registry
   * providers are never filtered; this only limits which catalog-only
   * providers become executable.
   */
  allow?: string[];
  /** Injectable fetch for auto-built adapters (defaults to global fetch). */
  adapterFetch?: typeof fetch;
  /** Per-provider capability overrides for auto-built adapters. */
  capabilities?: (meta: CatalogProviderMeta) => Partial<Capabilities> | undefined;
}

/** Why a catalog provider is (or isn't) executable. */
export type CatalogUsability = 'registry' | 'built' | 'metadata-only';

export interface CatalogSource extends ProviderSource {
  readonly kind: 'catalog';
  readonly warmed: boolean;
  /** Fetch the catalog (api.json) and build the executable provider set. */
  warm(): Promise<void>;
  /** Executable provider set: registry (curated) first, then auto-built catalog-only. */
  providers(): Provider[];
  lookup(providerId: string): Provider | undefined;
  defaultModel(providerId: string): string | undefined;
  /** Catalog model inventory for any known provider (executable or not). */
  modelsFor(providerId: string): string[] | undefined;
  /** Catalog metadata for any known provider (executable or not), after warm. */
  metadata(providerId: string): CatalogProviderMeta | undefined;
  /** How the provider is served. */
  usability(providerId: string): CatalogUsability | undefined;
  /** Why a metadata-only provider is not executable, else undefined. */
  usabilityReason(providerId: string): string | undefined;
  /** Executable provider ids (registry + auto-built). */
  executableIds(): string[];
  /** All catalog provider ids (including metadata-only). */
  catalogIds(): string[];
  /** Drop the mdev-sdk cache (keeps built providers). */
  clearCatalogCache(): void;
}

function modelMeta(model: MdevModel): CatalogModelMeta {
  const cost: ModelCost | undefined = model.cost;
  const limit: Limit | undefined = model.limit;
  return {
    id: model.id,
    name: model.name,
    contextLength: limit?.context,
    maxOutput: limit?.output,
    inputCostPer1M: cost?.input,
    outputCostPer1M: cost?.output,
    reasoning: model.reasoning,
    toolCall: model.tool_call,
    status: model.status,
  };
}

function providerMeta(p: MdevProvider): CatalogProviderMeta {
  return {
    id: p.id,
    name: p.name,
    env: p.env ?? [],
    api: p.api,
    models: Object.values(p.models ?? {}).map(modelMeta),
  };
}

export function createCatalogSource(options: CatalogSourceOptions = {}): CatalogSource {
  const client = options.client ?? new ModelsDevClient({ baseUrl: options.baseUrl, fetch: options.fetch, ttlMs: options.ttlMs });
  const registry = options.registry ?? [];
  const registryById = new Map(registry.map((p) => [p.id, p] as const));
  const allowed = options.allow ? new Set(options.allow) : undefined;
  const adapterFetch = options.adapterFetch ?? ((...args) => fetch(...args));

  let warmed = false;
  let providerList: CatalogProviderMeta[] = [];
  let builtProviders: Provider[] = [];
  const builtById = new Map<string, Provider>();
  const metaById = new Map<string, CatalogProviderMeta>();

  function warmSync(): void {
    if (!warmed) {
      throw new Error(
        'CatalogSource has not been warmed — call await source.warm() first (or use ModelHitch.create).',
      );
    }
  }

  function buildAdapter(meta: CatalogProviderMeta, baseUrl: string): Provider {
    // Deterministic default: prefer the first model that looks like a chat
    // model (not deprecated, has a max output) over raw insertion order —
    // insertion order has picked deprecated/embedding-ish models live.
    const preferred = meta.models.find((m) => !m.status && (m.maxOutput ?? 0) > 0);
    const defaultModel = (preferred ?? meta.models[0])?.id ?? 'local-model';
    const maxContext = Math.max(0, ...meta.models.map((m) => m.contextLength ?? 0)) || undefined;
    const caps = options.capabilities?.(meta);
    return createOpenAICompatibleProvider({
      id: meta.id,
      name: meta.name,
      baseUrl,
      defaultModel,
      apiKeyEnvVar: meta.env[0],
      apiKeyEnvFallbacks: meta.env.slice(1),
      requiresKey: meta.env.length > 0,
      capabilities: {
        streaming: true,
        toolCalling: true,
        vision: true,
        embeddings: false,
        maxContextTokens: maxContext,
        ...caps,
      },
      fetchImpl: adapterFetch,
    });
  }

  return {
    kind: 'catalog',
    get warmed() {
      return warmed;
    },

    async warm(): Promise<void> {
      const map = await client.providers();
      const metas: CatalogProviderMeta[] = [];
      for (const p of Object.values(map)) {
        metas.push(providerMeta(p));
      }
      providerList = metas.sort((a, b) => a.id.localeCompare(b.id));

      // Registry providers keep their curated adapters (and their position),
      // and their catalog metadata stays intact (registry-only ids get an
      // empty shell so lookups never fail).
      metaById.clear();
      for (const m of providerList) metaById.set(m.id, m);
      for (const p of registry) {
        let entry = metaById.get(p.id);
        if (!entry) {
          entry = { id: p.id, name: p.name, env: [], models: [] };
          metaById.set(p.id, entry);
        }
        if ((p.id === 'opencode' || p.id === 'opencode-go') && entry.models.length === 0) {
          const zenMeta = metaById.get('opencode');
          if (zenMeta && zenMeta.models.length > 0 && p.id === 'opencode-go') {
            entry.models = [...zenMeta.models];
          } else {
            entry.models = OPENCODE_SNAPSHOT_MODELS.map((id) => ({ id, name: id }));
          }
          if (entry.env.length === 0) {
            entry.env = ['OPENCODE_API_KEY'];
          }
        }
      }

      // Executable set: registry first (curated), then auto-built catalog-only.
      const built: Provider[] = [];
      const builtMap = new Map<string, Provider>();
      for (const p of registry) {
        built.push(p);
        builtMap.set(p.id, p);
      }
      for (const meta of providerList) {
        if (builtMap.has(meta.id)) continue; // registry wins
        if (allowed && !allowed.has(meta.id)) continue; // allowlist filter
        const baseUrl = meta.api ?? options.baseUrls?.[meta.id];
        if (!baseUrl) continue; // metadata-only — no way to reach it yet
        const adapter = buildAdapter(meta, baseUrl);
        built.push(adapter);
        builtMap.set(meta.id, adapter);
      }
      builtProviders = built;
      builtById.clear();
      for (const [id, p] of builtMap) builtById.set(id, p);
      warmed = true;
    },

    providers(): Provider[] {
      warmSync();
      return builtProviders;
    },

    lookup(providerId: string): Provider | undefined {
      warmSync();
      return builtById.get(providerId);
    },

    defaultModel(providerId: string): string | undefined {
      warmSync();
      return builtById.get(providerId)?.defaultModel;
    },

    modelsFor(providerId: string): string[] | undefined {
      warmSync();
      const meta = metaById.get(providerId);
      if (!meta) return undefined;
      const ids = meta.models.map((m) => m.id);
      return ids.length ? ids : undefined;
    },

    metadata(providerId: string): CatalogProviderMeta | undefined {
      warmSync();
      return metaById.get(providerId);
    },

    usability(providerId: string): CatalogUsability | undefined {
      warmSync();
      if (!metaById.has(providerId)) return undefined;
      if (builtById.has(providerId)) return registryById.has(providerId) ? 'registry' : 'built';
      return 'metadata-only';
    },

    usabilityReason(providerId: string): string | undefined {
      warmSync();
      const meta = metaById.get(providerId);
      if (!meta) return undefined;
      if (allowed && !allowed.has(providerId)) {
        return 'not in the catalog allowlist (configure `allow`)';
      }
      if (!meta.api && !options.baseUrls?.[providerId]) {
        return 'has no API base URL in models.dev — configure `baseUrls` to make it callable';
      }
      return undefined;
    },

    executableIds(): string[] {
      warmSync();
      return [...builtById.keys()];
    },

    catalogIds(): string[] {
      warmSync();
      return [...metaById.keys()];
    },

    clearCatalogCache(): void {
      client.clearCache();
    },
  };
}

/** Convenience: does the source make this provider callable? */
export function isCallableProvider(source: ProviderSource, providerId: string): boolean {
  return source.lookup(providerId) !== undefined;
}