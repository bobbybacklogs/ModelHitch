import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runToolLoop, type ToolExecutor } from '../agent.js';
import type { ModelHitch, ChatInput } from '../client.js';
import type { ModelMessage, ToolDefinition, Usage } from '../core/types.js';
import { createBridgeClient, type BridgeConfig } from './bridge.js';
import { initialStreamState, reduceStreamChunk, startReduction, type StreamState } from './stream-reducer.js';

export { createBridgeClient, type BridgeConfig } from './bridge.js';

/**
 * React hooks for BYOK UIs. Point them at a ModelHitch bridge
 * (`createModelHitchServer`) and they drive chat + streaming tool loops with
 * keys held locally by the bridge.
 *
 * Import from `modelhitch/react` (React >= 18 peer dependency).
 *
 * ```tsx
 * const { messages, pending, send, isThinking, usage } = useChat({
 *   baseUrl: 'http://127.0.0.1:3939/v1',
 *   model: 'vercel-ai-gateway/openai/gpt-5.4',
 *   tools: [weatherTool],
 *   executeTool: async (name, args) => { ... },
 * });
 * ```
 */

// ---------------------------------------------------------------------------
// useStream — raw, one-shot streaming with full chunk-level control
// ---------------------------------------------------------------------------

export interface UseStreamOptions extends BridgeConfig {
  /** Extra per-call params (temperature, tools, toolChoice, ...). */
  params?: Omit<ChatInput, 'provider' | 'model' | 'messages' | 'signal'>;
}

export interface UseStreamResult {
  /** Accumulated assistant text so far (this run). */
  text: string;
  /** Tool calls captured so far (arguments parsed). */
  toolCalls: StreamState['toolCalls'];
  finishReason: string | null;
  usage: Usage | null;
  error: Error | null;
  isStreaming: boolean;
  /**
   * Stream one assistant turn for the given messages. Replaces the previous
   * run's state. Resolves with the final accumulated state (rejects on
   * network errors; resolves with partial state if `cancel()` was called).
   */
  start: (messages: ModelMessage[]) => Promise<StreamState>;
  /** Abort the in-flight stream (partial state stays in `text`/`toolCalls`). */
  cancel: () => void;
}

export function useStream(config: UseStreamOptions): UseStreamResult {
  const client = useBridgeClient(config);
  const [state, setState] = useState<StreamState>(initialStreamState);
  const [error, setError] = useState<Error | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const start = useCallback(
    async (messages: ModelMessage[]): Promise<StreamState> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setError(null);
      setIsStreaming(true);
      setState(initialStreamState);
      const red = startReduction();

      try {
        const stream = await client.stream({
          provider: 'bridge',
          model: config.model,
          messages,
          signal: controller.signal,
          ...config.params,
        });
        for await (const chunk of stream) {
          if (controller.signal.aborted) break;
          reduceStreamChunk(red, chunk);
          setState({ ...red.state });
        }
        if (!controller.signal.aborted) setError(null);
        return red.state;
      } catch (err) {
        if (controller.signal.aborted) {
          return red.state; // cancelled — partial state is the result
        }
        setError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      } finally {
        setIsStreaming(false);
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [client, config.model, config.params],
  );

  useEffect(() => () => controllerRef.current?.abort(), []);

  return {
    text: state.text,
    toolCalls: state.toolCalls,
    finishReason: state.finishReason,
    usage: state.usage,
    error,
    isStreaming,
    start,
    cancel,
  };
}

// ---------------------------------------------------------------------------
// useChat — message-list chat with an automatic streaming tool loop
// ---------------------------------------------------------------------------

export interface UseChatOptions extends BridgeConfig {
  /** System message seeded into every conversation (optional). */
  systemPrompt?: string;
  /** Tools advertised to the model on every turn. */
  tools?: ToolDefinition[];
  /** Executor for tool calls. Default: feed a "no executor" error back. */
  executeTool?: ToolExecutor;
  /** Tool-loop turn cap per send (default 8). */
  maxTurns?: number;
  /** Extra per-call params (temperature, toolChoice, ...). */
  params?: Omit<ChatInput, 'provider' | 'model' | 'messages' | 'signal' | 'tools'>;
}

export interface UseChatResult {
  /** Full conversation history (user, assistant, tool messages). */
  messages: ModelMessage[];
  /** Text of the assistant turn currently streaming (null when idle). */
  pending: string | null;
  /** Name of the tool call currently executing, if any. */
  activeTool: string | null;
  isThinking: boolean;
  error: Error | null;
  /** Token totals across the whole conversation (last `done` event). */
  usage: Usage | null;
  /** Send a user message and stream the assistant's (possibly tool-chained) reply. */
  send: (content: string) => Promise<void>;
  /** Clear the conversation (keeps systemPrompt). */
  reset: () => void;
  /** Abort the in-flight turn. */
  cancel: () => void;
}

const noExecutor: ToolExecutor = (name) => JSON.stringify({ error: `no executor registered for tool "${name}"` });

export function useChat(config: UseChatOptions): UseChatResult {
  const client = useBridgeClient(config);
  const [messages, setMessages] = useState<ModelMessage[]>(() =>
    config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }] : [],
  );
  const [pending, setPending] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [isThinking, setIsThinking] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (content: string) => {
      if (!content.trim() || isThinking) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setError(null);
      setIsThinking(true);
      setPending('');
      setMessages((prev) => [...prev, { role: 'user', content }]);
      const working: ModelMessage[] = [...messages, { role: 'user', content }];

      try {
        for await (const ev of runToolLoop(
          client,
          {
            provider: 'bridge',
            model: config.model,
            messages: working,
            tools: config.tools,
            signal: controller.signal,
            ...config.params,
          },
          config.executeTool ?? noExecutor,
          { maxTurns: config.maxTurns ?? 8 },
        )) {
          if (controller.signal.aborted) break;
          if (ev.type === 'chunk') {
            const chunk = ev.chunk;
            if (chunk.type === 'text-delta') {
              setPending((prev) => (prev ?? '') + chunk.text);
            }
          } else if (ev.type === 'tool') {
            setActiveTool(ev.call.name);
          } else if (ev.type === 'done') {
            setMessages(ev.messages);
            setUsage(ev.usage);
          }
        }
      } catch (err) {
        if (controller.signal.aborted) return; // cancelled — keep partial state
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setPending(null);
          setActiveTool(null);
          setIsThinking(false);
        }
      }
    },
    [client, config.model, config.tools, config.executeTool, config.maxTurns, config.params, messages, isThinking],
  );

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    setMessages(config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }] : []);
    setPending(null);
    setActiveTool(null);
    setError(null);
    setUsage(null);
    setIsThinking(false);
  }, [config.systemPrompt]);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { messages, pending, activeTool, isThinking, error, usage, send, reset, cancel };
}

/** Memoized bridge client, recreated when the connection config changes. */
function useBridgeClient(config: BridgeConfig): ModelHitch {
  return useMemo(
    () => createBridgeClient({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey }),
    [config.baseUrl, config.model, config.apiKey],
  );
}
