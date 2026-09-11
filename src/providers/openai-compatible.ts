import { ModelHitchError } from '../core/errors.js';
import { parseRetryAfter } from '../core/headers.js';
import { resolveOpenAICompatMaxTokens } from '../core/max-tokens.js';
import type {
  Capabilities,
  ChatParams,
  ChatResult,
  ContentPart,
  ModelMessage,
  ProviderCredentials,
  ResponseFormat,
  StreamChunk,
  ToolCall,
  ToolChoice,
  Usage,
} from '../core/types.js';
import { safeJsonParse } from '../core/json.js';
import { bodyToAsyncIterable, parseSSE, requireBody } from '../core/stream.js';
import type { ModelInfo, Provider } from './types.js';

export interface OpenAICompatibleConfig {
  /** Unique provider id, e.g. "vercel-ai-gateway". */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Default model id used when the caller doesn't specify one. */
  defaultModel: string;
  /** Base URL including the version segment, e.g. "https://api.openai.com/v1". */
  baseUrl: string;
  /** Primary env var to read the API key from as a fallback. */
  apiKeyEnvVar?: string;
  /** Additional env vars checked when the primary one is unset. */
  apiKeyEnvFallbacks?: string[];
  /**
   * Extra credential sources tried after env vars (e.g. Vercel CLI auth.json).
   * Return a non-empty string to use it as the bearer token.
   */
  extraApiKeySources?: Array<() => string | undefined | null>;
  /** Optional guidance appended to the missing-api-key error. */
  missingApiKeyHint?: string;
  /** Set false for local endpoints that don't need a key (e.g. LM Studio). */
  requiresKey?: boolean;
  /** Set false when model discovery is public even though inference requires a key. */
  modelsRequireKey?: boolean;
  /** Optional `/models` type allowlist for gateways that expose mixed media catalogs. */
  modelTypes?: string[];
  capabilities?: Partial<Capabilities>;
  /** Extra headers to send with every request. */
  headers?: Record<string, string>;
  /** Injectable fetch for tests and edge runtimes. */
  fetchImpl?: typeof fetch;
  /**
   * When the caller omits `maxTokens`, send this as `max_tokens` instead of
   * leaving the field off the wire. Gateways like Vercel AI Gateway inject an
   * oversize catalog default (65536) when the field is absent.
   */
  defaultMaxTokens?: number;
  /** Clamp explicit `maxTokens` above this value before sending. */
  maxTokensCeiling?: number;
}

interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface OpenAIToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[];
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  /** Chain-of-thought emitted by reasoning models (e.g. DeepSeek thinking mode). */
  reasoning_content?: string;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface OpenAIStreamChoice {
  index?: number;
  delta?: Partial<OpenAIMessage>;
  finish_reason?: string | null;
}

interface OpenAIStreamChunk {
  choices?: OpenAIStreamChoice[];
  usage?: OpenAIUsage;
}

interface OpenAIChatCompletion {
  choices?: Array<{
    message?: OpenAIMessage;
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
  model?: string;
}

function toOpenAIContent(content: string | ContentPart[]): string | OpenAIContentPart[] {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return { type: 'image_url', image_url: { url: part.imageUrl } };
    return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
  });
}

function toOpenAIMessages(messages: ModelMessage[]): OpenAIMessage[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
      case 'user':
        return { role: m.role, content: toOpenAIContent(m.content), name: m.name };
      case 'assistant': {
        const openai: OpenAIMessage = {
          role: 'assistant',
          content: toOpenAIContent(m.content),
          tool_calls: m.toolCalls?.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        };
        // Thinking-mode providers (e.g. DeepSeek) require the prior
        // `reasoning_content` to be echoed verbatim on every assistant message
        // in later requests; omitting it makes them reject the conversation.
        if (m.reasoningContent) openai.reasoning_content = m.reasoningContent;
        return openai;
      }
      case 'tool':
        // Tool content must be a plain string for chat-completions providers
        // (e.g. GLM's pydantic backend rejects anything else with
        // "Input should be a valid string"). Defensively coerce: never let a
        // non-string value reach the wire.
        return {
          role: 'tool',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
          tool_call_id: m.toolCallId,
        };
    }
  });
}

function toOpenAITools(tools: ChatParams['tools']): Array<{ type: string; function: unknown }> | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ type: 'function', function: t }));
}

/** Map a normalized ToolChoice to the OpenAI wire format. */
function toOpenAIToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  return { type: 'function', function: { name: choice.name } };
}

