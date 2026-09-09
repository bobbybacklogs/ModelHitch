import { randomUUID } from 'node:crypto';
import { safeJsonParse } from '../core/json.js';
import { serializeText } from '../core/content.js';
import { conversationFor } from './conversation-state.js';
import type {
  ChatParams,
  ContentPart,
  ModelMessage,
  ResponseFormat,
  StreamChunk,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  Usage,
} from '../core/types.js';
import type { ChatResult } from '../core/types.js';

/**
 * OpenAI *Responses API* wire protocol — the only protocol Codex CLI custom
 * model providers speak (`model_providers.<id>.wire_api = "responses"` is the
 * only supported value, and the default).
 *
 * The bridge maps between the two wire protocols:
 *
 *   Codex (Responses API)  ->  normalized ChatParams  ->  family router
 *     POST /v1/responses        (instructions/input items)   -> /chat/completions
 *                                                             -> /responses
 *                                                             -> /messages
 *                                                             -> :generateContent
 *
 * Inbound, a Responses request has `instructions` + an `input` array of items
 * (messages, top-level `function_call` and `function_call_output`). Outbound,
 * a completion is a `{ object: 'response', output: [...] }` body, and streaming
 * emits fine-grained SSE events (response.output_text.delta,
 * response.function_call_arguments.delta, response.output_item.added/done,
 * response.completed) — the same vocabulary the Zen /responses adapter parses.
 */

export interface ResponsesRequest {
  model?: string;
  /** System prompt, as a string or a list of text content parts. */
  instructions?: string | Array<{ type?: string; text?: string }>;
  /** Conversation items: messages, function_call, function_call_output, ... */
  input?: unknown[];
  /** Flat tool definitions: { type: 'function', name, description, parameters, strict }. */
  tools?: Array<{
    type?: string;
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  }>;
  /** "auto" | "none" | "required" | { type: 'function', name }. */
  tool_choice?: unknown;
  /** Structured output: { text: { format: { type: 'json_schema', ... } } }. */
  text?: { format?: unknown };
  stream?: boolean;
  temperature?: number;
  max_output_tokens?: number;
  stop?: string | string[];
  /**
   * Stateful continuation: the id of the previous response. Kept conversation
   * state server-side; input is the *delta* since that response. Forwarded to
   * providers with a stateful Responses endpoint.
   */
  previous_response_id?: string;
}

// ---------------------------------------------------------------------------
// Inbound: Responses request -> normalized ChatParams
// ---------------------------------------------------------------------------

/**
 * Convert a Responses content part into normalized content parts.
 *
 * `image_url` arrives in BOTH shapes in the wild: the Responses spec's
 * `{ type: 'input_image', image_url: { url, detail } }` object, and the
 * VS Code Copilot extension's BYOK custom-endpoint builder, which sends the
 * bare URL *string* (`image_url: imageUrl.url`). Handle both so images aren't
 * silently dropped (a dropped image leaves empty user content, which upstream
 * providers reject with "Input must have at least 1 token.").
 */
function partToContent(part: Record<string, unknown>, text: string): ContentPart[] {
  const parts: ContentPart[] = [];
  if (text) parts.push({ type: 'text', text });
  if (part.type === 'input_image') {
    const raw = part.image_url;
    const url = typeof raw === 'string' ? raw : String((raw as Record<string, unknown> | undefined)?.url ?? '');
    const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (m) parts.push({ type: 'image-data', mimeType: m[1]!, data: m[2]! });
    else if (url) parts.push({ type: 'image', imageUrl: url });
  }
  return parts;
}

/** Extract text (and any images) from a Responses message item's content. */
function itemContent(item: Record<string, unknown>): string | ContentPart[] {
  const content = item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: ContentPart[] = [];
  let text = '';
  for (const raw of content) {
    const part = raw as Record<string, unknown>;
    switch (part.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        text += String(part.text ?? '');
        break;
      case 'input_image': {
        const mapped = partToContent(part, '');
        if (mapped.length) {
          // Image mapped — flush accumulated text as a part before it.
          if (text) parts.push({ type: 'text', text });
          text = '';
          parts.push(...mapped);
        }
        // No usable image URL — keep the accumulated text instead of
        // discarding it.
        break;
      }
    }
  }
  // Pure text collapses to a plain string so it flows through the normalized
  // pipeline exactly like chat-completions text; only mixed content (images)
  // stays as structured parts.
  if (!parts.length) return text;
  if (text) parts.push({ type: 'text', text });
  return parts;
}

