import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  firstTask,
  formatSessionList,
  formatSessionDetail,
  runSessions,
  summarizeSessions,
} from '../harness/sessions.js';
import { createSnapshotter, runIds, undoRun } from '../harness/snapshot.js';
import type { SessionRecord } from '../harness/session.js';
import { stripAnsi } from '../harness/theme.js';

/**
 * `sessions` is a convenience over files that already exist, so the cases worth
 * pinning are the ones where convenience turns into damage: deleting a session
 * must not touch that run's snapshot, and the literal word `sessions` must never
 * become part of a task prompt.
 *
 * Everything here runs against a throwaway state directory, so no real saved run
 * is ever listed or removed.
 */

const STATE = resolve(__dirname, '.tmp-sessions-state');
const SNAPSHOTS = resolve(__dirname, '.tmp-sessions-snapshots');

beforeAll(() => {
  rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  rmSync(SNAPSHOTS, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  mkdirSync(join(STATE, 'sessions'), { recursive: true });
  process.env['HARNESS_STATE_DIR'] = STATE;
  process.env['HARNESS_SNAPSHOT_DIR'] = SNAPSHOTS;
});

afterAll(() => {
  delete process.env['HARNESS_STATE_DIR'];
  delete process.env['HARNESS_SNAPSHOT_DIR'];
  rmSync(STATE, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  rmSync(SNAPSHOTS, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

function collector(): { stream: NodeJS.WriteStream; text: () => string } {
  let out = '';
  return {
    stream: {
      isTTY: false,
      columns: 100,
      write(chunk: string) {
        out += chunk;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    text: () => out,
  };
}

function writeSession(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const record: SessionRecord = {
    id,
    createdAt: '2026-06-01T14:30:12.000Z',
    model: 'vercel-ai-gateway/anthropic/claude-sonnet-4',
    playbook: 'feature',
    turns: 3,
    messages: [
      { role: 'system', content: 'you are an engineer' },
      {
        role: 'user',
        content: 'fix the failing health test\nand make the route return JSON',
      },
      {
        role: 'assistant',
        content: 'looking',
        toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
      },
      { role: 'tool', content: 'file body', toolCallId: 'c1' },
      { role: 'assistant', content: 'done' },
    ],
    ...overrides,
  };
  writeFileSync(join(STATE, 'sessions', `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

describe('firstTask', () => {
  it('flattens the first user message onto one line', () => {
    expect(firstTask(writeSession('20260601-000000-aaaa'))).toBe(
      'fix the failing health test and make the route return JSON',
    );
  });

  it('reads a multimodal first message rather than reporting nothing', () => {
    const record = writeSession('20260601-000000-bbbb', {
      messages: [
        { role: 'system', content: 's' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', imageUrl: 'data:image/png;base64,xx' },
          ],
        },
      ],
    });
    expect(firstTask(record)).toBe('look at this');
  });

  it('says so when there is no user message at all', () => {
    const record = writeSession('20260601-000000-cccc', {
      messages: [{ role: 'system', content: 's' }],
    });
    expect(firstTask(record)).toBe('(no task recorded)');
  });
});

describe('summarizeSessions', () => {
  it('reports the headline facts for each saved run', () => {
    writeSession('20260601-120000-1111');
    const summary = summarizeSessions().find((entry) => entry.id === '20260601-120000-1111');
    expect(summary?.model).toContain('claude-sonnet-4');
    expect(summary?.turns).toBe(3);
    expect(summary?.task).toContain('fix the failing health test');
    expect(summary?.messages).toBe(5);
    expect(summary?.error).toBeUndefined();
  });

  it('reports an unreadable session as a row rather than hiding it', () => {
    // A corrupt file the listing silently skips is a corrupt file nobody cleans
    // up, so it gets a line saying what is wrong with it.
    writeFileSync(join(STATE, 'sessions', '20260601-130000-bad1.json'), '{ not json', 'utf8');
    const summary = summarizeSessions().find((entry) => entry.id === '20260601-130000-bad1');
    expect(summary?.error).toContain('not valid JSON');
  });
});

describe('formatSessionList', () => {
  it('says so plainly when there is nothing saved', () => {
    const text = stripAnsi(formatSessionList([]));
    expect(text).toContain('no saved sessions');
    expect(text).toContain('--save-session');
  });

  it('shows id, model, turns and the task for each row', () => {
    const text = stripAnsi(formatSessionList(summarizeSessions()));
    expect(text).toContain('20260601-120000-1111');
    expect(text).toContain('claude-sonnet-4');
    expect(text).toContain('3t');
    expect(text).toContain('fix the failing health test');
  });
});

describe('formatSessionDetail', () => {
  it('prints the record and a resume hint', () => {
    const record = writeSession('20260601-140000-2222');
    const text = stripAnsi(formatSessionDetail(record));
    expect(text).toContain(record.id);
    expect(text).toContain('mhh --resume 20260601-140000-2222');
    expect(text).toContain('fix the failing health test');
    // Tool names, counted, without their bodies.
    expect(text).toContain('read×1');
  });
});

describe('runSessions', () => {
  it('lists, and exits 0 even with nothing saved', async () => {
    const out = collector();
    const code = await runSessions({ verb: 'list', output: out.stream, error: out.stream });
    expect(code).toBe(0);
  });

  it('emits parseable JSON for a script', async () => {
    writeSession('20260601-150000-3333');
    const out = collector();
    await runSessions({ verb: 'list', json: true, output: out.stream, error: out.stream });
    const parsed = JSON.parse(out.text()) as { sessions: Array<{ id: string }> };
    expect(Array.isArray(parsed.sessions)).toBe(true);
    expect(parsed.sessions.some((entry) => entry.id === '20260601-150000-3333')).toBe(true);
  });

  it('exits 0 for an empty --json list, because none is a fact and not a failure', async () => {
    const out = collector();
    const code = await runSessions({ verb: 'list', json: true, output: out.stream, error: out.stream });
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toHaveProperty('sessions');
  });

  it('reports an unknown id on stderr, lists the known ones, and exits 1', async () => {
    const out = collector();
    let err = '';
    const errStream = {
      isTTY: false,
      columns: 100,
      write(chunk: string) {
        err += chunk;
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const code = await runSessions({ verb: 'show', id: 'nope', output: out.stream, error: errStream });
    expect(code).toBe(1);
    expect(out.text()).toBe('');
    expect(err).toContain('No session "nope"');
    // The same courtesy the --resume failure path gives.
    expect(err).toContain('Saved sessions');
  });

  it('needs an id for show and rm', async () => {
    const out = collector();
    expect(await runSessions({ verb: 'show', output: out.stream, error: out.stream })).toBe(1);
    expect(await runSessions({ verb: 'rm', output: out.stream, error: out.stream })).toBe(1);
  });

  it('does not remove without confirmation, and exits 1 when refused', async () => {
    writeSession('20260601-160000-4444');
    const out = collector();
    const code = await runSessions({
      verb: 'rm',
      id: '20260601-160000-4444',
      output: out.stream,
      error: out.stream,
      confirmRemove: async () => false,
    });
    expect(code).toBe(1);
    expect(existsSync(join(STATE, 'sessions', '20260601-160000-4444.json'))).toBe(true);
    expect(stripAnsi(out.text())).toContain('left in place');
  });

  it('removes with --yes and leaves the run snapshot alone', async () => {
    const id = '20260601-170000-5555';
    writeSession(id);

    // A snapshot for the same run id, as a mutating run would have produced.
    const workspace = resolve(__dirname, '.tmp-sessions-workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'tracked.txt'), 'original\n');
    const snapshotter = createSnapshotter({ workspaceDir: workspace, runId: id, root: SNAPSHOTS });
    snapshotter.capture(join(workspace, 'tracked.txt'));
    snapshotter.finish();
    expect(runIds(SNAPSHOTS)).toContain(id);

    const out = collector();
    const code = await runSessions({
      verb: 'rm',
      id,
      assumeYes: true,
      output: out.stream,
      error: out.stream,
    });
    expect(code).toBe(0);
    expect(existsSync(join(STATE, 'sessions', `${id}.json`))).toBe(false);
    expect(stripAnsi(out.text())).toContain('✔ deleted');

    // The point of the case: forgetting a transcript must not destroy the
    // ability to roll back the change the transcript described.
    expect(runIds(SNAPSHOTS)).toContain(id);
    writeFileSync(join(workspace, 'tracked.txt'), 'changed\n');
    const undone = undoRun(id, { root: SNAPSHOTS });
    expect(undone.restored).toContain('tracked.txt');
    expect(readdirSync(join(STATE, 'sessions')).includes(`${id}.json`)).toBe(false);
    rmSync(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });

  it('exits 1 when asked to remove something that is not there', async () => {
    const out = collector();
    const code = await runSessions({
      verb: 'rm',
      id: '20260601-999999-zzzz',
      assumeYes: true,
      output: out.stream,
      error: out.stream,
    });
    expect(code).toBe(1);
  });
});