/** Map a normalized ResponseFormat to the OpenAI wire format. */
function toOpenAIResponseFormat(format: ResponseFormat | undefined): unknown {
  if (!format) return undefined;
  if (format === 'text') return { type: 'text' };
  if (format === 'json') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name ?? 'response',
        strict: format.strict ?? false,
        schema: format.schema,
      },
    };
  }
  return format;
}

function toUsage(u?: OpenAIUsage): Usage | undefined {
  if (!u) return undefined;
  const usage: Usage = {};
  if (u.prompt_tokens !== undefined) usage.inputTokens = u.prompt_tokens;
  if (u.completion_tokens !== undefined) usage.outputTokens = u.completion_tokens;
  if (u.total_tokens !== undefined) usage.totalTokens = u.total_tokens;
  return Object.keys(usage).length ? usage : undefined;
}

function mapFinishReason(reason?: string | null): string {
  switch (reason) {
    case undefined:
    case null:
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool-calls';
    case 'content_filter':
      return 'content-filter';
    default:
      return reason;
  }
}

function toToolCalls(toolCalls?: OpenAIToolCall[]): ToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;
  return toolCalls.map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.function?.name ?? 'unknown',
    arguments: safeJsonParse<Record<string, unknown>>(tc.function?.arguments ?? '', {}),
  }));
}

/** Build the OpenAI-compatible error message body into a truncatable string. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Some OpenAI-compatible gateways wrap upstream 5xx/unavailable errors in HTTP 400. */
function isTransientUpstreamError(bodyText: string): boolean {
  const normalized = bodyText.toLowerCase();
  return (
    /"(?:type|code)"\s*:\s*"(?:server_error|model_unavailable|service_unavailable)"/.test(normalized) ||
    /\bmodel\b.{0,80}\b(?:is\s+)?(?:currently\s+|temporarily\s+)?unavailable\b/.test(normalized)
  );
}

/** Map an HTTP status to a ModelHitchError with a friendly message. */
export function mapHTTPError(
  status: number,
  providerId: string,
  bodyText: string,
  retryAfterMs?: number,
): ModelHitchError {
  const detail = bodyText ? ` (${truncate(bodyText, 300)})` : '';
  switch (status) {
    case 401:
      return new ModelHitchError('invalid-api-key', `Provider "${providerId}" rejected the API key.`, {
        status,
        providerId,
      });
    case 403:
      return new ModelHitchError('invalid-api-key', `Provider "${providerId}" denied access (403).`, {
        status,
        providerId,
      });
    case 429:
      return new ModelHitchError('rate-limited', `Provider "${providerId}" rate limited the request.`, {
        status,
        providerId,
        retryAfterMs,
      });
    case 404:
      return new ModelHitchError(
        'model-not-found',
        `Provider "${providerId}" could not find the model or endpoint.${detail}`,
        { status, providerId },
      );
    case 400:
      if (isTransientUpstreamError(bodyText)) {
        return new ModelHitchError('provider-error', `Provider "${providerId}" is temporarily unavailable.${detail}`, {
          status,
          providerId,
        });
      }
      return new ModelHitchError('bad-request', `Provider "${providerId}" rejected the request.${detail}`, {
        status,
        providerId,
      });
    default:
      return new ModelHitchError(
        status >= 500 ? 'provider-error' : 'bad-request',
        `Provider "${providerId}" returned HTTP ${status}.${detail}`,
        { status, providerId },
      );
  }
}

/** True when an upstream 4xx is specifically a `response_format` rejection. */
function isResponseFormatRejection(status: number, text: string): boolean {
  return status === 400 && /response_format/i.test(text);
}

const JSON_INSTRUCTION = 'Respond with valid JSON only, no prose.';

/**
 * Degrade a request body that sent `response_format` to a model which
 * rejected it (e.g. DeepSeek V4): drop the param and enforce JSON via a
 * system instruction instead — same strategy as the Anthropic wire.
 */
function degradeResponseFormatBody(body: Record<string, unknown>): Record<string, unknown> {
  const degraded = { ...body };
  delete degraded.response_format;
  const messages = Array.isArray(degraded.messages) ? [...degraded.messages] : [];
  let patched = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined;
    if (m?.role === 'system') {
      messages[i] = {
        ...m,
        content: `${typeof m.content === 'string' && m.content ? `${m.content}\n\n` : ''}${JSON_INSTRUCTION}`,
      };
      patched = true;
      break;
    }
  }
  if (!patched) messages.unshift({ role: 'system', content: JSON_INSTRUCTION });
  degraded.messages = messages;
  return degraded;
}

