/**
 * Presentation primitives shared by the TUI and the plaintext CLI.
 *
 * Everything here is pure and dependency-free on purpose: the TUI renders on
 * top of these helpers, the plaintext renderer prints them, and the tests
 * exercise them without a terminal, a model, or a renderer.
 */

/** Terminal column width of a string, counting East Asian wide glyphs as two. */
export function strWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x200d || (code >= 0x0300 && code <= 0x036f)) continue; // zero-width joiner, combining marks
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff)
  );
}

/** Clip a single line to `columns`, marking the cut with an ellipsis. */
export function clip(text: string, columns: number): string {
  if (columns <= 0) return '';
  if (strWidth(text) <= columns) return text;
  if (columns === 1) return '…';
  let out = '';
  let width = 0;
  for (const char of text) {
    const w = strWidth(char);
    if (width + w > columns - 1) break;
    out += char;
    width += w;
  }
  return `${out}…`;
}

/** Clip from the right, i.e. keep the tail of the string. */
export function clipEnd(text: string, columns: number, lead = '…'): string {
  if (columns <= 0) return '';
  if (strWidth(text) <= columns) return text;
  let out = '';
  let width = 0;
  for (const char of [...text].reverse()) {
    const w = strWidth(char);
    if (width + w > columns - strWidth(lead)) break;
    out = char + out;
    width += w;
  }
  return `${lead}${out}`;
}

/**
 * Clip in the middle: the head and tail of a long tool result are the parts
 * worth keeping (a command echoes, a match list ends with a count).
 */
export function headTail(text: string, lines: number): { text: string; dropped: number } {
  const all = text.split('\n');
  if (all.length <= lines) return { text, dropped: 0 };
  const head = Math.ceil((lines - 1) / 2);
  const tail = lines - 1 - head;
  const kept = [
    ...all.slice(0, head),
    `… ${all.length - lines} lines omitted …`,
    ...(tail > 0 ? all.slice(all.length - tail) : []),
  ];
  return { text: kept.join('\n'), dropped: all.length - lines };
}

