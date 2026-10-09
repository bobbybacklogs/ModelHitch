import {
  CHATGPT_PLAN_API_BASE_URL,
  CHATGPT_PLAN_PROVIDER_ID,
  CHATGPT_PLAN_PROVIDER_NAME,
  CHATGPT_PLAN_USAGE_SETTINGS_URL,
  type ChatGptPlanToken,
  type ChatGptPlanTokenSource,
  chatGptPlanModelSlug,
} from '../chatgpt-plan.js';
import { serializeText } from '../core/content.js';
import { ModelHitchError, type ModelHitchErrorCode } from '../core/errors.js';
import { parseRetryAfter } from '../core/headers.js';
import { safeJsonParse } from '../core/json.js';
import { aggregateStream, bodyToAsyncIterable, parseSSE, requireBody } from '../core/stream.js';
import type {
  Capabilities,
  ChatParams,
  ChatResult,
  ModelMessage,
  ProviderCredentials,
  StreamChunk,
} from '../core/types.js';
import { mapHTTPError } from './openai-compatible.js';
import type { ModelInfo, Provider } from './types.js';

/**
 * The ChatGPT plan lane's adapter: Sign in with ChatGPT access tokens against
 * the public Responses API.
 *
 * This route is not the ordinary OpenAI API. It is a preview with hard rules,
 * enforced here rather than left to fail server-side:
 *
 * - Every inference request must set `store: false` and `stream: true`. There
 *   is no non-streaming form, so `chat()` streams and aggregates.
 * - History must be sent in `input`; `previous_response_id` is not accepted.
 *   `ChatParams.previousResponseId` is therefore dropped.
 * - System prompts go in `instructions`. An explicit `{type:"message",
 *   role:"system"}` input item is rejected.
 * - A list of fields is rejected outright: `temperature`, `top_p`,
 *   `max_output_tokens`, `metadata`, `user`, `truncation`, `prompt`,
 *   `prompt_cache_retention`, `safety_identifier`, `top_logprobs`,
 *   `background`, `conversation`, `max_tool_calls`, `moderation`,
 *   `multi_agent`. `ChatParams.temperature` and `ChatParams.maxTokens` are
 *   dropped here for that reason, and `stop` has no Responses equivalent.
 * - Success requires a `response.completed` event. A stream that just ends is
 *   an interrupted stream, not a result.
 *
 * A usage-limit error can arrive *after* streaming has begun, as
 * `response.failed` with `subscription_sharing_usage_limit_exceeded`. That maps
 * to `rate-limited` with status 429 so the failover walk treats the lane as
 * temporarily unable to serve the request, exactly like any other 429.
 *
 * Reference: https://developers.openai.com/siwc/token-sharing-open-source
 */

/** Status to report for each documented structured Responses error code. */
const RESPONSES_ERROR_STATUS: Record<string, number> = {
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_user_unavailable: 503,
  subscription_sharing_unsupported_capability: 400,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  chatpass_v2_scope_not_authorized: 403,
  chatpass_v2_invalid_authorization_context: 403,
};

/**
 * Normalized code for a documented error status.
 *
 * 429 becomes `rate-limited` and 5xx becomes `provider-error` so the failover
 * walk rotates; 400/403 stay `bad-request` because the spec says not to repeat
 * that request or loop through OAuth.
 */
function codeForStatus(status: number): ModelHitchErrorCode {
  if (status === 429) return 'rate-limited';
  if (status === 401) return 'invalid-api-key';
  if (status >= 500) return 'provider-error';
  return 'bad-request';
}

/** Translate a structured Responses failure into a ModelHitch error. */
function responsesFailureError(
  failure: { code?: unknown; message?: unknown; param?: unknown; type?: unknown },
  requestId: string | undefined,
): ModelHitchError {
  const code = typeof failure.code === 'string' ? failure.code : undefined;
  const status = code ? RESPONSES_ERROR_STATUS[code] : undefined;
  const message = typeof failure.message === 'string' && failure.message ? failure.message : 'ChatGPT plan request failed.';
  const param = typeof failure.param === 'string' && failure.param ? ` (param: ${failure.param})` : '';
  const id = requestId ? ` [request ${requestId}]` : '';
  const settings =
    status === 429
      ? ` Manage plan and per-app limits at ${CHATGPT_PLAN_USAGE_SETTINGS_URL}.`
      : '';
  return new ModelHitchError(
    status ? codeForStatus(status) : 'provider-error',
    `${code ? `${code}: ` : ''}${message}${param}${id}${settings}`,
    {
      status,
      providerId: CHATGPT_PLAN_PROVIDER_ID,
    },
  );
}

