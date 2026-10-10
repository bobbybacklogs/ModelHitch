import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createModelHitchServer,
  mockProvider,
  type OpenAICompatibleServer,
} from '../src/index.js';
import type { ChatParams, ChatResult, ProviderCredentials, StreamChunk } from '../src/core/types.js';
import type { Provider } from '../src/providers/types.js';
import { WorkspaceStore } from '../src/workspace/store.js';
import type { ChatSession } from '../src/workspace/types.js';

const blockingProvider: Provider = {
  id: 'blocking',
  name: 'Blocking',
  defaultModel: 'block-model',
  capabilities: { streaming: false, toolCalling: false, vision: false, embeddings: false },
  async chat(params: ChatParams): Promise<ChatResult> {
    const signal = params.signal;
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    return { message: { role: 'assistant', content: 'never' }, finishReason: 'stop' };
  },
  async *stream(_params: ChatParams, _credentials: ProviderCredentials): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', finishReason: 'stop' };
  },
};

let server: OpenAICompatibleServer;
let store: WorkspaceStore;
let base: string;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelhitch-workspace-http-'));
  store = new WorkspaceStore(dir);
  server = createModelHitchServer({
    providers: [mockProvider, blockingProvider],
    defaultProviderId: 'mock',
    defaultModel: 'mock-model',
    workspaceStore: store,
  });
  const info = await server.listen(0, '127.0.0.1');
  base = info.url;
});

afterAll(async () => {
  await server.close();
  rmSync(store.directory, { recursive: true, force: true });
});

afterEach(() => {
  for (const kind of ['sessions', 'work-orders'] as const) {
    const dir = join(store.directory, kind);
    try {
      for (const file of readdirSync(dir)) {
        rmSync(join(dir, file));
      }
    } catch {
      /* empty */
    }
  }
});

