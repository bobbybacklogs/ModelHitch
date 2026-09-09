import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelHitchError } from '../core/errors.js';
import { estimateCost } from '../core/cost.js';
import type { KeyStore } from '../core/keystore.js';
import type { ChatParams, ProviderCredentials, StreamChunk, Usage } from '../core/types.js';
import { defaultProviders } from '../registry.js';
import type { Provider } from '../providers/types.js';
import {
  resolveLanes,
  retryableCodesFor,
  maxAttemptsFor,
  withFailover,
  withFailoverStream,
  DEFAULT_RETRYABLE_CODES,
  type AutoModeOptions,
  type ExhaustionInfo,
  type FailoverEvent,
  type FailoverTarget,
  type LaneCooldown,
} from '../core/failover.js';
import {
  createRegistrySource,
  resolvePolicyLanes,
  computeBackoffDelay,
  type Policy,
  type ProviderSource,
} from '../core/policy.js';
import { CircuitBreaker, type LaneHealth } from '../core/circuit-breaker.js';
import { MemoryLaneCooldown } from '../core/cooldown.js';
import { inferRequirements, filterEligibleLanes, CapabilityUnavailableError, type CapabilityRequirements } from '../core/capabilities.js';
import type { CatalogSource } from '../catalog/source.js';
import { settingsPageHtml } from '../settings-page.js';
import { UsageTracker, usageDashboardHtml, type UsageEvent } from '../core/usage.js';
import { SqliteUsageStorage } from '../core/usage-storage.js';
import { mapFinishReasonOpenAI, mapRequest, routeModel, toChatCompletion, toOpenAIError, toUsageOutput } from './mapping.js';
import {
  estimateAnthropicInputTokens,
  mapAnthropicRequest,
  toAnthropicCompletion,
  toAnthropicError,
  toAnthropicStreamEvents,
  type AnthropicRequest,
} from './anthropic-wire.js';
import {
  estimateGeminiInputTokens,
  mapGeminiRequest,
  toGeminiCompletion,
  toGeminiError,
  toGeminiStreamEvents,
  type GeminiRequest,
} from './gemini-wire.js';
import {
  assistantMessagesFromResult,
  mapResponsesRequest,
  resolveConversation,
  toResponsesCompletion,
  toResponsesStreamEvents,
  toolMessagesFromOutputs,
  toolOutputsFromInput,
  type ResponsesRequest,
} from './responses.js';
import { clearConversations, findConversationWithToolCall, rememberConversation } from './conversation-state.js';
import { normalizeBodyImages } from './local-images.js';
import { extractSessionId } from '../core/session.js';
import type { OpenAIChatRequest, OpenAIModelEntry, OpenAIStreamChunk } from './types.js';
import type { ImageGenerationConfig } from '../config.js';
import { safeJsonParse } from '../core/json.js';

export interface ModelHitchServerOptions {
  /** Providers to serve. Defaults to the built-in set. */
  providers?: Provider[];
  /** BYOK store consulted per request (after `apiKeys`). */
  keystore?: KeyStore;
  /** Provider used for bare model ids and when none is specified. */
  defaultProviderId?: string;
  /** Default model when the request omits one. */
  defaultModel?: string;
  /** Dedicated image lane config, disabled by default. */
  imageGeneration?: ImageGenerationConfig;
  /** Image upstream fetch implementation. Primarily useful for deterministic tests. */
  imageFetch?: typeof fetch;
  /** Per-provider API key overrides, e.g. `{ 'vercel-ai-gateway': '…' }`. */
  apiKeys?: Record<string, string>;
  /** Per-provider base URL overrides. */
  baseUrls?: Record<string, string>;
  /**
   * Extra models to advertise in `GET /v1/models` per provider, e.g.
   * `{ 'vercel-ai-gateway': ['openai/gpt-5.4'] }`. Merged with live `/models`
   * discovery where the provider supports it.
   */
  staticModels?: Record<string, string[]>;
  /** Request body size cap in bytes. Default 64 MiB (room for inline base64 images). */
  maxBodyBytes?: number;
  /** Called once per request with a one-line summary. */
  logger?: (line: string) => void;
  /**
   * Called once per completed inference request with token usage + cost.
   * Fires for successful non-stream calls and for streams that run to
   * completion (not for aborted/disconnected streams). Handy for dashboards,
   * per-user metering, or rate-limit accounting.
   */
  onUsage?: (event: UsageEvent) => void;
  /**
   * auto-mode: transparent failover to fallback lanes when the primary lane
   * errors (429 rate limits, 5xx, network blips). `true` uses the default
   * lineup (cheap Go model, then free Zen models); pass `AutoModeOptions` for
   * custom lanes/models. Applies to every wire, stream and non-stream.
   * Mutually exclusive with `policy`.
   */
  autoMode?: AutoModeOptions | boolean;
  /**
   * Policy-driven routing (Milestone 1). The lane is the meaningful trust
   * object. Higher-level than `autoMode` — configure one or the other, never
   * both.
   */
  policy?: Policy;
  /**
   * Lane-health memory used when `policy` is set. Defaults to
   * `MemoryLaneCooldown` (registry) / `CircuitBreaker` (when `catalogSource`
   * is provided). The settings UI reads this via `GET /v1/lane-health`.
   */
  cooldown?: LaneCooldown;
  /** Warmed models.dev catalog source (provider inventory + lane health). */
  catalogSource?: CatalogSource;
  /**
   * Settings surface backing `GET/PUT /v1/config`. Implemented by the daemon:
   * read the (masked) config, validate + persist + apply on update.
   */
  configBridge?: ConfigBridge;
  /** Called when auto-mode walks every lane and work stops. */
  onExhausted?: (info: ExhaustionInfo) => void;
  /** Called each time auto-mode switches lanes. */
  onFailover?: (event: FailoverEvent) => void;
  /**
   * Usage tracker backing `GET /v1/usage` and `GET /usage`. Defaults to an
   * internal in-memory tracker.
   */
  usageTracker?: UsageTracker;
  /**
   * Persist usage + failover history to SQLite so it survives restarts.
   * `true` writes to `modelhitch-usage.db` in the working directory; a string
   * is a custom file path (parent directories are created). Requires Node
   * >= 22.5 (`node:sqlite`). Ignored when `usageTracker` is provided.
   */
  usagePersistence?: boolean | string;
}

/** One completed inference request, as reported to the `onUsage` hook. */
export type { UsageEvent } from '../core/usage.js';

/**
 * Settings surface implemented by the daemon (config file + hot reload).
 * The server only proxies: GET returns the masked document, PUT validates
 * + persists + applies. When absent, `/v1/config` returns an empty document
 * and PUT returns 501.
 */
export interface ConfigBridge {
  /** The masked config document (never contains plaintext keys). */
  getConfig(): unknown;
  /** Validate + persist + apply. Errors are shown verbatim in the settings UI. */
  updateConfig(next: unknown): Promise<{ ok: boolean; errors?: string[] }>;
}

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024; // images arrive as inline base64 — 10 MiB was too small

