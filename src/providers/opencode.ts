import { ModelHitchError } from '../core/errors.js';
import { parseRetryAfter } from '../core/headers.js';
import { safeJsonParse } from '../core/json.js';
import { serializeText } from '../core/content.js';
import { bodyToAsyncIterable, parseSSE, requireBody } from '../core/stream.js';
import type {
  Capabilities,
  ChatParams,
  ChatResult,
  ContentPart,
  ModelMessage,
  ProviderCredentials,
  StreamChunk,
  ToolCall,
  Usage,
} from '../core/types.js';
import { AnthropicProvider } from './anthropic.js';
import {
  createOpenAICompatibleProvider,
  mapHTTPError,
  applySessionHeaders,
  DEFAULT_SESSION_HEADERS,
} from './openai-compatible.js';
import { recoverMessageToolCalls, toolSchemaFromDefinitions } from '../core/dsml.js';
import { deriveSessionId } from '../core/session.js';
import type { ModelInfo, Provider } from './types.js';

export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_DEFAULT_MODEL = 'deepseek-v4-pro';

/**
 * OpenCode Go requires a stable per-conversation session header and rejects
 * requests without one (`MissingSessionID`, HTTP 400). Zen accepts the same
 * header, so both lanes send it on every wire.
 * See https://opencode.ai/docs/go/#where-can-i-use-it
 */
export const OPENCODE_SESSION_HEADER = 'x-opencode-session';

/** Session header names sent upstream, OpenCode's required name first. */
export const OPENCODE_SESSION_HEADERS = [
  OPENCODE_SESSION_HEADER,
  'x-session-id',
  'x-conversation-id',
];

/**
 * OpenCode asks clients to identify themselves with a real user agent rather
 * than a generic SDK or HTTP-library name.
 */
export const OPENCODE_USER_AGENT = 'ModelHitch-OpenCode/2.0';

export type OpenCodeWire = 'responses' | 'messages' | 'gemini' | 'chat-completions';

/**
 * Determine the wire protocol based on the model family as documented in the
 * OpenCode Zen reference:
 * - GPT / Grok / Muse Spark -> OpenAI Responses API (`/v1/responses`)
 * - Claude / Qwen -> Anthropic Messages API (`/v1/messages`)
 * - Gemini -> Google AI GenerateContent (`/v1/models/<id>:generateContent`)
 * - DeepSeek / GLM / Kimi / MiniMax / freebies -> OpenAI Chat Completions (`/v1/chat/completions`)
 */
export function detectOpenCodeWire(model: string): OpenCodeWire {
  const clean = model.replace(/^(?:opencode|opencode-go)\//, '');
  if (clean.startsWith('gpt-') || clean.startsWith('grok-') || clean.startsWith('muse-spark-')) {
    return 'responses';
  }
  if (clean.startsWith('claude-') || clean.startsWith('qwen')) {
    return 'messages';
  }
  if (clean.startsWith('gemini-') || clean.startsWith('gemini')) {
    return 'gemini';
  }
  return 'chat-completions';
}

export const OPENCODE_SNAPSHOT_MODELS: string[] = [
  // GPT family (Responses)
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5',
  'gpt-5-codex',
  'gpt-5-nano',
  // Claude family (Messages)
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  // Gemini family
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro',
  'gemini-3-flash',
  // Grok family (Responses)
  'grok-4.7',
  'grok-4.6',
  'grok-4.5',
  'grok-build-0.1',
  // Muse family (Responses)
  'muse-spark-1.3',
  'muse-spark-1.2',
  // Qwen family (Messages)
  'qwen3.8-flash',
  'qwen3.7-max',
  'qwen3.7-plus',
  'qwen3.6-plus',
  'qwen3.5-plus',
  // DeepSeek family (Chat Completions)
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4-flash-vision-exp',
  // MiniMax family (Chat Completions)
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  // GLM family (Chat Completions)
  'glm-5.3-flash',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'glm-5',
  // Kimi family (Chat Completions)
  'kimi-k3',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'kimi-k2.5',
  // Free tier
  'big-pickle',
  'space-bunny-free',
  'mimo-v2.6-flash-free',
  'mimo-v2.5-free',
  'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'muse-spark-1.3-contributor-free',
  'jev-1.13-free',
];

export interface OpenCodeProviderOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKeyEnvVar?: string;
  apiKeyEnvFallbacks?: string[];
  capabilities?: Partial<Capabilities>;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  /**
   * Pin the wire protocol instead of detecting it from the model family.
   * Console BYOK connections fix their schema per connection (`Chat
   * Completions`, `Responses API`, `Anthropic Compatible`, `Google Generative
   * AI`), so the model id is not a reliable signal there — a custom
   * connection can expose `claude-…` over the Chat Completions schema.
   * Left undefined, the Zen/Go behavior (family detection) is unchanged.
   */
  forceWire?: OpenCodeWire;
}

