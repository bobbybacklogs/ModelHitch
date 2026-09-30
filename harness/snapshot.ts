import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * Per-run snapshots, so a run that edits the workspace can be undone.
 *
 * The harness hands out `write`, `edit`, and `bash`. Before the first change to
 * a path, the pre-change bytes are copied aside into a temp directory along with
 * a manifest. `/undo` (or `--undo`) puts those bytes back and deletes files the
 * run created.
 *
 * Two limits are stated rather than hidden, because a rollback that quietly
 * misses things is worse than one that says what it missed:
 *
 *   1. `bash` can change anything. The harness never sees those paths, so a
 *      shell call is recorded as a note, not as coverage.
 *   2. Subagent delegation runs its own loop inside bihan. Those writes are not
 *      visible here either, so a delegation is recorded the same way.
 *
 * Everything here is best-effort. A snapshot that cannot be taken must never
 * fail the tool call it was protecting, so every filesystem call is wrapped and
 * a failure lands in the manifest instead of on the model.
 */

/** Where snapshots live. Overridable so tests and CI do not share state. */
export function snapshotRoot(): string {
  return process.env['HARNESS_SNAPSHOT_DIR'] ?? join(tmpdir(), 'modelhitch-harness');
}

export interface SnapshotEntry {
  /** Workspace-relative path, forward slashes. */
  path: string;
  /** False when the path did not exist before the run, so undo deletes it. */
  existed: boolean;
  bytes: number;
  /** Blob file name under `<run>/files`, when bytes were captured. */
  blob?: string;
  /** Why this entry is incomplete, if it is. */
  note?: string;
}

export interface SnapshotManifest {
  runId: string;
  workspaceDir: string;
  createdAt: string;
  entries: SnapshotEntry[];
  /** Run-level caveats: what this snapshot does NOT cover. */
  notes: string[];
}

export interface Snapshotter {
  readonly runId: string;
  readonly dir: string;
  /** Number of paths captured so far. */
  readonly captured: number;
  /** Copy a path's current bytes aside. Safe to call repeatedly; the first wins. */
  capture(absPath: string, note?: string): void;
  /** Record a caveat without capturing anything. */
  note(text: string): void;
  /** Write the manifest. Returns its path, or null when nothing was recorded. */
  finish(): string | null;
}

function toRelative(workspaceDir: string, absPath: string): string {
  return relative(workspaceDir, absPath).split('\\').join('/');
}

