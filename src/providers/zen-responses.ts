import { ModelHitchError } from '../core/errors.js';
import { parseRetryAfter } from '../core/headers.js';
import type {
  Capabilities,
  ChatParams,
  ChatResult,
  ContentPart,
  ModelMessage,
  ProviderCredentials,
  StreamChunk,
  ToolCall,
  ToolChoice,
  Usage,
} from '../core/types.js';
import { safeJsonParse } from '../core/json.js';
import { bodyToAsyncIterable, parseSSE, requireBody } from '../core/stream.js';
import { mapHTTPError } from './openai-compatible.js';
import { deriveSessionId } from '../core/session.js';
import type { ModelInfo, Provider } from './types.js';

/**
 * OpenCode Zen /responses adapter — speaks the OpenAI *Responses API*
 * (https://opencode.ai/docs/zen routes GPT & Grok models there).
 *
 * The Responses API is OpenAI's newer protocol: POST /responses with an `input`
 * array of items (messages, function_call, function_call_output) instead of the
 * chat-completions `messages` shape, and streams fine-grained SSE events
 * (response.output_text.delta, response.function_call_arguments.delta, ...).
 */

export interface ZenResponsesProviderOptions {
  /** Base URL, e.g. "https://opencode.ai/zen/v1". */
  baseUrl?: string;
  defaultModel?: string;
  apiKeyEnvVar?: string;
  apiKeyEnvFallbacks?: string[];
  capabilities?: Partial<Capabilities>;
  fetchImpl?: typeof fetch;
}

interface ResponsesOutputItem {
  type?: string;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  role?: string;
  status?: string;
  content?: Array<{ type?: string; text?: string; annotations?: unknown[] }>;
}

interface ResponsesBody {
  id?: string;
  model?: string;
  status?: string;
  error?: { message?: string; code?: string };
  output?: ResponsesOutputItem[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}

/** Convert normalized messages into Responses API `input` items. */
function toResponsesInput(messages: ModelMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        // System text is hoisted into the `instructions` field instead.
        break;
      case 'user':
        items.push({ role: 'user', content: toUserParts(m.content) });
        break;
      case 'assistant': {
        // Text stays in a role envelope; tool calls are TOP-LEVEL input items
        // (OpenAI Responses API shape, verified against opencode's own
        // recordings — nesting function_call inside an assistant message is
        // rejected with "Invalid Responses API request").
        const parts: unknown[] = [];
        if (typeof m.content === 'string') {
          if (m.content) parts.push({ type: 'output_text', text: m.content });
        } else {
          for (const p of m.content) {
            if (p.type === 'text') parts.push({ type: 'output_text', text: p.text });
          }
        }
        if (parts.length) items.push({ role: 'assistant', content: parts });
        for (const tc of m.toolCalls ?? []) {
          items.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
        break;
      }
      case 'tool':
        items.push({
          type: 'function_call_output',
          call_id: m.toolCallId,
          output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
        break;
    }
  }
  return items;
}

function toUserParts(content: string | ContentPart[]): unknown[] {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return content.map((p) => {
    if (p.type === 'text') return { type: 'input_text', text: p.text };
    if (p.type === 'image') return { type: 'input_image', image_url: p.imageUrl };
    return { type: 'input_image', image_url: `data:${p.mimeType};base64,${p.data}` };
  });
}

function extractInstructions(messages: ModelMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' '),
    )
    .filter((s) => s.length > 0)
    .join('\n\n');
}

function toResponsesToolChoice(choice: ToolChoice | undefined): unknown {
  if (!choice) return undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  // Responses API form: { type: "function", name } (no nested `function`).
  return { type: 'function', name: choice.name };
}

function toResponsesTextFormat(format: ChatParams['responseFormat']): unknown {
  if (!format || format === 'text') return undefined;
  if (format === 'json' || format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      name: format.name ?? 'response',
      strict: format.strict ?? false,
      schema: format.schema,
    };
  }
  return undefined;
}

function toUsage(u?: ResponsesBody['usage']): Usage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    totalTokens: u.total_tokens,
  };
}

function parseArguments(args?: string): Record<string, unknown> {
  if (!args) return {};
  return safeJsonParse<Record<string, unknown>>(args, { _raw: args });
}