/**
 * The generic multi-wire engine the OpenCode lanes and the custom BYOK lanes
 * are both built from. Everything OpenCode-specific (its base URL, its session
 * header, its user agent, its model-family wire detection, its `GET /models`
 * snapshot) is an *option* here, so a lane that was never in ModelHitch's
 * catalog can be served by the same code path instead of a second copy of the
 * Responses / Anthropic / Gemini mappings.
 *
 * See `createOpenCodeProvider` for the Zen/Go preset and
 * `providers/custom-lane.ts` for the BYOK preset.
 */
export interface MultiWireProviderOptions {
  /** Unique provider id — the lane identity in routing, health, and logs. */
  id: string;
  /** Human-readable name; defaults to the id. */
  name?: string;
  /** Base URL including the version segment, e.g. "https://api.example.com/v1". */
  baseUrl: string;
  /** Model used when a request omits one. */
  defaultModel: string;
  /** Env var read when the caller passes no `apiKey` (optional: BYOK keys
   * usually live in the config `keys` map, which reaches us as a credential). */
  apiKeyEnvVar?: string;
  /** Additional env vars checked when the primary one is unset. */
  apiKeyEnvFallbacks?: string[];
  /** Set false for a keyless endpoint (a self-hosted gateway behind a URL). */
  requiresKey?: boolean;
  /** Label used in the missing-api-key message ("OpenCode", "Lane "x""). */
  providerLabel?: string;
  capabilities?: Partial<Capabilities>;
  /** Extra headers sent with every request (auth overrides included). */
  headers?: Record<string, string>;
  /** Outbound session-header names, in priority order. */
  sessionHeaders?: readonly string[];
  /** User-Agent sent unless the caller set one. */
  userAgent?: string;
  /** Strip this pattern from a model id before it reaches the wire. */
  stripModelPrefix?: RegExp;
  /** Wire used when `forceWire` is unset. Default: OpenCode family detection. */
  detectWire?: (model: string) => OpenCodeWire;
  forceWire?: OpenCodeWire;
  /** Model ids advertised when the endpoint has no usable `GET /models`. */
  snapshotModels?: readonly string[];
  /**
   * Model discovery override. When set it is the ONLY source — no `GET
   * /models` request is made. Custom BYOK lanes use it to advertise the slots
   * the user typed, which is the whole point: never poll a provider whose
   * catalog we cannot know.
   */
  listModels?: (credentials: ProviderCredentials) => Promise<ModelInfo[]>;
  fetchImpl?: typeof fetch;
}

function resolveApiKey(
  credentials: ProviderCredentials,
  envVar: string | undefined,
  envFallbacks: string[],
  providerId: string,
  providerLabel: string,
  requiresKey: boolean,
): string | undefined {
  if (credentials.apiKey) return credentials.apiKey;
  for (const name of [envVar, ...envFallbacks]) {
    if (!name) continue;
    const value = (typeof process !== 'undefined' && process.env?.[name]) as string | undefined;
    if (value) return value;
  }
  if (!requiresKey) return undefined;
  const hint = envVar
    ? ` Set ${envVar} in your environment or configure it in ModelHitch settings.`
    : ' Add one in ModelHitch settings.';
  throw new ModelHitchError('missing-api-key', `${providerLabel} requires an API key.${hint}`, {
    providerId,
  });
}

