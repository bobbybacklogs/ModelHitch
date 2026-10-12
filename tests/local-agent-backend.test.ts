import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';import {
  createLocalAgentBackend,
  LOCAL_AGENT_PROVIDER_ID,
  type LocalAgentPersistence,
  type LocalRunEvent,
} from '../src/providers/local-agent-backend.js';
import { CloudAgentSessionStore } from '../src/providers/cloud-agent-session-store.js';
import { drivesOwnRuns } from '../src/providers/cloud-agent-backend.js';
import { ModelHitchError } from '../src/core/errors.js';
import type { SessionRecord } from '../harness/session.js';

/** Scratch directory for durable-store tests, cleaned up by the suite. */
const scratchDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh-local-scratch-'));
  scratchDirs.push(dir);
  return dir;
}

/** In-memory persistence so tests never touch the real home directory. */
function memoryPersistence(): LocalAgentPersistence & { saved: SessionRecord[] } {  const records = new Map<string, SessionRecord>();
  let counter = 0;
  return {
    saved: [],
    save(record) {
      records.set(record.id, record);
      this.saved.push(record);
      return record.id;
    },
    read(id) {
      return records.get(id) ?? null;
    },
    newId() {
      counter += 1;
      return `local-${counter}`;
    },
  };
}

/** A run double: yields configured text deltas and a done event with history. */
function fakeRun(events: LocalRunEvent[]) {
  const seen: Array<{ prompt: string; resumed: boolean }> = [];
  return {
    seen,
    run: async function* (prompt: string, options: { initialMessages?: unknown[] }) {
      seen.push({ prompt, resumed: (options.initialMessages?.length ?? 0) > 0 });
      for (const event of events) yield event;
    },
  };
}

describe('local agent backend', () => {
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const base = { enabled: true, workspaceDir: '/tmp/ws' };

  it('is a run driver, not a provider lane', () => {
    const backend = createLocalAgentBackend(base);
    expect(backend.id).toBe(LOCAL_AGENT_PROVIDER_ID);
    expect(backend.execution).toBe('backend');
    expect(drivesOwnRuns(backend)).toBe(true);
  });

  it('reports not ready with 403 when disabled', () => {
    const backend = createLocalAgentBackend({ ...base, enabled: false });
    const readiness = backend.readiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) throw new Error('expected not ready');
    expect(readiness.error).toBeInstanceOf(ModelHitchError);
    expect(readiness.error.status).toBe(403);
  });

  it('refuses management calls when disabled instead of silently serving', async () => {
    const backend = createLocalAgentBackend({ ...base, enabled: false });
    await expect(backend.list()).rejects.toBeInstanceOf(ModelHitchError);
    await expect(backend.get('x')).rejects.toBeInstanceOf(ModelHitchError);
  });

  it('does not claim remote tool execution', () => {
    // The harness runs tools locally, so the bridge must NOT treat this like
    // the Cursor lane (which owns its tools and has client tools stripped).
    expect(createLocalAgentBackend(base).remoteToolExecution).toBe(false);
  });
});

