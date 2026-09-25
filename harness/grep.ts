import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * A read-only workspace search.
 *
 * This exists because `grep_search` is by far the most commonly declared tool in
 * the agency agent library (49 of 57 agents). Without a real implementation the
 * only way to satisfy those declarations would be to hand out a shell, which
 * would grant 49 read-only agents the ability to modify the workspace — shell
 * access is write access. A native search keeps the `readonly` tier honest.
 */

/** Directories that are never worth walking in a source search. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'vendor',
]);

/** Files larger than this are skipped: they are almost never source. */
const MAX_FILE_BYTES = 1_000_000;

/** Bytes inspected when deciding whether a file is binary. */
const SNIFF_BYTES = 8_000;

export interface GrepOptions {
  /** Pattern to search for. Treated literally unless `regex` is true. */
  pattern: string;
  /** Directory to search, absolute or resolved against the workspace. */
  dir: string;
  /** Only search these extensions, with or without a leading dot. */
  include?: string[];
  /** Stop after this many matches. Defaults to 50. */
  maxResults?: number;
  /** Case-sensitive match. Defaults to false. */
  caseSensitive?: boolean;
  /** Treat the pattern as a regular expression. Defaults to false. */
  regex?: boolean;
  /** Stop after scanning this many files. Defaults to 2000. */
  maxFiles?: number;
}

export interface GrepMatch {
  /** Path relative to the searched directory, with forward slashes. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The matching line, trimmed and length-capped. */
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  /** True when a cap (results or files) stopped the search early. */
  truncated: boolean;
  filesScanned: number;
  filesSkippedBinary: number;
  /** Set when the search could not run at all, e.g. a bad pattern. */
  error?: string;
}

/** Lines are capped so one minified line cannot flood the context. */
const MAX_LINE_CHARS = 400;

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isProbablyBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, SNIFF_BYTES).includes(0);
}

/** `1 file` / `2 files`, so counts never read as "1 file(s)". */
function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

function normaliseExtensions(include?: string[]): Set<string> | null {
  if (!include || include.length === 0) return null;
  return new Set(
    include.map((ext) => {
      const trimmed = ext.trim().toLowerCase();
      return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    }),
  );
}

function matchesExtension(fileName: string, extensions: Set<string> | null): boolean {
  if (!extensions) return true;
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 && extensions.has(fileName.slice(dot).toLowerCase());
}

/**
 * Search a directory tree for a pattern. Pure filesystem work: no process
 * spawning, nothing mutating, no network.
 */
