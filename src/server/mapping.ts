import { randomUUID } from 'node:crypto';
import { ModelHitchError } from '../core/errors.js';
import { safeJsonParse } from '../core/json.js';
import { serializeText } from '../core/content.js';
import type {
  ChatParams,
  ChatResult,
  ContentPart,
  ModelMessage,
  ToolCall,
  ToolDefinition,
  Usage,
} from '../core/types.js';
import type { Provider } from '../providers/types.js';
import type {
  OpenAIChatCompletion,
  OpenAIChatRequest,
  OpenAIErrorBody,
  OpenAIMessageInput,
  OpenAIToolCallInput,
  OpenAIToolInput,
} from './types.js';

/**
 * Convert inbound OpenAI message parts to ModelHitch content parts.
 * `image_url` values that are data URIs become inline `image-data` parts;
 * remote URLs stay as `image` parts (the provider adapter decides how to
 * handle them).
 */
function mapIncomingContent(content: string | OpenAIMessageInput['content']): string | ContentPart[] {
  if (typeof content === 'string') return content;
  if (!content?.length) return '';
  const parts: ContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text ?? '' });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url;
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
      if (m) parts.push({ type: 'image-data', mimeType: m[1]!, data: m[2]! });
      else parts.push({ type: 'image', imageUrl: url });
    }
  }
  return parts;
}

/** Convert inbound OpenAI messages to normalized `ModelMessage[]`. */
export function toModelHitchMessages(messages: OpenAIMessageInput[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    const content = mapIncomingContent(m.content);
    switch (m.role) {
      case 'assistant': {
        const toolCalls = toModelHitchToolCalls(m.tool_calls);
        const message: ModelMessage = { role: 'assistant', content };
        if (toolCalls?.length) message.toolCalls = toolCalls;
        out.push(message);
        break;
      }
      case 'tool':
        out.push({
          role: 'tool',
          content: typeof content === 'string' ? content : serializeText(content),
          toolCallId: m.tool_call_id ?? '',
        });
        break;
      case 'system':
        out.push({ role: 'system', content, name: m.name });
        break;
      default:
        out.push({ role: 'user', content, name: m.name });
    }
  }
  return out;
}

function toModelHitchToolCalls(toolCalls: OpenAIToolCallInput[] | undefined): ToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;
  const out: ToolCall[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!tc) continue;
    out.push({
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? 'unknown',
      arguments: safeJsonParse<Record<string, unknown>>(tc.function?.arguments ?? '', {}),
      ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** Convert inbound OpenAI tool declarations to `ToolDefinition[]`. */
export function toModelHitchTools(tools: OpenAIToolInput[] | undefined): ToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  const out: ToolDefinition[] = [];
  for (const t of tools) {
    if (t.function?.name) {
      out.push({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      });
    }
  }
  return out.length ? out : undefined;
}

/** Build normalized `ChatParams` from an OpenAI request body and routed model. */
export function mapRequest(body: OpenAIChatRequest, model: string): ChatParams {
  const params: ChatParams = { model, messages: toModelHitchMessages(body.messages ?? []) };
  const tools = toModelHitchTools(body.tools);
  if (tools) params.tools = tools;
  if (body.temperature !== undefined) params.temperature = body.temperature;
  const maxTokens = body.max_tokens ?? body.max_completion_tokens;
  if (maxTokens !== undefined) params.maxTokens = maxTokens;
  if (body.stop?.length) params.stop = body.stop;
  const toolChoice = toModelHitchToolChoice(body.tool_choice);
  if (toolChoice !== undefined) params.toolChoice = toolChoice;
  const responseFormat = toModelHitchResponseFormat(body.response_format);
  if (responseFormat !== undefined) params.responseFormat = responseFormat;
  return params;
}

/** Normalize an OpenAI `tool_choice` value; unknown shapes fall back to undefined. */
export function toModelHitchToolChoice(value: unknown): ChatParams['toolChoice'] | undefined {
  if (value === 'auto' || value === 'none' || value === 'required') return value;
  if (value && typeof value === 'object') {
    const obj = value as { type?: string; function?: { name?: string }; name?: string };
    if (obj.type === 'function') {
      const name = obj.function?.name ?? obj.name;
      if (name) return { type: 'function', name };
    }
  }
  return undefined;
}

/** Normalize an OpenAI `response_format` value; unknown shapes fall back to undefined. */
export function toModelHitchResponseFormat(value: unknown): ChatParams['responseFormat'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'json') return 'json';
  if (value === 'text') return 'text';
  if (value && typeof value === 'object') {
    const obj = value as {
      type?: string;
      json_schema?: { name?: string; strict?: boolean; schema?: Record<string, unknown> };
    };
    if (obj.type === 'text') return 'text';
    if (obj.type === 'json_object') return 'json';
    if (obj.type === 'json_schema' && obj.json_schema?.schema) {
      return {
        type: 'json_schema',
        name: obj.json_schema.name,
        strict: obj.json_schema.strict,
        schema: obj.json_schema.schema,
      };
    }
  }
  return undefined;
}

