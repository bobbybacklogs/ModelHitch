import { ModelHitchError } from '../core/errors.js';
import { parseRetryAfter } from '../core/headers.js';
import { serializeText } from '../core/content.js';
import { deriveSessionId } from '../core/session.js';
import type { ChatParams, ChatResult, ModelMessage, ProviderCredentials, StreamChunk } from '../core/types.js';
import type { CloudAgentConfig, CloudAgentRepoConfig } from '../config.js';
import type { Provider, ModelInfo } from './types.js';
import { CursorCloudSessionStore } from './cursor-cloud-session.js';

export const CURSOR_CLOUD_API_BASE = 'https://api.cursor.com/v1';
export const CURSOR_CLOUD_PROVIDER_ID = 'cursor-cloud';

export interface CursorCloudProviderOptions {
  config: CloudAgentConfig;
  sessionStore: CursorCloudSessionStore;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

interface CursorApiErrorBody {
  error?: { type?: string; message?: string };
}

interface CursorAgentCreateResponse {
  agent: { id: string };
  run: { id: string };
}

interface CursorRunCreateResponse {
  run: { id: string };
}

interface CursorRunDetail {
  id: string;
  status: string;
  result?: string;
  durationMs?: number;
}

export interface CursorCloudAgent {
  id: string;
  status?: string;
  name?: string;
  createdAt?: string;
}

interface CursorCloudAgentsListResponse {
  items?: CursorCloudAgent[];
  agents?: CursorCloudAgent[];
}

interface CursorCloudAgentResponse {
  agent?: CursorCloudAgent;
}

interface CursorRepositoryEntry {
  url?: string;
  repository?: string;
  defaultBranch?: string;
  startingRef?: string;
}

interface CursorRepositoriesResponse {
  items?: CursorRepositoryEntry[];
  repositories?: CursorRepositoryEntry[];
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

async function cursorApiFetch(
  path: string,
  init: RequestInit,
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? CURSOR_CLOUD_API_BASE).replace(/\/$/, '');
  const res = await fetchImpl(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw await mapCursorResponseError(res, CURSOR_CLOUD_PROVIDER_ID);
  return res;
}

function agentNotFoundError(id: string): ModelHitchError {
  return new ModelHitchError('model-not-found', `Cloud agent "${id}" was not found.`, {
    status: 404,
    providerId: CURSOR_CLOUD_PROVIDER_ID,
  });
}

/** List Cursor Cloud agents via `GET /v1/agents`. */
export async function listCursorCloudAgents(
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<CursorCloudAgent[]> {
  const res = await cursorApiFetch('/agents', { method: 'GET' }, apiKey, opts);
  const body = (await res.json()) as CursorCloudAgentsListResponse;
  return body.items ?? body.agents ?? [];
}

/** Fetch one Cursor Cloud agent via `GET /v1/agents/:id`. */
export async function getCursorCloudAgent(
  apiKey: string,
  id: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<CursorCloudAgent> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? CURSOR_CLOUD_API_BASE).replace(/\/$/, '');
  const res = await fetchImpl(`${baseUrl}/agents/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 404) throw agentNotFoundError(id);
  if (!res.ok) throw await mapCursorResponseError(res, CURSOR_CLOUD_PROVIDER_ID);
  const body = (await res.json()) as CursorCloudAgent | CursorCloudAgentResponse;
  const agent = 'agent' in body && body.agent ? body.agent : (body as CursorCloudAgent);
  if (!agent?.id) throw agentNotFoundError(id);
  return agent;
}

/** Cancel a Cursor Cloud agent via `POST /v1/agents/:id/cancel`. */
export async function cancelCursorCloudAgent(
  apiKey: string,
  id: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<CursorCloudAgent> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? CURSOR_CLOUD_API_BASE).replace(/\/$/, '');
  const res = await fetchImpl(`${baseUrl}/agents/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.status === 404) throw agentNotFoundError(id);
  if (!res.ok) throw await mapCursorResponseError(res, CURSOR_CLOUD_PROVIDER_ID);
  const body = (await res.json()) as CursorCloudAgent | CursorCloudAgentResponse;
  const agent = 'agent' in body && body.agent ? body.agent : (body as CursorCloudAgent);
  if (!agent?.id) throw agentNotFoundError(id);
  return agent;
}

/** Validate a Cursor API key via `GET /v1/me`. */
export async function validateCursorCloudApiKey(
  apiKey: string,
  opts: { fetchImpl?: typeof fetch; baseUrl?: string } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl ?? CURSOR_CLOUD_API_BASE).replace(/\/$/, '');
  const res = await fetchImpl(`${baseUrl}/me`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  if (!res.ok) throw await mapCursorResponseError(res, CURSOR_CLOUD_PROVIDER_ID);
}

function resolveApiKey(credentials: ProviderCredentials): string {
  const key = credentials.apiKey ?? process.env.CURSOR_API_KEY;
  if (!key) {
    throw new ModelHitchError(
      'missing-api-key',
      'Cursor Cloud Agent lane requires CURSOR_API_KEY or keys.cursor-cloud in ~/.modelhitch/config.json.',
      { providerId: CURSOR_CLOUD_PROVIDER_ID },
    );
  }
  return key;
}

async function mapCursorResponseError(res: Response, providerId: string): Promise<ModelHitchError> {
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  let body: CursorApiErrorBody = {};
  try {
    body = (await res.json()) as CursorApiErrorBody;
  } catch {
    /* ignore */
  }
  const type = body.error?.type ?? '';
  const message = body.error?.message ?? `Cursor API HTTP ${res.status}`;
  if (res.status === 401 || type === 'authentication_error') {
    return new ModelHitchError('invalid-api-key', message, { status: res.status, providerId });
  }
  if (res.status === 429 || type === 'rate_limit_error') {
    return new ModelHitchError('rate-limited', message, { status: res.status, providerId, retryAfterMs });
  }
  if (res.status === 409) {
    return new ModelHitchError('rate-limited', message, { status: res.status, providerId, retryAfterMs: retryAfterMs ?? 5_000 });
  }
  if (res.status === 404 || type === 'invalid_request_error') {
    return new ModelHitchError('bad-request', message, { status: res.status, providerId });
  }
  if (res.status >= 500 || type === 'upstream_error' || type === 'service_unavailable') {
    return new ModelHitchError('provider-error', message, { status: res.status, providerId });
  }
  return new ModelHitchError('provider-error', message, { status: res.status, providerId });
}

function extractLatestUserPrompt(messages: ModelMessage[]): { text: string; images: Array<{ data?: string; url?: string; mimeType?: string }> } {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) {
    throw new ModelHitchError('bad-request', 'Cloud agent requests need at least one user message.', {
      providerId: CURSOR_CLOUD_PROVIDER_ID,
      status: 400,
    });
  }
  const images: Array<{ data?: string; url?: string; mimeType?: string }> = [];
  if (typeof lastUser.content === 'string') {
    return { text: lastUser.content, images };
  }
  const textParts: string[] = [];
  for (const part of lastUser.content) {
    if (part.type === 'text') textParts.push(part.text);
    else if (part.type === 'image') images.push({ url: part.imageUrl });
    else if (part.type === 'image-data') images.push({ data: part.data, mimeType: part.mimeType });
  }
  const text = textParts.join('\n').trim();
  if (!text && images.length === 0) {
    throw new ModelHitchError('bad-request', 'Cloud agent requests need non-empty user content.', {
      providerId: CURSOR_CLOUD_PROVIDER_ID,
      status: 400,
    });
  }
  return { text: text || '(image attachment)', images };
}

function toPromptImages(images: Array<{ data?: string; url?: string; mimeType?: string }>) {
  if (!images.length) return undefined;
  return images.map((image) => {
    if (image.data && image.mimeType) return { data: image.data, mimeType: image.mimeType };
    if (image.url) return { url: image.url };
    return { url: '' };
  });
}

export function createCursorCloudProvider(options: CursorCloudProviderOptions): Provider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? CURSOR_CLOUD_API_BASE).replace(/\/$/, '');
  const config = options.config;
  const sessionStore = options.sessionStore;
  let cachedRepositories: CloudAgentRepoConfig[] | null = null;
  let repositoriesFetchedAt = 0;

  async function cursorFetch(path: string, init: RequestInit, apiKey: string): Promise<Response> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw await mapCursorResponseError(res, CURSOR_CLOUD_PROVIDER_ID);
    return res;
  }

  async function fetchRepositories(apiKey: string): Promise<CloudAgentRepoConfig[]> {
    const now = Date.now();
    if (cachedRepositories && now - repositoriesFetchedAt < 60_000) return cachedRepositories;
    const res = await cursorFetch('/repositories', { method: 'GET' }, apiKey);
    const body = (await res.json()) as CursorRepositoriesResponse;
    const items = body.items ?? body.repositories ?? [];
    const mapped = items
      .map((entry) => {
        const url = entry.url ?? (entry.repository?.startsWith('http') ? entry.repository : undefined);
        if (!url) return null;
        const startingRef = entry.startingRef ?? entry.defaultBranch;
        return startingRef ? { url, startingRef } : { url };
      })
      .filter((entry): entry is CloudAgentRepoConfig => entry !== null);
    cachedRepositories = mapped;
    repositoriesFetchedAt = now;
    return mapped;
  }

  async function resolveRepos(apiKey: string): Promise<CloudAgentRepoConfig[]> {
    if (config.repos?.length) return config.repos;
    const cached = await fetchRepositories(apiKey);
    if (cached.length === 1) return cached;
    throw new ModelHitchError(
      'bad-request',
      'cloudAgent.repos must include at least one repository URL (or connect exactly one repo for automatic selection).',
      { providerId: CURSOR_CLOUD_PROVIDER_ID, status: 400 },
    );
  }

  async function createAgent(apiKey: string, promptText: string, model: string, images?: ReturnType<typeof toPromptImages>): Promise<{ agentId: string; runId: string }> {
    const repos = await resolveRepos(apiKey);
    const body: Record<string, unknown> = {
      prompt: { text: promptText, ...(images?.length ? { images } : {}) },
      model: { id: model },
      repos,
      mode: config.mode ?? 'agent',
      autoCreatePR: false,
      workOnCurrentBranch: config.workOnCurrentBranch ?? false,
    };
    const res = await cursorFetch('/agents', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }, apiKey);
    const payload = (await res.json()) as CursorAgentCreateResponse;
    return { agentId: payload.agent.id, runId: payload.run.id };
  }

  async function createRun(apiKey: string, agentId: string, promptText: string, images?: ReturnType<typeof toPromptImages>): Promise<string> {
    const body: Record<string, unknown> = {
      prompt: { text: promptText, ...(images?.length ? { images } : {}) },
      mode: config.mode ?? 'agent',
    };
    const res = await cursorFetch(`/agents/${agentId}/runs`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }, apiKey);
    const payload = (await res.json()) as CursorRunCreateResponse;
    return payload.run.id;
  }

  async function getRun(apiKey: string, agentId: string, runId: string): Promise<CursorRunDetail> {
    const res = await cursorFetch(`/agents/${agentId}/runs/${runId}`, { method: 'GET' }, apiKey);
    return (await res.json()) as CursorRunDetail;
  }

  async function resolveRun(
    apiKey: string,
    params: ChatParams,
    model: string,
  ): Promise<{ agentId: string; runId: string; sessionId: string }> {
    const sessionId = params.sessionId ?? deriveSessionId(params.messages);
    const { text, images } = extractLatestUserPrompt(params.messages);
    const promptImages = toPromptImages(images);
    const reuse = config.sessionReuse ?? 'per-bridge-session';
    let agentId = reuse === 'per-request' ? undefined : sessionStore.get(sessionId);
    let runId: string;
    if (!agentId) {
      const created = await createAgent(apiKey, text, model, promptImages);
      agentId = created.agentId;
      runId = created.runId;
      if (reuse !== 'per-request') sessionStore.set(sessionId, agentId);
    } else {
      runId = await createRun(apiKey, agentId, text, promptImages);
    }
    return { agentId, runId, sessionId };
  }

  async function* streamRunEvents(apiKey: string, agentId: string, runId: string, signal?: AbortSignal): AsyncGenerator<SseEvent> {
    const res = await fetchImpl(`${baseUrl}/agents/${agentId}/runs/${runId}/stream`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'text/event-stream' },
      signal,
    });
    if (res.status === 410) {
      const detail = await getRun(apiKey, agentId, runId);
      yield { event: 'result', data: JSON.stringify({ status: detail.status, text: detail.result ?? '' }) };
      return;
    }
    if (!res.ok) throw await mapCursorResponseError(res, CURSOR_CLOUD_PROVIDER_ID);
    if (!res.body) {
      throw new ModelHitchError('provider-error', 'Cursor run stream returned no body.', { providerId: CURSOR_CLOUD_PROVIDER_ID });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(raw);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const event = parseSseBlock(tail);
      if (event) yield event;
    }
  }

  return {
    id: CURSOR_CLOUD_PROVIDER_ID,
    name: 'Cursor Cloud Agent',
    defaultModel: config.defaultModel ?? 'composer-2.5',
    capabilities: {
      streaming: true,
      toolCalling: false,
      vision: true,
      embeddings: false,
    },

    async chat(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult> {
      const apiKey = resolveApiKey(credentials);
      const { agentId, runId } = await resolveRun(apiKey, params, params.model);
      let text = '';
      let finishReason = 'stop';
      for await (const event of streamRunEvents(apiKey, agentId, runId, params.signal)) {
        if (event.event === 'assistant') {
          try {
            const payload = JSON.parse(event.data) as { text?: string };
            if (payload.text) text += payload.text;
          } catch {
            /* ignore malformed chunk */
          }
        } else if (event.event === 'result') {
          try {
            const payload = JSON.parse(event.data) as { status?: string; text?: string };
            if (payload.text) text = payload.text;
            if (payload.status && payload.status !== 'FINISHED') finishReason = payload.status.toLowerCase();
          } catch {
            /* ignore */
          }
        } else if (event.event === 'error') {
          try {
            const payload = JSON.parse(event.data) as { message?: string };
            throw new ModelHitchError('provider-error', payload.message ?? 'Cursor run stream error.', {
              providerId: CURSOR_CLOUD_PROVIDER_ID,
            });
          } catch (err) {
            if (err instanceof ModelHitchError) throw err;
          }
        }
      }
      if (!text) {
        const detail = await getRun(apiKey, agentId, runId);
        text = detail.result ?? '';
      }
      return {
        message: { role: 'assistant', content: text || '(no assistant text returned)' },
        finishReason,
        raw: { agentId, runId },
      };
    },

    async *stream(params: ChatParams, credentials: ProviderCredentials): AsyncGenerator<StreamChunk> {
      const apiKey = resolveApiKey(credentials);
      const { agentId, runId } = await resolveRun(apiKey, params, params.model);
      let finishReason = 'stop';
      for await (const event of streamRunEvents(apiKey, agentId, runId, params.signal)) {
        if (event.event === 'assistant') {
          try {
            const payload = JSON.parse(event.data) as { text?: string };
            if (payload.text) yield { type: 'text-delta', text: payload.text };
          } catch {
            /* ignore */
          }
        } else if (event.event === 'result') {
          try {
            const payload = JSON.parse(event.data) as { status?: string; text?: string };
            if (payload.text) yield { type: 'text-delta', text: payload.text };
            if (payload.status && payload.status !== 'FINISHED') finishReason = payload.status.toLowerCase();
          } catch {
            /* ignore */
          }
          yield { type: 'finish', finishReason };
          return;
        } else if (event.event === 'error') {
          try {
            const payload = JSON.parse(event.data) as { message?: string };
            throw new ModelHitchError('provider-error', payload.message ?? 'Cursor run stream error.', {
              providerId: CURSOR_CLOUD_PROVIDER_ID,
            });
          } catch (err) {
            if (err instanceof ModelHitchError) throw err;
          }
        }
      }
      yield { type: 'finish', finishReason };
    },

    async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
      const apiKey = resolveApiKey(credentials);
      const res = await cursorFetch('/models', { method: 'GET' }, apiKey);
      const body = (await res.json()) as { items?: Array<{ id: string; name?: string }>; data?: Array<{ id: string; name?: string }> };
      const items = body.items ?? body.data ?? [];
      return items.map((item) => ({ id: item.id, name: item.name }));
    },
  };
}

export function parseSseBlock(block: string): SseEvent | null {
  const lines = block.split('\n');
  let event = 'message';
  let data = '';
  let id: string | undefined;
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
    else if (line.startsWith('id:')) id = line.slice(3).trim();
  }
  if (!data && event === 'heartbeat') return { event, data: '{}' };
  if (!data) return null;
  return { event, data, id };
}