/**
 * Serialize a Responses `function_call_output` parts-array (the shape the
 * extension emits when prompt-cache breakpoints are enabled) into plain text.
 *
 * Tool results are sent as chat-completions `tool` messages, whose content
 * must be a string (GLM's pydantic backend rejects anything else with
 * "Input should be a valid string"). Text parts serialize to their text;
 * image parts keep a stable placeholder instead of silently collapsing to
 * nothing (an all-image tool result would otherwise become an empty tool
 * message).
 */
function serializeOutputParts(parts: unknown[]): string {
  const out: string[] = [];
  for (const raw of parts) {
    const part = (raw ?? {}) as Record<string, unknown>;
    if (part.type === 'output_text') {
      out.push(String(part.text ?? ''));
      continue;
    }
    if (part.type === 'output_image') {
      const url = part.image_url;
      const src = typeof url === 'string' ? url : String((url as Record<string, unknown> | undefined)?.url ?? '');
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(src);
      out.push(m ? `[image: ${m[1]}]` : src ? `[image: ${src}]` : '[image]');
      continue;
    }
    if (part.type === 'output_audio') {
      out.push('[audio]');
      continue;
    }
    // prompt_cache_breakpoint and other structural parts carry no content.
  }
  return out.join('');
}

/**
 * Convert Responses `input` items into normalized messages. Consecutive
 * top-level `function_call` items are merged into a single assistant message
 * (they belong to one assistant turn); each `function_call_output` becomes the
 * matching `tool` message.
 *
 * `opts.keepOrphanedOutputs` (stateful continuations): when the request
 * carries `previous_response_id`, the conversation lives on the upstream
 * provider, so `function_call_output` items whose `function_call` was in an
 * *earlier* request must be kept — their call_ids are matched by the
 * provider's own state.
 */
export function responsesInputToMessages(
  input: unknown[] | undefined,
  opts?: { keepOrphanedOutputs?: boolean },
): ModelMessage[] {
  const out: ModelMessage[] = [];
  let pending: { role: 'assistant'; content: string; toolCalls: ToolCall[] } | null = null;
  const flush = () => {
    if (pending) {
      out.push(pending);
      pending = null;
    }
  };

  // Collect call_ids of top-level function_call items in THIS request so we
  // can drop orphaned function_call_output items (see below).
  const callIds = new Set<string>();
  for (const raw of input ?? []) {
    const item = raw as Record<string, unknown>;
    if (item.type === 'function_call') callIds.add(String(item.call_id ?? item.id ?? ''));
  }

  for (const raw of input ?? []) {
    const item = raw as Record<string, unknown>;
    if (item.type === 'function_call') {
      const call: ToolCall = {
        id: String(item.call_id ?? item.id ?? `call_${out.length}`),
        name: String(item.name ?? 'unknown'),
        arguments: safeJsonParse<Record<string, unknown>>(String(item.arguments ?? '{}'), {}),
      };
      if (pending) pending.toolCalls.push(call);
      else pending = { role: 'assistant', content: '', toolCalls: [call] };
      continue;
    }
    flush();
    if (item.type === 'function_call_output') {
      const callId = String(item.call_id ?? '');
      // Stateless conversion (no previous_response_id): a function_call_output
      // whose function_call lives in an earlier request (or that has no
      // call_id at all) would be forwarded as an orphaned tool message and
      // rejected upstream with an opaque 400 — drop it, since that context
      // was never forwarded anyway. Stateful continuations (VS Code Copilot
      // extension delta turns) keep them: the upstream provider matches the
      // call_ids against its own conversation state.
      if (!callId || (!opts?.keepOrphanedOutputs && !callIds.has(callId))) continue;
      const output = item.output;
      let content: string;
      if (typeof output === 'string') content = output;
      else if (Array.isArray(output)) {
        // The extension emits output as a parts array when prompt-cache
        // breakpoints are enabled — serialize the text-bearing parts and
        // keep image placeholders so the tool message is never empty.
        content = serializeOutputParts(output);
      } else {
        content = JSON.stringify(output ?? '');
      }
      out.push({ role: 'tool', content, toolCallId: callId });
      continue;
    }
    // Reasoning summaries carry no instruction for the model — drop them.
    if (item.type === 'reasoning') continue;

    const role = String(item.role ?? '');
    // Items without a chat role (tool_search_call, tool_search_output, custom
    // vendor items, …) are not messages — skip them rather than emitting an
    // empty user message that upstream providers reject.
    if (!['system', 'assistant', 'user', 'tool'].includes(role)) continue;
    const content = itemContent(item);
    if (role === 'system') out.push({ role: 'system', content });
    else if (role === 'assistant') {
      // Assistant message with no text and no tool calls is meaningless.
      if (!content) continue;
      out.push({ role: 'assistant', content });
    }
    // The normalized `tool` message carries plain text only.
    else if (role === 'tool') out.push({ role: 'tool', content: serializeText(content), toolCallId: String(item.tool_call_id ?? '') });
    else {
      // Empty user message carries no instruction — drop it too (an
      // all-image message whose image failed to map is better skipped than
      // sent as an empty turn).
      if (!content) continue;
      out.push({ role: 'user', content });
    }
  }
  flush();
  return out;
}

