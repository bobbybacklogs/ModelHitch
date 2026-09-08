import { ModelHitchError } from '../core/errors.js';
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
import { bytesToBase64 } from '../core/base64.js';
import { safeJsonParse } from '../core/json.js';
import { parseRetryAfter } from '../core/headers.js';
import { bodyToAsyncIterable, parseSSE, requireBody } from '../core/stream.js';
import { deriveSessionId } from '../core/session.js';
import type { ModelInfo, Provider } from './types.js';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  source?: { type: string; media_type?: string; data?: string };
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  content_block?: AnthropicContentBlock;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

const DEFAULT_MAX_TOKENS = 4096; // Anthropic requires max_tokens.

/** Map a normalized ToolChoice to the Anthropic tool_choice format. */
function toAnthropicToolChoice(choice: ChatParams['toolChoice']): Record<string, unknown> {
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (typeof choice === 'object') return { type: 'tool', name: choice.name };
  return { type: 'auto' };
}

export interface AnthropicProviderOptions {
  /** Provider id (default "anthropic"). */
  id?: string;
  /** Display name (default "Anthropic"). */
  name?: string;
  /** Base URL including the version segment, e.g. "https://api.anthropic.com/v1". */
  baseUrl?: string;
  defaultModel?: string;
  apiKeyEnvVar?: string;
  /** Additional env vars checked when the primary one is unset. */
  apiKeyEnvFallbacks?: string[];
  /** Messages endpoint path (default "/messages"). */
  messagesPath?: string;
  capabilities?: Partial<Capabilities>;
  /**
   * Allow direct browser-origin calls. Anthropic's API rejects browser
   * requests unless the `anthropic-dangerous-direct-browser-access: true`
   * header is sent (the official SDK's `dangerouslyAllowBrowser` opt-in).
   * Keep `false` on the server — this header is a footgun outside the browser.
   */
  dangerouslyAllowBrowser?: boolean;
  /** Extra headers merged into every request (parity with `OpenAICompatibleConfig.headers`). */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * Native Anthropic Messages API adapter.
 * NOTE: Anthropic does not accept image URLs — imageUrl parts are fetched and
 * sent as base64, which requires network access (fine in Node/edge; in a pure
 * browser context prefer image-data parts).
 */
export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: Capabilities;
  private readonly baseUrl: string;
  private readonly messagesPath: string;
  private readonly apiKeyEnvVar: string;
  private readonly apiKeyEnvFallbacks: string[];
  private readonly dangerouslyAllowBrowser: boolean;
  private readonly headers: Record<string, string> | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.id = opts.id ?? 'anthropic';
    this.name = opts.name ?? 'Anthropic';
    this.defaultModel = opts.defaultModel ?? 'claude-sonnet-4-5';
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '');
    this.messagesPath = opts.messagesPath ?? '/messages';
    this.apiKeyEnvVar = opts.apiKeyEnvVar ?? 'ANTHROPIC_API_KEY';
    this.apiKeyEnvFallbacks = opts.apiKeyEnvFallbacks ?? [];
    this.dangerouslyAllowBrowser = opts.dangerouslyAllowBrowser ?? false;
    this.headers = opts.headers;
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      vision: true,
      embeddings: false,
      maxContextTokens: 200_000,
      ...opts.capabilities,
    };
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  resolveApiKey(credentials: ProviderCredentials): string {
    if (credentials.apiKey) return credentials.apiKey;
    for (const name of [this.apiKeyEnvVar, ...this.apiKeyEnvFallbacks]) {
      const env = (typeof process !== 'undefined' && process.env?.[name]) as string | undefined;
      if (env) return env;
    }
    throw new ModelHitchError(
      'missing-api-key',
      `Provider "${this.id}" requires an API key. Pass one in the client options or set ${this.apiKeyEnvVar}.`,
      { providerId: this.id },
    );
  }

  private async toAnthropicContent(
    content: string | ContentPart[],
  ): Promise<AnthropicContentBlock[]> {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    const blocks: AnthropicContentBlock[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'image-data') {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mimeType, data: part.data },
        });
      } else {
        // Anthropic has no image URL support; fetch and inline as base64.
        const res = await this.fetchImpl(part.imageUrl);
        if (!res.ok) {
          throw new ModelHitchError(
            'network-error',
            `Failed to fetch image for Anthropic: HTTP ${res.status}`,
            { providerId: this.id },
          );
        }
        const buf = new Uint8Array(await res.arrayBuffer());
        const mime = res.headers.get('content-type') ?? 'image/png';
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mime, data: bytesToBase64(buf) },
        });
      }
    }
    return blocks;
  }

  /** Convert a tool result message into an Anthropic tool_result content block. */
  private async toUserContent(content: string | ContentPart[]): Promise<AnthropicContentBlock[]> {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return this.toAnthropicContent(content);
  }

  private async toAnthropicMessages(
    messages: ModelMessage[],
  ): Promise<{ system: string; messages: Array<{ role: string; content: unknown }> }> {
    const system: string[] = [];
    const out: Array<{ role: string; content: unknown }> = [];
    for (const m of messages) {
      switch (m.role) {
        case 'system':
          system.push(typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '));
          break;
        case 'user':
          out.push({ role: 'user', content: await this.toUserContent(m.content) });
          break;
        case 'assistant': {
          const blocks: AnthropicContentBlock[] = [];
          if (typeof m.content === 'string') {
            if (m.content) blocks.push({ type: 'text', text: m.content });
          } else {
            blocks.push(...(await this.toAnthropicContent(m.content)));
          }
          for (const tc of m.toolCalls ?? []) {
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments });
          }
          out.push({ role: 'assistant', content: blocks });
          break;
        }
        case 'tool':
          out.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: m.toolCallId,
                content: m.content,
              },
            ],
          });
          break;
      }
    }
    return { system: system.join('\n\n'), messages: out };
  }

  private buildBody(
    params: ChatParams,
    stream: boolean,
    system: string,
    messages: Array<{ role: string; content: unknown }>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages,
    };
    let systemText = system;
    // Anthropic has no response_format param — JSON mode is achieved via instruction.
    if (params.responseFormat && params.responseFormat !== 'text') {
      systemText = systemText
        ? `${systemText}\n\nRespond with valid JSON only, no prose.`
        : 'Respond with valid JSON only, no prose.';
    }
    if (systemText) body.system = systemText;
    if (params.tools?.length) {
      body.tools = params.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters ?? { type: 'object', properties: {} },
      }));
    }
    if (params.toolChoice !== undefined) {
      body.tool_choice = toAnthropicToolChoice(params.toolChoice);
    }
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.stop?.length) body.stop_sequences = params.stop;
    if (stream) body.stream = true;
    return body;
  }

  private async request(
    params: ChatParams,
    credentials: ProviderCredentials,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const apiKey = this.resolveApiKey(credentials);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...this.headers,
    };
    const sessionId = params.sessionId ?? (this.id.includes('zen') || this.baseUrl.includes('opencode.ai') ? deriveSessionId(params.messages) : undefined);
    if (sessionId) {
      if (!headers['x-opencode-session']) headers['x-opencode-session'] = sessionId;
      if (!headers['x-session-id']) headers['x-session-id'] = sessionId;
    }
    if (!headers['User-Agent'] && !headers['user-agent']) {
      headers['User-Agent'] = 'ModelHitch/0.15';
    }
    if (this.dangerouslyAllowBrowser) {
      // Explicit opt-in wins over any user-supplied value.
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${this.messagesPath}`, {
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

  private toToolCalls(blocks: AnthropicContentBlock[]): ToolCall[] | undefined {
    const calls = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id ?? `toolu_${Math.random().toString(36).slice(2, 8)}`,
        name: b.name ?? 'unknown',
        arguments: (b.input as Record<string, unknown>) ?? {},
      }));
    return calls.length ? calls : undefined;
  }

  async chat(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult> {
    const { system, messages } = await this.toAnthropicMessages(params.messages);
    const res = await this.request(params, credentials, this.buildBody(params, false, system, messages));
    const text = await res.text();
    if (!res.ok) {
      const err = safeJsonParse<{ error?: { message?: string; type?: string } }>(text, {});
      if (res.status === 401 || res.status === 403) {
        throw new ModelHitchError('invalid-api-key', err.error?.message ?? `Provider "${this.id}" rejected the API key.`, {
          status: res.status,
          providerId: this.id,
        });
      }
      if (res.status === 429) {
        throw new ModelHitchError('rate-limited', err.error?.message ?? `Provider "${this.id}" rate limited the request.`, {
          status: res.status,
          providerId: this.id,
          retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        });
      }
      if (res.status === 404) {
        throw new ModelHitchError('model-not-found', err.error?.message ?? `Provider "${this.id}" could not find the model.`, {
          status: res.status,
          providerId: this.id,
        });
      }
      throw new ModelHitchError(
        res.status >= 500 ? 'provider-error' : 'bad-request',
        err.error?.message ?? `Provider "${this.id}" returned HTTP ${res.status}.`,
        { status: res.status, providerId: this.id },
      );
    }
    const data = safeJsonParse<AnthropicResponse>(text, {});
    const blocks = data.content ?? [];
    const toolCalls = this.toToolCalls(blocks);
    const textContent = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const message: ModelMessage =
      toolCalls && toolCalls.length > 0
        ? { role: 'assistant', content: textContent, toolCalls }
        : { role: 'assistant', content: textContent };
    return {
      message,
      finishReason: mapStopReason(data.stop_reason),
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens,
            outputTokens: data.usage.output_tokens,
            totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
          }
        : undefined,
      raw: data,
    };
  }

  async *stream(params: ChatParams, credentials: ProviderCredentials): AsyncGenerator<StreamChunk> {
    const { system, messages } = await this.toAnthropicMessages(params.messages);
    const res = await this.request(params, credentials, this.buildBody(params, true, system, messages));
    if (!res.ok) {
      const text = await res.text();
      // Stream path deliberately maps everything to bad-request with the
      // status preserved (the status-429 check drives failover) — carry the
      // Retry-After header along so cooldown/backoff honor it here too.
      throw new ModelHitchError('bad-request', `Provider "${this.id}" returned HTTP ${res.status}: ${text.slice(0, 300)}`, {
        status: res.status,
        providerId: this.id,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    const body = requireBody(res, this.id);
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    for await (const payload of parseSSE(bodyToAsyncIterable(body))) {
      const event = safeJsonParse<AnthropicStreamEvent | null>(payload, null);
      if (!event) continue;
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block;
          if (block?.type === 'tool_use') {
            const idx = event.index ?? toolAcc.size;
            toolAcc.set(idx, { id: block.id ?? `toolu_${idx}`, name: block.name ?? 'unknown', args: '' });
            yield { type: 'tool-call-start', id: block.id ?? `toolu_${idx}`, name: block.name ?? 'unknown' };
          }
          break;
        }
        case 'content_block_delta': {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            yield { type: 'text-delta', text: event.delta.text };
          }
          if (event.delta?.type === 'input_json_delta' && event.delta.partial_json) {
            const idx = event.index ?? 0;
            const acc = toolAcc.get(idx);
            if (acc) {
              acc.args += event.delta.partial_json;
              yield { type: 'tool-call-args-delta', id: acc.id, argsDelta: event.delta.partial_json };
            }
          }
          break;
        }
        case 'content_block_stop': {
          const idx = event.index;
          if (idx !== undefined) {
            const acc = toolAcc.get(idx);
            if (acc) yield { type: 'tool-call-end', id: acc.id };
          }
          break;
        }
        case 'message_delta': {
          const stopReason = event.delta?.stop_reason;
          if (stopReason) {
            const usage: Usage | undefined = event.usage
              ? {
                  inputTokens: event.usage.input_tokens,
                  outputTokens: event.usage.output_tokens,
                }
              : undefined;
            yield usage
              ? { type: 'finish', finishReason: mapStopReason(stopReason), usage }
              : { type: 'finish', finishReason: mapStopReason(stopReason) };
          }
          break;
        }
        case 'message_stop':
          break;
        case 'error': {
          const msg = safeJsonParse<{ error?: { message?: string } }>(payload, {}).error?.message ?? 'Anthropic stream error';
          throw new ModelHitchError('provider-error', msg, { providerId: this.id });
        }
      }
    }
  }

  async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
    const apiKey = this.resolveApiKey(credentials);
    const headers: Record<string, string> = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...this.headers,
    };
    if (this.dangerouslyAllowBrowser) {
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers });
    if (!res.ok) throw new ModelHitchError('provider-error', `Failed to list Anthropic models: HTTP ${res.status}`, {
      providerId: this.id,
    });
    const data = safeJsonParse<{ data?: Array<{ id: string; display_name?: string }> }>(await res.text(), {});
    return (data.data ?? []).map((m) => ({ id: m.id, name: m.display_name }));
  }
}

function mapStopReason(reason?: string | null): string {
  switch (reason) {
    case undefined:
    case null:
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    default:
      return reason;
  }
}

export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): Provider {
  return new AnthropicProvider(opts);
}

/** Default Anthropic provider instance. */
export const anthropic: Provider = createAnthropicProvider();
