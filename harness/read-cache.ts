import { realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * The per-run read cache.
 *
 * A model that re-reads a file to check something pays for the whole body again
 * even when nothing has changed since the first read, and those bytes stay in
 * the context window for the rest of the run. So a repeat read of an unchanged
 * file is answered with one line naming the read that supplied it:
 *
 *   src/app.ts unchanged since turn 2 (412 bytes)
 *
 * The body is kept, because the notice has to be able to say whether the copy
 * the model already holds is the whole file or a digest of it.
 *
 * What it is keyed on, and when it is dropped:
 *
 *   - the resolved *real* path, so two symlinks to one file collapse into one
 *     entry instead of being paid for twice;
 *   - dropped wholesale before any mutating call runs, because `bash` can write
 *     anything and a per-path guess about what it touched is not worth making;
 *   - re-checked against `stat` on every read, so a file changed by something
 *     outside the harness is never served stale.
 *
 * Scope: one run, in memory, never written to the session or the snapshot
 * directory. Nothing here is a module-level singleton — `index.ts` calls
 * `createReadCache()` once per run and hands the instance to the tool executor,
 * so a new run starts empty and two runs cannot read each other's entries. A
 * caller that passes no cache gets the behaviour that existed before this: every
 * read goes to disk.
 *
 * Only `read` uses this, and deliberately so. `grep_search` is not cacheable the
 * same way — its answer depends on every file under a directory, so one path key
 * cannot speak for it — and the remaining tools either spawn a process or mutate
 * the workspace, which a cache of file bodies cannot describe. A later reader
 * should not assume this is a general tool cache.
 */

/**
 * Entries one run may hold.
 *
 * Every entry holds a whole body, and a long run can read hundreds of files.
 * Past this the oldest entry goes: a file the run still cares about has usually
 * been read recently, so what is lost is one extra read for a file read long
 * ago, against a map that would otherwise grow with everything ever touched.
 */
export const MAX_READ_CACHE_ENTRIES = 256;

/**
 * The marker `summarize.ts` writes into a body it replaced with head/digest/tail.
 * Matched rather than imported: this module only has to recognise the line, and
 * importing the label format would tie the two together for no gain.
 */
const SUMMARIZED_MARKER = /\[summarized: \d+ chars -> \d+\]/;

export interface ReadCacheEntry {
  /** The path as the model wrote it on the read that filled this entry. */
  label: string;
  /** The file's byte length when it was read, as `stat` reported it. */
  size: number;
  /** The file's modification time when it was read. */
  mtimeMs: number;
  /** The text the model was served for that read, which may be summarized. */
  body: string;
  /** The turn that supplied the read, when the caller knew which turn it was. */
  turn?: number;
}

export interface ReadCacheRequest {
  /** The path as the model wrote it, used only in the notice. */
  label: string;
  /** The turn holding this call, when the caller knows it. */
  turn?: number;
  /** Performs the read. Called only when the cache cannot answer. */
  load: () => Promise<string>;
}

export interface ReadCache {
  /**
   * The text to serve for a read of `file`: the body, or a notice naming the
   * earlier read that already supplied it.
   */
  read(file: string, request: ReadCacheRequest): Promise<string>;
  /** Record the text the model was served, when it differs from the tool's own. */
  recordServed(file: string, served: string): void;
  /** Drop every entry. The executor calls this before a mutating call runs. */
  invalidate(): void;
  /** Entries held, for a caller that wants to report or test it. */
  readonly size: number;
}

/**
 * The cache key for a file: its resolved real path.
 *
 * Two symlinks to one file, or two spellings of one path, have to collapse into
 * one entry, or the model pays twice for the same bytes by naming them
 * differently. `realpathSync` is the only thing that answers that, and it throws
 * for a path that does not exist, so the resolved path is the fallback: the key
 * still has to be stable, and freshness is re-checked before anything is served.
 * This never throws.
 */
export function readCacheKey(file: string): string {
  const resolved = resolve(file);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * The line a repeat read is answered with.
 *
 * The turn is named only when the read that filled the entry knew it. Printing
 * the current turn instead would point the model at a turn that may not hold the
 * read at all, which is worse than naming no turn.
 */
export function readCacheNotice(entry: ReadCacheEntry): string {
  const since =
    entry.turn === undefined
      ? 'unchanged since an earlier read in this run'
      : `unchanged since turn ${entry.turn}`;
  const marker = SUMMARIZED_MARKER.exec(entry.body)?.[0];
  // A body the model never saw whole has to keep saying so: without the marker
  // the notice reads as "you already have this file", when what the model holds
  // is a digest of it.
  return `${entry.label} ${since} (${entry.size} bytes)${marker === undefined ? '' : ` ${marker}`}`;
}

export function createReadCache(): ReadCache {
  const entries = new Map<string, ReadCacheEntry>();
  /**
   * Reads in flight, so two identical read calls in one batch cost one read.
   * The second waits for the first and is then answered from the entry it
   * stored, which is the point of keying this map the same way as the entries.
   */
  const inFlight = new Map<string, Promise<string>>();

  const remember = (key: string, entry: ReadCacheEntry): void => {
    if (entries.size >= MAX_READ_CACHE_ENTRIES && !entries.has(key)) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
    entries.set(key, entry);
  };

  /**
   * The stored entry for `key`, but only while the file still matches it.
   *
   * Anything else — a different size, a different mtime, a file that is gone or
   * unreadable — drops the entry and reports a miss, so the caller reads the
   * file and surfaces whatever the ordinary read says about it.
   */
  const unchanged = async (key: string, file: string): Promise<ReadCacheEntry | undefined> => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    try {
      const info = await stat(file);
      if (info.size === entry.size && info.mtimeMs === entry.mtimeMs) return entry;
    } catch {
      /* deleted or unreadable: nothing here can be served */
    }
    entries.delete(key);
    return undefined;
  };

  /** One call's answer: the notice, or the body the caller's `load` produced. */
  const serve = async (key: string, file: string, request: ReadCacheRequest): Promise<string> => {
    const hit = await unchanged(key, file);
    if (hit !== undefined) return readCacheNotice(hit);
    // Measured before the read so a file that disappears mid-read still reports
    // its own error rather than failing here on a missing stat.
    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(file);
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      // No measurement means nothing to key an entry on. The read below reports
      // the ordinary error for a file that cannot be stat'd.
      return await request.load();
    }
    const body = await request.load();
    remember(key, {
      label: request.label,
      size,
      mtimeMs,
      body,
      ...(request.turn === undefined ? {} : { turn: request.turn }),
    });
    return body;
  };

  return {
    async read(file: string, request: ReadCacheRequest): Promise<string> {
      const key = readCacheKey(file);
      for (;;) {
        const running = inFlight.get(key);
        if (running !== undefined) {
          // A read of this file is already running. Waiting for it and deciding
          // again is what keeps a second identical call in the same batch from
          // racing the first to the disk; its failure is swallowed here because
          // the retry below reports the real error on its own.
          await running.catch(() => undefined);
          continue;
        }
        const promise = serve(key, file, request);
        inFlight.set(key, promise);
        try {
          return await promise;
        } finally {
          inFlight.delete(key);
        }
      }
    },

    recordServed(file: string, served: string): void {
      const entry = entries.get(readCacheKey(file));
      if (entry === undefined) return;
      // A notice is not a body. A caller that records unconditionally — which is
      // the natural way to call this — would otherwise replace the body it is
      // describing with the notice itself.
      if (served === readCacheNotice(entry)) return;
      entry.body = served;
    },

    invalidate(): void {
      entries.clear();
    },

    get size(): number {
      return entries.size;
    },
  };
}
