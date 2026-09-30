import type { Capabilities } from '../core/types.js';
import type { ModelInfo, Provider } from './types.js';
import {
  createOpenCodeProvider,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_SNAPSHOT_MODELS,
  OPENCODE_USER_AGENT,
  type OpenCodeWire,
} from './opencode.js';

/**
 * OpenCode Console BYOK.
 *
 * Console's BYOK feature ("bring your own key") connects a provider account you
 * already pay for to an OpenCode workspace. Console stores the provider
 * credential and gives each connection exactly one gateway URL:
 *
 *   https://opencode.ai/inference/custom/<connection_id>
 *
 * Members and integrations call that URL with a Console *service account key*
 * — never the provider secret — and Console swaps the key for the connection's
 * credential before forwarding. Four API schemas are supported, each with its
 * own path under the connection URL:
 *
 *   Chat Completions      /chat/completions
 *   Responses API         /responses
 *   Anthropic Compatible  /messages
 *   Google Generative AI  /models/<model>:generateContent
 *
 * See https://opencode.ai/v2/docs/console/byok/
 *
 * ModelHitch models one Console connection as one Provider, so a connection is
 * a first-class lane: it gets its own provider id, its own circuit-breaker
 * health, its own place in the rotation, and it works with `bridge --provider
 * <id>` like any other provider. The wire is fixed per connection (Console
 * fixes the schema at connection time), which is why the schema is passed
 * through as `forceWire` instead of being detected from the model id.
 */

/** Root of every Console BYOK gateway URL. */
export const OPENCODE_BYOK_BASE_URL_PREFIX = 'https://opencode.ai/inference/custom';

/** Provider id prefix — one provider per connection (`opencode-byok-<slug>`). */
export const OPENCODE_BYOK_PROVIDER_PREFIX = 'opencode-byok-';

/**
 * Config key holding the Console service account key shared by every BYOK
 * connection. Falls back to `keys.opencode` / `keys.opencode-go` /
 * `OPENCODE_API_KEY`, because the Console key and the Zen key are the same
 * credential in practice.
 */
export const OPENCODE_BYOK_KEY_ID = 'opencode-byok';

/** Env var consulted after the config keys, matching the Zen/Go lanes. */
export const OPENCODE_BYOK_KEY_ENV = 'OPENCODE_API_KEY';

/** Console API schemas, as named on the connection page. */
export type OpenCodeByokSchema = 'auto' | 'chat-completions' | 'responses' | 'anthropic' | 'google';

/** Schema -> wire. `auto` keeps the Zen/Go family detection. */
export function openCodeByokWire(schema: OpenCodeByokSchema | undefined): OpenCodeWire | undefined {
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
 * URL-safe slug for a connection id or label. Console connection ids look like
 * `conn_02bb39d0c001jtG67gsmQfZw83`; the slug drops the punctuation so the
 * provider id survives `providerId/model` routing, shell quoting, and the
 * lane-health table without escaping.
 */
export function openCodeByokSlug(value: string, fallback = 'default'): string {
  const clean = (input: string): string =>
    (input ?? '')
      .trim()
      .toLowerCase()
      .replace(/^conn[_-]/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  return clean(value) || clean(fallback) || 'default';
}

/** Provider id for a Console connection (`opencode-byok-<slug>`). */
export function openCodeByokProviderId(connectionId: string, fallback?: string): string {
  return `${OPENCODE_BYOK_PROVIDER_PREFIX}${openCodeByokSlug(connectionId, fallback)}`;
}

/** True when a provider id belongs to a Console BYOK connection. */
export function isOpenCodeByokProviderId(providerId: string): boolean {
  return providerId.startsWith(OPENCODE_BYOK_PROVIDER_PREFIX);
}

/**
 * The Console API URL for a connection. Accepts a bare connection id, a full
 * `https://…/inference/custom/<id>` URL (returned unchanged), or any custom
 * gateway URL the workspace exposes.
 */
export function openCodeByokBaseUrl(connectionIdOrUrl: string): string {
  const value = connectionIdOrUrl.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(value)) return value;
  return `${OPENCODE_BYOK_BASE_URL_PREFIX}/${value.replace(/^\/+/, '')}`;
}

/** One Console BYOK connection, as stored in the config document. */
export interface OpenCodeByokConnectionInput {
  /** Console connection id (`conn_…`) or a full gateway URL. */
  id: string;
  /** Display label; defaults to the id. */
  label?: string;
  /** Overrides the derived `https://opencode.ai/inference/custom/<id>` URL. */
  baseUrl?: string;
  /** Console API schema. `auto` (default) detects the wire from the model family. */
  schema?: OpenCodeByokSchema;
  /** Model ids enabled on the connection — the rotation pool. */
  models?: string[];
  /** Off = configured but out of rotation. */
  enabled?: boolean;
  /** Per-connection key override; falls back to the shared Console key. */
  apiKey?: string;
  /** Per-connection capability overrides (a connection whose upstream cannot do tools, …). */
  capabilities?: Partial<Capabilities>;
}

export interface CreateOpenCodeByokProviderOptions {
  /** Provider id override; defaults to `opencode-byok-<slug>`. */
  id?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Build the Provider for one Console BYOK connection. The returned provider
 * speaks the connection's schema, advertises exactly the models the connection
 * enables (Console rejects anything else before it reaches the upstream), and
 * identifies itself the way OpenCode asks clients to.
 */
export function createOpenCodeByokProvider(
  connection: OpenCodeByokConnectionInput,
  options: CreateOpenCodeByokProviderOptions = {},
): Provider {
  const models = (connection.models ?? []).map((m) => m.trim()).filter(Boolean);
  const id = options.id ?? openCodeByokProviderId(connection.id, connection.label);
  const defaultModel = options.defaultModel ?? models[0] ?? OPENCODE_DEFAULT_MODEL;
  const baseUrl = openCodeByokBaseUrl(connection.baseUrl ?? connection.id);

  const provider = createOpenCodeProvider({
    id,
    name: connection.label?.trim() || `OpenCode BYOK (${connection.id})`,
    baseUrl,
    defaultModel,
    apiKeyEnvVar: OPENCODE_BYOK_KEY_ENV,
    // The Console key is a service account key, not the upstream provider key:
    // Console swaps it for the connection credential before forwarding.
    forceWire: openCodeByokWire(connection.schema),
    fetchImpl: options.fetchImpl,
    headers: { 'User-Agent': OPENCODE_USER_AGENT },
    capabilities: connection.capabilities,
  });

  // Console exposes no `GET /models` on a connection URL, so the Zen snapshot
  // would advertise models this connection cannot serve. The connection's own
  // list is the authority.
  return {
    ...provider,
    async listModels(): Promise<ModelInfo[]> {
      if (models.length) return models.map((modelId) => ({ id: modelId, name: modelId }));
      return OPENCODE_SNAPSHOT_MODELS.map((modelId) => ({ id: modelId, name: modelId }));
    },
  };
}