describe('local agent run lifecycle', () => {
  function harness(events: LocalRunEvent[] = [{ type: 'chunk', chunk: { type: 'text-delta', text: 'hi' } }]) {
    const persistence = memoryPersistence();
    const fake = fakeRun(events);
    const backend = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '/tmp/ws',
      persistence,
      runPrompt: fake.run,
    });
    return { backend, persistence, fake };
  }

  it('streams text deltas as assistant events then a terminal result', async () => {
    const { backend } = harness([
      { type: 'chunk', chunk: { type: 'text-delta', text: 'Hel' } },
      { type: 'chunk', chunk: { type: 'text-delta', text: 'lo' } },
    ]);

    const handle = await backend.startRun({ sessionKey: 'conv-1', prompt: 'do it', model: 'local' });
    const events = [];
    for await (const event of backend.streamRun(handle)) events.push(event);

    expect(events.filter((e) => e.type === 'assistant').map((e) => (e as { text: string }).text).join('')).toBe('Hello');
    expect(events.at(-1)).toEqual({ type: 'result', text: 'Hello', status: 'FINISHED' });
  });

  it('reuses the session id for the same conversation key', async () => {
    const persistence = memoryPersistence();
    const backend = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '/tmp/ws',
      persistence,
      sessionStore: new CloudAgentSessionStore(tempDir()),
      runPrompt: fakeRun([]).run,
    });

    const first = await backend.startRun({ sessionKey: 'conv-1', prompt: 'a', model: 'local' });
    for await (const _ of backend.streamRun(first)) { /* drain */ }
    const second = await backend.startRun({ sessionKey: 'conv-1', prompt: 'b', model: 'local' });

    expect(second.sessionId).toBe(first.sessionId);
  });

  it('gives different conversations different sessions', async () => {
    const { backend } = harness();
    const a = await backend.startRun({ sessionKey: 'conv-a', prompt: 'a', model: 'local' });
    const b = await backend.startRun({ sessionKey: 'conv-b', prompt: 'b', model: 'local' });
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('persists finished history so the next run resumes it', async () => {
    const persistence = memoryPersistence();
    const fake = fakeRun([
      { type: 'chunk', chunk: { type: 'text-delta', text: 'ok' } },
      { type: 'done', messages: [{ role: 'system', content: 's' }], turns: 2 },
    ]);
    const backend = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '/tmp/ws',
      persistence,
      // A durable map is what makes two runs the same conversation; the session
      // file is keyed by the id this map remembers.
      sessionStore: new CloudAgentSessionStore(tempDir()),
      runPrompt: fake.run,
    });

    const first = await backend.startRun({ sessionKey: 'conv-1', prompt: 'a', model: 'local' });
    for await (const _ of backend.streamRun(first)) { /* drain */ }
    expect(persistence.saved).toHaveLength(1);
    expect(persistence.saved[0]?.turns).toBe(2);

    // Second run on the same conversation hands the finished history back as
    // the seed, which is what makes a local session resumable.
    const second = await backend.startRun({ sessionKey: 'conv-1', prompt: 'b', model: 'local' });
    for await (const _ of backend.streamRun(second)) { /* drain */ }
    expect(fake.seen.map((s) => s.resumed)).toEqual([false, true]);
  });

  it('without a durable map, each run is a fresh session (honest limitation)', async () => {
    const { backend } = harness();
    const first = await backend.startRun({ sessionKey: 'conv-1', prompt: 'a', model: 'local' });
    for await (const _ of backend.streamRun(first)) { /* drain */ }
    const second = await backend.startRun({ sessionKey: 'conv-1', prompt: 'b', model: 'local' });

    // No store means nothing can tie the conversation to the earlier session.
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  it('surfaces a run failure as an error event, not a throw', async () => {
    const backend = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '/tmp/ws',
      persistence: memoryPersistence(),
      runPrompt: async function* () {
        throw new Error('provider exploded');
      },
    });

    const handle = await backend.startRun({ sessionKey: 'conv-err', prompt: 'x', model: 'local' });
    const events = [];
    for await (const event of backend.streamRun(handle)) events.push(event);

    expect(events.at(-1)).toEqual({ type: 'error', message: 'provider exploded' });
  });

  it('refuses to stream a session that was never started', async () => {
    const { backend } = harness();
    const iterator = backend.streamRun({ sessionId: 'ghost', runId: 'ghost' });
    await expect(iterator.next()).rejects.toBeInstanceOf(ModelHitchError);
  });

  it('cancel marks the session cancelled', async () => {
    const { backend } = harness();
    const handle = await backend.startRun({ sessionKey: 'conv-c', prompt: 'x', model: 'local' });
    const cancelled = await backend.cancel(handle.sessionId);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('cancel of an unknown session is a 404', async () => {
    const { backend } = harness();
    await expect(backend.cancel('nope')).rejects.toBeInstanceOf(ModelHitchError);
  });

  it('lists live sessions and reports status', async () => {
    const { backend } = harness();
    const handle = await backend.startRun({ sessionKey: 'conv-1', prompt: 'a', model: 'local' });
    const listed = await backend.list();
    expect(listed.map((s) => s.id)).toContain(handle.sessionId);
    expect(listed.find((s) => s.id === handle.sessionId)?.status).toBe('RUNNING');
  });

  it('get returns a persisted session that this process never started', async () => {
    const persistence = memoryPersistence();
    persistence.save({
      id: 'from-earlier-bridge',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: 'm',
      playbook: 'harness',
      turns: 1,
      messages: [],
    });
    const backend = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '/tmp/ws',
      persistence,
      runPrompt: fakeRun([]).run,
    });

    const session = await backend.get('from-earlier-bridge');
    expect(session.status).toBe('FINISHED');
  });

  it('get 404s for a session that is neither live nor persisted', async () => {
    const backend = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '/tmp/ws',
      persistence: memoryPersistence(),
      runPrompt: fakeRun([]).run,
    });
    await expect(backend.get('never')).rejects.toBeInstanceOf(ModelHitchError);
  });
});

describe('local agent workspace requirement', () => {
  it('is NOT ready without an explicit workspaceDir', () => {
    // A silent process.cwd() fallback would grant the agent read/write over
    // whatever directory the bridge was started in — typically a repo root.
    const backend = createLocalAgentBackend({ enabled: true, runPrompt: fakeRun([]).run });
    const readiness = backend.readiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) throw new Error('expected not ready');
    expect(readiness.error.message).toContain('workspaceDir');
  });

  it('refuses to start a run without an explicit workspaceDir', async () => {
    const backend = createLocalAgentBackend({
      enabled: true,
      persistence: memoryPersistence(),
      runPrompt: fakeRun([]).run,
    });
    await expect(
      backend.startRun({ sessionKey: 'c', prompt: 'x', model: 'local' }),
    ).rejects.toBeInstanceOf(ModelHitchError);
  });

  it('treats a whitespace-only workspaceDir as absent', () => {
    const backend = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '   ',
      runPrompt: fakeRun([]).run,
    });
    expect(backend.readiness().ready).toBe(false);
  });

  it('is ready with a real workspaceDir', () => {
    const backend = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '/tmp/ws',
      runPrompt: fakeRun([]).run,
    });
    expect(backend.readiness()).toEqual({ ready: true });
  });
});

describe('local agent backend + durable store (restart continuity)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mh-local-agent-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a restarted bridge reuses the recorded local session', async () => {
    const fake = fakeRun([{ type: 'chunk', chunk: { type: 'text-delta', text: 'ok' } }]);

    // Bridge run 1.
    const first = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '/tmp/ws',
      sessionStore: new CloudAgentSessionStore(dir),
      persistence: memoryPersistence(),
      runPrompt: fake.run,
    });
    const h1 = await first.startRun({ sessionKey: 'conv-1', prompt: 'a', model: 'local' });
    for await (const _ of first.streamRun(h1)) { /* drain */ }

    // Bridge run 2: fresh process, same durable store.
    const second = createLocalAgentBackend({
      enabled: true,
      workspaceDir: '/tmp/ws',
      sessionStore: new CloudAgentSessionStore(dir),
      persistence: memoryPersistence(),
      runPrompt: fake.run,
    });
    const h2 = await second.startRun({ sessionKey: 'conv-1', prompt: 'b', model: 'local' });

    expect(h2.sessionId).toBe(h1.sessionId);
  });
});