function mapResponsesToolChoice(choice: unknown): ToolChoice | undefined {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (choice && typeof choice === 'object') {
    const c = choice as Record<string, unknown>;
    if (c.type === 'function' && typeof c.name === 'string') return { type: 'function', name: c.name };
  }
  return undefined;
}

function mapResponsesTextFormat(format: unknown): ResponseFormat | undefined {
  if (!format || typeof format !== 'object') return undefined;
  const f = format as Record<string, unknown>;
  if (f.type === 'json_object') return { type: 'json_object' };
  if (f.type === 'json_schema') {
    const schema = (f.schema as Record<string, unknown> | undefined) ?? {};
    return {
      type: 'json_schema',
      name: typeof f.name === 'string' ? f.name : undefined,
      strict: typeof f.strict === 'boolean' ? f.strict : undefined,
      schema,
    };
  }
  return undefined;
}

/** Convert a Responses API request into normalized ChatParams. */
export function mapResponsesRequest(body: ResponsesRequest, model: string): ChatParams {
  // Stateful continuation: forward the upstream response id so the provider
  // can resolve the delta input against its own conversation state.
  const previousResponseId =
    typeof body.previous_response_id === 'string' && body.previous_response_id.length > 0
      ? body.previous_response_id
      : undefined;
  const messages = responsesInputToMessages(body.input, { keepOrphanedOutputs: !!previousResponseId });
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.unshift({ role: 'system', content: body.instructions });
  } else if (Array.isArray(body.instructions)) {
    const text = body.instructions.map((p) => p.text ?? '').join('\n');
    if (text) messages.unshift({ role: 'system', content: text });
  }

  const params: ChatParams = { model, messages };
  if (previousResponseId) params.previousResponseId = previousResponseId;
  if (Array.isArray(body.tools)) {
    const tools: ToolDefinition[] = [];
    for (const t of body.tools) {
      if (t.name) tools.push({ name: t.name, description: t.description, parameters: t.parameters });
    }
    if (tools.length) params.tools = tools;
  }
  const toolChoice = mapResponsesToolChoice(body.tool_choice);
  if (toolChoice) params.toolChoice = toolChoice;
  const responseFormat = mapResponsesTextFormat(body.text?.format);
  if (responseFormat) params.responseFormat = responseFormat;
  if (body.temperature !== undefined) params.temperature = body.temperature;
  if (body.max_output_tokens !== undefined) params.maxTokens = body.max_output_tokens;
  if (body.stop !== undefined) params.stop = Array.isArray(body.stop) ? body.stop : [body.stop];
  return params;
}

/**
 * Resolve a stateful continuation against the bridge's conversation cache.
 *
 * The client (VS Code Copilot extension) slices prior turns out of the
 * request and references them via `previous_response_id`. zen rejects that
 * field outright, so the bridge reconstructs the FULL conversation (cached
 * messages + this request's delta) and forwards it stateless.
 *
 * Returns the expanded messages to forward. When the referenced conversation
 * is no longer cached (bridge restarted): if this request itself is
 * answerable (it carries real content, e.g. a fresh user message), it is
 * forwarded stateless — losing history is better than failing the turn; if it
 * is a delta-only turn (empty after mapping), the caller re-anchors it by
 * tool call id or fails with a clear error.
 */
export function resolveConversation(params: ChatParams, previousResponseId: string | undefined): ModelMessage[] {
  if (!previousResponseId) return params.messages;
  const prior = conversationFor(previousResponseId);
  if (prior) return [...prior, ...params.messages];
  // Cache miss (bridge restart / eviction).
  return params.messages;
}

