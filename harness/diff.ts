/**
 * A small unified diff, with no dependency behind it.
 *
 * Two callers need one: the approval gate shows what a `write`/`edit` would
 * change before the human says yes, and the snapshot/undo path reports what a
 * rollback restores. `git diff` would be a subprocess per prompt, and the
 * package's two real dependencies are not diff libraries.
 *
 * The algorithm is plain LCS over lines with the common prefix and suffix
 * trimmed first, which is what keeps a one-line edit inside a 3000-line file
 * cheap: the DP table only ever covers the region that actually differs.
 */

export interface DiffOptions {
  /** Workspace-relative path, used for the `---`/`+++` headers. */
  path?: string;
  /** Unchanged lines kept around each change. Defaults to 3, like git. */
  context?: number;
  /** Upper bound on emitted lines. Defaults to 400. */
  maxLines?: number;
  /** Lines compared before the DP is abandoned for a coarse summary. Defaults to 1_200. */
  maxMiddleLines?: number;
}

type Op = { kind: ' ' | '-' | '+'; line: string };

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline is a terminator, not an extra empty line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Longest common subsequence of two line arrays, as a flat op list. */
function diffMiddle(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] as string });
      i++;
      j++;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      ops.push({ kind: '-', line: a[i] as string });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] as string });
  while (j < m) ops.push({ kind: '+', line: b[j++] as string });
  return ops;
}

function renderOps(ops: Op[], context: number): string[] {
  const out: string[] = [];
  // A hunk is just a window of ops around a change; building the change indexes
  // first and merging windows keeps the `@@` headers honest.
  const changed: number[] = [];
  for (let i = 0; i < ops.length; i++) if ((ops[i] as Op).kind !== ' ') changed.push(i);
  if (changed.length === 0) return out;

  const windows: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = windows[windows.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else windows.push([start, end]);
  }

  // `ops` covers both files from line 1, so the counters start there and the
  // skip loop below carries them forward to the first hunk.
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const [start, end] of windows) {
    while (cursor < start) {
      const op = ops[cursor++] as Op;
      if (op.kind !== '+') oldLine++;
      if (op.kind !== '-') newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    for (let i = start; i <= end; i++) {
      const op = ops[i] as Op;
      if (op.kind !== '+') oldCount++;
      if (op.kind !== '-') newCount++;
    }
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`);
    for (let i = start; i <= end; i++) {
      const op = ops[i] as Op;
      out.push(`${op.kind}${op.line}`);
    }
    oldLine += oldCount;
    newLine += newCount;
    cursor = end + 1;
  }
  return out;
}

/**
 * Render `before` -> `after` as a unified diff. Returns an empty string when the
 * two are identical, so callers can treat "no output" as "no change".
 */
export function unifiedDiff(before: string, after: string, options: DiffOptions = {}): string {
  if (before === after) return '';

  const context = options.context ?? 3;
  const maxLines = options.maxLines ?? 400;
  const maxMiddle = options.maxMiddleLines ?? 1_200;
  const a = splitLines(before);
  const b = splitLines(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const middleA = a.slice(head, a.length - tail);
  const middleB = b.slice(head, b.length - tail);

  const header: string[] = [];
  const label = options.path;
  header.push(`--- ${before === '' ? '/dev/null' : label ? `a/${label}` : 'before'}`);
  header.push(`+++ ${after === '' ? '/dev/null' : label ? `b/${label}` : 'after'}`);

  if (middleA.length > maxMiddle || middleB.length > maxMiddle) {
    // Too large to diff honestly in a prompt. Say so instead of emitting a
    // meaningless wall of +/- lines.
    return [
      ...header,
      `[diff skipped: ${a.length} lines -> ${b.length} lines, too large to compare]`,
    ].join('\n');
  }

  const ops: Op[] = [
    ...a.slice(0, head).map((line): Op => ({ kind: ' ', line })),
    ...diffMiddle(middleA, middleB),
    ...a.slice(a.length - tail).map((line): Op => ({ kind: ' ', line })),
  ];

  const body = renderOps(ops, context);
  if (body.length === 0) return '';
  if (body.length > maxLines) {
    return [...header, ...body.slice(0, maxLines), `… (diff truncated at ${maxLines} lines)`].join('\n');
  }
  return [...header, ...body].join('\n');
}

/**
 * True when the preview should not be a diff at all. Approval shows a marker
 * instead: a binary blob or a huge file has no useful line diff, and reading
 * either into the prompt is worse than saying what it is.
 */
export const DIFF_MAX_BYTES = 1_000_000;