/** A Provider backed by any OpenAI-compatible /chat/completions API. */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: Capabilities;
  private readonly config: OpenAICompatibleConfig;
  private readonly fetchImpl: typeof fetch;  constructor(config: OpenAICompatibleConfig) {
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.defaultModel = config.defaultModel;
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      vision: true,
      embeddings: false,
      ...config.capabilities,
    };
    this.fetchImpl = config.fetchImpl ?? ((...args) => fetch(...args));
  }

  private apiKeyEnvVars(): string[] {
    return [this.config.apiKeyEnvVar, ...(this.config.apiKeyEnvFallbacks ?? [])].filter(
      (value): value is string => !!value,
    );
  }

  private findApiKey(credentials: ProviderCredentials): string | undefined {
    if (credentials.apiKey) return credentials.apiKey;
    for (const name of this.apiKeyEnvVars()) {
      const value = (typeof process !== 'undefined' && process.env?.[name]) as string | undefined;
      if (value) return value;
    }
    for (const source of this.config.extraApiKeySources ?? []) {
      try {
        const value = source();
        if (value?.trim()) return value.trim();
      } catch {
        // Best-effort external resolvers (e.g. CLI auth files) must not break inference.
      }
    }
    return undefined;
  }

  resolveApiKey(credentials: ProviderCredentials): string | undefined {
    const apiKey = this.findApiKey(credentials);
    if (apiKey) return apiKey;
    if (this.config.requiresKey !== false) {
      const envHint = this.apiKeyEnvVars()[0] ?? 'the provider env var';
      const hint = this.config.missingApiKeyHint
        ? ` ${this.config.missingApiKeyHint}`
        : ` Pass one in the client options or set ${envHint}.`;
      throw new ModelHitchError(
        'missing-api-key',
        `Provider "${this.id}" requires an API key.${hint}`,
        { providerId: this.id },
      );
    }
    return undefined;
  }

  private buildBody(params: ChatParams, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: toOpenAIMessages(params.messages),
    };
    const tools = toOpenAITools(params.tools);
    if (tools) body.tools = tools;
    if (params.temperature !== undefined) body.temperature = params.temperature;
    const maxTokens = resolveOpenAICompatMaxTokens({
      maxTokens: params.maxTokens,
      defaultMaxTokens: this.config.defaultMaxTokens,
      maxTokensCeiling: this.config.maxTokensCeiling,
    });
    if (maxTokens !== undefined) body.max_tokens = maxTokens;
    if (params.stop?.length) body.stop = params.stop;
    if (params.toolChoice !== undefined) body.tool_choice = toOpenAIToolChoice(params.toolChoice);
    if (params.responseFormat !== undefined && params.responseFormat !== 'text') {
      body.response_format = toOpenAIResponseFormat(params.responseFormat);
    }
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  private async request(
    path: string,
    params: ChatParams,
    credentials: ProviderCredentials,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const apiKey = this.resolveApiKey(credentials);
    const base = (credentials.baseUrl ?? this.config.baseUrl).replace(/\/+$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.config.headers };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const sessionId = params.sessionId ?? undefined;
    if (sessionId) {
      if (!headers['x-session-id']) headers['x-session-id'] = sessionId;
      if (!headers['x-conversation-id']) headers['x-conversation-id'] = sessionId;
    }
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'ModelHitch/2.0';
    }
    try {
      return await this.fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      if (err instanceof ModelHitchError) throw err;
      throw new ModelHitchError('network-error', `Request to provider "${this.id}" failed: ${(err as Error)?.message}`, {
        providerId: this.id,
        cause: err,
      });
    }
  }

  async chat(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult> {
    const body = this.buildBody(params, false);
    let res = await this.request('/chat/completions', params, credentials, body);
    if (!res.ok && body.response_format !== undefined) {
      // Some models reject response_format outright (e.g. DeepSeek V4:
      // "This response_format type is unavailable now"). Retry once with the
      // param stripped and JSON enforced via instruction.
      const errText = await res.text();
      if (isResponseFormatRejection(res.status, errText)) {
        res = await this.request('/chat/completions', params, credentials, degradeResponseFormatBody(body));
      } else {
        throw mapHTTPError(res.status, this.id, errText, parseRetryAfter(res.headers.get('retry-after')));
      }
    }
    const text = await res.text();
    if (!res.ok) throw mapHTTPError(res.status, this.id, text, parseRetryAfter(res.headers.get('retry-after')));
    const data = safeJsonParse<OpenAIChatCompletion>(text, {});
    const choice = data.choices?.[0];
    const message = choice?.message;
    if (!message) {
      throw new ModelHitchError('provider-error', `Provider "${this.id}" returned no message.`, {
        providerId: this.id,
      });
    }
    const toolCalls = toToolCalls(message.tool_calls);
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoningContent = typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined;
    const result: ModelMessage =
      toolCalls && toolCalls.length > 0
        ? { role: 'assistant', content, toolCalls, ...(reasoningContent ? { reasoningContent } : {}) }
        : { role: 'assistant', content: String(content ?? ''), ...(reasoningContent ? { reasoningContent } : {}) };
    return {
      message: result,
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: toUsage(data.usage),
      raw: data,
    };
  }

  async *stream(params: ChatParams, credentials: ProviderCredentials): AsyncGenerator<StreamChunk> {
    const reqBody = this.buildBody(params, true);
    let res = await this.request('/chat/completions', params, credentials, reqBody);
    if (!res.ok && reqBody.response_format !== undefined) {
      const errText = await res.text();
      if (isResponseFormatRejection(res.status, errText)) {
        res = await this.request('/chat/completions', params, credentials, degradeResponseFormatBody(reqBody));
      } else {
        throw mapHTTPError(res.status, this.id, errText, parseRetryAfter(res.headers.get('retry-after')));
      }
    }
    if (!res.ok) {
      const text = await res.text();
      throw mapHTTPError(res.status, this.id, text, parseRetryAfter(res.headers.get('retry-after')));
    }
    const body = requireBody(res, this.id);
    const toolAcc = new Map<string, { id: string; name: string; args: string }>();

    for await (const payload of parseSSE(bodyToAsyncIterable(body))) {
      const chunk = safeJsonParse<OpenAIStreamChunk | null>(payload, null);
      if (!chunk) continue;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text-delta', text: delta.content };
      }

      // DeepSeek thinking mode streams the chain-of-thought under
      // `delta.reasoning_content`. Surface it as a first-class chunk so
      // clients can render — and, critically, round-trip — it.
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        yield { type: 'reasoning-delta', text: delta.reasoning_content };
      }

      for (const tc of delta.tool_calls ?? []) {
        const key = String(tc.index ?? 0);
        const name = tc.function?.name;
        if (name) {
          const id = tc.id ?? `call_${key}`;
          toolAcc.set(key, { id, name, args: '' });
          yield { type: 'tool-call-start', id, name };
        }
        const argsDelta = tc.function?.arguments;
        if (argsDelta) {
          const acc = toolAcc.get(key);
          if (acc) {
            acc.args += argsDelta;
            yield { type: 'tool-call-args-delta', id: acc.id, argsDelta };
          }
        }
      }

      if (choice.finish_reason) {
        if (choice.finish_reason === 'tool_calls') {
          for (const acc of toolAcc.values()) yield { type: 'tool-call-end', id: acc.id };
        }
        const usage = toUsage(chunk.usage);
        yield usage
          ? { type: 'finish', finishReason: mapFinishReason(choice.finish_reason), usage }
          : { type: 'finish', finishReason: mapFinishReason(choice.finish_reason) };
      }
    }
  }

  async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
    const apiKey = this.config.modelsRequireKey === false
      ? this.findApiKey(credentials)
      : this.resolveApiKey(credentials);
    const base = (credentials.baseUrl ?? this.config.baseUrl).replace(/\/+$/, '');
    const headers: Record<string, string> = { ...this.config.headers };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}/models`, { headers });
    } catch (err) {
      throw new ModelHitchError('network-error', `Failed to list models from "${this.id}": ${(err as Error)?.message}`, {
        providerId: this.id,
        cause: err,
      });
    }
    const text = await res.text();
    if (!res.ok) throw mapHTTPError(res.status, this.id, text, parseRetryAfter(res.headers.get('retry-after')));
    const data = safeJsonParse<{
      data?: Array<{
        id: string;
        name?: string;
        type?: string;
        context_length?: number;
        context_window?: number;
      }>;
    }>(text, {});
    const models = this.config.modelTypes?.length
      ? (data.data ?? []).filter((model) => !!model.type && this.config.modelTypes!.includes(model.type))
      : (data.data ?? []);
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length ?? m.context_window,
    }));
  }
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): Provider {
  return new OpenAICompatibleProvider(config);
}
