import { ModelHitchError } from './errors.js';
import type { ChatResult, ModelMessage, StreamChunk, Usage } from './types.js';
import { safeJsonParse } from './json.js';

/** Wrap a `ReadableStream<Uint8Array>` (e.g. `response.body`) as an async iterable. */
export function bodyToAsyncIterable(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

/**
 * Parse a Server-Sent Events stream, yielding each `data:` payload.
 * Comments and the `[DONE]` sentinel are skipped. Handles payloads split
 * across network chunks.
 */
export async function* parseSSE(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = findEventBoundary(buffer);
    while (boundary) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      for (const line of event.split(/\r?\n/)) {
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trimStart();
          if (payload && payload !== '[DONE]') yield payload;
        }
      }
      boundary = findEventBoundary(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trimStart();
        if (payload && payload !== '[DONE]') yield payload;
      }
    }
  }
}

/** Parse a newline-delimited JSON stream (Ollama's native format), line by line. */
export async function* parseLines(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield line;
      nl = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield buffer.trim();
}

function findEventBoundary(buf: string): { index: number; length: number } | null {
  const lf = buf.indexOf('\n\n');
  if (lf !== -1) return { index: lf, length: 2 };
  const crlf = buf.indexOf('\r\n\r\n');
  if (crlf !== -1) return { index: crlf, length: 4 };
  return null;
}

/**
 * Consume a normalized stream and aggregate it into a `ChatResult`.
 * Lets non-streaming callers share one code path with streaming providers.
 */
export async function aggregateStream(chunks: AsyncIterable<StreamChunk>): Promise<ChatResult> {
  let text = '';
  let reasoning = '';
  const toolCalls = new Map<string, { id: string; name: string; argsJson: string }>();
  let finishReason: string = 'stop';
  let usage: Usage | undefined;

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text;
        break;
      case 'reasoning-delta':
        reasoning += chunk.text;
        break;
      case 'tool-call-start':
        toolCalls.set(chunk.id, { id: chunk.id, name: chunk.name, argsJson: '' });
        break;
      case 'tool-call-args-delta': {
        const tc = toolCalls.get(chunk.id);
        if (tc) tc.argsJson += chunk.argsDelta;
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

  const calls = [...toolCalls.values()].map((tc) => ({
    id: tc.id,
    name: tc.name,
    arguments: safeJsonParse<Record<string, unknown>>(tc.argsJson, {}),
  }));

  const message: ModelMessage =
    calls.length > 0
      ? { role: 'assistant', content: text, toolCalls: calls, ...(reasoning ? { reasoningContent: reasoning } : {}) }
      : { role: 'assistant', content: text, ...(reasoning ? { reasoningContent: reasoning } : {}) };

  return { message, finishReason, usage };
}

/** Guard helper for adapters that need a non-null response body. */
export function requireBody(res: Response, providerId: string): ReadableStream<Uint8Array> {
  if (!res.body) {
    throw new ModelHitchError('network-error', `Provider "${providerId}" returned an empty body.`, { providerId });
  }
  return res.body;
}
