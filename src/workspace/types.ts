import type { ModelMessage } from '../core/types.js';

export type RunTarget =
  | { kind: 'rotation' }
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