/** Usage from a Responses payload (`input_tokens` / `output_tokens`). */
function usageFrom(value: unknown): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const input = typeof raw.input_tokens === 'number' ? raw.input_tokens : undefined;
  const output = typeof raw.output_tokens === 'number' ? raw.output_tokens : undefined;
  const total = typeof raw.total_tokens === 'number' ? raw.total_tokens : undefined;
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

/** Map `ChatParams.responseFormat` onto the Responses `text.format` field. */
function textFormatFor(format: ChatParams['responseFormat']): Record<string, unknown> | undefined {
  if (format === undefined || format === 'text') return undefined;
  if (format === 'json') return { format: { type: 'json_object' } };
  if (format.type === 'json_object') return { format: { type: 'json_object' } };
  return {
    format: {
      type: 'json_schema',
      ...(format.name ? { name: format.name } : {}),
      ...(format.strict !== undefined ? { strict: format.strict } : {}),
      schema: format.schema,
    },
  };
}

/**
 * Build the request body for `POST /v1/responses` on this route.
 *
 * Exported so the field omissions are testable as data rather than inferred
 * from a mocked call: the rejected fields must be *absent*, not merely falsy.
 */
export function chatGptPlanRequestBody(params: ChatParams): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];

  for (const message of params.messages) {
    appendMessage(input, instructions, message);
  }

  const body: Record<string, unknown> = {
    model: chatGptPlanModelSlug(params.model),
    input,
    // Mandatory on this route, on every inference request.
    store: false,
    stream: true,
  };

  if (instructions.length) body.instructions = instructions.join('\n\n');

  if (params.tools?.length) {
    body.tools = params.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    }));
  }

  if (params.toolChoice) {
    if (typeof params.toolChoice === 'string') {
      body.tool_choice = params.toolChoice;
    } else if (params.toolChoice.type === 'function') {
      body.tool_choice = { type: 'function', name: params.toolChoice.name };
    }
  }

  const text = textFormatFor(params.responseFormat);
  if (text) body.text = text;

  return body;
}

/** One normalized message as Responses input items. */
function appendMessage(
  input: Array<Record<string, unknown>>,
  instructions: string[],
  message: ModelMessage,
): void {
  switch (message.role) {
    case 'system': {
      // `instructions`, never a `{type:"message", role:"system"}` input item:
      // the preview route rejects the explicit system item.
      const text = serializeText(message.content);
      if (text) instructions.push(text);
      return;
    }
    case 'user': {
      if (typeof message.content === 'string') {
        input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: message.content }] });
        return;
      }
      const parts: Array<Record<string, unknown>> = [];
      for (const part of message.content) {
        if (part.type === 'text') parts.push({ type: 'input_text', text: part.text });
        else if (part.type === 'image') parts.push({ type: 'input_image', image_url: { url: part.imageUrl } });
        else if (part.type === 'image-data') {
          parts.push({ type: 'input_image', image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
        }
      }
      input.push({ type: 'message', role: 'user', content: parts });
      return;
    }
    case 'assistant': {
      const text = serializeText(message.content);
      if (text) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      return;
    }
    case 'tool': {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: serializeText(message.content),
      });
      return;
    }
  }
}

export interface ChatGptPlanProviderOptions {
  /** Where access tokens come from. The Node store and a test fake both fit. */
  tokens: ChatGptPlanTokenSource;
  /**
   * Model slugs this lane serves, in rotation order. ChatGPT plan catalogs are
   * account-specific, so these are whatever the account reported (or the user
   * configured); an empty list means only explicitly routed slugs work.
   */
  models?: readonly string[];
  /** Overrides the API root. Tests point this at a local server. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Honest capability overrides for a reduced account or a limited model. */
  capabilities?: Partial<Capabilities>;
  /**
   * Called when the API rejects a request, so a caller can record the status,
   * error code, and request id. Diagnostics only — never a control path.
   */
  onHttpError?: (info: { status: number; code?: string; message: string; requestId?: string }) => void;
}

