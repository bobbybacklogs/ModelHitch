import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from '../src/core/types.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import type { ChatSession, WorkOrder } from '../src/workspace/types.js';

const dirs: string[] = [];

function tempStore(): WorkspaceStore {
  const dir = mkdtempSync(join(tmpdir(), 'modelhitch-workspace-'));
  dirs.push(dir);
  return new WorkspaceStore(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorkspaceStore', () => {
  it('round-trips a chat session', () => {
    const store = tempStore();
    const session: ChatSession = {
      id: 'sess-1',
      title: 'Bridge smoke test',
      target: { kind: 'rotation' },
      messages: [{ role: 'user', content: 'hello' }],
      updatedAt: '2026-09-23T04:00:00.000Z',
    };

    store.saveSession(session);
    expect(store.readSession('sess-1')).toEqual(session);
  });

  it('round-trips a queued work order with a rotation target', () => {
    const store = tempStore();
    const order: WorkOrder = {
      id: 'wo-1',
      prompt: 'Summarize the latest bridge logs',
      target: { kind: 'rotation' },
      status: 'queued',
      createdAt: '2026-09-23T04:01:00.000Z',
      updatedAt: '2026-09-23T04:01:00.000Z',
    };

    store.saveWorkOrder(order);
    expect(store.readWorkOrder('wo-1')).toEqual(order);
  });

  it('persists a pinned model target on a work order', () => {
    const store = tempStore();
    const order: WorkOrder = {
      id: 'wo-pinned',
      prompt: 'Run on a fixed lane',
      target: { kind: 'model', providerId: 'openai', modelId: 'gpt-5.4' },
      status: 'queued',
      createdAt: '2026-09-23T04:02:00.000Z',
      updatedAt: '2026-09-23T04:02:00.000Z',
    };

    store.saveWorkOrder(order);
    expect(store.readWorkOrder('wo-pinned')).toEqual(order);
  });

  it('replaces an existing session file on second save', () => {
    const store = tempStore();
    const id = 'sess-replace';
    store.saveSession({
      id,
      title: 'First title',
      target: { kind: 'rotation' },
      messages: [],
      updatedAt: '2026-09-23T04:03:00.000Z',
    });
    store.saveSession({
      id,
      title: 'Second title',
      target: { kind: 'rotation' },
      messages: [],
      updatedAt: '2026-09-23T04:04:00.000Z',
    });

    const sessionDir = join(store.directory, 'sessions');
    expect(readdirSync(sessionDir)).toEqual(['sess-replace.json']);
    expect(store.readSession(id)?.title).toBe('Second title');
  });

  it('returns null for a missing session id', () => {
    const store = tempStore();
    expect(store.readSession('missing-session')).toBeNull();
  });

  it('persists a cancelled work order status update', () => {
    const store = tempStore();
    const id = 'wo-cancel';
    store.saveWorkOrder({
      id,
      prompt: 'Long-running task',
      target: { kind: 'rotation' },
      status: 'running',
      createdAt: '2026-09-23T04:05:00.000Z',
      updatedAt: '2026-09-23T04:05:30.000Z',
    });
    store.saveWorkOrder({
      id,
      prompt: 'Long-running task',
      target: { kind: 'rotation' },
      status: 'cancelled',
      createdAt: '2026-09-23T04:05:00.000Z',
      updatedAt: '2026-09-23T04:06:00.000Z',
    });

    expect(store.readWorkOrder(id)?.status).toBe('cancelled');
  });

  it('reloads two messages in order', () => {
    const store = tempStore();
    const messages: ModelMessage[] = [
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'second turn' },
    ];
    const session: ChatSession = {
      id: 'sess-messages',
      title: 'Ordered history',
      target: { kind: 'model', providerId: 'mock', modelId: 'mock-model' },
      messages,
      updatedAt: '2026-09-23T04:07:00.000Z',
    };

    store.saveSession(session);
    expect(store.readSession('sess-messages')?.messages).toEqual(messages);
  });
});
