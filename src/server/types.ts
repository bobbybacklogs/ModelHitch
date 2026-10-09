/**
 * Wire types for the OpenAI-compatible bridge server.
 *
 * These describe the subset of the OpenAI Chat Completions protocol that the
 * bridge accepts on the way in and emits on the way out — enough for agentic
 * IDEs like Android Studio's Agent Mode (tools, multi-turn roles, SSE
 * streaming, usage), without pretending to implement the entire API surface.
 */

import type { PlanModelEntry } from './lane-catalog.js';

/** A content part inside an OpenAI message (text or image_url). */
export interface OpenAIContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

/** A tool call attached to an assistant message (non-streaming). */
export interface OpenAIToolCallInput {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  /** Provider-specific token echoed back on the next turn (e.g. Gemini thoughtSignature). */
  thoughtSignature?: string;
}

/** An inbound message. `role` is one of system | user | assistant | tool. */
export interface OpenAIMessageInput {
  role: string;
  content?: string | OpenAIContentPart[];
  name?: string;
  tool_calls?: OpenAIToolCallInput[];
  tool_call_id?: string;
}

/** An inbound tool declaration. `function` is a JSON Schema wrapper. */
export interface OpenAIToolInput {
  type?: string;
  function?: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/** Inbound `POST /v1/chat/completions` body. */
export interface OpenAIChatRequest {
  model?: string;
  messages?: OpenAIMessageInput[];
  tools?: OpenAIToolInput[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  /** Passed through to the provider (auto | none | required | {type,function}). */
  tool_choice?: unknown;
  /** Passed through to the provider (text | json_object | json_schema). */
  response_format?: unknown;
}

/** A tool call in an outbound assistant message. */
export interface OpenAIToolCallOutput {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Provider-specific token echoed back on the next turn (e.g. Gemini thoughtSignature). */
  thoughtSignature?: string;
}

/** Outbound non-streaming `chat.completion` object. */
export interface OpenAIChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCallOutput[];
    };
    finish_reason: string | null;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

/** Outbound streaming `chat.completion.chunk` object. */
export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** OpenAI-style error envelope: `{ error: { message, type, param, code } }`. */
export interface OpenAIErrorBody {
  error: { message: string; type: string; param: string | null; code: string | null };
}

/**
 * Outbound `GET /v1/models` entry.
 *
 * `id` is the route the client sends back (`providerId/modelId`, or a bare id
 * for the default provider). `name` and `modelhitch` are additions the OpenAI
 * shape tolerates: clients that don't know them ignore them, and they are what
 * lets a model picker show a lane by name and tier instead of a raw id.
 */
export interface OpenAIModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** Display label, e.g. "DeepSeek V4 Pro · OpenCode Go · trusted lane 1". */
  name?: string;
  /**
   * Present only on entries that describe a lane of the bridge's routing plan
   * (see `src/server/lane-catalog.ts`), never on plain catalog entries.
   */
  modelhitch?: PlanModelEntry;
}