/**
 * Extract `function_call_output` items from a Responses `input` array — the
 * raw tool results the client sends as a delta-only turn. Used to re-anchor
 * such turns against the cache by call id when `previous_response_id` is
 * missing or unresolvable.
 */
export function toolOutputsFromInput(input: unknown[] | undefined): Array<{ callId: string; output: string }> {
  const out: Array<{ callId: string; output: string }> = [];
  for (const raw of input ?? []) {
    const item = raw as Record<string, unknown>;
    if (item.type !== 'function_call_output') continue;
    const callId = String(item.call_id ?? '');
    if (!callId) continue;
    const output = item.output;
    let content: string;
    if (typeof output === 'string') content = output;
    else if (Array.isArray(output)) {
      content = serializeOutputParts(output);
    } else {
      content = JSON.stringify(output ?? '');
    }
    out.push({ callId, output: content });
  }
  return out;
}

/** Map extracted tool outputs to normalized `tool` messages. */
export function toolMessagesFromOutputs(outputs: Array<{ callId: string; output: string }>): ModelMessage[] {
  return outputs.map((o) => ({ role: 'tool', content: o.output, toolCallId: o.callId }));
}

/**
 * Extract the normalized assistant message(s) from a provider result — the
 * part of a turn the bridge must remember for stateful continuations.
 */
export function assistantMessagesFromResult(message: ModelMessage): ModelMessage[] {
  if (message.role !== 'assistant') return [];
  const content = serializeText(message.content);
  const toolCalls = message.toolCalls ?? [];
  if (!content && toolCalls.length === 0) return [];
  return [{ role: 'assistant', content, toolCalls }];
}

// ---------------------------------------------------------------------------
// Outbound: normalized result -> Responses API body / SSE events
// ---------------------------------------------------------------------------

function toResponsesUsage(usage?: Usage): { input_tokens: number; output_tokens: number; total_tokens: number } {
  return {
    input_tokens: usage?.inputTokens ?? 0,
    output_tokens: usage?.outputTokens ?? 0,
    total_tokens: usage?.totalTokens ?? 0,
  };
}

/**
 * Best-effort extraction of the upstream Responses API id from a provider's
 * raw result. Accepts `resp_` ids (OpenAI/zen spec) and zen's native `gen-`
 * ids; anything else (chat-completion ids, mock echoes, …) is ignored — an
 * unknown id would poison the stateful previous_response_id chain.
 */
function upstreamResponseId(raw: unknown): string | undefined {
  if (raw && typeof raw === 'object') {
    const id = (raw as Record<string, unknown>).id;
    if (typeof id === 'string' && /^(resp_|gen_|gen-)/.test(id)) return id;
  }
  return undefined;
}

/** Convert a normalized ChatResult into a non-streamed Responses body. */
export function toResponsesCompletion(result: ChatResult, model: string): Record<string, unknown> {
  // Round-trip the provider's real response id so the client's follow-up
  // previous_response_id resolves against this bridge's conversation cache.
  const id = upstreamResponseId(result.raw) ?? `resp_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const output: Record<string, unknown>[] = [];
  const content = serializeText(result.message.content);
  if (content) {
    output.push({
      type: 'message',
      id: `msg_${randomUUID()}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    });
  }
  if (result.message.role === 'assistant') {
    for (const tc of result.message.toolCalls ?? []) {
      output.push({
        type: 'function_call',
        id: `fc_${randomUUID()}`,
        call_id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
        ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
      });
    }
  }
  return {
    id,
    object: 'response',
    created_at: created,
    status: 'completed',
    model,
    output,
    usage: toResponsesUsage(result.usage),
  };
}

/**
 * Convert a normalized provider event stream into Responses API SSE lines
 * (`data: {...}\n\n`). Mirrors the event vocabulary emitted by the Zen
 * /responses endpoint so Codex parses it natively.
 *
 * `opts.onCompleted` fires once the final response id is known (after
 * response.completed), with the assistant messages of this turn — the caller
 * stores them in the conversation cache for stateful continuations.
 */
