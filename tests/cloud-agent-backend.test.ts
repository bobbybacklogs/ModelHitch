import { describe, expect, it } from 'vitest';
import { ModelHitchError } from '../src/core/errors.js';
import {
  drivesOwnRuns,
  type CloudAgentBackend,
  type CloudAgentRunDriver,
  type CloudAgentRunEvent,
  type CloudAgentSession,
  type CloudAgentStartInput,
} from '../src/providers/cloud-agent-backend.js';
import { createCursorCloudBackend } from '../src/providers/cursor-cloud-backend.js';
import { CURSOR_CLOUD_PROVIDER_ID } from '../src/providers/cursor-cloud.js';
import type { CloudAgentConfig } from '../src/config.js';

const enabledConfig: CloudAgentConfig = { enabled: true };

/** Fetch stub covering the three management endpoints. */
function manageFetchStub() {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/agents')) {
      return new Response(JSON.stringify({ items: [{ id: 'bc-1', status: 'RUNNING', name: 'agent one' }] }), {
        status: 200,
      });
    }
    if (method === 'GET' && url.endsWith('/agents/bc-1')) {
      return new Response(JSON.stringify({ agent: { id: 'bc-1', status: 'FINISHED' } }), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/agents/bc-1/cancel')) {
      return new Response(JSON.stringify({ agent: { id: 'bc-1', status: 'CANCELLED' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { message: `unmocked ${method} ${url}` } }), { status: 400 });
  };
  return fetchImpl;
}

describe('CloudAgentBackend contract (Cursor adapter)', () => {
  it('reports provider-lane execution so tools stay owned by the provider', () => {
    const backend = createCursorCloudBackend({ config: enabledConfig, apiKey: 'k' });
    expect(backend.execution).toBe('provider-lane');
    expect(backend.remoteToolExecution).toBe(true);
  });

  it('uses the vendor id as the backend id', () => {
    const backend = createCursorCloudBackend({ config: enabledConfig, apiKey: 'k' });
    expect(backend.id).toBe(CURSOR_CLOUD_PROVIDER_ID);
  });

  it('readiness fails with 403 when the lane is disabled', () => {
    const backend = createCursorCloudBackend({ config: { enabled: false }, apiKey: 'k' });
    const readiness = backend.readiness();
    expect(readiness.ready).toBe(false);
    if (readiness.ready) throw new Error('expected not ready');
    expect(readiness.error).toBeInstanceOf(ModelHitchError);
    expect(readiness.error.status).toBe(403);
  });

  it('readiness fails with 401 when no key is configured', () => {
    const previous = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      const backend = createCursorCloudBackend({ config: enabledConfig });
      const readiness = backend.readiness();
      expect(readiness.ready).toBe(false);
      if (readiness.ready) throw new Error('expected not ready');
      expect(readiness.error.status).toBe(401);
    } finally {
      if (previous !== undefined) process.env.CURSOR_API_KEY = previous;
    }
  });

  it('readiness succeeds when the lane is enabled and a key exists', () => {
    const backend = createCursorCloudBackend({ config: enabledConfig, apiKey: 'k' });
    expect(backend.readiness()).toEqual({ ready: true });
  });

  it('list normalizes sessions and omits absent optional fields', async () => {
    const backend = createCursorCloudBackend({
      config: enabledConfig,
      apiKey: 'k',
      fetchImpl: manageFetchStub(),
    });
    const sessions = await backend.list();
    expect(sessions).toEqual([{ id: 'bc-1', status: 'RUNNING', name: 'agent one' }]);
    // `createdAt` was not in the stub payload, so it must not appear as undefined.
    expect(Object.keys(sessions[0] ?? {})).not.toContain('createdAt');
  });

  it('get and cancel normalize to the same session shape', async () => {
    const backend = createCursorCloudBackend({
      config: enabledConfig,
      apiKey: 'k',
      fetchImpl: manageFetchStub(),
    });
    expect(await backend.get('bc-1')).toEqual({ id: 'bc-1', status: 'FINISHED' });
    expect(await backend.cancel('bc-1')).toEqual({ id: 'bc-1', status: 'CANCELLED' });
  });
});

describe('CloudAgentBackend is satisfiable by a non-vendor backend', () => {
  /**
   * A local lane over `harness/` is the intended second implementation. This
   * fake proves the interface is actually general — not shaped around Cursor —
   * without needing a real local backend to exist yet.
   */
  function createFakeLocalBackend(): CloudAgentRunDriver {
    const sessions = new Map<string, CloudAgentSession>();
    return {
      id: 'local-agent',
      label: 'Local Agent',
      remoteToolExecution: false,
      execution: 'backend',
      readiness: () => ({ ready: true }),
      async list() {
        return [...sessions.values()];
      },
      async get(id) {
        const session = sessions.get(id);
        if (!session) {
          throw new ModelHitchError('model-not-found', `Cloud agent "${id}" was not found.`, { status: 404 });
        }
        return session;
      },
      async cancel(id) {
        const session = await this.get(id);
        const next = { ...session, status: 'CANCELLED' };
        sessions.set(id, next);
        return next;
      },
      async startRun(input: CloudAgentStartInput) {
        const existing = sessions.get(input.sessionKey);
        const session = existing ?? { id: `local-${sessions.size + 1}`, status: 'RUNNING' };
        sessions.set(input.sessionKey, session);
        return { sessionId: session.id, runId: 'run-1' };
      },
      async *streamRun(): AsyncGenerator<CloudAgentRunEvent> {
        yield { type: 'assistant', text: 'working' };
        yield { type: 'result', text: 'done', status: 'FINISHED' };
      },
    };
  }

  it('satisfies the base contract with a non-Cursor id', async () => {
    const backend: CloudAgentBackend = createFakeLocalBackend();
    expect(backend.id).toBe('local-agent');
    expect(backend.remoteToolExecution).toBe(false);
    expect(backend.readiness()).toEqual({ ready: true });
    expect(await backend.list()).toEqual([]);
  });

  it('drivesOwnRuns distinguishes a driver from a provider-lane backend', () => {
    const local = createFakeLocalBackend();
    const cursor = createCursorCloudBackend({ config: enabledConfig, apiKey: 'k' });
    expect(drivesOwnRuns(local)).toBe(true);
    expect(drivesOwnRuns(cursor)).toBe(false);
  });

  it('a driver reuses the session for the same conversation key', async () => {
    const backend = createFakeLocalBackend();
    const first = await backend.startRun({ sessionKey: 'conv-1', prompt: 'a', model: 'local' });
    const second = await backend.startRun({ sessionKey: 'conv-1', prompt: 'b', model: 'local' });
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('a driver streams normalized events to a terminal result', async () => {
    const backend = createFakeLocalBackend();
    const events: CloudAgentRunEvent[] = [];
    for await (const event of backend.streamRun({ sessionId: 'local-1', runId: 'run-1' })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'assistant', text: 'working' },
      { type: 'result', text: 'done', status: 'FINISHED' },
    ]);
  });
});