const GEMINI_ASPECT_RATIOS = new Set(['1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9']);

function geminiImageConfig(size: string): { aspectRatio: string; imageSize: '1K' | '2K' | '4K' } | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height || Math.max(width, height) > 4096) return undefined;
  const gcd = (left: number, right: number): number => right === 0 ? left : gcd(right, left % right);
  const divisor = gcd(width, height);
  const aspectRatio = `${width / divisor}:${height / divisor}`;
  if (!GEMINI_ASPECT_RATIOS.has(aspectRatio)) return undefined;
  const longestEdge = Math.max(width, height);
  return { aspectRatio, imageSize: longestEdge <= 1024 ? '1K' : longestEdge <= 2048 ? '2K' : '4K' };
}

/** A routable lane: provider + model + the credentials to call it with. */
interface ResolvedLane extends FailoverTarget {
  provider: Provider;
  credentials: ProviderCredentials;
}

/**
 * A local, OpenAI-compatible HTTP server in front of the ModelHitch harness.
 *
 * Agentic IDEs (Android Studio's Agent Mode, JetBrains AI, Cursor, ...) that
 * accept a "custom model endpoint" can point at this server and drive any
 * registered provider — Vercel AI Gateway, OpenAI, Anthropic, Ollama, ... —
 * with tools, multi-turn roles, and SSE streaming. Keys resolve locally
 * (apiKeys > keystore > provider env fallback) and never leave the machine.
 *
 * Endpoints:
 * - `POST /v1/chat/completions` (stream + non-stream)
 * - `POST /v1/responses` (stream + non-stream — Codex CLI / Responses-API clients)
 * - `POST /v1/messages` (stream + non-stream — Claude Code / Anthropic-format clients)
 * - `POST /v1/messages/count_tokens` (Claude Code token counting)
 * - `POST /v1beta/models/:model:generateContent` and
 *   `POST /v1beta/models/:model:streamGenerateContent?alt=sse`
 *   (Gemini CLI / Google-native clients)
 * - `GET /v1/models` and `GET /v1/models/:id`
 * - `HEAD /api/hello` (Claude Code connection-warming probe)
 * - `GET /healthz`
 *
 * Model routing: `providerId/modelId` (e.g. `vercel-ai-gateway/openai/gpt-5.4`); bare
 * model ids go to the default provider.
 */
export class OpenAICompatibleServer {
  providers: Provider[];
  readonly options: ModelHitchServerOptions;
  private httpServer: Server | null = null;
  private usageTracker: UsageTracker;
  private ownsUsageTracker = false;
  private imageGeneration: ImageGenerationConfig | undefined;
  private policy: Policy | undefined;
  private cooldown: LaneCooldown | undefined;
  private source: ProviderSource;
  private catalogSource: CatalogSource | undefined;

  constructor(options: ModelHitchServerOptions = {}) {
    this.options = options;
    this.providers = options.providers ?? defaultProviders;
    this.imageGeneration = options.imageGeneration;
    this.catalogSource = options.catalogSource;
    this.source = this.catalogSource ?? createRegistrySource(this.providers);
    this.policy = options.policy;
    if (options.policy && options.autoMode) {
      throw new ModelHitchError(
        'bad-request',
        'Configure either "policy" or "autoMode", not both. Policy is the higher-level replacement.',
        {},
      );
    }
    if (this.policy) {
      this.cooldown = options.cooldown ?? (this.catalogSource ? new CircuitBreaker() : new MemoryLaneCooldown());
    }
    if (options.usageTracker) {
      this.usageTracker = options.usageTracker;
    } else if (options.usagePersistence) {
      const file = typeof options.usagePersistence === 'string' ? options.usagePersistence : undefined;
      this.usageTracker = new UsageTracker(new SqliteUsageStorage(file));
      this.ownsUsageTracker = true;
      this.log(`usage persistence: SQLite (${file ?? 'modelhitch-usage.db'})`);
    } else {
      this.usageTracker = new UsageTracker();
    }
  }

  /**
   * Hot-reload the routing state (settings UI "Apply"). Providers, policy,
   * keys, and health engine swap atomically by reference — in-flight requests
   * finish on the state they started with.
   */
  reconfigure(partial: {
    providers?: Provider[];
    policy?: Policy;
    autoMode?: AutoModeOptions | boolean;
    cooldown?: LaneCooldown;
    catalogSource?: CatalogSource;
    apiKeys?: Record<string, string>;
    baseUrls?: Record<string, string>;
    defaultProviderId?: string;
    defaultModel?: string;
    imageGeneration?: ImageGenerationConfig;
    keystore?: KeyStore;
    staticModels?: Record<string, string[]>;
  }): void {
    if (partial.providers) this.providers = partial.providers;
    if (partial.catalogSource !== undefined) {
      this.catalogSource = partial.catalogSource;
      this.source = this.catalogSource ?? createRegistrySource(this.providers);
    } else if (partial.providers && !this.catalogSource) {
      this.source = createRegistrySource(this.providers);
    }
    if (partial.policy !== undefined) {
      if (partial.policy && this.options.autoMode) {
        throw new ModelHitchError('bad-request', 'Cannot set a policy while autoMode is active.', {});
      }
      this.policy = partial.policy;
      this.options.autoMode = partial.policy ? undefined : this.options.autoMode;
    }
    if (partial.autoMode !== undefined) {
      if (partial.autoMode && this.policy) {
        throw new ModelHitchError('bad-request', 'Cannot enable autoMode while a policy is active.', {});
      }
      this.options.autoMode = partial.autoMode;
      if (partial.autoMode) this.policy = undefined;
    }
    if (partial.cooldown !== undefined) this.cooldown = partial.cooldown;
    else if (partial.policy !== undefined) this.cooldown = this.catalogSource ? new CircuitBreaker() : new MemoryLaneCooldown();
    if (partial.apiKeys !== undefined) this.options.apiKeys = partial.apiKeys;
    if (partial.baseUrls !== undefined) this.options.baseUrls = partial.baseUrls;
    if (partial.defaultProviderId !== undefined) this.options.defaultProviderId = partial.defaultProviderId;
    if (partial.defaultModel !== undefined) this.options.defaultModel = partial.defaultModel;
    if (partial.imageGeneration !== undefined) {
      this.imageGeneration = partial.imageGeneration;
      this.options.imageGeneration = partial.imageGeneration;
    }
    if (partial.keystore !== undefined) this.options.keystore = partial.keystore;
    if (partial.staticModels !== undefined) this.options.staticModels = partial.staticModels;
  }

