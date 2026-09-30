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
import { createOpenAICompatibleProvider, mapHTTPError, applySessionHeaders } from './openai-compatible.js';
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

function resolveApiKey(
  credentials: ProviderCredentials,
  envVar: string,
  envFallbacks: string[],
  providerId: string,
): string {
  if (credentials.apiKey) return credentials.apiKey;
  const envKey = process.env[envVar];
  if (envKey) return envKey;
  for (const fb of envFallbacks) {
    const val = process.env[fb];
    if (val) return val;
  }
  throw new ModelHitchError(
    'missing-api-key',
    `OpenCode requires an API key. Set ${envVar} in your environment or configure it in ModelHitch settings.`,
    { providerId },
  );
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

export function createOpenCodeProvider(opts: OpenCodeProviderOptions = {}): Provider {
  const id = opts.id ?? 'opencode';
  const name = opts.name ?? 'OpenCode Zen';
  const baseUrl = (opts.baseUrl ?? OPENCODE_ZEN_BASE_URL).replace(/\/+$/, '');
  const defaultModel = opts.defaultModel ?? OPENCODE_DEFAULT_MODEL;
  const apiKeyEnvVar = opts.apiKeyEnvVar ?? 'OPENCODE_API_KEY';
  const apiKeyEnvFallbacks = opts.apiKeyEnvFallbacks ?? [];
  const fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  const customHeaders = opts.headers ?? {};

  const capabilities: Capabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: true,
    maxContextTokens: 1_000_000,
    ...opts.capabilities,
  };

  // Internal delegate for OpenAI Chat Completions wire (DeepSeek, GLM, Kimi, MiniMax, freebies)
  const chatCompletionsDelegate = createOpenAICompatibleProvider({
    id,
    name,
    baseUrl,
    defaultModel,
    apiKeyEnvVar,
    apiKeyEnvFallbacks,
    capabilities,
    headers: customHeaders,
    sessionHeaders: OPENCODE_SESSION_HEADERS,
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
    const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id);
    const body = chatParamsToResponsesBody(params, false);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...customHeaders,
    };
    applySessionHeaders(headers, params.sessionId, OPENCODE_SESSION_HEADERS);
    if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = OPENCODE_USER_AGENT;

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
    const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id);
    const body = chatParamsToResponsesBody(params, true);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...customHeaders,
    };
    applySessionHeaders(headers, params.sessionId, OPENCODE_SESSION_HEADERS);
    if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = OPENCODE_USER_AGENT;

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
    const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id);
    const cleanModel = params.model.replace(/^(?:opencode|opencode-go)\//, '');
    const body = chatParamsToGeminiBody(params);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      ...customHeaders,
    };
    applySessionHeaders(headers, params.sessionId, OPENCODE_SESSION_HEADERS);
    if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = OPENCODE_USER_AGENT;

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
    const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id);
    const cleanModel = params.model.replace(/^(?:opencode|opencode-go)\//, '');
    const body = chatParamsToGeminiBody(params);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      ...customHeaders,
    };
    applySessionHeaders(headers, params.sessionId, OPENCODE_SESSION_HEADERS);
    if (!headers['User-Agent'] && !headers['user-agent']) headers['User-Agent'] = OPENCODE_USER_AGENT;

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
      const cleanModel = params.model.replace(/^(?:opencode|opencode-go)\//, '');
      const wire = opts.forceWire ?? detectOpenCodeWire(cleanModel);
      const normalizedParams: ChatParams = withSession({ ...params, model: cleanModel });

      switch (wire) {
        case 'responses':
          return chatResponses(normalizedParams, credentials);
        case 'messages':
          return messagesDelegate.chat(normalizedParams, credentials);
        case 'gemini':
          return chatGemini(normalizedParams, credentials);
        case 'chat-completions':
        default:
          return chatCompletionsDelegate.chat(normalizedParams, credentials);
      }
    },

    async *stream(params: ChatParams, credentials: ProviderCredentials): AsyncIterable<StreamChunk> {
      const cleanModel = params.model.replace(/^(?:opencode|opencode-go)\//, '');
      const wire = opts.forceWire ?? detectOpenCodeWire(cleanModel);
      const normalizedParams: ChatParams = withSession({ ...params, model: cleanModel });

      switch (wire) {
        case 'responses':
          yield* streamResponses(normalizedParams, credentials);
          break;
        case 'messages':
          yield* messagesDelegate.stream(normalizedParams, credentials);
          break;
        case 'gemini':
          yield* streamGemini(normalizedParams, credentials);
          break;
        case 'chat-completions':
        default:
          yield* chatCompletionsDelegate.stream(normalizedParams, credentials);
          break;
      }
    },

    async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
      try {
        const apiKey = resolveApiKey(credentials, apiKeyEnvVar, apiKeyEnvFallbacks, id);
        const res = await fetchImpl(`${baseUrl}/models`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...customHeaders,
          },
        });
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

      return OPENCODE_SNAPSHOT_MODELS.map((mId) => ({
        id: mId,
        name: mId,
      }));
    },
  };
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