/** Extract content + tool calls from a non-streaming response.output array. */
function fromOutput(output: ResponsesOutputItem[] | undefined): {
  content: string;
  toolCalls?: ToolCall[];
} {
  let content = '';
  const toolCalls: ToolCall[] = [];
  for (const item of output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if (part.type === 'output_text') content += part.text ?? '';
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${toolCalls.length}`,
        name: item.name ?? 'unknown',
        arguments: parseArguments(item.arguments),
      });
    }
  }
  return { content, toolCalls: toolCalls.length ? toolCalls : undefined };
}

function finishReasonFor(output: ResponsesOutputItem[] | undefined, status?: string): string {
  if ((output ?? []).some((i) => i.type === 'function_call')) return 'tool-calls';
  if (status === 'incomplete') return 'length';
  return 'stop';
}

/**
 * Native OpenCode Zen provider for the GPT/Grok family, which Zen serves
 * through the OpenAI Responses API at https://opencode.ai/zen/v1/responses.
 */
export class ZenResponsesProvider implements Provider {
  readonly id: string;
  readonly name: string;
  readonly defaultModel: string;
  readonly capabilities: Capabilities;
  private readonly baseUrl: string;
  private readonly apiKeyEnvVar: string;
  private readonly apiKeyEnvFallbacks: string[];
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ZenResponsesProviderOptions = {}) {
    this.id = 'zen-responses';
    this.name = 'OpenCode Zen (Responses)';
    this.defaultModel = opts.defaultModel ?? 'gpt-5.6-luna';
    this.baseUrl = (opts.baseUrl ?? 'https://opencode.ai/zen/v1').replace(/\/+$/, '');
    this.apiKeyEnvVar = opts.apiKeyEnvVar ?? 'OPENCODE_ZEN_API_KEY';
    this.apiKeyEnvFallbacks = opts.apiKeyEnvFallbacks ?? ['OPENCODE_API_KEY'];
    this.capabilities = {
      streaming: true,
      toolCalling: true,
      vision: true,
      embeddings: false,
      maxContextTokens: 1_000_000,
      ...opts.capabilities,
    };
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  resolveApiKey(credentials: ProviderCredentials): string {
    if (credentials.apiKey) return credentials.apiKey;
    for (const name of [this.apiKeyEnvVar, ...this.apiKeyEnvFallbacks]) {
      const value = (typeof process !== 'undefined' && process.env?.[name]) as string | undefined;
      if (value) return value;
    }
    throw new ModelHitchError(
      'missing-api-key',
      `Provider "${this.id}" requires an API key. Pass one in the client options or set ${this.apiKeyEnvVar}.`,
      { providerId: this.id },
    );
  }

  private buildBody(params: ChatParams, stream: boolean): Record<string, unknown> {
    const instructions = extractInstructions(params.messages);
    const body: Record<string, unknown> = {
      model: params.model,
      input: toResponsesInput(params.messages),
    };
    if (instructions) body.instructions = instructions;
    if (params.tools?.length) {
      body.tools = params.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters ?? { type: 'object', properties: {} },
      }));
    }
    const toolChoice = toResponsesToolChoice(params.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    const textFormat = toResponsesTextFormat(params.responseFormat);
    if (textFormat !== undefined) body.text = { format: textFormat };
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.maxTokens !== undefined) body.max_output_tokens = params.maxTokens;
    if (params.stop?.length) body.stop = params.stop;
    // Stateful continuation: the client references a previous response whose
    // id this provider issued — forward it so zen resolves the delta input
    // (including orphaned function_call_output items) against its own state.
    if (params.previousResponseId) body.previous_response_id = params.previousResponseId;
    if (stream) body.stream = true;
    return body;
  }

  /**
   * Opt-in request/response forensics: with MODELHITCH_DEBUG=1 the bridge
   * logs the exact body it forwards to the provider plus the FULL upstream
   * error body on failures. This is how opaque upstream 400s ("Provider
   * returned error") get diagnosed — the client-facing error is truncated,
   * but the debug log is not.
   */
  private debugLog(...args: unknown[]): void {
    const enabled = (typeof process !== 'undefined' && process.env?.MODELHITCH_DEBUG === '1') || false;
    if (enabled) console.log(`[modelhitch:${this.id}]`, ...args);
  }

  private async request(
    params: ChatParams,
    credentials: ProviderCredentials,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const apiKey = this.resolveApiKey(credentials);
    this.debugLog('-> POST', `${this.baseUrl}/responses`, JSON.stringify(body));
    const sessionId = params.sessionId ?? deriveSessionId(params.messages);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'User-Agent': 'ModelHitch/0.15',
    };
    if (sessionId) {
      headers['x-opencode-session'] = sessionId;
      headers['x-session-id'] = sessionId;
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}/responses`, {
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
    const res = await this.request(params, credentials, this.buildBody(params, false));
    const text = await res.text();
    if (!res.ok) {
      this.debugLog('<- HTTP', res.status, text);
      throw mapHTTPError(res.status, this.id, text, parseRetryAfter(res.headers.get('retry-after')));
    }
    const data = safeJsonParse<ResponsesBody>(text, {});
    const { content, toolCalls } = fromOutput(data.output);
    const message: ModelMessage =
      toolCalls && toolCalls.length > 0
        ? { role: 'assistant', content, toolCalls }
        : { role: 'assistant', content };
    return {
      message,
      finishReason: finishReasonFor(data.output, data.status),
      usage: toUsage(data.usage),
      raw: data,
    };
  }

  async *stream(params: ChatParams, credentials: ProviderCredentials): AsyncGenerator<StreamChunk> {
    const res = await this.request(params, credentials, this.buildBody(params, true));
    if (!res.ok) {
      const text = await res.text();
      this.debugLog('<- HTTP', res.status, text);
      throw mapHTTPError(res.status, this.id, text, parseRetryAfter(res.headers.get('retry-after')));
    }
    const body = requireBody(res, this.id);
    // Maps Responses item ids (item_id on arg deltas) -> tool call ids.
    const itemIds = new Map<string, string>();

    for await (const payload of parseSSE(bodyToAsyncIterable(body))) {
      const event = safeJsonParse<{
        type: string;
        delta?: string;
        item_id?: string;
        output_index?: number;
        item?: ResponsesOutputItem;
        response?: ResponsesBody;
        message?: string;
      } | null>(payload, null);
      if (!event) continue;
      switch (event.type) {
        case 'response.output_item.added': {
          const item = event.item;
          if (item?.type === 'function_call') {
            const id = item.call_id ?? item.id ?? `call_${itemIds.size}`;
            if (item.id) itemIds.set(item.id, id);
            yield { type: 'tool-call-start', id, name: item.name ?? 'unknown' };
          }
          break;
        }
        case 'response.output_text.delta': {
          if (event.delta) yield { type: 'text-delta', text: event.delta };
          break;
        }
        case 'response.function_call_arguments.delta': {
          if (event.delta && event.item_id) {
            const id = itemIds.get(event.item_id) ?? event.item_id;
            yield { type: 'tool-call-args-delta', id, argsDelta: event.delta };
          }
          break;
        }
        case 'response.output_item.done': {
          const item = event.item;
          if (item?.type === 'function_call') {
            yield {
              type: 'tool-call-end',
              id: item.call_id ?? item.id ?? (event.item_id ?? ''),
            };
          }
          break;
        }
        case 'response.completed': {
          const resp = event.response;
          yield {
            type: 'finish',
            finishReason: finishReasonFor(resp?.output, resp?.status),
            ...(toUsage(resp?.usage) ? { usage: toUsage(resp?.usage) } : {}),
            // Round-trip zen's real response id (resp_... or gen-...) so the
            // client's next previous_response_id resolves against this same
            // conversation.
            ...(typeof resp?.id === 'string' && /^(resp_|gen_|gen-)/.test(resp.id) ? { responseId: resp.id } : {}),
          };
          break;
        }
        case 'response.incomplete': {
          const resp = event.response;
          yield {
            type: 'finish',
            finishReason: 'length',
            ...(toUsage(resp?.usage) ? { usage: toUsage(resp?.usage) } : {}),
            ...(typeof resp?.id === 'string' && /^(resp_|gen_|gen-)/.test(resp.id) ? { responseId: resp.id } : {}),
          };
          break;
        }
        case 'response.failed': {
          const msg =
            event.response?.error?.message ??
            event.message ??
            'Zen Responses stream failed';
          throw new ModelHitchError('provider-error', msg, { providerId: this.id });
        }
        case 'error': {
          throw new ModelHitchError(
            'provider-error',
            event.message ?? 'Zen Responses stream error',
            { providerId: this.id },
          );
        }
      }
    }
  }

  async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
    const apiKey = this.resolveApiKey(credentials);
    const res = await this.fetchImpl(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new ModelHitchError('provider-error', `Failed to list Zen models: HTTP ${res.status}`, {
        providerId: this.id,
      });
    }
    const data = safeJsonParse<{ data?: Array<{ id: string; display_name?: string }> }>(await res.text(), {});
    return (data.data ?? []).map((m) => ({ id: m.id, name: m.display_name }));
  }
}

/** Factory for the OpenCode Zen Responses API adapter. */
export function createZenResponsesProvider(opts: ZenResponsesProviderOptions = {}): Provider {
  return new ZenResponsesProvider(opts);
}

/** Default OpenCode Zen /responses provider instance. */
export const zenResponses: Provider = createZenResponsesProvider();
