/**
 * A single message in a conversation. `content` is either plain text or a list
 * of content parts (text, image URL, or base64 image data) for multimodal models.
 */
export type ModelMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[]; name?: string }
  | {
      role: 'assistant';
      content: string | ContentPart[];
      toolCalls?: ToolCall[];
      /**
       * Chain-of-thought text emitted by reasoning models (e.g. DeepSeek's
       * `reasoning_content` in thinking mode). Thinking-mode APIs REQUIRE this
       * to be passed back verbatim on the assistant message in every later
       * request — dropping it makes them reject the conversation.
       */
      reasoningContent?: string;
    }
  | { role: 'tool'; content: string; toolCallId: string };

/** A content part for multimodal messages. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; imageUrl: string }
  | { type: 'image-data'; data: string; mimeType: string };

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** A tool invocation emitted by the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Provider-specific token the model requires when the client re-sends the
   * tool call on the next turn (e.g. Gemini's `thoughtSignature`).
   */
  thoughtSignature?: string;
}

/** How the model should decide which tool to call. */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string };

/** Structured output request. */
export type ResponseFormat =
  | 'text'
  | 'json'
  | { type: 'json_object' }
  | { type: 'json_schema'; name?: string; strict?: boolean; schema: Record<string, unknown> };

/** Normalized, provider-agnostic parameters for a chat request. */
export interface ChatParams {
  /** Provider model id, e.g. "gpt-4o-mini", "claude-3-5-sonnet-latest", "llama3.2". */
  model: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Which tool the model should pick (defaults to provider behavior, usually "auto"). */
  toolChoice?: ToolChoice;
  /** Structured output request (JSON mode / JSON Schema). */
  responseFormat?: ResponseFormat;
  /**
   * Responses-API continuation: the id of the previous response, when the
   * client keeps conversation state server-side (previous_response_id).
   * Providers that expose a stateful Responses endpoint forward it; the
   * stateless bridge conversion relies on it to keep orphaned
   * function_call_output deltas (see responses.ts).
   */
  previousResponseId?: string;
  /**
   * Optional session id forwarded as `x-session-id` / `x-conversation-id` for
   * caching and gateway routing by session.
   */
  sessionId?: string;
  signal?: AbortSignal;
}

/** Token usage, normalized. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** A complete (non-streaming) chat result. */
export interface ChatResult {
  message: ModelMessage;
  finishReason: 'stop' | 'length' | 'tool-calls' | 'content-filter' | (string & {});
  usage?: Usage;
  /** Provider-specific raw payload, when available. */
  raw?: unknown;
}

/** A single normalized streaming event. */
export type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'tool-call-start'; id: string; name: string; thoughtSignature?: string }
  | { type: 'tool-call-args-delta'; id: string; argsDelta: string }
  | { type: 'tool-call-end'; id: string }
  | { type: 'finish'; finishReason: string; usage?: Usage; responseId?: string };

/** What a provider can do. Used for capability detection and filtering. */
export interface Capabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  embeddings: boolean;
  maxContextTokens?: number;
}

/** Per-call credentials resolved by the client (from options or the KeyStore). */
export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
}