describe('workspace HTTP sessions', () => {
  it('creates a session and returns it', async () => {
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Smoke test', target: { kind: 'rotation' } }),
    });
    expect(res.status).toBe(200);
    const session = (await res.json()) as ChatSession;
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session.title).toBe('Smoke test');
    expect(session.target).toEqual({ kind: 'rotation' });
    expect(session.messages).toEqual([]);
    expect(store.readSession(session.id)).toEqual(session);
  });

  it('returns a session by id and 404s when missing', async () => {
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const session = (await created.json()) as ChatSession;

    const ok = await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).id).toBe(session.id);

    const missing = await fetch(`${base}/v1/sessions/does-not-exist`);
    expect(missing.status).toBe(404);
  });

  it('lists saved sessions', async () => {
    const first = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'First' }),
    });
    const second = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Second' }),
    });
    const a = (await first.json()) as ChatSession;
    const b = (await second.json()) as ChatSession;
    const listed = await fetch(`${base}/v1/sessions`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { sessions: ChatSession[] };
    const ids = body.sessions.map((session) => session.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('appends two messages in order via rotation target', async () => {
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'rotation' } }),
    });
    const session = (await created.json()) as ChatSession;

    const first = await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello rotation' }),
    });
    expect(first.status).toBe(200);
    const afterFirst = (await first.json()) as ChatSession;
    expect(afterFirst.messages).toHaveLength(2);
    expect(afterFirst.messages[0]).toEqual({ role: 'user', content: 'hello rotation' });
    expect(afterFirst.messages[1]?.role).toBe('assistant');
    expect(afterFirst.messages[1]?.content).toContain('Mock reply: hello rotation');

    const second = await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'second turn' }),
    });
    expect(second.status).toBe(200);
    const afterSecond = (await second.json()) as ChatSession;
    expect(afterSecond.messages).toHaveLength(4);
    expect(afterSecond.messages[2]).toEqual({ role: 'user', content: 'second turn' });
    expect(afterSecond.messages[3]?.content).toContain('Mock reply: second turn');
  });

  it('sends through a pinned mock model target', async () => {
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'model', providerId: 'mock', modelId: 'mock-model' },
      }),
    });
    const session = (await created.json()) as ChatSession;

    const res = await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'pinned lane' }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ChatSession;
    expect(updated.messages[1]?.content).toContain('Mock reply: pinned lane');
  });

  it('rejects an empty prompt with 400 and writes no session file', async () => {
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const session = (await created.json()) as ChatSession;
    const sessionDir = join(store.directory, 'sessions');
    expect(readdirSync(sessionDir)).toEqual([`${session.id}.json`]);

    const res = await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(readdirSync(sessionDir)).toEqual([`${session.id}.json`]);
    expect(store.readSession(session.id)?.messages).toEqual([]);
  });

  it('rejects a bad session id with 400', async () => {
    const res = await fetch(`${base}/v1/sessions/bad%20id/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_id');
  });

  it('names an untitled session after its first prompt', async () => {
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: { kind: 'rotation' } }),
    });
    const session = (await created.json()) as ChatSession;
    expect(session.title).toBe('Untitled');

    const first = await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'why is the sky blue?\nsecond line is not the title' }),
    });
    const titled = (await first.json()) as ChatSession;
    expect(titled.title).toBe('why is the sky blue?');

    // Later turns are not titles: the name is set once, from the first prompt.
    const second = await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'and at night?' }),
    });
    expect(((await second.json()) as ChatSession).title).toBe('why is the sky blue?');
  });

  it('keeps a title the caller chose, and trims a long first prompt', async () => {
    const named = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Chosen name', target: { kind: 'rotation' } }),
    });
    const chosen = (await named.json()) as ChatSession;
    const kept = await fetch(`${base}/v1/sessions/${encodeURIComponent(chosen.id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'this should not become the title' }),
    });
    expect(((await kept.json()) as ChatSession).title).toBe('Chosen name');

    const long = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const untitled = (await long.json()) as ChatSession;
    const trimmed = await fetch(`${base}/v1/sessions/${encodeURIComponent(untitled.id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'x'.repeat(200) }),
    });
    const titled = (await trimmed.json()) as ChatSession;
    expect(titled.title).toHaveLength(60);
    expect(titled.title.endsWith('…')).toBe(true);
  });
});

describe('workspace HTTP work orders', () => {
  it('creates a work order that finishes done with a result', async () => {
    const res = await fetch(`${base}/v1/work-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'summarize logs',
        target: { kind: 'rotation' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string; result?: string };
    expect(body.status).toBe('done');
    expect(body.result).toBeTruthy();
    expect(body.result).toContain('Mock reply: summarize logs');

    const stored = store.readWorkOrder(body.id);
    expect(stored?.status).toBe('done');
    expect(stored?.result).toBe(body.result);

    const listed = await fetch(`${base}/v1/work-orders`);
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { workOrders: Array<{ id: string; status: string }> };
    expect(listBody.workOrders.some((order) => order.id === body.id && order.status === 'done')).toBe(true);
  });

  it('cancels an in-flight work order', async () => {
    const createPromise = fetch(`${base}/v1/work-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'long task',
        target: { kind: 'model', providerId: 'blocking', modelId: 'block-model' },
      }),
    });

    await new Promise((r) => setTimeout(r, 30));
    const ordersDir = join(store.directory, 'work-orders');
    const files = readdirSync(ordersDir);
    expect(files.length).toBe(1);
    const id = files[0]!.replace(/\.json$/, '');

    const cancel = await fetch(`${base}/v1/work-orders/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()).status).toBe('cancelled');

    const createRes = await createPromise;
    expect(createRes.status).toBe(200);
    expect((await createRes.json()).status).toBe('cancelled');
    expect(store.readWorkOrder(id)?.status).toBe('cancelled');
  });

  it('rejects an empty prompt with 400 and writes no work order file', async () => {
    const res = await fetch(`${base}/v1/work-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '', target: { kind: 'rotation' } }),
    });
    expect(res.status).toBe(400);
    const ordersDir = join(store.directory, 'work-orders');
    let files: string[] = [];
    try {
      files = readdirSync(ordersDir);
    } catch {
      files = [];
    }
    expect(files).toEqual([]);
  });
});
