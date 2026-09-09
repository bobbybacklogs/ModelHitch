import { ModelHitch, type ChatInput } from './client.js';
import { safeJsonParse } from './core/json.js';
import type { ChatResult, ModelMessage, StreamChunk, ToolCall, Usage } from './core/types.js';

/**
 * Agent loop driver — chains multi-turn tool calls into a single streaming run.
 *
 * Given a client, an initial request, and a tool executor, this drives the
 * full loop: stream a turn → if the model emitted tool calls, execute each
 * one and feed the results back → repeat until the model answers without
 * tools (or the turn cap is hit).
 *
 * ```ts
 * for await (const ev of runToolLoop(mh, { provider: 'vercel-ai-gateway', messages, tools }, executeTool)) {
 *   if (ev.type === 'chunk' && ev.chunk.type === 'text-delta') ui.append(ev.chunk.text);
 *   if (ev.type === 'tool') console.log(`called ${ev.call.name} -> ${ev.output}`);
 *   if (ev.type === 'done') console.log(`total cost-tracked turns: ${ev.turns}, usage: ${JSON.stringify(ev.usage)}`);
 * }
 * ```
 *
 * Events are emitted in order:
 * - `chunk` — every raw `StreamChunk` passthrough (for live rendering)
 * - `turn` — one per model turn, with the aggregated `ChatResult`
 * - `tool` — one per executed tool call, with the executor's output
 * - `done` — exactly once at the end, with the full message history + totals
 */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => string | Promise<string>;

export interface ToolLoopOptions {
  /** Maximum model turns before the loop stops (default 8). */
  maxTurns?: number;
}

export type ToolLoopEvent =
  | { type: 'chunk'; turn: number; chunk: StreamChunk }
  | { type: 'turn'; turn: number; result: ChatResult }
  | { type: 'tool'; turn: number; call: ToolCall; output: string }
  | { type: 'done'; turns: number; messages: ModelMessage[]; usage: Usage; final: ChatResult };

/** Accumulate a single streamed turn into a ChatResult (mirrors aggregateStream). */
async function streamTurn(
  client: ModelHitch,
  input: ChatInput,
  messages: ModelMessage[],
): Promise<{ result: ChatResult; chunks: StreamChunk[] }> {
  const stream = await client.stream({ ...input, messages });
  const chunks: StreamChunk[] = [];
  let text = '';
  let reasoning = '';
  const calls = new Map<string, { id: string; name: string; argsJson: string }>();
  let finishReason = 'stop';
  let usage: Usage | undefined;

  for await (const chunk of stream) {
    chunks.push(chunk);
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text;
        break;
      case 'reasoning-delta':
        reasoning += chunk.text;
        break;
      case 'tool-call-start':
        calls.set(chunk.id, { id: chunk.id, name: chunk.name, argsJson: '' });
        break;
      case 'tool-call-args-delta': {
        const c = calls.get(chunk.id);
        if (c) c.argsJson += chunk.argsDelta;
        break;
      }
      case 'tool-call-end':
        break;
      case 'finish':
        finishReason = chunk.finishReason;
        usage = chunk.usage;
        break;
    }
  }

  const toolCalls: ToolCall[] = [...calls.values()].map((c) => ({
    id: c.id,
    name: c.name,
    arguments: safeJsonParse<Record<string, unknown>>(c.argsJson, {}),
  }));
  const message: ModelMessage =
    toolCalls.length > 0
      ? { role: 'assistant', content: text, toolCalls, ...(reasoning ? { reasoningContent: reasoning } : {}) }
      : { role: 'assistant', content: text, ...(reasoning ? { reasoningContent: reasoning } : {}) };
  return { result: { message, finishReason, usage }, chunks };
}

/**
 * Run a streaming multi-turn tool loop. Yields events as they happen; the
 * generator ends right after the final `done` event. If the executor throws,
 * the error propagates out of the generator (wrap it to feed failures back
 * to the model as tool output instead).
 */
export async function* runToolLoop(
  client: ModelHitch,
  input: ChatInput,
  executeTool: ToolExecutor,
  options: ToolLoopOptions = {},
): AsyncGenerator<ToolLoopEvent> {
  const maxTurns = options.maxTurns ?? 8;
  const messages: ModelMessage[] = [...input.messages];
  const totals: Usage = {};
  let final: ChatResult | undefined;
  let turns = 0;

  for (let turn = 1; turn <= maxTurns; turn++) {
    turns = turn;
    const { result, chunks } = await streamTurn(client, input, messages);
    // Live passthrough first — callers render text deltas / tool progress as
    // they stream in.
    for (const chunk of chunks) yield { type: 'chunk', turn, chunk };
    final = result;

    if (result.usage) {
      totals.inputTokens = (totals.inputTokens ?? 0) + (result.usage.inputTokens ?? 0);
      totals.outputTokens = (totals.outputTokens ?? 0) + (result.usage.outputTokens ?? 0);
      totals.totalTokens = (totals.totalTokens ?? 0) + (result.usage.totalTokens ?? 0);
    }

    yield { type: 'turn', turn, result };
    messages.push(result.message);

    const toolCalls = result.message.role === 'assistant' ? result.message.toolCalls : undefined;
    if (!toolCalls?.length) break;

    for (const call of toolCalls) {
      const output = await executeTool(call.name, call.arguments);
      yield { type: 'tool', turn, call, output };
      messages.push({ role: 'tool', content: output, toolCallId: call.id });
    }
  }

  yield {
    type: 'done',
    turns,
    messages,
    usage: totals,
    final: final!,
  };
}
