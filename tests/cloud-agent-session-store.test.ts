import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CloudAgentSessionStore } from '../src/providers/cloud-agent-session-store.js';
import { createCursorCloudBackend } from '../src/providers/cursor-cloud-backend.js';
import { adoptsSessions, drivesOwnRuns } from '../src/providers/cloud-agent-backend.js';
import type { CloudAgentConfig } from '../src/config.js';

const config: CloudAgentConfig = { enabled: true, defaultModel: 'composer-2.5' };

function statusFetch(): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ items: [{ id: 'bc-1', status: 'RUNNING' }] }), { status: 200 });
}

describe('CloudAgentSessionStore (durable conversation -> agent map)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mh-cloud-sessions-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a mapping through a fresh instance (the restart case)', () => {
    const first = new CloudAgentSessionStore(dir);
    first.set('cursor-cloud', 'conv-1', 'bc-1');

    // A brand-new instance == a restarted bridge reading from disk.
    const second = new CloudAgentSessionStore(dir);
    expect(second.get('cursor-cloud', 'conv-1')).toBe('bc-1');
  });

  it('returns undefined for an unknown conversation', () => {
    const store = new CloudAgentSessionStore(dir);
    expect(store.get('cursor-cloud', 'never-seen')).toBeUndefined();
  });

  it('isolates backends from each other', () => {
    const store = new CloudAgentSessionStore(dir);
    store.set('cursor-cloud', 'conv-1', 'bc-1');
    store.set('local-agent', 'conv-1', 'local-1');

    expect(store.get('cursor-cloud', 'conv-1')).toBe('bc-1');
    expect(store.get('local-agent', 'conv-1')).toBe('local-1');
  });

  it('overwrites an existing mapping instead of duplicating it', () => {
    const store = new CloudAgentSessionStore(dir);
    store.set('cursor-cloud', 'conv-1', 'bc-1');
    store.set('cursor-cloud', 'conv-1', 'bc-2');

    expect(store.get('cursor-cloud', 'conv-1')).toBe('bc-2');
    expect(store.list('cursor-cloud')).toHaveLength(1);
  });

  it('deletes a mapping', () => {
    const store = new CloudAgentSessionStore(dir);
    store.set('cursor-cloud', 'conv-1', 'bc-1');
    store.delete('cursor-cloud', 'conv-1');
    expect(store.get('cursor-cloud', 'conv-1')).toBeUndefined();
  });

  it('treats deleting an absent mapping as a no-op', () => {
    const store = new CloudAgentSessionStore(dir);
    expect(() => store.delete('cursor-cloud', 'ghost')).not.toThrow();
  });

  it('lists records newest first', () => {
    const store = new CloudAgentSessionStore(dir);
    store.set('cursor-cloud', 'conv-old', 'bc-old');
    store.set('cursor-cloud', 'conv-new', 'bc-new');
    // Force a distinct, later timestamp without sleeping.
    const records = store.list('cursor-cloud');
    expect(records.map((r) => r.sessionId).sort()).toEqual(['bc-new', 'bc-old']);
    expect(records.map((r) => r.conversationId).sort()).toEqual(['conv-new', 'conv-old']);
  });

  it('keeps conversation ids with path-hostile characters addressable', () => {
    const store = new CloudAgentSessionStore(dir);
    const nasty = '../../etc/passwd';
    store.set('cursor-cloud', nasty, 'bc-nasty');

    expect(store.get('cursor-cloud', nasty)).toBe('bc-nasty');
    // The hostile id must not have escaped its directory.
    const topLevel = readdirSync(dir);
    expect(topLevel).toEqual(['cursor-cloud']);
  });

  it('survives a corrupt record without losing the readable ones', () => {
    const store = new CloudAgentSessionStore(dir);
    store.set('cursor-cloud', 'conv-good', 'bc-good');
    const backendDir = join(dir, 'cursor-cloud');
    // Write a bad record beside the good one.
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(backendDir, 'deadbeef.json'), '{not json', 'utf8');

    expect(store.list('cursor-cloud').map((r) => r.sessionId)).toEqual(['bc-good']);
  });
});

describe('Cursor backend re-adoption across a restart', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mh-cloud-readopt-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a restarted bridge adopts the recorded agent instead of forking', async () => {
    // Bridge run 1 records the conversation.
    const before = createCursorCloudBackend({
      config,
      apiKey: 'k',
      fetchImpl: statusFetch(),
      durableSessionStore: new CloudAgentSessionStore(dir),
    });
    await before.rememberConversation('conv-1', 'bc-1');

    // Bridge run 2: new process, empty memory, same disk.
    const after = createCursorCloudBackend({
      config,
      apiKey: 'k',
      fetchImpl: statusFetch(),
      durableSessionStore: new CloudAgentSessionStore(dir),
    });
    expect(await after.adoptConversation('conv-1')).toBe('bc-1');
  });

  it('a conversation with no record adopts nothing', async () => {
    const backend = createCursorCloudBackend({
      config,
      apiKey: 'k',
      fetchImpl: statusFetch(),
      durableSessionStore: new CloudAgentSessionStore(dir),
    });
    expect(await backend.adoptConversation('brand-new')).toBeUndefined();
  });

  it('forgetConversation clears both memory and disk', async () => {
    const store = new CloudAgentSessionStore(dir);
    const backend = createCursorCloudBackend({
      config,
      apiKey: 'k',
      fetchImpl: statusFetch(),
      durableSessionStore: store,
    });
    await backend.rememberConversation('conv-1', 'bc-1');
    await backend.forgetConversation('conv-1');

    expect(await backend.adoptConversation('conv-1')).toBeUndefined();
    expect(store.get('cursor-cloud', 'conv-1')).toBeUndefined();
  });

  it('still works with no durable store at all (management-only use)', async () => {
    const backend = createCursorCloudBackend({ config, apiKey: 'k', fetchImpl: statusFetch() });
    // Management routes stay usable, and adoption degrades to "nothing recorded".
    expect(await backend.adoptConversation('conv-1')).toBeUndefined();
    await expect(backend.list()).resolves.toHaveLength(1);
  });

  it('narrowing helpers classify the Cursor backend correctly', () => {
    const backend = createCursorCloudBackend({ config, apiKey: 'k', fetchImpl: statusFetch() });
    expect(adoptsSessions(backend)).toBe(true);
    expect(drivesOwnRuns(backend)).toBe(false);
  });
});