/**
 * Route a model string to a provider. Supports the `providerId/modelId`
 * prefix form (e.g. `vercel-ai-gateway/openai/gpt-5.4`, `anthropic/claude-sonnet-4-5`)
 * with longest-prefix matching, so models whose own ids contain slashes
 * (e.g. OpenRouter's `meta-llama/llama-3.1-8b-instruct:free`) fall through to
 * the default provider unchanged. Bare model ids go to the default provider.
 */
export function routeModel(
  modelInput: string | undefined,
  providers: Provider[],
  defaultProviderId?: string,
): { provider: Provider; model: string } {
  const defaultProvider = providers.find((p) => p.id === defaultProviderId) ?? providers[0];
  if (!defaultProvider) {
    throw new ModelHitchError('provider-not-found', 'No providers registered on the bridge server.', {});
  }
  const model = modelInput?.trim();
  if (model) {
    let best: { provider: Provider; rest: string } | null = null;
    for (const provider of providers) {
      const prefix = `${provider.id}/`;
      if (model.startsWith(prefix)) {
        if (!best || prefix.length > best.provider.id.length + 1) {
          best = { provider, rest: model.slice(prefix.length) };
        }
      }
    }
    if (best) {
      if (!best.rest) {
        throw new ModelHitchError(
          'bad-request',
          `Model id is missing after the provider prefix "${best.provider.id}/".`,
          { status: 400, providerId: best.provider.id },
        );
      }
      return { provider: best.provider, model: best.rest };
    }
  }
  return { provider: defaultProvider, model: model ?? defaultProvider.defaultModel };
}

/** Normalized finish reason -> OpenAI finish_reason string. */
export function mapFinishReasonOpenAI(reason: string): string {
  switch (reason) {
    case 'tool-calls':
      return 'tool_calls';
    case 'content-filter':
      return 'content_filter';
    default:
      return reason;
  }
}

/** Normalized usage -> OpenAI usage counters (0-filled). */
export function toUsageOutput(usage?: Usage): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null {
  if (!usage) return null;
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokens ?? prompt + completion,
  };
}

/** Build an outbound non-streaming `chat.completion` object. */
export function toChatCompletion(result: ChatResult, model: string): OpenAIChatCompletion {
  const content = serializeText(result.message.content);
  const toolCalls = result.message.role === 'assistant' ? result.message.toolCalls : undefined;
  const toolCallOutput = toolCalls?.map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
  }));
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || null,
          ...(toolCallOutput?.length ? { tool_calls: toolCallOutput } : {}),
        },
        finish_reason: mapFinishReasonOpenAI(result.finishReason),
      },
    ],
    usage: toUsageOutput(result.usage),
  };
}

const ERROR_TYPES: Record<string, string> = {
  'missing-api-key': 'authentication_error',
  'invalid-api-key': 'authentication_error',
  'rate-limited': 'rate_limit_error',
  'model-not-found': 'invalid_request_error',
  'provider-not-found': 'invalid_request_error',
  'provider-error': 'api_error',
  'network-error': 'api_error',
  'bad-request': 'invalid_request_error',
};

function mapErrorStatus(err: ModelHitchError): number {
  if (err.status) return err.status;
  switch (err.code) {
    case 'missing-api-key':
    case 'invalid-api-key':
      return 401;
    case 'rate-limited':
      return 429;
    case 'model-not-found':
    case 'provider-not-found':
      return 404;
    case 'provider-error':
    case 'network-error':
      return 502;
    default:
      return 400;
  }
}

/** Convert any thrown error into an OpenAI-style error body + HTTP status. */
export function toOpenAIError(err: unknown): { status: number; body: OpenAIErrorBody } {
  if (err instanceof ModelHitchError) {
    return {
      status: mapErrorStatus(err),
      body: {
        error: {
          message: err.message,
          type: ERROR_TYPES[err.code] ?? 'api_error',
          param: null,
          code: err.code,
        },
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: { error: { message, type: 'server_error', param: null, code: 'internal_error' } },
  };
}
