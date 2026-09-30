/**
 * Writing a small JSON document so a reader never sees half of one.
 *
 * Two places in the harness now persist a document the user owns: the config
 * that `setup` writes, and the approval rules a run accumulates. Both need the
 * same property — a crash mid-write must leave the previous file intact rather
 * than a truncated one — and the same permissions, because both can hold
 * something worth keeping to the user's account.
 *
 * Temp file in the same directory, then rename. The rename is atomic on POSIX
 * and on Windows (`MoveFileEx` with replace), which is the whole trick; the temp
 * file must be in the *same* directory or the rename crosses a filesystem
 * boundary and stops being atomic.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  /** POSIX mode for the new file. Ignored on Windows, where it is not a thing. */
  mode?: number;
  /** Indent for the JSON. `0` writes it compact. */
  indent?: number;
}

/**
 * Write `value` as JSON, atomically.
 *
 * Throws on failure after cleaning up its own temp file, so a caller can report
 * a real reason rather than leaving a `.tmp` behind to be found later.
 */
export function writeJsonAtomic(path: string, value: unknown, options: AtomicWriteOptions = {}): void {
  const indent = options.indent ?? 2;
  const text = `${JSON.stringify(value, null, indent)}\n`;
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  // Same directory, and unique per process: two runs writing at once must not
  // share one temp path and rename each other's half-written file into place.
  const temp = join(dir, `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tmp`);
  try {
    writeFileSync(temp, text, { encoding: 'utf8', ...(options.mode !== undefined ? { mode: options.mode } : {}) });
    renameSync(temp, path);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* the temp file never landed, or the directory is unwritable anyway */
    }
    throw err;
  }
}