export async function* toResponsesStreamEvents(
  events: AsyncIterable<StreamChunk>,
  model: string,
  opts?: { onCompleted?: (responseId: string, assistantMessages: ModelMessage[]) => void },
): AsyncGenerator<string> {
  const id = `resp_${randomUUID()}`;
  // When the provider reports its own response id (stateful Responses
  // endpoint), the final response.completed carries it so the client's next
  // previous_response_id round-trips to this bridge's conversation cache.
  let upstreamId: string | undefined;
  const created = Math.floor(Date.now() / 1000);
  const data = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

  yield data({
    type: 'response.created',
    response: { id, object: 'response', created_at: created, status: 'in_progress', model, output: [] },
  });

  const output: Array<Record<string, unknown>> = [];
  const assistantMessages: ModelMessage[] = [];
  let textItem: Record<string, unknown> | null = null;
  let textPart: Record<string, unknown> | null = null;
  let toolItem: Record<string, unknown> | null = null;
  let toolArgs = '';
  let usage: Usage | undefined;

  const indexOf = (item: Record<string, unknown>) => Math.max(0, output.indexOf(item));

  const completeTextItem = function* (): Generator<string> {
    if (!textItem) return;
    const i = indexOf(textItem);
    yield data({
      type: 'response.output_text.done',
      item_id: textItem.id,
      output_index: i,
      content_index: 0,
      text: (textPart?.text as string) ?? '',
    });
    textItem.status = 'completed';
    yield data({ type: 'response.output_item.done', output_index: i, item: textItem });
    assistantMessages.push({ role: 'assistant', content: (textPart?.text as string) ?? '' });
    textItem = null;
    textPart = null;
  };

  const completeToolItem = function* (): Generator<string> {
    if (!toolItem) return;
    toolItem.arguments = toolArgs;
    toolItem.status = 'completed';
    yield data({ type: 'response.output_item.done', output_index: indexOf(toolItem), item: toolItem });
    assistantMessages.push({
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: toolItem.call_id as string,
          name: toolItem.name as string,
          arguments: safeJsonParse<Record<string, unknown>>(toolArgs, {}),
        },
      ],
    });
    toolItem = null;
  };

  try {
    for await (const event of events) {
      switch (event.type) {
        case 'text-delta': {
          if (!textItem) {
            textItem = {
              type: 'message',
              id: `msg_${randomUUID()}`,
              status: 'in_progress',
              role: 'assistant',
              content: [],
            };
            output.push(textItem);
            yield data({ type: 'response.output_item.added', output_index: output.length - 1, item: textItem });
            textPart = { type: 'output_text', text: '', annotations: [] };
            (textItem.content as unknown[]).push(textPart);
            yield data({
              type: 'response.content_part.added',
              item_id: textItem.id,
              output_index: output.length - 1,
              content_index: 0,
              part: textPart,
            });
          }
          textPart!.text = `${textPart!.text as string}${event.text}`;
          yield data({
            type: 'response.output_text.delta',
            item_id: textItem.id,
            output_index: output.length - 1,
            content_index: 0,
            delta: event.text,
          });
          break;
        }
        case 'tool-call-start': {
          toolItem = {
            type: 'function_call',
            id: `fc_${randomUUID()}`,
            call_id: event.id,
            name: event.name,
            arguments: '',
            status: 'in_progress',
            ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
          };
          toolArgs = '';
          output.push(toolItem);
          yield data({ type: 'response.output_item.added', output_index: output.length - 1, item: toolItem });
          break;
        }
        case 'tool-call-args-delta': {
          toolArgs += event.argsDelta;
          if (toolItem) {
            yield data({
              type: 'response.function_call_arguments.delta',
              item_id: toolItem.id,
              output_index: indexOf(toolItem),
              delta: event.argsDelta,
            });
          }
          break;
        }
        case 'tool-call-end':
          // Completion of the item happens on 'finish' (or stream end).
          break;
        case 'finish': {
          if (event.usage) usage = event.usage;
          if (event.responseId) upstreamId = event.responseId;
          yield* completeTextItem();
          yield* completeToolItem();
          break;
        }
      }
    }
    // Providers may end without an explicit finish chunk — finalize anyway.
    yield* completeTextItem();
    yield* completeToolItem();
  } catch (err) {
    yield data({
      type: 'response.failed',
      response: {
        id,
        object: 'response',
        created_at: created,
        status: 'failed',
        model,
        output,
        error: { code: 'provider_error', message: (err as Error).message },
      },
    });
    return;
  }

  yield data({
    type: 'response.completed',
    response: {
      id: upstreamId ?? id,
      object: 'response',
      created_at: created,
      status: 'completed',
      model,
      output,
      usage: toResponsesUsage(usage),
    },
  });

  // The response id is final now — let the caller remember this turn for
  // stateful continuations (streaming path; non-stream uses the ChatResult).
  opts?.onCompleted?.(upstreamId ?? id, assistantMessages);
}