export function createSnapshotter(options: {
  workspaceDir: string;
  runId: string;
  root?: string;
}): Snapshotter {
  const workspaceDir = resolve(options.workspaceDir);
  const root = options.root ?? snapshotRoot();
  const dir = join(root, options.runId);
  const entries = new Map<string, SnapshotEntry>();
  const notes: string[] = [];
  let started = false;

  const ensureDir = (): void => {
    if (started) return;
    mkdirSync(join(dir, 'files'), { recursive: true });
    started = true;
  };

  return {
    runId: options.runId,
    dir,
    get captured(): number {
      return entries.size;
    },
    capture(absPath: string, note?: string): void {
      const key = toRelative(workspaceDir, absPath);
      // First capture wins: the point is the state before the run, not before
      // the most recent tool call.
      if (entries.has(key)) return;
      try {
        if (!existsSync(absPath)) {
          entries.set(key, { path: key, existed: false, bytes: 0, ...(note ? { note } : {}) });
          ensureDir();
          return;
        }
        const size = statSync(absPath).size;
        ensureDir();
        const blob = `${String(entries.size + 1).padStart(4, '0')}.bin`;
        copyFileSync(absPath, join(dir, 'files', blob));
        entries.set(key, {
          path: key,
          existed: true,
          bytes: size,
          blob,
          ...(note ? { note } : {}),
        });
      } catch (err) {
        // Recording the failure is the whole job here: the write goes ahead
        // either way, and undo will say this path is not covered.
        notes.push(
          `${key}: not captured (${err instanceof Error ? err.message : String(err)})`,
        );
        entries.set(key, {
          path: key,
          existed: false,
          bytes: 0,
          note: 'bytes were not captured; undo cannot restore this path',
        });
        ensureDir();
      }
    },
    note(text: string): void {
      if (!notes.includes(text)) notes.push(text);
      ensureDir();
    },
    finish(): string | null {
      if (!started) return null; // no mutating calls: no snapshot directory at all
      const manifest: SnapshotManifest = {
        runId: options.runId,
        workspaceDir,
        createdAt: new Date().toISOString(),
        entries: [...entries.values()],
        notes,
      };
      const path = join(dir, 'manifest.json');
      try {
        writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        writeFileSync(join(root, 'latest'), options.runId, 'utf8');
      } catch {
        return null;
      }
      return path;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reading back
 * ------------------------------------------------------------------ */

export function runIds(root: string = snapshotRoot()): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'manifest.json')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function latestRunId(root: string = snapshotRoot()): string | null {
  try {
    const pointer = readFileSync(join(root, 'latest'), 'utf8').trim();
    if (pointer !== '' && existsSync(join(root, pointer, 'manifest.json'))) return pointer;
  } catch {
    /* fall through to the directory scan */
  }
  const ids = runIds(root);
  return ids.length > 0 ? (ids[ids.length - 1] as string) : null;
}

/** Read a manifest, or explain why it cannot be read in one line. */
export function readManifest(runId: string, root: string = snapshotRoot()): SnapshotManifest {
  const path = join(root, runId, 'manifest.json');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    const known = runIds(root);
    throw new Error(
      known.length === 0
        ? `No snapshot found for run "${runId}" (nothing has been recorded under ${root}).`
        : `No snapshot found for run "${runId}" under ${root}. Known runs: ${known.join(', ')}.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Snapshot ${runId} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || typeof raw !== 'object' || !Array.isArray((raw as SnapshotManifest).entries)) {
    throw new Error(`Snapshot ${runId} has no usable manifest at ${path}.`);
  }
  const manifest = raw as SnapshotManifest;
  return { ...manifest, notes: Array.isArray(manifest.notes) ? manifest.notes : [] };
}

export interface UndoResult {
  runId: string;
  restored: string[];
  removed: string[];
  failures: Array<{ path: string; error: string }>;
  notes: string[];
}

/**
 * Restore a run's snapshot: put captured bytes back, delete files that did not
 * exist before, and report anything that would not cooperate. Paths outside the
 * recorded workspace are refused, so a tampered manifest cannot be used to
 * delete arbitrary files.
 */
export function undoRun(runId?: string, options: { root?: string } = {}): UndoResult {
  const root = options.root ?? snapshotRoot();
  const id = runId ?? latestRunId(root);
  if (id === null) {
    throw new Error(`No snapshot to undo (nothing recorded under ${root}).`);
  }
  const manifest = readManifest(id, root);
  const workspaceDir = resolve(manifest.workspaceDir);
  const result: UndoResult = {
    runId: id,
    restored: [],
    removed: [],
    failures: [],
    notes: manifest.notes,
  };

  // Reverse order: the last change to a path is undone first.
  for (const entry of [...manifest.entries].reverse()) {
    const abs = resolve(workspaceDir, entry.path);
    const rel = relative(workspaceDir, abs);
    if (rel.startsWith('..') || resolve(rel) === rel) {
      result.failures.push({ path: entry.path, error: 'outside the recorded workspace' });
      continue;
    }
    try {
      if (entry.existed && entry.blob) {
        mkdirSync(dirname(abs), { recursive: true });
        copyFileSync(join(root, id, 'files', entry.blob), abs);
        result.restored.push(entry.path);
      } else if (!entry.existed) {
        if (existsSync(abs)) {
          rmSync(abs, { force: true });
          result.removed.push(entry.path);
        }
      } else {
        result.failures.push({ path: entry.path, error: 'no captured bytes to restore' });
      }
    } catch (err) {
      result.failures.push({
        path: entry.path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/** One-line summary for the CLI, so `--undo` says what it did. */
export function describeUndo(result: UndoResult): string {
  const parts = [
    `undo ${result.runId}: restored ${result.restored.length}, removed ${result.removed.length}`,
  ];
  if (result.failures.length > 0) {
    parts.push(
      `${result.failures.length} could not be undone (${result.failures
        .map((f) => `${f.path}: ${f.error}`)
        .join('; ')})`,
    );
  }
  if (result.notes.length > 0) parts.push(`not covered: ${result.notes.join('; ')}`);
  return parts.join(' | ');
}

/** How many paths are named before a list is summarised instead. */
const UNDO_LIST_LIMIT = 8;

function pathList(paths: string[]): string {
  if (paths.length <= UNDO_LIST_LIMIT) return paths.join(', ');
  return `${paths.slice(0, UNDO_LIST_LIMIT).join(', ')} +${paths.length - UNDO_LIST_LIMIT} more`;
}

/**
 * The same result, as lines a UI can lay out.
 *
 * `describeUndo` joins everything with `|`, which is right for a log line and
 * wrong for a panel: a run with three shell calls produces three near-identical
 * caveats, and repeating each one in full buries the two numbers that matter.
 * Caveats are grouped by their subject and counted instead.
 */
export function summarizeUndo(result: UndoResult): string[] {
  const lines: string[] = [
    `restored ${result.restored.length} file${result.restored.length === 1 ? '' : 's'}, ` +
      `removed ${result.removed.length} created file${result.removed.length === 1 ? '' : 's'}`,
  ];
  if (result.restored.length > 0) lines.push(`restored: ${pathList(result.restored)}`);
  if (result.removed.length > 0) lines.push(`removed: ${pathList(result.removed)}`);
  for (const failure of result.failures) lines.push(`could not undo ${failure.path}: ${failure.error}`);

  const groups = new Map<string, number>();
  for (const note of result.notes) {
    // A per-call caveat ends in its own `(command: …)`; the subject is the part
    // before it, and that is what repeats.
    const subject = note.replace(/\s*\([^()]*\)\s*$/, '').trim();
    groups.set(subject, (groups.get(subject) ?? 0) + 1);
  }
  for (const [subject, count] of groups) {
    lines.push(`not covered — ${subject}${count > 1 ? ` (${count}×)` : ''}`);
  }
  return lines;
}