export function grepWorkspace(options: GrepOptions): GrepResult {
  const empty: GrepResult = { matches: [], truncated: false, filesScanned: 0, filesSkippedBinary: 0 };

  const pattern = options.pattern ?? '';
  if (pattern.length === 0) {
    return { ...empty, error: 'grep_search needs a non-empty pattern.' };
  }

  const maxResults = options.maxResults ?? 50;
  const maxFiles = options.maxFiles ?? 2000;
  const extensions = normaliseExtensions(options.include);

  let matcher: RegExp;
  try {
    const source = options.regex ? pattern : escapeLiteral(pattern);
    matcher = new RegExp(source, options.caseSensitive ? '' : 'i');
  } catch (err) {
    return { ...empty, error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}` };
  }

  const root = resolve(options.dir);
  try {
    if (!statSync(root).isDirectory()) {
      return { ...empty, error: `Not a directory: ${options.dir}` };
    }
  } catch {
    return { ...empty, error: `Directory not found: ${options.dir}` };
  }

  const matches: GrepMatch[] = [];
  let filesScanned = 0;
  let filesSkippedBinary = 0;
  let truncated = false;

  // Iterative walk: a deep tree should not risk a stack overflow.
  const queue: string[] = [root];
  while (queue.length > 0) {
    if (filesScanned >= maxFiles || matches.length >= maxResults) {
      truncated = true;
      break;
    }
    const current = queue.shift() as string;

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than abort the search
    }

    for (const entry of entries) {
      if (filesScanned >= maxFiles || matches.length >= maxResults) {
        truncated = true;
        break;
      }
      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!matchesExtension(entry.name, extensions)) continue;

      let buffer: Buffer;
      try {
        const stat = statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        buffer = readFileSync(full);
      } catch {
        continue;
      }
      filesScanned++;
      if (isProbablyBinary(buffer)) {
        filesSkippedBinary++;
        continue;
      }

      const lines = buffer.toString('utf8').split('\n');
      const file = relative(root, full).split('\\').join('/');
      for (let i = 0; i < lines.length; i++) {
        if (!matcher.test(lines[i] as string)) continue;
        const text = (lines[i] as string).trim();
        matches.push({
          file,
          line: i + 1,
          text: text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text,
        });
        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    }
  }

  return { matches, truncated, filesScanned, filesSkippedBinary };
}

/** Render a result as compact text for a model to read. */
export function formatGrepResult(result: GrepResult, pattern: string): string {
  if (result.error) return `Error: ${result.error}`;
  if (result.matches.length === 0) {
    return `No matches for "${pattern}" (scanned ${result.filesScanned} ${plural(result.filesScanned, 'file')}).`;
  }
  const lines = result.matches.map((m) => `${m.file}:${m.line}: ${m.text}`);
  // "1 match(es) ... in 2 file(s)" reads as though one match exists across two
  // files. State the match count first and label the second number as files
  // *scanned*, which is what it is. (A subagent flagged the old wording.)
  const header =
    `${result.matches.length} ${plural(result.matches.length, 'match', 'matches')} for "${pattern}" ` +
    `(scanned ${result.filesScanned} ${plural(result.filesScanned, 'file')}):`;
  const footer = result.truncated ? '\n(results truncated — narrow the pattern or pass include/maxResults)' : '';
  return `${header}\n${lines.join('\n')}${footer}`;
}

/**
 * The tool shape bihan calls. bihan only ever uses `name` (for its registry and
 * for `toModelHitch()`), `toModelHitch()`, and `run()`, so this is supplied as a
 * duck-typed object rather than a bihan `Tool`. That avoids pulling zod into
 * this package purely for one tool, and avoids binding to bihan's zod version.
 */
export interface DuckTool {
  name: string;
  description: string;
  toModelHitch(): { name: string; description: string; parameters: Record<string, unknown> };
  run(rawArgs: unknown, context?: unknown): Promise<string>;
}

export const GREP_TOOL_NAME = 'grep_search';

export const GREP_DESCRIPTION =
  'Search file contents across the workspace and return matching lines as path:line: text. ' +
  'Read-only. Skips node_modules, .git, dist, build and other generated directories.';

export function createGrepTool(workspaceDir: string): DuckTool {
  const parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Text to search for. Literal unless regex is true.' },
      path: { type: 'string', description: 'Directory to search, relative to the workspace. Defaults to ".".' },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Limit to these file extensions, e.g. ["ts","tsx"].',
      },
      maxResults: { type: 'integer', description: 'Maximum matches to return. Defaults to 50.' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive match. Defaults to false.' },
      regex: { type: 'boolean', description: 'Treat pattern as a regular expression. Defaults to false.' },
    },
    required: ['pattern'],
  };

  return {
    name: GREP_TOOL_NAME,
    description: GREP_DESCRIPTION,
    toModelHitch: () => ({ name: GREP_TOOL_NAME, description: GREP_DESCRIPTION, parameters }),
    async run(rawArgs: unknown): Promise<string> {
      let args: Record<string, unknown> = {};
      try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : ((rawArgs ?? {}) as Record<string, unknown>);
      } catch (err) {
        return `Error: could not parse grep arguments: ${err instanceof Error ? err.message : String(err)}`;
      }

      const pattern = typeof args['pattern'] === 'string' ? (args['pattern'] as string) : '';
      const sub = typeof args['path'] === 'string' ? (args['path'] as string) : '.';
      const result = grepWorkspace({
        pattern,
        dir: resolve(workspaceDir, sub),
        include: Array.isArray(args['include']) ? (args['include'] as string[]) : undefined,
        maxResults: typeof args['maxResults'] === 'number' ? (args['maxResults'] as number) : undefined,
        caseSensitive: args['caseSensitive'] === true,
        regex: args['regex'] === true,
      });
      return formatGrepResult(result, pattern);
    },
  };
}