/** Case-insensitive header presence check (a caller's own header always wins). */
function hasHeader(headers: Record<string, string>, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

function chatParamsToResponsesBody(params: ChatParams, stream = false): Record<string, unknown> {
  const cleanModel = params.model.replace(/^(?:opencode|opencode-go)\//, '');
  const body: Record<string, unknown> = {
    model: cleanModel,
    stream,
  };
  const input: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];

  for (const m of params.messages) {
    if (m.role === 'system') {
      const text = serializeText(m.content);
      if (text) instructions.push(text);
    } else if (m.role === 'user') {
      if (typeof m.content === 'string') {
        input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: m.content }],
        });
      } else if (Array.isArray(m.content)) {
        const parts: Array<Record<string, unknown>> = [];
        for (const p of m.content) {
          if (p.type === 'text') {
            parts.push({ type: 'input_text', text: p.text });
          } else if (p.type === 'image') {
            parts.push({ type: 'input_image', image_url: { url: p.imageUrl } });
          } else if (p.type === 'image-data') {
            parts.push({ type: 'input_image', image_url: { url: `data:${p.mimeType};base64,${p.data}` } });
          }
        }
        input.push({ type: 'message', role: 'user', content: parts });
      }
    } else if (m.role === 'assistant') {
      const text = serializeText(m.content);
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        });
      }
    } else if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId,
        output: serializeText(m.content),
      });
    }
  }

  if (instructions.length) {
    body.instructions = instructions.join('\n\n');
  }
  body.input = input;

  if (params.tools?.length) {
    body.tools = params.tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  if (params.toolChoice) {
    if (typeof params.toolChoice === 'string') {
      body.tool_choice = params.toolChoice;
    } else if (params.toolChoice.type === 'function') {
      body.tool_choice = { type: 'function', name: params.toolChoice.name };
    }
  }
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.maxTokens !== undefined) body.max_output_tokens = params.maxTokens;
  if (params.stop?.length) body.stop = params.stop;
  return body;
}

function chatParamsToGeminiBody(params: ChatParams): Record<string, unknown> {
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;

  for (const m of params.messages) {
    if (m.role === 'system') {
      const text = serializeText(m.content);
      if (text) systemInstruction = { parts: [{ text }] };
    } else if (m.role === 'user') {
      const parts: Array<Record<string, unknown>> = [];
      if (typeof m.content === 'string') {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') parts.push({ text: p.text });
          else if (p.type === 'image-data') parts.push({ inlineData: { mimeType: p.mimeType, data: p.data } });
          else if (p.type === 'image') parts.push({ fileData: { fileUri: p.imageUrl } });
        }
      }
      contents.push({ role: 'user', parts });
    } else if (m.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      const text = serializeText(m.content);
      if (text) parts.push({ text });
      for (const tc of m.toolCalls ?? []) {
        parts.push({
          functionCall: { id: tc.id, name: tc.name, args: tc.arguments },
        });
      }
      contents.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: 'tool_response',
            response: { content: serializeText(m.content) },
          },
        }],
      });
    }
  }

  const body: Record<string, unknown> = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (params.tools?.length) {
    body.tools = [{
      functionDeclarations: params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }];
  }
  const genConfig: Record<string, unknown> = {};
  if (params.temperature !== undefined) genConfig.temperature = params.temperature;
  if (params.maxTokens !== undefined) genConfig.maxOutputTokens = params.maxTokens;
  if (params.stop?.length) genConfig.stopSequences = params.stop;
  if (Object.keys(genConfig).length) body.generationConfig = genConfig;
  return body;
}

/**
 * Ensure every OpenCode request carries a session id. Go rejects requests
 * without one, and Zen uses it for routing and cache affinity, so a caller that
 * supplies nothing gets a stable id derived from the conversation.
 */
function withSession(params: ChatParams): ChatParams {
  return params.sessionId ? params : { ...params, sessionId: deriveSessionId(params.messages) };
}

/**
 * DeepSeek-family models can emit tool calls as DSML markup in the text channel
 * instead of real `tool_calls`; recover them so no client ever sees raw markup.
 */
