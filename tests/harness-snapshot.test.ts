import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSnapshotter,
  describeUndo,
  latestRunId,
  readManifest,
  undoRun,
} from '../harness/snapshot.js';
import { executeHarnessTool } from '../harness/tools.js';

/** The executor returns `{ text, outcome }`; these cases only need the side effect. */
const toolText = async (
  name: string,
  args: Record<string, unknown>,
  opts?: Parameters<typeof executeHarnessTool>[2],
): Promise<string> => (await executeHarnessTool(name, args, opts)).text;

/**
 * Undo is an escape hatch for a run that changed the wrong thing, so the tests
 * care that it restores exactly and removes exactly, and that it states what it
 * could not cover instead of implying a complete rollback.
 */

const SANDBOX = resolve(__dirname, '.tmp-snapshot-sandbox');
const ROOT = resolve(__dirname, '.tmp-snapshot-store');

beforeAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(SANDBOX, 'src'), { recursive: true });
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  rmSync(ROOT, { recursive: true, force: true });
});

describe('snapshot and undo', () => {
  it('restores original bytes and removes files the run created', async () => {
    writeFileSync(join(SANDBOX, 'src', 'tracked.txt'), 'original\n');
    const snapshotter = createSnapshotter({ workspaceDir: SANDBOX, runId: 'run-a', root: ROOT });

    await toolText('write', { path: 'src/tracked.txt', content: 'edited\n' }, {
      workspaceDir: SANDBOX,
      snapshot: snapshotter,
    });
    await toolText('write', { path: 'src/created.txt', content: 'brand new\n' }, {
      workspaceDir: SANDBOX,
      snapshot: snapshotter,
    });

    expect(readFileSync(join(SANDBOX, 'src', 'tracked.txt'), 'utf8')).toBe('edited\n');
    expect(existsSync(join(SANDBOX, 'src', 'created.txt'))).toBe(true);
    expect(snapshotter.finish()).not.toBeNull();

    const result = undoRun('run-a', { root: ROOT });
    expect(result.restored).toEqual(['src/tracked.txt']);
    expect(result.removed).toEqual(['src/created.txt']);
    expect(result.failures).toEqual([]);
    expect(readFileSync(join(SANDBOX, 'src', 'tracked.txt'), 'utf8')).toBe('original\n');
    expect(existsSync(join(SANDBOX, 'src', 'created.txt'))).toBe(false);
  });

  it('captures the state before the first change, not before the last', async () => {
    writeFileSync(join(SANDBOX, 'src', 'twice.txt'), 'one\n');
    const snapshotter = createSnapshotter({ workspaceDir: SANDBOX, runId: 'run-b', root: ROOT });
    await toolText('write', { path: 'src/twice.txt', content: 'two\n' }, {
      workspaceDir: SANDBOX,
      snapshot: snapshotter,
    });
    await toolText('write', { path: 'src/twice.txt', content: 'three\n' }, {
      workspaceDir: SANDBOX,
      snapshot: snapshotter,
    });
    snapshotter.finish();
    undoRun('run-b', { root: ROOT });
    expect(readFileSync(join(SANDBOX, 'src', 'twice.txt'), 'utf8')).toBe('one\n');
  });

  it('records a shell call as out of scope rather than as coverage', async () => {
    const snapshotter = createSnapshotter({ workspaceDir: SANDBOX, runId: 'run-c', root: ROOT });
    await toolText('bash', { command: 'echo hello' }, {
      workspaceDir: SANDBOX,
      snapshot: snapshotter,
    });
    snapshotter.finish();
    const manifest = readManifest('run-c', ROOT);
    expect(manifest.notes.join(' ')).toContain('run_command may modify paths the harness never sees');
    expect(manifest.entries).toEqual([]);
    expect(describeUndo(undoRun('run-c', { root: ROOT }))).toContain('not covered');
  });

  it('writes no snapshot directory when nothing mutating happened', async () => {
    const snapshotter = createSnapshotter({ workspaceDir: SANDBOX, runId: 'run-d', root: ROOT });
    await grepOnly(snapshotter);
    expect(snapshotter.captured).toBe(0);
    expect(snapshotter.finish()).toBeNull();
    expect(existsSync(join(ROOT, 'run-d'))).toBe(false);
  });

  it('remembers the last run so --undo needs no id', async () => {
    writeFileSync(join(SANDBOX, 'src', 'latest.txt'), 'before\n');
    const snapshotter = createSnapshotter({ workspaceDir: SANDBOX, runId: 'run-e', root: ROOT });
    await toolText('write', { path: 'src/latest.txt', content: 'after\n' }, {
      workspaceDir: SANDBOX,
      snapshot: snapshotter,
    });
    snapshotter.finish();
    expect(latestRunId(ROOT)).toBe('run-e');
    undoRun(undefined, { root: ROOT });
    expect(readFileSync(join(SANDBOX, 'src', 'latest.txt'), 'utf8')).toBe('before\n');
  });

  it('explains an unknown run in one line', () => {
    expect(() => readManifest('nope', ROOT)).toThrow(/No snapshot found for run "nope"/);
  });

  it('refuses a manifest entry that points outside the recorded workspace', () => {
    const dir = join(ROOT, 'run-escape');
    mkdirSync(join(dir, 'files'), { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        runId: 'run-escape',
        workspaceDir: SANDBOX,
        createdAt: new Date().toISOString(),
        entries: [{ path: '../../escape.txt', existed: false, bytes: 0 }],
        notes: [],
      }),
    );
    const result = undoRun('run-escape', { root: ROOT });
    expect(result.failures[0]?.error).toBe('outside the recorded workspace');
    expect(result.removed).toEqual([]);
  });
});

/** Reads a file through the tool path, which must capture nothing. */
async function grepOnly(snapshotter: ReturnType<typeof createSnapshotter>): Promise<void> {
  await toolText('read', { path: 'src/tracked.txt' }, {
    workspaceDir: SANDBOX,
    snapshot: snapshotter,
  });
  await toolText('grep_search', { pattern: 'original' }, {
    workspaceDir: SANDBOX,
    snapshot: snapshotter,
  });
}