/** Build the lane's `Provider`. */
export function createChatGptPlanProvider(options: ChatGptPlanProviderOptions): Provider {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? CHATGPT_PLAN_API_BASE_URL).replace(/\/+$/, '');
  const snapshotModels = [...new Set((options.models ?? []).map((m) => chatGptPlanModelSlug(m)).filter(Boolean))];

  if (typeof doFetch !== 'function') {
    throw new ModelHitchError('provider-error', `Provider "${CHATGPT_PLAN_PROVIDER_ID}" requires a fetch implementation.`, {
      providerId: CHATGPT_PLAN_PROVIDER_ID,
    });
  }

  const capabilities: Capabilities = {
    streaming: true,
    toolCalling: true,
    vision: true,
    embeddings: false,
    ...options.capabilities,
  };

  /** Resolve the bearer plus the base URL this call should use. */
  async function resolveAuth(
    credentials: ProviderCredentials,
    mode: 'fresh' | 'refresh',
  ): Promise<{ apiKey: string; baseUrl: string; requestIdHint?: string }> {
    const requestBase = (credentials.baseUrl ?? baseUrl).replace(/\/+$/, '');
    // An explicit per-call key wins, so a caller can drive the lane from a
    // token it obtained elsewhere without a credential store in the graph.
    if (credentials.apiKey?.trim()) {
      return { apiKey: credentials.apiKey.trim(), baseUrl: requestBase };
    }
    const token: ChatGptPlanToken =
      mode === 'refresh' ? await options.tokens.refreshToken() : await options.tokens.getToken();
    return { apiKey: token.accessToken, baseUrl: requestBase };
  }

  function notSignedIn(): ModelHitchError {
    return new ModelHitchError(
      'missing-api-key',
      `Provider "${CHATGPT_PLAN_PROVIDER_ID}" has no ChatGPT account signed in. Sign in with ChatGPT on the bridge's /settings page, or run \`modelhitch chatgpt-plan sign-in\`.`,
      { providerId: CHATGPT_PLAN_PROVIDER_ID },
    );
  }

  async function post(
    params: ChatParams,
    credentials: ProviderCredentials,
  ): Promise<Response> {
    if (typeof doFetch !== 'function') throw notSignedIn();
    let auth = await resolveAuth(credentials, 'fresh');
    let response: Response;
    try {
      response = await doFetch(`${auth.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${auth.apiKey}`,
        },
        body: JSON.stringify(chatGptPlanRequestBody(params)),
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new ModelHitchError('network-error', `ChatGPT plan request failed: ${(err as Error).message}`, {
        providerId: CHATGPT_PLAN_PROVIDER_ID,
        cause: err,
      });
    }

    // A rejected token is worth exactly one forced refresh: the access token
    // may have been rotated out from under us by another process.
    if (response.status === 401 && !credentials.apiKey?.trim()) {
      await response.body?.cancel().catch(() => {});
      auth = await resolveAuth(credentials, 'refresh');
      try {
        response = await doFetch(`${auth.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${auth.apiKey}`,
          },
          body: JSON.stringify(chatGptPlanRequestBody(params)),
          ...(params.signal ? { signal: params.signal } : {}),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        throw new ModelHitchError('network-error', `ChatGPT plan request failed: ${(err as Error).message}`, {
          providerId: CHATGPT_PLAN_PROVIDER_ID,
          cause: err,
        });
      }
    }

    return response;
  }

  /** Non-OK HTTP response (before the stream opens) into a typed error. */
  async function httpError(response: Response): Promise<ModelHitchError> {
    const text = await response.text().catch(() => '');
    const requestId = response.headers.get('x-request-id') ?? undefined;
    const parsed = safeJsonParse<Record<string, unknown>>(text, {});
    // Direct-route admission can answer with `{"detail":"…"}` before a
    // Responses request starts. That is diagnostic text, not a stable code.
    const detail =
      typeof parsed.detail === 'string'
        ? parsed.detail
        : typeof (parsed.error as Record<string, unknown> | undefined)?.message === 'string'
          ? String((parsed.error as Record<string, unknown>).message)
          : text.slice(0, 400);
    const code = (parsed.error as Record<string, unknown> | undefined)?.code;
    options.onHttpError?.({
      status: response.status,
      ...(typeof code === 'string' ? { code } : {}),
      message: detail,
      ...(requestId ? { requestId } : {}),
    });
    const settings =
      response.status === 429 ? ` Manage plan and per-app limits at ${CHATGPT_PLAN_USAGE_SETTINGS_URL}.` : '';
    return mapHTTPError(
      response.status,
      CHATGPT_PLAN_PROVIDER_ID,
      `${detail}${requestId ? ` [request ${requestId}]` : ''}${settings}`,
      parseRetryAfter(response.headers.get('retry-after')),
    );
  }

  /** Normalize the Responses event stream, enforcing the completion rule. */
  async function* streamEvents(response: Response, signal: AbortSignal | undefined): AsyncGenerator<StreamChunk> {
    const requestId = response.headers.get('x-request-id') ?? undefined;
    /** Responses deltas carry `item_id`; only the item carries `call_id`. */
    const callIdByItemId = new Map<string, string>();
    /** Argument text already forwarded per item, so a `done` item can fill gaps. */
    const argsSeen = new Map<string, number>();
    const toolCalls = new Set<string>();
    let terminal: 'completed' | 'incomplete' | 'failed' | undefined;
    let finishReason = 'stop';
    let usage: ChatResult['usage'];
    let responseId: string | undefined;

    for await (const payload of parseSSE(bodyToAsyncIterable(requireBody(response, CHATGPT_PLAN_PROVIDER_ID)))) {
      const event = safeJsonParse<Record<string, unknown>>(payload, {});
      const type = typeof event.type === 'string' ? event.type : '';

      switch (type) {
        case 'response.output_text.delta': {
          const text = typeof event.delta === 'string' ? event.delta : '';
          if (text) yield { type: 'text-delta', text };
          break;
        }
        case 'response.reasoning_summary_text.delta':
        case 'response.reasoning_text.delta': {
          const text = typeof event.delta === 'string' ? event.delta : '';
          if (text) yield { type: 'reasoning-delta', text };
          break;
        }
        case 'response.output_item.added': {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call') {
            const id = typeof item.call_id === 'string' ? item.call_id : '';
            const name = typeof item.name === 'string' ? item.name : '';
            const itemId = typeof item.id === 'string' ? item.id : '';
            if (id && name) {
              if (itemId) callIdByItemId.set(itemId, id);
              toolCalls.add(id);
              argsSeen.set(id, 0);
              yield { type: 'tool-call-start', id, name };
            }
          }
          break;
        }
        case 'response.function_call_arguments.delta': {
          const itemId = typeof event.item_id === 'string' ? event.item_id : '';
          const id = callIdByItemId.get(itemId);
          const delta = typeof event.delta === 'string' ? event.delta : '';
          if (id && delta) {
            argsSeen.set(id, (argsSeen.get(id) ?? 0) + delta.length);
            yield { type: 'tool-call-args-delta', id, argsDelta: delta };
          }
          break;
        }
        case 'response.output_item.done': {
          const item = event.item as Record<string, unknown> | undefined;
          if (item?.type === 'function_call') {
            const id = typeof item.call_id === 'string' ? item.call_id : callIdByItemId.get(String(item.id ?? '')) ?? '';
            if (id) {
              // Some responses deliver the whole argument string only here.
              const full = typeof item.arguments === 'string' ? item.arguments : '';
              const seen = argsSeen.get(id) ?? 0;
              if (full.length > seen) {
                yield { type: 'tool-call-args-delta', id, argsDelta: full.slice(seen) };
                argsSeen.set(id, full.length);
              }
              yield { type: 'tool-call-end', id };
            }
          }
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          const envelope = (event.response ?? {}) as Record<string, unknown>;
          responseId = typeof envelope.id === 'string' ? envelope.id : responseId;
          usage = usageFrom(envelope.usage) ?? usage;
          if (type === 'response.completed') {
            terminal = 'completed';
            finishReason = toolCalls.size > 0 ? 'tool-calls' : 'stop';
          } else {
            terminal = 'incomplete';
            const details = envelope.incomplete_details as Record<string, unknown> | undefined;
            const reason = typeof details?.reason === 'string' ? details.reason : '';
            finishReason = reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'content-filter' : reason || 'incomplete';
          }
          break;
        }
        case 'response.failed': {
          const envelope = (event.response ?? {}) as Record<string, unknown>;
          const failure = (envelope.error ?? event.error ?? {}) as Record<string, unknown>;
          terminal = 'failed';
          throw responsesFailureError(failure, requestId);
        }
        case 'error':
        case 'response.error': {
          const failure = (event.error ?? event) as Record<string, unknown>;
          terminal = 'failed';
          throw responsesFailureError(failure, requestId);
        }
        case 'response.created':
        case 'response.in_progress':
        case 'response.output_item.delta':
        case 'response.function_call_arguments.done':
        case 'response.output_text.done':
        case 'response.content_part.added':
        case 'response.content_part.done':
          break;
        default:
          break;
      }
    }

    if (!terminal) {
      // The spec is explicit: only `response.completed` (or an explicit
      // `response.incomplete`) marks the end of a response. Anything else is an
      // interrupted stream, and reporting it as a clean stop would hand the
      // caller a truncated answer with no signal.
      throw new ModelHitchError(
        'provider-error',
        `ChatGPT plan stream ended without response.completed${signal?.aborted ? ' (aborted)' : ''}.${requestId ? ` [request ${requestId}]` : ''} The response was interrupted; retry the request.`,
        { providerId: CHATGPT_PLAN_PROVIDER_ID },
      );
    }

    yield {
      type: 'finish',
      finishReason,
      ...(usage ? { usage } : {}),
      ...(responseId ? { responseId } : {}),
    };
  }

  return {
    id: CHATGPT_PLAN_PROVIDER_ID,
    name: CHATGPT_PLAN_PROVIDER_NAME,
    defaultModel: snapshotModels[0] ?? '',
    capabilities,

    async chat(params: ChatParams, credentials: ProviderCredentials): Promise<ChatResult> {
      if (!snapshotModels.length && !params.model.trim()) throw notSignedIn();
      const response = await post({ ...params, model: chatGptPlanModelSlug(params.model) }, credentials);
      if (!response.ok) throw await httpError(response);
      return aggregateStream(streamEvents(response, params.signal));
    },

    stream(params: ChatParams, credentials: ProviderCredentials): AsyncIterable<StreamChunk> {
      return (async function* () {
        const response = await post({ ...params, model: chatGptPlanModelSlug(params.model) }, credentials);
        if (!response.ok) throw await httpError(response);
        yield* streamEvents(response, params.signal);
      })();
    },

    async listModels(credentials: ProviderCredentials): Promise<ModelInfo[]> {
      // Configured slots are always reportable: they are what the lane serves
      // even when the account catalog cannot be read.
      let auth: { apiKey: string; baseUrl: string };
      try {
        auth = await resolveAuth(credentials, 'fresh');
      } catch {
        return snapshotModels.map((id) => ({ id }));
      }

      let response: Response;
      try {
        response = await doFetch(`${auth.baseUrl}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${auth.apiKey}`, Accept: 'application/json' },
        });
      } catch {
        return snapshotModels.map((id) => ({ id }));
      }
      if (!response.ok) return snapshotModels.map((id) => ({ id }));

      const payload = safeJsonParse<Record<string, unknown>>(await response.text().catch(() => ''), {});

      // This route answers `{ models: [{ slug, display_name, visibility }] }`,
      // not the standard `{ data: [{ id }] }` shape.
      if (Array.isArray(payload.models)) {
        const listed: ModelInfo[] = [];
        for (const entry of payload.models) {
          if (!entry || typeof entry !== 'object') continue;
          const model = entry as Record<string, unknown>;
          // Keep only models intended for display, in the server's order.
          if (model.visibility !== undefined && model.visibility !== 'list') continue;
          const id = typeof model.slug === 'string' ? model.slug.trim() : '';
          if (!id) continue;
          const name = typeof model.display_name === 'string' ? model.display_name : undefined;
          listed.push({ id, ...(name ? { name } : {}) });
        }
        if (listed.length) return listed;
      }

      if (Array.isArray(payload.data)) {
        const listed: ModelInfo[] = [];
        for (const entry of payload.data) {
          if (!entry || typeof entry !== 'object') continue;
          const id = typeof (entry as Record<string, unknown>).id === 'string' ? String((entry as Record<string, unknown>).id) : '';
          if (id) listed.push({ id });
        }
        if (listed.length) return listed;
      }

      return snapshotModels.map((id) => ({ id }));
    },
  };
}