/** `1234` -> `1.2k`, `12_400` -> `12.4k`, `2_400_000` -> `2.4M`. */
export function formatCount(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n < 1000) return String(n);
  const scaled = (divisor: number, suffix: string): string => {
    const raw = n / divisor;
    // One decimal while the number is still small enough for it to mean
    // something; a whole number otherwise, so `42k` does not read as `42.0k`.
    const rounded = raw >= 100 ? Math.round(raw) : Math.round(raw * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}${suffix}`;
  };
  return n < 1_000_000 ? scaled(1000, 'k') : scaled(1_000_000, 'M');
}

/** `820` -> `820ms`, `4200` -> `4.2s`, `125000` -> `2m05s`. */
export function formatDuration(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** Elapsed clock for the status bar: `0:04`, `1:02:30`. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}

/** Workspace-relative path with forward slashes, when it is inside the workspace. */
export function displayPath(absolute: string, workspaceDir?: string): string {
  const normalized = absolute.replace(/\\/g, '/');
  if (!workspaceDir) return normalized;
  const root = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized === root) return '.';
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

const DIFF_FILE = /^(---|\+\+\+)\s/;
const DIFF_HUNK = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;

/**
 * Whether a tool result is a unified diff, so the UI can colour it per line.
 * `unifiedDiff` in `diff.ts` emits `--- a/<path>` / `+++ b/<path>` / `@@` hunk
 * headers, and nothing else in the harness produces that shape by accident.
 */
export function looksLikeDiff(text: string): boolean {
  const lines = text.split('\n', 40);
  let hasFile = false;
  let hasHunk = false;
  for (const line of lines) {
    if (DIFF_FILE.test(line)) hasFile = true;
    else if (DIFF_HUNK.test(line)) hasHunk = true;
  }
  return hasFile && hasHunk;
}

export interface DiffStat {
  added: number;
  removed: number;
}

/**
 * Trim a unified diff to a line budget without breaking its grammar.
 *
 * A hunk header declares how many added and removed lines follow it, so cutting
 * a diff the way a log is cut (`headTail`) produces something a diff viewer
 * rejects outright — OpenTUI's `DiffRenderable` renders "Error parsing diff"
 * instead of the change. The only safe cut is between hunks, so whole trailing
 * hunks are dropped and the caller is told how many were kept.
 */
export interface DiffWindow {
  /** A diff that still parses: the file headers plus whole hunks. */
  text: string;
  /** Hunks kept, and how many the original had. */
  kept: number;
  total: number;
  /** True when not even one hunk fits, so no valid short form exists. */
  tooLarge: boolean;
}

export function diffWindow(diff: string, budget: number): DiffWindow {
  const header: string[] = [];
  const hunks: string[][] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) hunks.push([line]);
    else if (hunks.length === 0) header.push(line);
    else (hunks[hunks.length - 1] as string[]).push(line);
  }
  if (hunks.length === 0) return { text: diff, kept: 0, total: 0, tooLarge: false };

  const kept: string[][] = [];
  let used = header.length;
  for (const hunk of hunks) {
    if (used + hunk.length > budget) break;
    kept.push(hunk);
    used += hunk.length;
  }
  if (kept.length === 0) return { text: diff, kept: 0, total: hunks.length, tooLarge: true };
  return {
    text: [...header, ...kept.flat()].join('\n'),
    kept: kept.length,
    total: hunks.length,
    tooLarge: false,
  };
}

/** Count `+`/`-` body lines in a unified diff, ignoring the `+++`/`---` headers. */
export function diffStat(text: string): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** A compact `+12 -3` badge, or an empty string when the diff is empty. */
export function formatDiffStat(stat: DiffStat): string {
  const parts: string[] = [];
  if (stat.added > 0) parts.push(`+${stat.added}`);
  if (stat.removed > 0) parts.push(`-${stat.removed}`);
  return parts.join(' ');
}

/**
 * One-line argument summary for a tool call header.
 *
 * A transcript that prints the whole JSON blob for every call is unreadable, and
 * a transcript that prints only the tool name hides what the agent is doing. The
 * interesting field per tool is stable, so name it.
 */
export function toolArgsSummary(name: string, args: Record<string, unknown>): string {
  const text = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' && value.trim() !== '' ? value.replace(/\s+/g, ' ').trim() : undefined;
  };
  const number = (key: string): number | undefined => {
    const value = args[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };

  switch (name) {
    case 'read':
    case 'read_file':
    case 'view_file': {
      const path = text('path') ?? text('file') ?? '(no path)';
      const offset = number('offset');
      const limit = number('limit');
      const range = offset !== undefined || limit !== undefined
        ? `:${offset ?? 1}${limit !== undefined ? `+${limit}` : ''}`
        : '';
      return `${path}${range}`;
    }
    case 'write':
    case 'write_file': {
      const path = text('path') ?? '(no path)';
      // Count from the raw content: `text()` flattens whitespace for display,
      // which would collapse a whole file into one apparent line.
      const raw = args['content'];
      if (typeof raw !== 'string') return path;
      const lines = raw.split('\n').length;
      return `${path}  ${lines} line${lines === 1 ? '' : 's'}`;
    }
    case 'edit':
    case 'replace_file_content':
      return text('path') ?? '(no path)';
    case 'bash':
    case 'run_command':
      return text('command') ?? '(no command)';
    case 'grep_search':
    case 'grep': {
      const pattern = text('pattern') ?? text('query') ?? '(no pattern)';
      const path = text('path');
      const glob = text('glob') ?? text('include');
      return [pattern, path === undefined ? undefined : `in ${path}`, glob === undefined ? undefined : `(${glob})`]
        .filter((part): part is string => part !== undefined)
        .join(' ');
    }
    case 'list_files':
      return text('path') ?? '.';
    case 'gh': {
      const raw = Array.isArray(args['args']) ? (args['args'] as unknown[]) : [];
      return `gh ${raw.filter((token): token is string => typeof token === 'string').join(' ')}`.trim();
    }
    case 'subagent':
    case 'manage_task': {
      const agent = text('agent') ?? text('name') ?? '(agent)';
      const task = text('task') ?? text('prompt');
      return task === undefined ? agent : `${agent} — ${clip(task, 96)}`;
    }
    case 'opencode':
      return text('message') ?? text('model') ?? '';
    case 'agy':
      return text('prompt') ?? '';
    default: {
      const entries = Object.entries(args);
      if (entries.length === 0) return '';
      return clip(
        entries
          .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'}`)
          .join(' '),
        120,
      );
    }
  }
}

/** `'read'` -> `'Read'`, `'grep_search'` -> `'Grep search'`. */
export function toolLabel(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim().split(/\s+/);
  return words.map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word)).join(' ');
}