function finalizeOpenCodeMessage(
  messageText: string,
  toolCalls: ToolCall[] | undefined,
  params: ChatParams,
): { message: ModelMessage; finishReason: string } {
  const recovery = recoverMessageToolCalls(
    { content: messageText, toolCalls },
    toolSchemaFromDefinitions(params.tools),
  );
  const content = typeof recovery.content === 'string' ? recovery.content : messageText;
  const calls = recovery.toolCalls;
  return {
    message: {
      role: 'assistant',
      content,
      toolCalls: calls && calls.length > 0 ? calls : undefined,
    },
    finishReason: recovery.recovered ? 'tool-calls' : '',
  };
}

export function createMultiWireProvider(opts: MultiWireProviderOptions): Provider {
  const id = opts.id;
  const name = opts.name ?? opts.id;
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const defaultModel = opts.defaultModel;
  const apiKeyEnvVar = opts.apiKeyEnvVar;
  const apiKeyEnvFallbacks = opts.apiKeyEnvFallbacks ?? [];
  const providerLabel = opts.providerLabel ?? name;
  const requiresKey = opts.requiresKey !== false;
  const sessionHeaders = opts.sessionHeaders ?? DEFAULT_SESSION_HEADERS;
  const userAgent = opts.userAgent ?? 'ModelHitch/2.0';
  const stripModelPrefix = opts.stripModelPrefix;
  const detectWire = opts.detectWire ?? detectOpenCodeWire;
  const snapshotModels = opts.snapshotModels ?? OPENCODE_SNAPSHOT_MODELS;
  const listModelsOverride = opts.listModels;
  const fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  const customHeaders = opts.headers ?? {};

  /** Model id as the endpoint expects it (OpenCode lanes strip their own prefix). */
  const stripModel = (model: string): string =>
    stripModelPrefix ? model.replace(stripModelPrefix, '') : model;

  const capabilities: Capabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
    ...opts.capabilities,
  };

  /**
   * Resolve the credential once, before the wire is chosen.
   *
   * Every wire used to answer "is there a key?" for itself, which meant a
   * missing key was reported by whichever delegate happened to be picked — and
   * `requiresKey: false` only worked on some of them. One resolution here keeps
   * the answer (and the error naming the lane) identical across wires.
   */
  const scopedCredentials = (credentials: ProviderCredentials): ProviderCredentials => {
    const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id, providerLabel, requiresKey);
    return apiKey ? { ...credentials, apiKey } : credentials;
  };

  // Internal delegate for OpenAI Chat Completions wire (DeepSeek, GLM, Kimi, MiniMax, freebies)
  //
  // `requiresKey: false` is deliberate: the engine resolves the key once for
  // every wire (see `scopedCredentials`), so a keyless custom lane works here
  // too and a missing key is reported in the lane's own terms rather than by a
  // delegate that does not know what it is serving.
  const chatCompletionsDelegate = createOpenAICompatibleProvider({
    id,
    name,
    baseUrl,
    defaultModel,
    apiKeyEnvVar,
    apiKeyEnvFallbacks,
    requiresKey: false,
    capabilities,
    headers: customHeaders,
    sessionHeaders: [...sessionHeaders],
    fetchImpl,
  });

  // Internal delegate for Anthropic Messages wire (Claude, Qwen). The endpoint
  // is Anthropic-shaped and reads the key from `x-api-key`, so a bearer-only
  // request is answered "Missing API key" even when the key is valid — verified
  // against opencode.ai/zen/v1/messages. Both spellings go out because the other
  // OpenCode wires read `Authorization`, and upstream ignores the header it does
  // not use.
  const messagesDelegate = new AnthropicProvider({
    id,
    name,
    baseUrl,
    defaultModel,
    messagesPath: '/messages',
    authScheme: 'bearer-and-x-api-key',
    apiKeyEnvVar,
    apiKeyEnvFallbacks,
    capabilities,
    headers: customHeaders,
    sessionHeaders: OPENCODE_SESSION_HEADERS,
    fetchImpl,
  });

  async function chatResponses(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult> {
    const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id, providerLabel, requiresKey);
    const body = chatParamsToResponsesBody(params, false);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };
    if (apiKey && !hasHeader(headers, 'authorization')) headers.Authorization = `Bearer ${apiKey}`;
    applySessionHeaders(headers, params.sessionId, sessionHeaders);
    if (!hasHeader(headers, 'user-agent')) headers['User-Agent'] = userAgent;

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      if (err instanceof ModelHitchError) throw err;
      throw new ModelHitchError('network-error', `Request to provider "${id}" failed: ${(err as Error)?.message}`, {
        providerId: id,
        cause: err,
      });
    }

    const text = await res.text();
    if (!res.ok) {
      throw mapHTTPError(res.status, id, text, parseRetryAfter(res.headers.get('retry-after')));
    }

    const data = safeJsonParse<Record<string, unknown>>(text, {});
    const outputList = Array.isArray(data.output) ? data.output : [];
    let messageText = '';
    const toolCalls: ToolCall[] = [];

    for (const item of outputList) {
      const obj = item as Record<string, unknown>;
      if (obj.type === 'message') {
        const contentList = Array.isArray(obj.content) ? obj.content : [];
        for (const c of contentList) {
          const part = c as Record<string, unknown>;
          if (part.type === 'output_text') {
            messageText += String(part.text ?? '');
          }
        }
      } else if (obj.type === 'function_call') {
        toolCalls.push({
          id: String(obj.call_id ?? obj.id ?? `call_${toolCalls.length}`),
          name: String(obj.name ?? ''),
          arguments: safeJsonParse<Record<string, unknown>>(String(obj.arguments ?? '{}'), {}),
        });
      }
    }

    const usageRaw = (data.usage ?? {}) as Record<string, number | undefined>;
    const usage: Usage = {
      inputTokens: usageRaw.input_tokens ?? 0,
      outputTokens: usageRaw.output_tokens ?? 0,
      totalTokens: usageRaw.total_tokens ?? (usageRaw.input_tokens ?? 0) + (usageRaw.output_tokens ?? 0),
    };

    const finishReason = toolCalls.length ? 'tool-calls' : data.status === 'incomplete' ? 'length' : 'stop';
    const finalized = finalizeOpenCodeMessage(messageText, toolCalls.length ? toolCalls : undefined, params);

    return {
      message: finalized.message,
      finishReason: finalized.finishReason || finishReason,
      usage,
      raw: data,
    };
  }

  async function* streamResponses(params: ChatParams, credentials: ProviderCredentials): AsyncIterable<StreamChunk> {
    const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id, providerLabel, requiresKey);
    const body = chatParamsToResponsesBody(params, true);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };
    if (apiKey && !hasHeader(headers, 'authorization')) headers.Authorization = `Bearer ${apiKey}`;
    applySessionHeaders(headers, params.sessionId, sessionHeaders);
    if (!hasHeader(headers, 'user-agent')) headers['User-Agent'] = userAgent;

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      if (err instanceof ModelHitchError) throw err;
      throw new ModelHitchError('network-error', `Request to provider "${id}" failed: ${(err as Error)?.message}`, {
        providerId: id,
        cause: err,
      });
    }

    if (!res.ok) {
      const text = await res.text();
      throw mapHTTPError(res.status, id, text, parseRetryAfter(res.headers.get('retry-after')));
    }

    let emittedFinish = false;
    let accumulatedUsage: Usage | undefined;
    /**
     * Responses carries two ids for one function call and uses a different one
     * on each event: `output_item.added` names the call (`call_id`) *and* the
     * item (`id`), while `function_call_arguments.delta` names only the item.
     * A consumer joins a chunk by the id its `tool-call-start` carried, so the
     * delta has to be re-keyed onto that call id — emitting the item id there
     * starts an entry and then appends the arguments to nothing, and the call
     * arrives with `{}`. OpenAI's own stream behaves the same way, so the
     * mapping belongs here rather than at every consumer.
     */
    const callIdByItemId = new Map<string, string>();

    for await (const sse of parseSSE(bodyToAsyncIterable(requireBody(res, id)))) {
      const data = safeJsonParse<Record<string, unknown>>(sse, {});
      const type = String(data.type ?? '');

      if (type === 'response.output_text.delta') {
        const delta = String(data.delta ?? '');
        if (delta) yield { type: 'text-delta', text: delta };
      } else if (type === 'response.output_item.added') {
        const item = (data.item ?? {}) as Record<string, unknown>;
        if (item.type === 'function_call') {
          const callId = String(item.call_id ?? item.id ?? '');
          if (item.id !== undefined) callIdByItemId.set(String(item.id), callId);
          yield {
            type: 'tool-call-start',
            id: callId,
            name: String(item.name ?? ''),
          };
        }
      } else if (type === 'response.function_call_arguments.delta') {
        const delta = String(data.delta ?? '');
        const itemId = String(data.item_id ?? '');
        yield {
          type: 'tool-call-args-delta',
          id: callIdByItemId.get(itemId) ?? itemId,
          argsDelta: delta,
        };
      } else if (type === 'response.output_item.done') {
        const item = (data.item ?? {}) as Record<string, unknown>;
        if (item.type === 'function_call') {
          const callId = callIdByItemId.get(String(item.id ?? '')) ?? String(item.call_id ?? item.id ?? '');
          yield {
            type: 'tool-call-end',
            id: callId,
          };
        }
      } else if (type === 'response.completed') {
        const resp = (data.response ?? {}) as Record<string, unknown>;
        const u = (resp.usage ?? data.usage ?? {}) as Record<string, number | undefined>;
        accumulatedUsage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          totalTokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        };
        emittedFinish = true;
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: accumulatedUsage,
        };
      }
    }

    if (!emittedFinish) {
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: accumulatedUsage,
      };
    }
  }

  async function chatGemini(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult> {
    const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id, providerLabel, requiresKey);
    const cleanModel = stripModel(params.model);
    const body = chatParamsToGeminiBody(params);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };
    if (apiKey && !hasHeader(headers, 'x-goog-api-key')) headers['x-goog-api-key'] = apiKey;
    applySessionHeaders(headers, params.sessionId, sessionHeaders);
    if (!hasHeader(headers, 'user-agent')) headers['User-Agent'] = userAgent;

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/models/${cleanModel}:generateContent`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      if (err instanceof ModelHitchError) throw err;
      throw new ModelHitchError('network-error', `Request to provider "${id}" failed: ${(err as Error)?.message}`, {
        providerId: id,
        cause: err,
      });
    }

    const text = await res.text();
    if (!res.ok) {
      throw mapHTTPError(res.status, id, text, parseRetryAfter(res.headers.get('retry-after')));
    }

    const data = safeJsonParse<Record<string, unknown>>(text, {});
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const firstCandidate = (candidates[0] ?? {}) as Record<string, unknown>;
    const content = (firstCandidate.content ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts) ? content.parts : [];

    let messageText = '';
    const toolCalls: ToolCall[] = [];

    for (const p of parts) {
      const part = p as Record<string, unknown>;
      if (typeof part.text === 'string') {
        messageText += part.text;
      }
      if (part.functionCall && typeof part.functionCall === 'object') {
        const fc = part.functionCall as Record<string, unknown>;
        toolCalls.push({
          id: String(fc.id ?? `call_${toolCalls.length}`),
          name: String(fc.name ?? ''),
          arguments: (fc.args as Record<string, unknown>) ?? {},
        });
      }
    }

    const meta = (data.usageMetadata ?? {}) as Record<string, number | undefined>;
    const inputTokens = meta.promptTokenCount ?? 0;
    const outputTokens = meta.candidatesTokenCount ?? 0;
    const usage: Usage = {
      inputTokens,
      outputTokens,
      totalTokens: meta.totalTokenCount ?? inputTokens + outputTokens,
    };

    const rawReason = String(firstCandidate.finishReason ?? 'STOP');
    const finishReason = toolCalls.length ? 'tool-calls' : rawReason === 'MAX_TOKENS' ? 'length' : 'stop';
    const finalized = finalizeOpenCodeMessage(messageText, toolCalls.length ? toolCalls : undefined, params);

    return {
      message: finalized.message,
      finishReason: finalized.finishReason || finishReason,
      usage,
      raw: data,
    };
  }

  async function* streamGemini(params: ChatParams, credentials: ProviderCredentials): AsyncIterable<StreamChunk> {
    const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id, providerLabel, requiresKey);
    const cleanModel = stripModel(params.model);
    const body = chatParamsToGeminiBody(params);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };
    if (apiKey && !hasHeader(headers, 'x-goog-api-key')) headers['x-goog-api-key'] = apiKey;
    applySessionHeaders(headers, params.sessionId, sessionHeaders);
    if (!hasHeader(headers, 'user-agent')) headers['User-Agent'] = userAgent;

    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/models/${cleanModel}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      if (err instanceof ModelHitchError) throw err;
      throw new ModelHitchError('network-error', `Request to provider "${id}" failed: ${(err as Error)?.message}`, {
        providerId: id,
        cause: err,
      });
    }

    if (!res.ok) {
      const text = await res.text();
      throw mapHTTPError(res.status, id, text, parseRetryAfter(res.headers.get('retry-after')));
    }

    let emittedFinish = false;
    let accumulatedUsage: Usage | undefined;

    for await (const sse of parseSSE(bodyToAsyncIterable(requireBody(res, id)))) {
      const data = safeJsonParse<Record<string, unknown>>(sse, {});
      const candidates = Array.isArray(data.candidates) ? data.candidates : [];
      const firstCandidate = (candidates[0] ?? {}) as Record<string, unknown>;
      const content = (firstCandidate.content ?? {}) as Record<string, unknown>;
      const parts = Array.isArray(content.parts) ? content.parts : [];

      for (const p of parts) {
        const part = p as Record<string, unknown>;
        if (typeof part.text === 'string' && part.text) {
          yield { type: 'text-delta', text: part.text };
        }
        if (part.functionCall && typeof part.functionCall === 'object') {
          const fc = part.functionCall as Record<string, unknown>;
          const callId = String(fc.id ?? 'call_0');
          yield {
            type: 'tool-call-start',
            id: callId,
            name: String(fc.name ?? ''),
          };
          yield {
            type: 'tool-call-args-delta',
            id: callId,
            argsDelta: JSON.stringify(fc.args ?? {}),
          };
          yield {
            type: 'tool-call-end',
            id: callId,
          };
        }
      }

      if (data.usageMetadata && typeof data.usageMetadata === 'object') {
        const meta = data.usageMetadata as Record<string, number | undefined>;
        accumulatedUsage = {
          inputTokens: meta.promptTokenCount ?? 0,
          outputTokens: meta.candidatesTokenCount ?? 0,
          totalTokens: meta.totalTokenCount ?? (meta.promptTokenCount ?? 0) + (meta.candidatesTokenCount ?? 0),
        };
      }

      if (firstCandidate.finishReason) {
        emittedFinish = true;
        yield {
          type: 'finish',
          finishReason: 'stop',
          usage: accumulatedUsage,
        };
      }
    }

    if (!emittedFinish) {
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: accumulatedUsage,
      };
    }
  }

  return {
    id,
    name,
    defaultModel,
    capabilities,

    async chat(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult> {
      const cleanModel = stripModel(params.model);
      const wire = opts.forceWire ?? detectWire(cleanModel);
      const normalizedParams: ChatParams = withSession({ ...params, model: cleanModel });
      const scoped = scopedCredentials(credentials);

      switch (wire) {
        case 'responses':
          return chatResponses(normalizedParams, scoped);
        case 'messages':
          return messagesDelegate.chat(normalizedParams, scoped);
        case 'gemini':
          return chatGemini(normalizedParams, scoped);
        case 'chat-completions':
        default:
          return chatCompletionsDelegate.chat(normalizedParams, scoped);
      }
    },

    async *stream(params: ChatParams, credentials: ProviderCredentials): AsyncIterable<StreamChunk> {
      const cleanModel = stripModel(params.model);
      const wire = opts.forceWire ?? detectWire(cleanModel);
      const normalizedParams: ChatParams = withSession({ ...params, model: cleanModel });
      const scoped = scopedCredentials(credentials);

      switch (wire) {
        case 'responses':
          yield* streamResponses(normalizedParams, scoped);
          break;
        case 'messages':
          yield* messagesDelegate.stream(normalizedParams, scoped);
          break;
        case 'gemini':
          yield* streamGemini(normalizedParams, scoped);
          break;
        case 'chat-completions':
        default:
          yield* chatCompletionsDelegate.stream(normalizedParams, scoped);
          break;
      }
    },

    async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
      // An explicit override is the only source: a BYOK lane never polls.
      if (listModelsOverride) return listModelsOverride(credentials);
      try {
        const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id, providerLabel, requiresKey);
        if (!apiKey && requiresKey) return snapshotModels.map((mId) => ({ id: mId, name: mId }));
        const headers: Record<string, string> = { ...customHeaders };
        if (apiKey && !hasHeader(headers, 'authorization')) headers.Authorization = `Bearer ${apiKey}`;
        const res = await fetchImpl(`${baseUrl}/models`, { method: 'GET', headers });
        if (res.ok) {
          const json = await res.json();
          const list = Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [];
          if (list.length > 0) {
            return list.map((m: { id: string; name?: string }) => ({
              id: m.id,
              name: m.name ?? m.id,
            }));
          }
        }
      } catch {
        // Fall back to static snapshot
      }

      return snapshotModels.map((mId) => ({
        id: mId,
        name: mId,
      }));
    },
  };
}

/**
 * The OpenCode Zen / Go preset over the generic multi-wire engine.
 *
 * OpenCode is what the generic engine was extracted from, so this preset is
 * where its quirks live: the `x-opencode-session` header Go requires, the
 * `ModelHitch-OpenCode/2.0` user agent OpenCode asks clients to send, the
 * `opencode/`-prefixed model ids the lane accepts, `OPENCODE_API_KEY` as the
 * credential fallback, and the Zen model snapshot as the offline catalog.
 */
export function createOpenCodeProvider(opts: OpenCodeProviderOptions = {}): Provider {
  return createMultiWireProvider({
    id: opts.id ?? 'opencode',
    name: opts.name ?? 'OpenCode Zen',
    baseUrl: opts.baseUrl ?? OPENCODE_ZEN_BASE_URL,
    defaultModel: opts.defaultModel ?? OPENCODE_DEFAULT_MODEL,
    apiKeyEnvVar: opts.apiKeyEnvVar ?? 'OPENCODE_API_KEY',
    apiKeyEnvFallbacks: opts.apiKeyEnvFallbacks,
    providerLabel: 'OpenCode',
    capabilities: {
      streaming: true,
      toolCalling: true,
      vision: true,
      embeddings: true,
      maxContextTokens: 1_000_000,
      ...opts.capabilities,
    },
    headers: opts.headers,
    sessionHeaders: OPENCODE_SESSION_HEADERS,
    userAgent: OPENCODE_USER_AGENT,
    stripModelPrefix: /^(?:opencode|opencode-go)\//,
    detectWire: detectOpenCodeWire,
    forceWire: opts.forceWire,
    snapshotModels: OPENCODE_SNAPSHOT_MODELS,
    fetchImpl: opts.fetchImpl,
  });
}

/** OpenCode Zen pay-per-use provider instance */
export const opencode: Provider = createOpenCodeProvider({
  id: 'opencode',
  name: 'OpenCode Zen',
  baseUrl: OPENCODE_ZEN_BASE_URL,
  defaultModel: OPENCODE_DEFAULT_MODEL,
});

/** OpenCode Go flat-rate subscription provider instance */
export const opencodeGo: Provider = createOpenCodeProvider({
  id: 'opencode-go',
  name: 'OpenCode Go',
  baseUrl: OPENCODE_GO_BASE_URL,
  defaultModel: OPENCODE_DEFAULT_MODEL,
});
