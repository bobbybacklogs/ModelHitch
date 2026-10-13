import type { ModelMessage } from '../core/types.js';
import type { IntentName } from '../core/intent.js';

/**
 * What a session or work order runs on.
 *
 * - `rotation` — the bridge decides: infer an intent from the request's shape,
 *   else the base plan.
 * - `intent` — a plan the user picked on purpose.
 * - `model` — one lane, with the base plan behind it.
 */
export type RunTarget =
  | { kind: 'rotation' }
  | { kind: 'intent'; name: IntentName }
  | { kind: 'model'; providerId: string; modelId: string };

export interface ChatSession {
  id: string;
  title: string;
  target: RunTarget;
  messages: ModelMessage[];
  updatedAt: string;
}

export type WorkOrderStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface WorkOrder {
  id: string;
  prompt: string;
  target: RunTarget;
  status: WorkOrderStatus;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