  /** Start listening. `port` defaults to 0 (ephemeral). */
  listen(port = 0, host = '127.0.0.1'): Promise<{ server: Server; port: number; url: string }> {
    if (this.httpServer) return Promise.reject(new Error('Server is already listening.'));
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.dispatch(req, res).catch((err) => this.sendError(res, err));
      });
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        server.on('error', (err) => this.log(`server error: ${String(err)}`));
        this.httpServer = server;
        const actual = (server.address() as AddressInfo).port;
        const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actual}`;
        resolve({ server, port: actual, url });
      });
    });
  }

  /** Stop the server (also closes an internally-created usage tracker). */
  close(): Promise<void> {
    clearConversations();
    if (this.ownsUsageTracker) {
      this.usageTracker.close();
      this.ownsUsageTracker = false;
    }
    return new Promise((resolve, reject) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
      this.httpServer = null;
    });
  }

  // ---------------------------------------------------------------------------
  // Routing
  // ---------------------------------------------------------------------------

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (method === 'OPTIONS') {
      this.cors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && (path === '/health' || path === '/healthz')) {
      this.log(`${method} ${path} 200`);
      this.sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (method === 'GET' && path === '/v1/models') {
      this.log(`${method} ${path} ->`);
      await this.handleModels(res);
      return;
    }

    if (method === 'GET' && path.startsWith('/v1/models/')) {
      this.log(`${method} ${path} ->`);
      await this.handleModelById(res, decodeURIComponent(path.slice('/v1/models/'.length)));
      return;
    }

    if (method === 'POST' && path === '/v1/chat/completions') {
      this.log(`${method} ${path} ->`);
      await this.handleChat(req, res);
      return;
    }

    if (method === 'POST' && path === '/v1/images/generations') {
      this.log(`${method} ${path} ->`);
      await this.handleImageGeneration(req, res);
      return;
    }

    if (method === 'POST' && path === '/v1/responses') {
      this.log(`${method} ${path} ->`);
      await this.handleResponses(req, res);
      return;
    }

    // Claude Code / Anthropic-format gateways. Claude Code posts to
    // `/v1/messages?beta=true` — `url.pathname` strips the query for us.
    if (method === 'POST' && path === '/v1/messages') {
      this.log(`${method} ${path} ->`);
      try {
        await this.handleAnthropic(req, res);
      } catch (err) {
        // Non-stream Anthropic errors use the Anthropic error envelope.
        if (res.headersSent) throw err;
        const { status, body } = toAnthropicError(err);
        const error = body.error as { type?: string; message?: string };
        this.log(`  !! HTTP ${status} ${error.type ?? 'error'}: ${error.message ?? ''}`);
        this.sendJson(res, status, body);
      }
      return;
    }

    if (method === 'POST' && path === '/v1/messages/count_tokens') {
      this.log(`${method} ${path} ->`);
      try {
        await this.handleAnthropicCountTokens(req, res);
      } catch (err) {
        if (res.headersSent) throw err;
        const { status, body } = toAnthropicError(err);
        this.sendJson(res, status, body);
      }
      return;
    }

    // Usage telemetry: JSON snapshot + a self-contained HTML dashboard.
    if (method === 'GET' && path === '/v1/usage') {
      this.log(`${method} ${path} ->`);
      this.sendJson(res, 200, this.usageTracker.snapshot());
      return;
    }

    if (method === 'POST' && path === '/v1/usage/reset') {
      this.log(`${method} ${path} ->`);
      this.usageTracker.reset();
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && path === '/usage') {
      this.log(`${method} ${path} ->`);
      this.cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(usageDashboardHtml());
      return;
    }

    // Settings surface (Milestone 5): self-contained HTML UI + JSON endpoints.
    if (method === 'GET' && path === '/settings') {
      this.log(`${method} ${path} ->`);
      this.cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(settingsPageHtml());
      return;
    }

    if (method === 'GET' && path === '/v1/config') {
      this.log(`${method} ${path} ->`);
      const config = this.options.configBridge ? (this.options.configBridge.getConfig() as unknown) : {};
      this.sendJson(res, 200, config);
      return;
    }

    if (method === 'PUT' && path === '/v1/config') {
      this.log(`${method} ${path} ->`);
      if (!this.options.configBridge) {
        this.sendJson(res, 501, { error: { message: 'No config bridge configured (run via `modelhitch bridge`).', type: 'not_implemented', code: 'not_implemented' } });
        return;
      }
      const body = await this.readBody(req);
      const result = await this.options.configBridge.updateConfig(body);
      if (!result.ok) {
        this.sendJson(res, 400, { error: { message: (result.errors ?? ['invalid config']).join('\n'), type: 'invalid_request_error', code: 'invalid_config' } });
        return;
      }
      this.sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && path === '/v1/lane-health') {
      this.log(`${method} ${path} ->`);
      const health: LaneHealth[] = [];
      const cd = this.cooldown;
      if (cd instanceof CircuitBreaker) health.push(...cd.snapshot());
      this.sendJson(res, 200, health);
      return;
    }

    if (method === 'GET' && path === '/v1/catalog') {
      this.log(`${method} ${path} ->`);
      const providers: Array<{ id: string; name?: string; env?: string[]; modelCount?: number; minCost?: number; callable: boolean }> = [];
      const builtin: string[] = [];
      if (this.catalogSource) {
        for (const id of this.catalogSource.catalogIds().sort()) {
          const meta = this.catalogSource.metadata(id);
          if (!meta) continue;
          const callable = this.catalogSource.lookup(id) !== undefined;
          const priced = meta.models.filter((m) => m.inputCostPer1M !== undefined).map((m) => m.inputCostPer1M as number);
          providers.push({
            id: meta.id,
            name: meta.name,
            env: meta.env.length ? meta.env : undefined,
            modelCount: meta.models.length || undefined,
            minCost: priced.length ? Math.min(...priced) : undefined,
            callable,
          });
          if (callable && this.catalogSource.usability(id) === 'registry') builtin.push(meta.id);
        }
      } else {
        // Registry-only mode: still populate `providers` so the settings UI has
        // a picker (and key rows) without requiring models.dev catalog mode.
        for (const p of this.providers) {
          builtin.push(p.id);
          const env = providerEnvHints(p.id);
          providers.push({
            id: p.id,
            name: p.name,
            env: env.length ? env : undefined,
            callable: true,
          });
        }
      }
      this.sendJson(res, 200, { providers, builtin });
      return;
    }

    // Gemini CLI / Google-native clients. Gemini CLI sends model ids in the
    // *path* (`/v1beta/models/{model}:generateContent`), so the capture is
    // `[^:]+` — `provider/model` prefixes survive for explicit routing.
    // `v1alpha` / `v1` prefixes are tolerated (GOOGLE_GENAI_API_VERSION).
    const geminiMatch = path.match(/^\/v1(?:beta|alpha)?\/models\/([^:]+):(generateContent|streamGenerateContent)$/);
    if (method === 'POST' && geminiMatch) {
      const modelFromPath = decodeURIComponent(geminiMatch[1] ?? '');
      const isStream = geminiMatch[2] === 'streamGenerateContent';
      this.log(`${method} ${path} ->`);
      try {
        await this.handleGemini(req, res, modelFromPath, isStream);
      } catch (err) {
        // Non-stream Gemini errors use the Google API error envelope.
        if (res.headersSent) throw err;
        const { status, body } = toGeminiError(err);
        const error = body.error as { status?: string; message?: string };
        this.log(`  !! HTTP ${status} ${error.status ?? 'INTERNAL'}: ${error.message ?? ''}`);
        this.sendJson(res, status, body);
      }
      return;
    }

    // Best-effort connection-warming probe from Claude Code — safe to ignore.
    if (method === 'HEAD' && path === '/api/hello') {
      res.writeHead(200);
      res.end();
      return;
    }

    this.log(`${method} ${path} 404`);
    this.sendJson(res, 404, {
      error: { message: `Unknown endpoint: ${method} ${path}`, type: 'invalid_request_error', param: null, code: 'unknown_endpoint' },
    });
  }

  // ---------------------------------------------------------------------------
  // Chat completions
  // ---------------------------------------------------------------------------

  private async handleImageGeneration(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as Record<string, unknown> | null;
    const requestBody = (body ?? {}) as Record<string, unknown>;
    if (!this.imageGeneration?.enabled) {
      throw new ModelHitchError(
        'bad-request',
        'The image lane is disabled by default. Enable it in /settings or with modelhitch bridge --image-lane.',
        { status: 403 },
      );
    }
    const prompt = typeof requestBody.prompt === 'string' ? requestBody.prompt.trim() : '';
    if (!prompt) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'prompt'.", { status: 400 });
    }
    const cfg = this.imageGeneration;
    const providerId = cfg.providerId || 'openai';
    const provider = this.providerFor(providerId) ?? this.providers.find((p) => p.id === providerId);
    if (!provider) {
      throw new ModelHitchError('bad-request', `Image lane provider "${providerId}" is unavailable.`, { status: 400, providerId });
    }
    const model = (typeof requestBody.model === 'string' && requestBody.model.trim()) || cfg.model || (providerId === 'gemini' ? 'gemini-3.1-flash-image' : 'gpt-image-2');
    const quality = (typeof requestBody.quality === 'string' && requestBody.quality) || cfg.quality || 'medium';
    const size = (typeof requestBody.size === 'string' && requestBody.size.trim()) || cfg.size || '1024x1024';
    const count = Number.isInteger(requestBody.n) ? Math.max(1, Number(requestBody.n)) : 1;

    if (providerId === 'openai') {
      if (!['gpt-image-2', 'gpt-image-1.5'].includes(model)) {
        throw new ModelHitchError('bad-request', 'The OpenAI image lane supports gpt-image-2 and gpt-image-1.5.', { status: 400, providerId });
      }
      if ((model === 'gpt-image-1.5' && quality !== 'medium') || (model === 'gpt-image-2' && !['low', 'medium'].includes(quality))) {
        throw new ModelHitchError('bad-request', `${model} does not support quality "${quality}" in this image lane.`, { status: 400, providerId });
      }
    } else if (providerId === 'gemini') {
      if (!['gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'].includes(model)) {
        throw new ModelHitchError('bad-request', `Gemini model "${model}" is not a supported image model.`, { status: 400, providerId });
      }
      if (count !== 1) {
        throw new ModelHitchError('bad-request', 'The Gemini image lane supports one generated image per request.', { status: 400, providerId });
      }
    }

    const credentials = await this.resolveCredentials(providerId);
    const base = (credentials.baseUrl ?? {
      openai: 'https://api.openai.com/v1',
      gemini: 'https://generativelanguage.googleapis.com/v1beta',
    }[providerId] ?? 'https://api.openai.com/v1').replace(/\/+$/, '');

    let payload: Record<string, unknown>;
    if (providerId === 'gemini') {
      const imageConfig = geminiImageConfig(size);
      if (!imageConfig) {
        throw new ModelHitchError('bad-request', `Size "${size}" cannot be mapped to a supported Gemini aspect ratio and image size.`, { status: 400, providerId });
      }
      payload = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig },
      };
    } else {
      payload = {
        model,
        prompt,
        n: count,
        size,
        quality,
      };
    }

    const url = providerId === 'gemini'
      ? `${base}/models/${encodeURIComponent(model)}:generateContent`
      : `${base}/images/generations`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (providerId === 'gemini') {
      const apiKey = credentials.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) throw new ModelHitchError('missing-api-key', 'Gemini image generation requires a Gemini API key.', { status: 401, providerId });
      headers['x-goog-api-key'] = apiKey;
    } else {
      const apiKey = credentials.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.HF_TOKEN;
      if (!apiKey) {
        throw new ModelHitchError('missing-api-key', `Image generation for "${providerId}" requires a configured API key.`, { status: 401, providerId });
      }
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await (this.options.imageFetch ?? fetch)(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    const text = await response.text();
    if (!response.ok) {
      throw new ModelHitchError(
        'provider-error',
        `Image generation via "${providerId}" failed: ${text || 'unknown upstream error'}`,
        { status: response.status, providerId },
      );
    }

    const data = safeJsonParse<Record<string, unknown>>(text, {});
    let imageData: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> = [];
    if (providerId === 'gemini') {
      const parts = ((data.candidates as Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> } }> | undefined) ?? [])[0]?.content?.parts ?? [];
      imageData = parts
        .filter((part) => part && part.inlineData && typeof part.inlineData.data === 'string')
        .map((part) => ({ b64_json: part.inlineData!.data, revised_prompt: parts.map((p) => p.text).filter(Boolean).join('\n') || undefined }));
    } else {
      const items = Array.isArray(data.data) ? (data.data as Array<Record<string, unknown>>) : [];
      imageData = items.map((item) => ({
        url: typeof item.url === 'string' ? item.url : undefined,
        b64_json: typeof item.b64_json === 'string' ? item.b64_json : undefined,
        revised_prompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      }));
    }
    if (!imageData.length) {
      throw new ModelHitchError('provider-error', `Image generation via "${providerId}" returned no image payload.`, { status: 502, providerId });
    }
    this.sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: imageData });
  }

  private async handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as OpenAIChatRequest | null;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'messages' array.", { status: 400 });
    }
    const { provider, model } = routeModel(body.model, this.providers, this.options.defaultProviderId);
    const credentials = await this.resolveCredentials(provider.id);
    const params = mapRequest(body, model);
    const incomingSession = extractSessionId(req.headers);
    if (incomingSession) params.sessionId = incomingSession;
    if (this.options.defaultModel && !body.model) params.model = this.options.defaultModel;

    if (body.stream === true) {
      this.log(`  -> ${provider.id}/${model} (stream)`);
      await this.writeStream(res, provider, params, credentials, model);
      return;
    }

    this.log(`  -> ${provider.id}/${model}`);
    const startedAt = Date.now();
    const primary: ResolvedLane = { providerId: provider.id, model, provider, credentials };
    const targets = this.requireCapableTargets([primary, ...(await this.resolveLaneTargets(provider.id, model))], params);
    const { value: result, target } = await this.withFailover(targets, (lane) =>
      lane.provider.chat({ ...params, model: lane.model }, lane.credentials),
    );
    this.reportUsage(
      { providerId: target.provider.id, model: target.model, wire: 'chat-completions', streamed: false },
      result.usage,
      startedAt,
    );
    this.sendJson(res, 200, toChatCompletion(result, model));
  }

  /**
   * Stream a normalized provider stream out as OpenAI SSE chunks. The first
   * chunk is fetched BEFORE the HTTP 200 is committed, so an upstream 429
   * (or an exhausted auto-mode lane chain) surfaces as a real error status
   * instead of a 200 followed by an SSE error event.
   */
  private async writeStream(
    res: ServerResponse,
    provider: Provider,
    params: ChatParams,
    credentials: ProviderCredentials,
    model: string,
  ): Promise<void> {
    const controller = new AbortController();
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunkBase = { id, object: 'chat.completion.chunk' as const, created, model };
    const startedAt = Date.now();

    // Abort the upstream call if the client disconnects mid-stream (registered
    // before the header peek so a disconnect during it also aborts upstream).
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const primary: ResolvedLane = { providerId: provider.id, model, provider, credentials };
    const targets = this.requireCapableTargets([primary, ...(await this.resolveLaneTargets(provider.id, model))], params, { streaming: true });
    const usageInfo = { providerId: provider.id, model, wire: 'chat-completions' as const, streamed: true };
    const stream = this.trackStream(
      withFailoverStream(
        targets,
        (lane) =>
          lane.provider.stream({ ...params, model: lane.model, signal: controller.signal }, lane.credentials),
        this.failoverContext(this.streamCodes(), targets, (target) => {
          usageInfo.providerId = target.providerId;
          usageInfo.model = target.model;
        }),
      ),
      usageInfo,
      startedAt,
    );

    const iterator = stream[Symbol.asyncIterator]();
    let first: IteratorResult<StreamChunk>;
    try {
      first = await iterator.next();
    } catch (err) {
      if (res.destroyed || res.writableEnded) return;
      this.sendError(res, err);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const toolIndex = new Map<string, number>();
    let nextToolIndex = 0;
    let started = false;

    const write = (chunk: OpenAIStreamChunk) => {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    const consume = (event: StreamChunk) => {
      switch (event.type) {
        case 'text-delta': {
          const delta: Record<string, unknown> = { content: event.text };
          if (!started) {
            delta.role = 'assistant';
            started = true;
          }
          write({ ...chunkBase, choices: [{ index: 0, delta, finish_reason: null }] });
          break;
        }
        case 'tool-call-start': {
          const index = nextToolIndex++;
          toolIndex.set(event.id, index);
          const delta = {
            role: 'assistant',
            tool_calls: [
              {
                index,
                id: event.id,
                type: 'function',
                function: { name: event.name, arguments: '' },
                ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
              },
            ],
          };
          write({ ...chunkBase, choices: [{ index: 0, delta, finish_reason: null }] });
          break;
        }
        case 'tool-call-args-delta': {
          const index = toolIndex.get(event.id) ?? 0;
          const delta = { tool_calls: [{ index, function: { arguments: event.argsDelta } }] };
          write({ ...chunkBase, choices: [{ index: 0, delta, finish_reason: null }] });
          break;
        }
        case 'tool-call-end':
          // The final finish chunk carries the resolved finish_reason.
          break;
        case 'finish': {
          const finish: OpenAIStreamChunk = {
            ...chunkBase,
            choices: [{ index: 0, delta: {}, finish_reason: mapFinishReasonOpenAI(event.finishReason) }],
          };
          if (event.usage) finish.usage = toUsageOutput(event.usage) ?? undefined;
          write(finish);
          break;
        }
      }
    };

    try {
      if (!first.done) consume(first.value);
      for await (const event of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<StreamChunk>) {
        consume(event);
      }
      // Some providers end without an explicit finish chunk — synthesize one.
      write({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      if (res.writableEnded) return;
      const { status, body } = toOpenAIError(err);
      // Stream already started: emit the error as an SSE event, then [DONE].
      res.write(`data: ${JSON.stringify(body)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${body.error.code}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Responses API (Codex CLI wire protocol)
  // ---------------------------------------------------------------------------

  private async handleResponses(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as ResponsesRequest | null;
    const hasInput = Array.isArray(body?.input) && body!.input!.length > 0;
    const hasInstructions = typeof body?.instructions === 'string' && body.instructions.length > 0;
    if (!body || (!hasInput && !hasInstructions)) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'input' array or 'instructions'.", { status: 400 });
    }
    const { provider, model } = routeModel(body.model, this.providers, this.options.defaultProviderId);
    const credentials = await this.resolveCredentials(provider.id);
    const params = mapResponsesRequest(body, model);
    const incomingSession = extractSessionId(req.headers);
    if (incomingSession) params.sessionId = incomingSession;
    if (this.options.defaultModel && !body.model) params.model = this.options.defaultModel;

    // Stateful continuation: the client sliced prior turns out and references
    // them via previous_response_id. The bridge holds the state (zen rejects
    // the field outright) — expand the delta against the cache and forward
    // the FULL conversation stateless.
    if (process.env.MODELHITCH_DEBUG === '1') this.log(`<- POST /v1/responses ${JSON.stringify(body)}`);
    params.messages = resolveConversation(params, body.previous_response_id);

    // Never forward an unanswerable input: if the delta can't be resolved
    // against the cache (previous_response_id lost/missing), try re-anchoring
    // the tool results by their call ids — the function_call they answer may
    // still be cached. Only if nothing resolves do we fail, with a clear
    // message instead of the upstream provider's opaque 400.
    const hasRealContent = params.messages.some((m) => m.role !== 'tool');
    if (!hasRealContent) {
      const outputs = toolOutputsFromInput(body.input);
      const prior = outputs.length > 0 ? findConversationWithToolCall(new Set(outputs.map((o) => o.callId))) : undefined;
      if (prior) {
        this.log(`  ~~ re-anchored delta by call_id (${outputs.map((o) => o.callId).join(', ')})`);
        params.messages = [...prior, ...toolMessagesFromOutputs(outputs)];
      } else {
        throw new ModelHitchError(
          'bad-request',
          'This request contains only tool results whose conversation state is unavailable (bridge restarted or cache evicted). Start a new chat.',
          { status: 400 },
        );
      }
    }
    params.previousResponseId = undefined;

    if (body.stream === true) {
      this.log(`  -> ${provider.id}/${model} (responses stream)`);
      await this.writeResponsesStream(res, provider, params, credentials, model);
      return;
    }

    this.log(`  -> ${provider.id}/${model} (responses)`);
    const startedAt = Date.now();
    const primary: ResolvedLane = { providerId: provider.id, model, provider, credentials };
    const targets = this.requireCapableTargets([primary, ...(await this.resolveLaneTargets(provider.id, model))], params);
    const { value: result, target } = await this.withFailover(targets, (lane) =>
      lane.provider.chat({ ...params, model: lane.model }, lane.credentials),
    );
    this.reportUsage(
      { providerId: target.provider.id, model: target.model, wire: 'responses', streamed: false },
      result.usage,
      startedAt,
    );
    const completion = toResponsesCompletion(result, model);
    this.sendJson(res, 200, completion);
    // Remember this turn so a follow-up previous_response_id can be resolved.
    rememberConversation(String(completion.id), [...params.messages, ...assistantMessagesFromResult(result.message)]);
  }

  /** Stream a normalized provider stream out as Responses API SSE events. */
  private async writeResponsesStream(
    res: ServerResponse,
    provider: Provider,
    params: ChatParams,
    credentials: ProviderCredentials,
    model: string,
  ): Promise<void> {
    const controller = new AbortController();
    // Abort the upstream call if the client disconnects mid-stream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const primary: ResolvedLane = { providerId: provider.id, model, provider, credentials };
    const targets = this.requireCapableTargets([primary, ...(await this.resolveLaneTargets(provider.id, model))], params, { streaming: true });
    const usageInfo = { providerId: provider.id, model, wire: 'responses' as const, streamed: true };
    const stream = this.trackStream(
      withFailoverStream(
        targets,
        (lane) =>
          lane.provider.stream({ ...params, model: lane.model, signal: controller.signal }, lane.credentials),
        this.failoverContext(this.streamCodes(), targets, (target) => {
          usageInfo.providerId = target.providerId;
          usageInfo.model = target.model;
        }),
      ),
      usageInfo,
      Date.now(),
    );
    const mapped = toResponsesStreamEvents(stream, model, {
      onCompleted: (responseId, assistantMessages) => {
        rememberConversation(responseId, [...params.messages, ...assistantMessages]);
      },
    });

    // Peek the first event before committing to HTTP 200.
    const iterator = mapped[Symbol.asyncIterator]();
    let first: IteratorResult<string>;
    try {
      first = await iterator.next();
    } catch (err) {
      if (res.destroyed || res.writableEnded) return;
      const { status, body } = toOpenAIError(err);
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${body.error.code}`);
      this.sendJson(res, status, body);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      if (!first.done) res.write(first.value);
      for await (const line of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<string>) {
        res.write(line);
      }
      res.end();
    } catch (err) {
      if (res.writableEnded) return;
      const { status, body } = toOpenAIError(err);
      res.write(
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: { error: { code: body.error.code ?? 'provider_error', message: body.error.message } },
        })}\n\n`,
      );
      res.end();
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${body.error.code}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Anthropic Messages (Claude Code gateway wire protocol)
  // ---------------------------------------------------------------------------

  private async handleAnthropic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await this.readBody(req)) as AnthropicRequest | null;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'messages' array.", { status: 400 });
    }
    const { provider, model } = routeModel(body.model, this.providers, this.options.defaultProviderId);
    const credentials = await this.resolveCredentials(provider.id);
    const params = mapAnthropicRequest(body, model);
    const incomingSession = extractSessionId(req.headers);
    if (incomingSession) params.sessionId = incomingSession;
    if (this.options.defaultModel && !body.model) params.model = this.options.defaultModel;

    if (body.stream === true) {
      this.log(`  -> ${provider.id}/${model} (anthropic stream)`);
      await this.writeAnthropicStream(res, provider, params, credentials, model, body);
      return;
    }

    this.log(`  -> ${provider.id}/${model} (anthropic)`);
    const startedAt = Date.now();
    const primary: ResolvedLane = { providerId: provider.id, model, provider, credentials };
    const targets = this.requireCapableTargets([primary, ...(await this.resolveLaneTargets(provider.id, model))], params);
    const { value: result, target } = await this.withFailover(targets, (lane) =>
      lane.provider.chat({ ...params, model: lane.model }, lane.credentials),
    );
    this.reportUsage(
      { providerId: target.provider.id, model: target.model, wire: 'messages', streamed: false },
      result.usage,
      startedAt,
    );
    this.sendJson(res, 200, toAnthropicCompletion(result, model, estimateAnthropicInputTokens(body)));
  }

  /** Stream a normalized provider stream out as Anthropic Messages SSE events. */
  private async writeAnthropicStream(
    res: ServerResponse,
    provider: Provider,
    params: ChatParams,
    credentials: ProviderCredentials,
    model: string,
    body: AnthropicRequest,
  ): Promise<void> {
    const controller = new AbortController();
    // Abort the upstream call if the client disconnects mid-stream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const primary: ResolvedLane = { providerId: provider.id, model, provider, credentials };
    const targets = this.requireCapableTargets([primary, ...(await this.resolveLaneTargets(provider.id, model))], params, { streaming: true });
    const usageInfo = { providerId: provider.id, model, wire: 'messages' as const, streamed: true };
    const stream = this.trackStream(
      withFailoverStream(
        targets,
        (lane) =>
          lane.provider.stream({ ...params, model: lane.model, signal: controller.signal }, lane.credentials),
        this.failoverContext(this.streamCodes(), targets, (target) => {
          usageInfo.providerId = target.providerId;
          usageInfo.model = target.model;
        }),
      ),
      usageInfo,
      Date.now(),
    );
    const mapped = toAnthropicStreamEvents(stream, model, estimateAnthropicInputTokens(body));

    // Peek the first event before committing to HTTP 200.
    const iterator = mapped[Symbol.asyncIterator]();
    let first: IteratorResult<string>;
    try {
      first = await iterator.next();
    } catch (err) {
      if (res.destroyed || res.writableEnded) return;
      const { status, body: errBody } = toAnthropicError(err);
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${(errBody.error as { type?: string })?.type ?? 'error'}`);
      this.sendJson(res, status, errBody);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Keep-alive pings: Claude Code aborts streams that go silent for ~300s,
    // so relay a ping while upstream is thinking.
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write('event: ping\ndata: {"type":"ping"}\n\n');
    }, 15_000);

    try {
      if (!first.done) res.write(first.value);
      for await (const line of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<string>) {
        res.write(line);
      }
      res.end();
    } catch (err) {
      if (res.writableEnded) return;
      const { status, body: errBody } = toAnthropicError(err);
      res.write(`event: error\ndata: ${JSON.stringify(errBody)}\n\n`);
      res.end();
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${(errBody.error as { type?: string })?.type ?? 'error'}`);
    } finally {
      clearInterval(ping);
    }
  }

  /** Claude Code's optional token counter — cheap estimate, no inference call. */
  private async handleAnthropicCountTokens(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body || typeof body !== 'object' || !Array.isArray((body as AnthropicRequest).messages) || (body as AnthropicRequest).messages!.length === 0) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'messages' array.", { status: 400 });
    }
    this.sendJson(res, 200, { input_tokens: estimateAnthropicInputTokens(body) });
  }

  // ---------------------------------------------------------------------------
  // Gemini generateContent (Gemini CLI / Google-native wire protocol)
  // ---------------------------------------------------------------------------

  private async handleGemini(
    req: IncomingMessage,
    res: ServerResponse,
    modelFromPath: string,
    stream: boolean,
  ): Promise<void> {
    const body = (await this.readBody(req)) as GeminiRequest | null;
    if (!body || !Array.isArray(body.contents) || body.contents.length === 0) {
      throw new ModelHitchError('bad-request', "The request body must include a non-empty 'contents' array.", { status: 400 });
    }
    // The model lives in the URL path for the Google wire; body.model (if any)
    // is a fallback for clients that send it anyway.
    const { provider, model } = routeModel(modelFromPath || body.model, this.providers, this.options.defaultProviderId);
    const credentials = await this.resolveCredentials(provider.id);
    const params = mapGeminiRequest(body, model);
    const incomingSession = extractSessionId(req.headers);
    if (incomingSession) params.sessionId = incomingSession;
    if (this.options.defaultModel && !modelFromPath && !body.model) params.model = this.options.defaultModel;

    if (stream) {
      this.log(`  -> ${provider.id}/${model} (gemini stream)`);
      await this.writeGeminiStream(res, provider, params, credentials, model, body);
      return;
    }

    this.log(`  -> ${provider.id}/${model} (gemini)`);
    const startedAt = Date.now();
    const primary: ResolvedLane = { providerId: provider.id, model, provider, credentials };
    const targets = this.requireCapableTargets([primary, ...(await this.resolveLaneTargets(provider.id, model))], params);
    const { value: result, target } = await this.withFailover(targets, (lane) =>
      lane.provider.chat({ ...params, model: lane.model }, lane.credentials),
    );
    this.reportUsage(
      { providerId: target.provider.id, model: target.model, wire: 'gemini', streamed: false },
      result.usage,
      startedAt,
    );
    this.sendJson(res, 200, toGeminiCompletion(result, model, estimateGeminiInputTokens(body)));
  }

  /** Stream a normalized provider stream out as Google `:streamGenerateContent` SSE. */
  private async writeGeminiStream(
    res: ServerResponse,
    provider: Provider,
    params: ChatParams,
    credentials: ProviderCredentials,
    model: string,
    body: GeminiRequest,
  ): Promise<void> {
    const controller = new AbortController();
    // Abort the upstream call if the client disconnects mid-stream.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const primary: ResolvedLane = { providerId: provider.id, model, provider, credentials };
    const targets = this.requireCapableTargets([primary, ...(await this.resolveLaneTargets(provider.id, model))], params, { streaming: true });
    const usageInfo = { providerId: provider.id, model, wire: 'gemini' as const, streamed: true };
    const stream = this.trackStream(
      withFailoverStream(
        targets,
        (lane) =>
          lane.provider.stream({ ...params, model: lane.model, signal: controller.signal }, lane.credentials),
        this.failoverContext(this.streamCodes(), targets, (target) => {
          usageInfo.providerId = target.providerId;
          usageInfo.model = target.model;
        }),
      ),
      usageInfo,
      Date.now(),
    );
    const mapped = toGeminiStreamEvents(stream, model, estimateGeminiInputTokens(body));

    // Peek the first event before committing to HTTP 200.
    const iterator = mapped[Symbol.asyncIterator]();
    let first: IteratorResult<string>;
    try {
      first = await iterator.next();
    } catch (err) {
      if (res.destroyed || res.writableEnded) return;
      const { status, body: errBody } = toGeminiError(err);
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${(errBody.error as { status?: string })?.status ?? 'INTERNAL'}`);
      this.sendJson(res, status, errBody);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      if (!first.done) res.write(first.value);
      for await (const line of { [Symbol.asyncIterator]: () => iterator } as AsyncIterable<string>) {
        res.write(line);
      }
      res.end();
    } catch (err) {
      if (res.writableEnded) return;
      // Mid-stream failures surface as a Google error envelope chunk — the SDK
      // reads `error` out of the SSE payload, same as a plain JSON error.
      const { status, body: errBody } = toGeminiError(err);
      res.write(`data: ${JSON.stringify(errBody)}\n\n`);
      res.end();
      this.log(`  !! ${provider.id} failed: HTTP ${status} ${(errBody.error as { status?: string })?.status ?? 'INTERNAL'}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Models
  // ---------------------------------------------------------------------------

  private async modelCatalog(): Promise<OpenAIModelEntry[]> {
    const out: OpenAIModelEntry[] = [];
    const seen = new Set<string>();
    const push = (id: string, ownedBy: string) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, object: 'model', created: 0, owned_by: ownedBy });
    };

    for (const provider of this.providers) {
      const credentials = await this.resolveCredentials(provider.id);
      const ownedBy = provider.id;
      // The default provider's models are advertised with bare ids.
      const isDefault = provider.id === this.options.defaultProviderId;
      const qualify = (modelId: string) => (isDefault ? modelId : `${provider.id}/${modelId}`);

      push(qualify(provider.defaultModel), ownedBy);
      for (const modelId of this.options.staticModels?.[provider.id] ?? []) {
        push(qualify(modelId), ownedBy);
      }
      if (provider.listModels) {
        try {
          const live = await provider.listModels(credentials);
          for (const m of live) push(qualify(m.id), ownedBy);
        } catch {
          // Missing key / offline endpoint: static catalog still applies.
        }
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async handleModels(res: ServerResponse): Promise<void> {
    const data = await this.modelCatalog();
    this.log(`  -> ${data.length} models`);
    this.sendJson(res, 200, { object: 'list', data });
  }

  private async handleModelById(res: ServerResponse, id: string): Promise<void> {
    const catalog = await this.modelCatalog();
    const entry = catalog.find((m) => m.id === id);
    if (!entry) {
      throw new ModelHitchError('model-not-found', `Model "${id}" is not available on this bridge.`, { status: 404 });
    }
    this.sendJson(res, 200, entry);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Credential resolution: apiKeys option > keystore > provider env fallback. */
  private async resolveCredentials(providerId: string): Promise<ProviderCredentials> {
    const credentials: ProviderCredentials = {};
    if (this.options.apiKeys?.[providerId]) credentials.apiKey = this.options.apiKeys[providerId];
    if (this.options.baseUrls?.[providerId]) credentials.baseUrl = this.options.baseUrls[providerId];
    if (!credentials.apiKey && this.options.keystore) {
      const apiKey = await this.options.keystore.get(providerId);
      if (apiKey) credentials.apiKey = apiKey;
    }
    return credentials;
  }

  /** Resolve fallback lanes for a routed primary: policy lanes or auto-mode. */
  private async resolveLaneTargets(providerId: string, model: string): Promise<ResolvedLane[]> {
    const lanes: ResolvedLane[] = [];
    const fromSource = this.laneTargetsFromSource(providerId, model);
    for (const target of fromSource) {
      if (target.providerId === providerId && target.model === model) continue; // primary handled by caller
      const provider = this.providerFor(target.providerId);
      if (!provider) continue;
      lanes.push({
        ...target,
        provider,
        credentials: await this.resolveCredentials(target.providerId),
      });
    }
    return lanes;
  }

  /**
   * Drop lanes whose provider can't meet the request's inferred requirements
   * (tool calling, vision, ...) before failover attempts them. A capability
   * mismatch is a routing decision, not a runtime failure: skipped lanes are
   * logged but never cooled and never counted against a provider.
   */
  private requireCapableTargets(
    targets: ResolvedLane[],
    params: ChatParams,
    extra: CapabilityRequirements = {},
  ): ResolvedLane[] {
    const requirements = inferRequirements(params, extra);
    const { eligible, skipped } = filterEligibleLanes(targets, requirements, (t) => t.provider.capabilities);
    for (const s of skipped) {
      this.log(`  ~~ skipped ${s.target.providerId}/${s.target.model} (${s.reason})`);
    }
    if (eligible.length === 0) throw new CapabilityUnavailableError(requirements, skipped);
    return eligible;
  }

  private laneTargetsFromSource(providerId: string, model: string): FailoverTarget[] {
    if (this.policy) return resolvePolicyLanes(this.policy, { providerId, model }, this.source);
    return resolveLanes({ providerId, model }, this.options.autoMode);
  }

  private providerFor(id: string): Provider | undefined {
    return this.catalogSource ? this.catalogSource.lookup(id) : this.providers.find((p) => p.id === id);
  }

  /** Run a provider call with policy/auto-mode failover; returns result + lane. */
  private withFailover<T>(
    targets: ResolvedLane[],
    call: (lane: ResolvedLane) => Promise<T>,
  ): Promise<{ value: T; target: ResolvedLane }> {
    const codes = this.policy ? (this.policy.retryableCodes ?? DEFAULT_RETRYABLE_CODES) : retryableCodesFor(this.options.autoMode);
    return withFailover(
      targets,
      (lane) => call(lane),
      this.failoverContext(codes, targets, () => undefined),
    );
  }

  /**
   * Shared failover context for the streaming wires. `onLane` updates the
   * per-request usage info to the lane that took over.
   */
  private failoverContext(
    codes: readonly (import('../core/errors.js').ModelHitchErrorCode)[],
    targets: ResolvedLane[],
    onLaneChange: (target: FailoverTarget) => void,
  ) {
    return {
      codes,
      maxAttempts: this.policy ? targets.length : maxAttemptsFor(this.options.autoMode, Math.max(targets.length - 1, 0)),
      onFailover: (event: FailoverEvent) => {
        onLaneChange(event.to);
        this.emitFailover(event);
      },
      cooldown: this.cooldown,
      onSuccess: (target: FailoverTarget) => this.cooldown?.success?.(target),
      delayMsBeforeFailover: this.policy
        ? (from: FailoverTarget, err: unknown, attempt: number) => computeBackoffDelay(this.policy?.backoff, err, attempt)
        : undefined,
      onExhausted: this.options.onExhausted,
    };
  }

  private streamCodes(): readonly (import('../core/errors.js').ModelHitchErrorCode)[] {
    return this.policy
      ? (this.policy.retryableCodes ?? DEFAULT_RETRYABLE_CODES)
      : retryableCodesFor(this.options.autoMode);
  }

  private emitFailover(event: FailoverEvent): void {
    this.log(
      `  ~~ auto-mode failover ${event.from.providerId}/${event.from.model} -> ${event.to.providerId}/${event.to.model} (${event.error.code}${event.error.status ? ` HTTP ${event.error.status}` : ''})`,
    );
    // Strip ResolvedLane extras (provider object, credentials) so telemetry
    // carries only the lane identity.
    const clean: FailoverEvent = {
      at: event.at,
      from: { providerId: event.from.providerId, model: event.from.model },
      to: { providerId: event.to.providerId, model: event.to.model },
      error: event.error,
      attempt: event.attempt,
    };
    this.options.onFailover?.(clean);
    this.usageTracker.recordFailover(clean);
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    const max = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          // Don't destroy the socket — the error response wouldn't flush.
          // Pause reading and let the dispatch error handler write the 413;
          // Node closes the connection after the response since the body
          // wasn't consumed.
          req.pause();
          reject(new ModelHitchError('bad-request', 'Request body too large.', { status: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text.trim()) return resolve({});
        try {
          const parsed = JSON.parse(text) as unknown;
          // Inline local image files (file://, vscode-resource:// URIs) so the
          // upstream never has to fetch client-local URLs — otherwise those
          // come back as opaque upstream 400s. Data/http(s) URLs are untouched.
          normalizeBodyImages(parsed)
            .then(() => resolve(parsed))
            .catch((err) => reject(err));
        } catch {
          reject(new ModelHitchError('bad-request', 'Request body is not valid JSON.', { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    this.cors(res);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private sendError(res: ServerResponse, err: unknown): void {
    if (res.headersSent) return;
    const { status, body } = toOpenAIError(err);
    this.log(`  !! HTTP ${status} ${body.error.code}: ${body.error.message}`);
    this.sendJson(res, status, body);
  }

  private cors(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-session-id, session-id, x-conversation-id, conversation-id');
  }

  private log(line: string): void {
    this.options.logger?.(line);
  }

  // ---------------------------------------------------------------------------
  // Usage / cost tracking
  // ---------------------------------------------------------------------------

  private emitUsage(event: UsageEvent): void {
    this.options.onUsage?.(event);
    this.usageTracker.record(event);
  }

  /** Report usage for a completed non-stream call. */
  private reportUsage(
    info: { providerId: string; model: string; wire: string; streamed: boolean },
    usage: Usage | undefined,
    startedAt: number,
  ): void {
    if (!usage) return;
    const cost = estimateCost(info.model, usage, info.providerId);
    this.emitUsage({
      ...info,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      costUsd: cost.totalCostUsd,
      latencyMs: Date.now() - startedAt,
      at: new Date().toISOString(),
    });
  }

  /**
   * Wrap a provider stream to capture the `finish` event's usage and report
   * it via `onUsage` once the stream runs to completion. Pass-through: chunk
   * events are re-emitted untouched. Aborted/errored streams report nothing
   * (their usage is partial at best).
   */
  private trackStream(
    stream: AsyncIterable<StreamChunk>,
    info: { providerId: string; model: string; wire: string; streamed: boolean },
    startedAt: number,
  ): AsyncIterable<StreamChunk> {
    const self = this;
    let usage: Usage | undefined;
    return (async function* () {
      for await (const chunk of stream) {
        if (chunk.type === 'finish') usage = chunk.usage;
        yield chunk;
      }
      self.reportUsage(info, usage, startedAt);
    })();
  }
}

/** Env var hints for the settings UI when models.dev catalog mode is off. */
function providerEnvHints(providerId: string): string[] {
  const map: Record<string, string[]> = {
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    groq: ['GROQ_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    'vercel-ai-gateway': ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'VERCEL_TOKEN'],
    together: ['TOGETHER_API_KEY'],
    huggingface: ['HF_TOKEN'],
    gemini: ['GEMINI_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY'],
    xai: ['XAI_API_KEY'],
    mistral: ['MISTRAL_API_KEY'],
    moonshot: ['MOONSHOT_API_KEY'],
    zai: ['ZAI_API_KEY'],
  };
  return map[providerId] ?? [];
}

/** Create a bridge server with the given options. */
export function createModelHitchServer(options: ModelHitchServerOptions = {}): OpenAICompatibleServer {
  return new OpenAICompatibleServer(options);
}
