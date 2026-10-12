import { describe, expect, it } from 'vitest';
import type { CloudAgentConfig } from '../src/config.js';
import { createCursorCloudProvider, CURSOR_CLOUD_API_BASE } from '../src/providers/cursor-cloud.js';
import { CursorCloudSessionStore } from '../src/providers/cursor-cloud-session.js';
import { createCursorCloudBackend } from '../src/providers/cursor-cloud-backend.js';
import type { ChatParams } from '../src/core/types.js';

const config: CloudAgentConfig = {
  enabled: true,
  defaultModel: 'composer-2.5',
  repos: [{ url: 'https://github.com/org/repo' }],
  sessionReuse: 'per-bridge-session',
};

/**
 * Models a bridge restart: the vendor keeps its agents, but the bridge's
 * in-memory conversation->agent map is gone. The question this file answers is
 * whether the conversation can be re-adopted, or whether the next turn silently
 * forks a brand-new agent.
 */
function restartableFetch() {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  // Vendor-side state that survives a bridge restart.
  const vendorAgents: Array<{ id: string; status: string; name?: string }> = [
    { id: 'bc-existing', status: 'FINISHED', name: 'earlier conversation' },
  ];
  let created = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });

    if (method === 'GET' && url.endsWith('/agents')) {
      return new Response(JSON.stringify({ items: vendorAgents }), { status: 200 });
    }
    if (method === 'POST' && url.endsWith('/agents')) {
      created += 1;
      const agent = { id: `bc-new-${created}`, status: 'RUNNING' };
      vendorAgents.push(agent);
      return new Response(JSON.stringify({ agent: { id: agent.id }, run: { id: `run-new-${created}` } }), {
        status: 200,
      });
    }
    if (method === 'POST' && /\/agents\/[^/]+\/runs$/.test(url)) {
      return new Response(JSON.stringify({ run: { id: 'run-followup' } }), { status: 200 });
    }
    if (url.includes('/stream')) {
      const payload = [
        `event: result`,
        `data: ${JSON.stringify({ status: 'FINISHED', text: 'ok' })}`,
        '',
      ].join('\n');
      return new Response(payload, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ error: { message: `unmocked ${method} ${url}` } }), { status: 400 });
  };
  return {
    fetchImpl,
    calls,
    vendorAgents,
    get createdCount() {
      return created;
    },
  };
}

const params: ChatParams = {
  model: 'composer-2.5',
  sessionId: 'conv-1',
  messages: [{ role: 'user', content: 'keep going' }],
};

describe('session re-adoption across a bridge restart', () => {
  it('without a warm store, the next turn creates a NEW agent (the gap)', async () => {
    const stub = restartableFetch();
    // Fresh store == what a restarted bridge has.
    const provider = createCursorCloudProvider({
      config,
      sessionStore: new CursorCloudSessionStore(),
      fetchImpl: stub.fetchImpl,
    });

    await provider.chat(params, { apiKey: 'test-key' });

    // This is the documented gap: the vendor agent `bc-existing` is invisible to
    // the provider, so the conversation forks instead of continuing.
    expect(stub.createdCount).toBe(1);
    const runPosts = stub.calls.filter((c) => /\/agents\/[^/]+\/runs$/.test(c.url));
    expect(runPosts).toHaveLength(0);
  });

  it('a warm store continues the SAME agent instead of creating one', async () => {
    const stub = restartableFetch();
    const store = new CursorCloudSessionStore();
    store.set('conv-1', 'bc-existing');
    const provider = createCursorCloudProvider({ config, sessionStore: store, fetchImpl: stub.fetchImpl });

    await provider.chat(params, { apiKey: 'test-key' });

    expect(stub.createdCount).toBe(0);
    const runPosts = stub.calls.filter((c) => /\/agents\/[^/]+\/runs$/.test(c.url));
    expect(runPosts.map((c) => c.url)).toEqual([`${CURSOR_CLOUD_API_BASE}/agents/bc-existing/runs`]);
  });

  it('list() exposes enough to see the agent exists after a restart', async () => {
    const stub = restartableFetch();
    const backend = createCursorCloudBackend({
      config,
      apiKey: 'test-key',
      fetchImpl: stub.fetchImpl,
    });

    const sessions = await backend.list();
    expect(sessions.map((s) => s.id)).toContain('bc-existing');
  });

  it('list() alone cannot map a conversation to its agent (why ids must persist)', async () => {
    const stub = restartableFetch();
    const backend = createCursorCloudBackend({
      config,
      apiKey: 'test-key',
      fetchImpl: stub.fetchImpl,
    });

    const sessions = await backend.list();
    const match = sessions.find((s) => s.id === 'conv-1');

    // The vendor knows the agent; it has no idea what the bridge called the
    // conversation. Re-adoption therefore needs a persisted conversation->agent
    // map, not just a live list.
    expect(match).toBeUndefined();
  });
});
