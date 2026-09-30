import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { defaultEmbeddingCacheDir, type EmbedFn } from './agent-library.js';
import { clip, formatCount } from './format.js';

/**
 * Re-exported because `pickContextFiles` takes one and `agent-library.ts` owns
 * the definition: a caller wiring the picker should not have to import the agent
 * library to name the parameter it is passing. `subagents.ts` re-exports
 * `SubagentToolTier` the same way.
 */
export type { EmbedFn };

/**
 * Workspace semantic context picker.
 *
 * A model handed a task and a repository spends its first turns guessing which
 * files matter, and the guess is driven by names. This module ranks the
 * workspace against the task before the first turn and hands back the handful of
 * files worth opening, so the first read starts from evidence instead of a
 * directory listing.
 *
 * The shape follows `grep.ts` and `detect-workspace.ts`: pure exported
 * functions, `node:` builtins only, an injectable `AbortSignal`, documented
 * caps, and no failure that can reach the caller as an exception. The semantic
 * half follows `agent-library.ts`'s search: an injected `EmbedFn`, a blended
 * score, a JSON vector cache keyed by embedder identity, and a lexical path that
 * always works without either.
 *
 * `detect-workspace.ts` walks the same trees with the same guarantees, but it
 * exports neither its walker nor its skip set, and its walk opens no file at
 * all. The walker here is written locally rather than borrowed: it reads a
 * bounded head from every candidate, and that one read is the embedder's input,
 * the binary test and the head window the section prints, so the three views of
 * a file cannot disagree. That is more work per file than the workspace scan
 * does, which is why the budget below is larger than `WORKSPACE_BUDGET_MS`.
 */

/** Files the section offers by default. */
export const DEFAULT_CONTEXT_FILES = 5;

/**
 * Levels below the root that are walked.
 *
 * A horizon rather than a cap: the files that answer a task sit near the root in
 * every layout this harness sees, and the deepest leaves of a monorepo cannot
 * change which files the task is about. Files below it go unranked without
 * marking the listing a sample, the way `detect-workspace.ts` treats its own
 * depth horizon.
 */
export const CONTEXT_MAX_DEPTH = 4;

/**
 * Candidates visited before the walk is treated as good enough.
 *
 * The cap is what keeps the worst case bounded when someone points the harness
 * at a home directory. It also cuts the ranking sample, so hitting it is
 * reported rather than hidden: the counts and the picks below it are a lower
 * bound on what the workspace holds.
 */
export const CONTEXT_MAX_FILES = 800;

/**
 * Wall-clock budget for the walk, checked per entry.
 *
 * This runs before the first token of a run, so it is a startup cost rather than
 * a tool cost. Half a second sits below the point where a run feels stuck and
 * well below one model round trip, and the reads below are the reason it is not
 * `WORKSPACE_BUDGET_MS`'s 150ms: that walk never opens a file.
 */
export const CONTEXT_BUDGET_MS = 500;

/**
 * Files larger than this are skipped.
 *
 * A context file is something the model will read, and a 256 KB source file is
 * already past what fits in a prompt whole. Generated bundles and data dumps are
 * far past it, and their paths say nothing about the task either.
 */
export const CONTEXT_MAX_FILE_BYTES = 256 * 1024;

/**
 * Bytes read from each candidate.
 *
 * The same window `grep.ts` sniffs for a null byte. Only the head is ever read,
 * so a large file the size check let through cannot make the walk pay for its
 * whole length, and the head window printed in the section is a prefix of
 * exactly the bytes the binary test and the embedder saw.
 */
export const CONTEXT_READ_BYTES = 8_000;

/**
 * Characters of a file's head fed to the embedder.
 *
 * Mirrors `agent-library.ts`'s body budget with a smaller number: a path plus
 * two thousand characters of the head is what identifies a source file, and the
 * opening of a module states what it owns while the rest is procedure. It is
 * also the cap that keeps one vendored file from dominating the batch.
 */
export const CONTEXT_EMBED_CHARS = 2_000;

/**
 * Candidates sent to the embedder in one batch.
 *
 * Embedding every file of a large repository on every start would cost more than
 * the ranking is worth, so the batch is taken from the files the lexical score
 * already liked best. The cost of that choice is real and is reported: a file
 * that shares no word with the task and ranks below this cut is not embedded, so
 * semantics can only promote what the path pass surfaced.
 */
export const CONTEXT_MAX_EMBED_FILES = 200;

/**
 * Wall-clock ceiling on one embedder answer.
 *
 * The embedder is injected, so its latency is the caller's business, but a
 * picker that waits forever has blocked startup past every budget in this file.
 * Expiry is treated exactly like a rejection: lexical picks and one warning.
 */
export const CONTEXT_EMBED_BUDGET_MS = 2_000;

/**
 * Semantic share of the blended score.
 *
 * The same weight `agent-library.ts` uses, for the same reason: the point of the
 * embedder is finding a file whose path shares no vocabulary with the task, so
 * it must be able to outrank an exact name hit, and the lexical share is what
 * separates files the embedder finds equally close.
 */
export const CONTEXT_SEMANTIC_WEIGHT = 0.8;

/** Characters of one file's head in the section. `--context-bytes` sets this. */
export const DEFAULT_CONTEXT_HEAD_BYTES = 0;

/**
 * Ceiling on one head window.
 *
 * Four thousand characters of one file is already most of a small module, and a
 * larger window stops being a hint and becomes a paste.
 */
export const CONTEXT_HEAD_MAX_BYTES = 4_000;

/**
 * Ceiling on all head windows in one section.
 *
 * Shared across the picks in rank order, so `--context-bytes 4000` on the
 * default five picks costs twelve thousand characters rather than twenty.
 */
export const CONTEXT_TOTAL_HEAD_BYTES = 12_000;

/** Columns one head line is clipped to, so a minified line cannot flood the prompt. */
export const CONTEXT_HEAD_COLUMNS = 120;

/**
 * Directories that hold dependencies, version control or build output.
 *
 * Kept separate from `detect-workspace.ts`'s set, which is not exported and
 * answers a different question: that one excludes extensions from a language
 * histogram, this one decides what may be offered as context.
 */
export const CONTEXT_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
]);

/**
 * Tokens that carry no signal on their own.
 *
 * Two kinds share the set. Path plumbing (`src`, `index`, `test`) appears in
 * most paths, so matching it says nothing about which file a task is about. The
 * English words are here because a task is a sentence: "add a note to the
 * router" should be ranked by `router`, not by `add`, `to` or `the`.
 */
const STOP_TOKENS: ReadonlySet<string> = new Set([
  'src', 'lib', 'libs', 'dist', 'build', 'out', 'bin', 'obj', 'test', 'tests', 'spec', 'specs',
  'index', 'main', 'app', 'apps', 'core', 'common', 'utils', 'util', 'helper', 'helpers', 'types',
  'type', 'docs', 'doc', 'public', 'assets', 'static', 'style', 'styles', 'css', 'html', 'scss',
  'json', 'yaml', 'yml', 'toml', 'config', 'configs', 'scripts', 'script', 'packages', 'package',
  'node', 'modules', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'md', 'map',
  'test', 'tmp', 'temp', 'resources', 'examples', 'example',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'not', 'are', 'was', 'its', 'use',
  'uses', 'using', 'add', 'added', 'make', 'makes', 'should', 'when', 'then', 'than', 'where',
  'which', 'file', 'files', 'code', 'change', 'changes', 'new', 'old', 'one', 'two', 'all', 'any',
]);

/** Weight of a path token equal to a task token. */
const EXACT_TOKEN_WEIGHT = 3;

/** Weight of a path token that is a prefix of a task token, or the reverse. */
const PREFIX_TOKEN_WEIGHT = 1;

/**
 * Shortest token allowed to score on a prefix rather than on equality.
 *
 * Three characters prefix-match almost anything ("api" against "application"),
 * so a partial hit needs four before it counts as evidence.
 */
const MIN_PREFIX_CHARS = 4;

/** Single characters carry no meaning in a path, and one-letter tasks are noise. */
const MIN_TOKEN_CHARS = 2;

export interface ContextFilePick {
  /** Path relative to the searched directory, with forward slashes. */
  path: string;
  /** One line saying why this file is here. */
  reason: string;
  /** Blended score, for a caller that wants to re-order or threshold the picks. */
  score: number;
  /** Head window, present only when `headBytes` asked for one. */
  head?: string;
}

/**
 * Why the listing may be less than everything the workspace holds.
 *
 * `walk` means a walk cap stopped the scan, `embed` means more files were walked
 * than the embedder was given, and both are reported in the section because a
 * model that believes it saw every file will stop looking.
 */
export type ContextSampleCause = 'none' | 'walk' | 'embed';

export interface ContextFiles {
  /** Ranked picks, best first. Empty when nothing could be ranked. */
  picks: ContextFilePick[];
  sampleCause: ContextSampleCause;
  /** Files visited by the walk, before any cap. */
  filesWalked: number;
  /** Candidates the embedder was consulted about, from cache or from a call. */
  embedded: number;
  /** True when the ranking used vectors rather than path tokens alone. */
  semantic: boolean;
  /** True when the walk was cancelled rather than finished. */
  aborted: boolean;
}

export interface ContextFilesDeps {
  /** Identity of the embedder, part of the cache key. Defaults to 'default'. */
  embedderId?: string;
  /** Where vectors are cached. Defaults to `defaultEmbeddingCacheDir()`. */
  cacheDir?: string;
  /** Called once with a warning when semantic ranking is unavailable or fails. */
  log?: (message: string) => void;
  /** Characters of a file's head embedded per candidate. Defaults to `CONTEXT_EMBED_CHARS`. */
  bodyChars?: number;
}

export interface PickContextFilesInput {
  /** Directory to rank. A missing or unreadable one yields no picks. */
  dir: string;
  /** The task text. The query embedded and the text path tokens are matched against. */
  task: string;
  /**
   * Injected embedder. Absent, the ranking is lexical and the caller is told
   * once. Provider-neutral on purpose: this harness must not import a vendor SDK
   * or hard-code a model id.
   */
  embedder?: EmbedFn;
  /** How many files to offer. Defaults to `DEFAULT_CONTEXT_FILES`. */
  limit?: number;
  /** Characters of each pick's head to include. `0`, the default, includes none. */
  headBytes?: number;
  /** Override for the walk budget. Defaults to `CONTEXT_BUDGET_MS`. */
  budgetMs?: number;
  /**
   * Cancel the walk. A synchronous walk cannot be interrupted from outside
   * without a check inside the loop, so the flag is polled per entry, the same
   * way `grepWorkspace` and `detectWorkspace` poll it.
   */
  signal?: AbortSignal;
  deps?: ContextFilesDeps;
}

/* ------------------------------------------------------------------ *
 * Tokens
 * ------------------------------------------------------------------ */

const ACRONYM_BOUNDARY = /([A-Z]+)(?=[A-Z][a-z])/g;
const CAMEL_BOUNDARY = /([a-z0-9])(?=[A-Z])/g;

/**
 * Split one name into the words it is built from.
 *
 * `harness/replaceFileContent.ts` says "harness", "replace", "file", "content".
 * Two boundary rules cover the naming in use here: an acronym run followed by a
 * capitalised word (`XMLHttpRequest` -> xml, http, request) and a lower-case or
 * digit character followed by a capital (`sha256Digest` -> sha256, digest). A
 * run of digits stays attached to the word before it, because `base64` is one
 * word and `base` is not a useful half of it.
 */
function splitWords(name: string): string[] {
  return name
    .replace(ACRONYM_BOUNDARY, '$1 ')
    .replace(CAMEL_BOUNDARY, '$1 ')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= MIN_TOKEN_CHARS);
}

/**
 * Tokens of a relative path.
 *
 * Every segment contributes, with a trailing extension dropped, so a task that
 * says "library" reaches `harness/agent-library.ts` and a task that says
 * "agent" does too. The extension is not itself a token: `.ts` appears in most
 * of a TypeScript tree and would rank nothing.
 */
export function tokenizePath(relPath: string): string[] {
  const tokens: string[] = [];
  for (const segment of relPath.split('/')) {
    if (segment === '') continue;
    const withoutExtension = segment.replace(/\.[A-Za-z0-9]+$/, '');
    for (const token of splitWords(withoutExtension)) tokens.push(token);
  }
  return tokens;
}

/** Tokens of the task text, split by the same rules the path tokens use. */
export function tokenizeTask(task: string): string[] {
  return splitWords(task);
}

/**
 * Score a path's tokens against the task's tokens.
 *
 * Exact equality is worth three prefix hits: a file named `router.ts` is a
 * stronger answer to "fix the router" than one named `routes-helper.ts` is to
 * "routing", and the weights are small integers so the ordering stays obvious.
 * The matched token is returned alongside the score so the pick can say which
 * word found it, which is the only thing that makes a pick reviewable.
 */
export function pathLexicalScore(
  pathTokens: readonly string[],
  taskTokens: readonly string[],
): { score: number; token: string | null } {
  let score = 0;
  let best: string | null = null;
  let bestWeight = 0;
  const seen = new Set<string>();

  for (const task of taskTokens) {
    if (STOP_TOKENS.has(task) || seen.has(task)) continue;
    seen.add(task);
    for (const token of pathTokens) {
      if (STOP_TOKENS.has(token)) continue;
      let weight = 0;
      if (token === task) weight = EXACT_TOKEN_WEIGHT;
      else if (task.length >= MIN_PREFIX_CHARS && token.startsWith(task)) weight = PREFIX_TOKEN_WEIGHT;
      else if (token.length >= MIN_PREFIX_CHARS && task.startsWith(token)) weight = PREFIX_TOKEN_WEIGHT;
      if (weight === 0) continue;
      score += weight;
      // First best wins, over path order, so the reason a pick reports is the
      // same on every run over the same tree.
      if (weight > bestWeight) {
        best = token;
        bestWeight = weight;
      }
    }
  }

  return { score, token: best };
}

/* ------------------------------------------------------------------ *
 * Cache and vectors
 * ------------------------------------------------------------------ *
 *
 * These mirror the private helpers in `agent-library.ts`, which are not
 * exported. The formats are deliberately the same (a JSON object of key to
 * vector, in the same directory) but the file name is not: two writers sharing
 * one file would lose each other's entries to the last write.
 */

/** Cache file name for one embedder's file vectors, inside the cache directory. */
function cacheFileName(embedderId: string): string {
  return `${embedderId.replace(/[^A-Za-z0-9._-]+/g, '_') || 'default'}.context.json`;
}

/**
 * Key for one cached vector: sha256 over the embedder id and the exact text.
 *
 * The text is the relative path followed by the file's head, so the key covers
 * path, content and embedder identity together. The NUL separator keeps
 * "a"+"bc" distinct from "ab"+"c".
 */
function embeddingKey(embedderId: string, text: string): string {
  return createHash('sha256').update(`${embedderId}\u0000${text}`, 'utf8').digest('hex');
}

/** True for a non-empty vector of finite numbers, the only shape usable here. */
function isVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

/**
 * Read the cache, or an empty one.
 *
 * Every failure mode (absent file, unreadable file, truncated JSON, a hand-edited
 * shape) resolves to "no cache": a cache is a cost optimisation and never a
 * reason for a ranking to fail, and one junk entry is dropped rather than
 * poisoning the file.
 */
function readEmbeddingCache(path: string): Record<string, number[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const cache: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isVector(value)) cache[key] = value;
  }
  return cache;
}

/**
 * Persist the cache, best effort.
 *
 * A read-only directory or a full disk costs one extra embed next run, which is
 * cheaper than failing a ranking, so nothing here is allowed to throw.
 */
function writeEmbeddingCache(path: string, cache: Record<string, number[]>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), 'utf8');
  } catch {
    /* best effort by design */
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  // Equal widths are arranged by the caller; a mismatch would mean the embedder
  // is not honouring its own contract, and scoring that as 0 is safer than
  // reading past the end of either vector.
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Reject an embedder response that cannot be trusted, before it reaches scoring.
 *
 * A short or non-numeric batch is a bug in the embedder, not a ranking signal,
 * so it takes the same fallback path as a rejection rather than silently scoring
 * every file as 0.
 */
function assertVectors(value: unknown, expected: number): asserts value is number[][] {
  const list: unknown[] | null = Array.isArray(value) ? value : null;
  if (!list || list.length !== expected || !list.every(isVector)) {
    throw new Error(`embedder returned ${list ? list.length : 'no'} usable vectors for ${expected} texts`);
  }
}

/** Loggers already warned. */
const warnedLoggers = new WeakSet<object>();

/**
 * Warn through the injected logger at most once per logger.
 *
 * Keyed on the logger rather than on the process so a long-lived harness that
 * builds several prompts warns once for each caller that supplied a logger,
 * while a loop reusing one logger cannot flood. A logger that throws must not
 * take the ranking down with it.
 */
function warnOnce(deps: ContextFilesDeps, text: string): void {
  const log = deps.log;
  if (!log || warnedLoggers.has(log)) return;
  warnedLoggers.add(log);
  try {
    log(text);
  } catch {
    /* a logger is not allowed to fail a ranking */
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return CONTEXT_SEMANTIC_WEIGHT;
  return Math.min(1, Math.max(0, value));
}

/**
 * Read through a call so TypeScript re-checks the flag every time: a direct
 * `input.signal?.aborted` comparison inside the loop gets narrowed once and then
 * treated as never changing.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** `realpathSync` that reports failure as `null`: a broken link is not an error here. */
function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Whether a resolved path is a directory, with failure read as "no". */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The directory part of a relative path, `''` for a file at the root. */
function parentDir(relPath: string): string {
  const at = relPath.lastIndexOf('/');
  return at === -1 ? '' : relPath.slice(0, at);
}

/* ------------------------------------------------------------------ *
 * Walk
 * ------------------------------------------------------------------ */

interface Candidate {
  /** Path relative to the walk root, with forward slashes. */
  path: string;
  /** Head of the file, as decoded from the read window. */
  head: string;
  lexical: number;
  /** The path token that earned the lexical score, when one did. */
  token: string | null;
}

/**
 * Read a bounded head of one file, or `null`.
 *
 * `null` covers every reason a file is not context: too large to be worth
 * opening, binary, unreadable, or not a regular file. A NUL byte in the window
 * is the same binary test `grep.ts` uses, applied to the only bytes this module
 * ever looks at. The window is read through an open handle so the size check and
 * the read describe the same file even if it is replaced in between.
 */
function readFileHead(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > CONTEXT_MAX_FILE_BYTES) return null;
    const window = Buffer.allocUnsafe(CONTEXT_READ_BYTES);
    const read = readSync(fd, window, 0, CONTEXT_READ_BYTES, 0);
    const buffer = window.subarray(0, read);
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A handle that cannot be closed is the operating system's problem, and
        // failing the walk over it would turn a leak into a broken run.
      }
    }
  }
}

interface WalkResult {
  candidates: Candidate[];
  truncated: boolean;
  aborted: boolean;
  visited: number;
}

/**
 * Walk the tree for candidates.
 *
 * The walk is iterative because a deep tree should not risk a stack overflow,
 * and every level is sorted because a cap must cut the same tail on every run:
 * the filesystem's own order is not stable across platforms or checkouts, and a
 * listing that changes between two runs over one tree cannot be reviewed.
 */
function walkWorkspace(options: {
  root: string;
  taskTokens: readonly string[];
  deadline: number;
  signal: AbortSignal | undefined;
}): WalkResult {
  const candidates: Candidate[] = [];
  let visited = 0;
  let truncated = false;
  let aborted = false;

  // Every directory is keyed by a path, because a link can point at one of its
  // own ancestors; a repeat means this walk has been here already. The root is
  // keyed both ways so a link back to it is caught whichever form it takes.
  const rootReal = safeRealpath(options.root);
  const seenDirs = new Set<string>([options.root, ...(rootReal === null ? [] : [rootReal])]);
  const queue: Array<{ path: string; depth: number }> = [{ path: options.root, depth: 0 }];

  while (queue.length > 0) {
    if (isAborted(options.signal)) {
      aborted = true;
      truncated = true;
      break;
    }
    if (visited >= CONTEXT_MAX_FILES || Date.now() >= options.deadline) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    if (current === undefined) break;

    let entries: Dirent[];
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue; // unreadable directory: skip rather than abandon the walk
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (isAborted(options.signal)) {
        aborted = true;
        truncated = true;
        break;
      }
      if (visited >= CONTEXT_MAX_FILES || Date.now() >= options.deadline) {
        truncated = true;
        break;
      }

      // The skip list is about directories, so a *file* named `build` is still a
      // candidate; only an entry that could be descended into is dropped here.
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (CONTEXT_SKIP_DIRS.has(entry.name) || current.depth >= CONTEXT_MAX_DEPTH) continue;
        const full = join(current.path, entry.name);
        // Resolving a path is the most expensive call in this loop, so it is
        // paid only for links, which are the only entries that can point back
        // into the tree.
        const link = entry.isSymbolicLink();
        const key = link ? safeRealpath(full) : full;
        if (key === null || seenDirs.has(key)) continue;
        if (link && !isDirectory(key)) continue; // a link to a file, or a broken one
        seenDirs.add(key);
        queue.push({ path: key, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;

      visited++;
      const full = join(current.path, entry.name);
      const head = readFileHead(full);
      if (head === null) continue;

      const relPath = relative(options.root, full).split('\\').join('/');
      const tokens = tokenizePath(relPath);
      const match = pathLexicalScore(tokens, options.taskTokens);
      candidates.push({ path: relPath, head, lexical: match.score, token: match.token });
    }
  }

  return { candidates, truncated, aborted, visited };
}

/* ------------------------------------------------------------------ *
 * Semantic ranking
 * ------------------------------------------------------------------ */

/** Wait for the embedder, but never longer than the documented ceiling. */
async function withEmbedBudget(work: Promise<number[][]>, ms: number): Promise<number[][]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    // Clearing rather than unref-ing: a cleared timer cannot fire and cannot
    // hold the event loop open either.
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface SemanticOutcome {
  /** Cosine similarity per relative path, for the candidates that got a vector. */
  similarities: Map<string, number>;
  /** How many candidates a vector was obtained for, from cache or from a call. */
  embedded: number;
  /** True when the embed cap cut the candidate set. */
  capped: boolean;
}

/**
 * Cosine similarity between the task and each candidate the cap allows.
 *
 * Mirrors `searchAgentsSemantic`: one batched call covers everything the cache
 * missed plus the query itself, the query is cached like any other text so a
 * repeat ranking is free, and a cached vector of the wrong width invalidates its
 * own entry rather than the whole cache. Throwing is the contract here: the
 * caller turns any failure into the lexical ranking plus one warning.
 */
async function semanticSimilarities(options: {
  candidates: readonly Candidate[];
  query: string;
  embedder: EmbedFn;
  embedderId: string;
  cacheDir: string;
  bodyChars: number;
}): Promise<SemanticOutcome> {
  // Path tokens order the candidates before the cap is applied, so the cut
  // follows evidence rather than walk order.
  const ordered = [...options.candidates].sort(
    (a, b) => b.lexical - a.lexical || a.path.localeCompare(b.path),
  );
  const capped = ordered.length > CONTEXT_MAX_EMBED_FILES;
  const chosen = ordered.slice(0, CONTEXT_MAX_EMBED_FILES);

  // Path plus head is what identifies a file, the way name, description and body
  // identify an agent; the head is cut to a character budget first so one large
  // file cannot dominate the cost of the batch.
  const texts = chosen.map((candidate) => `${candidate.path}\n${candidate.head.slice(0, options.bodyChars)}`);
  const keys = texts.map((text) => embeddingKey(options.embedderId, text));
  const queryKey = embeddingKey(options.embedderId, options.query);
  const cachePath = join(options.cacheDir, cacheFileName(options.embedderId));

  const cache = readEmbeddingCache(cachePath);
  const vectors: Array<number[] | undefined> = keys.map((key) => cache[key]);
  let queryVector: number[] | undefined = cache[queryKey];
  let dirty = false;

  const missing: number[] = [];
  for (let i = 0; i < vectors.length; i++) {
    if (!isVector(vectors[i])) missing.push(i);
  }

  if (missing.length > 0 || !isVector(queryVector)) {
    const batch = [...missing.map((i) => texts[i] ?? ''), ...(isVector(queryVector) ? [] : [options.query])];
    const out = await withEmbedBudget(options.embedder(batch), CONTEXT_EMBED_BUDGET_MS);
    assertVectors(out, batch.length);
    missing.forEach((index, position) => {
      const vector = out[position] as number[];
      vectors[index] = vector;
      const key = keys[index];
      if (key !== undefined) {
        cache[key] = vector;
        dirty = true;
      }
    });
    if (!isVector(queryVector)) {
      const fresh = out[out.length - 1] as number[];
      queryVector = fresh;
      cache[queryKey] = fresh;
      dirty = true;
    }
  }

  if (!isVector(queryVector)) throw new Error('no usable query vector');
  const queryVec = queryVector;

  // A cached vector left by an embedder of another width cannot be compared with
  // the query. That invalidates the entry, not the ranking, so only the
  // offending entries are embedded again.
  const stale: number[] = [];
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i];
    if (isVector(vector) && vector.length !== queryVec.length) stale.push(i);
  }
  if (stale.length > 0) {
    const out = await withEmbedBudget(
      options.embedder(stale.map((i) => texts[i] ?? '')),
      CONTEXT_EMBED_BUDGET_MS,
    );
    assertVectors(out, stale.length);
    stale.forEach((index, position) => {
      const vector = out[position] as number[];
      vectors[index] = vector;
      const key = keys[index];
      if (key !== undefined) {
        cache[key] = vector;
        dirty = true;
      }
    });
  }

  if (dirty) writeEmbeddingCache(cachePath, cache);

  const similarities = new Map<string, number>();
  chosen.forEach((candidate, index) => {
    const vector = vectors[index];
    if (isVector(vector)) similarities.set(candidate.path, cosineSimilarity(vector, queryVec));
  });

  return { similarities, embedded: similarities.size, capped };
}

/* ------------------------------------------------------------------ *
 * Picking
 * ------------------------------------------------------------------ */

function emptyResult(walk?: WalkResult): ContextFiles {
  return {
    picks: [],
    sampleCause: walk?.truncated === true ? 'walk' : 'none',
    filesWalked: walk?.visited ?? 0,
    embedded: 0,
    semantic: false,
    aborted: walk?.aborted === true,
  };
}

async function pick(input: PickContextFilesInput): Promise<ContextFiles> {
  const deps = input.deps ?? {};
  const taskTokens = tokenizeTask(input.task ?? '');
  // An empty task names nothing to rank against, so there is no ranking to do
  // and no files to offer. It is still reported once: a caller that expected
  // picks and got none needs to know which of the two reasons it was.
  if (taskTokens.length === 0) {
    warnOnce(deps, 'the task is empty, so no file can be ranked against it; no context files picked');
    return emptyResult();
  }

  const root = resolve(input.dir);
  if (!isDirectory(root)) return emptyResult();

  const budgetMs =
    input.budgetMs !== undefined && Number.isFinite(input.budgetMs)
      ? Math.max(0, input.budgetMs)
      : CONTEXT_BUDGET_MS;
  const limit = input.limit !== undefined && Number.isFinite(input.limit)
    ? Math.max(0, Math.floor(input.limit))
    : DEFAULT_CONTEXT_FILES;
  const headBytes = input.headBytes !== undefined && Number.isFinite(input.headBytes)
    ? Math.max(0, Math.floor(input.headBytes))
    : DEFAULT_CONTEXT_HEAD_BYTES;

  const walk = walkWorkspace({
    root,
    taskTokens,
    deadline: Date.now() + budgetMs,
    signal: input.signal,
  });
  if (walk.candidates.length === 0 || limit === 0) return emptyResult(walk);

  let maxLexical = 0;
  for (const candidate of walk.candidates) {
    if (candidate.lexical > maxLexical) maxLexical = candidate.lexical;
  }

  let similarities = new Map<string, number>();
  let embedded = 0;
  let capped = false;
  const embedder = input.embedder;
  if (!embedder) {
    warnOnce(deps, 'semantic file ranking is off (no embedder injected); ranking by path names only');
  } else {
    try {
      const outcome = await semanticSimilarities({
        candidates: walk.candidates,
        query: input.task,
        embedder,
        embedderId: deps.embedderId ?? 'default',
        cacheDir: deps.cacheDir ?? defaultEmbeddingCacheDir(),
        bodyChars: Math.max(0, deps.bodyChars ?? CONTEXT_EMBED_CHARS),
      });
      similarities = outcome.similarities;
      embedded = outcome.embedded;
      capped = outcome.capped;
    } catch (err) {
      // One warning per logger, whatever the embedder did, and the ranking
      // continues on path tokens alone. A run is never failed over a hint.
      warnOnce(deps, `semantic file ranking failed (${errorText(err)}); ranking by path names only`);
      similarities = new Map<string, number>();
      embedded = 0;
      capped = false;
    }
  }

  const weight = clamp01(CONTEXT_SEMANTIC_WEIGHT);
  const scored = walk.candidates.map((candidate) => {
    const semantic = similarities.get(candidate.path) ?? 0;
    // Normalised against the best lexical score in the workspace so the two
    // halves of the blend share a 0..1 scale whatever the task's length.
    const share = maxLexical > 0 ? candidate.lexical / maxLexical : 0;
    return { candidate, semantic, score: semantic * weight + share * (1 - weight) };
  });
  scored.sort((a, b) => b.score - a.score || a.candidate.path.localeCompare(b.candidate.path));

  const picks: ContextFilePick[] = [];
  const picked = new Set<string>();
  for (const entry of scored) {
    if (picks.length >= limit) break;
    // `score > 0` also drops a file the embedder placed on the far side of the
    // query, whose cosine is negative: "unrelated" and "opposite" are both
    // reasons not to offer a file.
    if (!(entry.score > 0)) continue;
    picks.push({
      path: entry.candidate.path,
      reason: reasonFor(entry.candidate, entry.semantic),
      score: entry.score,
    });
    picked.add(entry.candidate.path);
  }

  // A file that shares a directory with a pick and scored nothing is more likely
  // to be needed than an unrelated file further away, so it fills the slots the
  // ranked picks left empty. It never displaces a scored pick: this loop only
  // runs while there is room and only considers candidates with a zero score.
  if (picks.length > 0 && picks.length < limit) {
    const siblingCount = (dir: string): number =>
      picks.filter((pick) => parentDir(pick.path) === dir).length;
    const siblings = walk.candidates
      .filter((candidate) => !picked.has(candidate.path) && siblingCount(parentDir(candidate.path)) > 0)
      .sort(
        (a, b) =>
          siblingCount(parentDir(b.path)) - siblingCount(parentDir(a.path)) ||
          a.path.localeCompare(b.path),
      );
    for (const sibling of siblings) {
      if (picks.length >= limit) break;
      const others = siblingCount(parentDir(sibling.path));
      picks.push({
        path: sibling.path,
        reason: `shares directory with ${others} other ${others === 1 ? 'pick' : 'picks'}`,
        score: 0,
      });
    }
  }

  if (headBytes > 0) attachHeadWindows(picks, walk.candidates, headBytes);

  return {
    picks,
    sampleCause: walk.truncated ? 'walk' : capped ? 'embed' : 'none',
    filesWalked: walk.visited,
    embedded,
    semantic: embedded > 0,
    aborted: walk.aborted,
  };
}

/**
 * One line explaining a pick, in the order the evidence is worth trusting.
 *
 * A named token is checkable by the reader; "semantically close" is not, so it
 * is only said when no token matched.
 */
function reasonFor(candidate: Candidate, semantic: number): string {
  if (candidate.token !== null) return `path token "${candidate.token}" matched the task`;
  if (semantic > 0) return 'semantically close to the task';
  // No token and no positive similarity scores above zero, so the ranking cannot
  // produce this case; the branch is here so a reason is always a string.
  return 'ranked by its path tokens';
}

/**
 * Fill each pick's head window, in rank order, out of one shared budget.
 *
 * The total is shared rather than per file so `--context-bytes` buys a bounded
 * addition to the prompt however many files are picked. Lines are clipped with
 * `format.ts`'s `clip` because one minified line would otherwise spend the whole
 * window on a single line of the file.
 */
function attachHeadWindows(picks: ContextFilePick[], candidates: readonly Candidate[], headBytes: number): void {
  const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  let remaining = Math.min(headBytes * picks.length, CONTEXT_TOTAL_HEAD_BYTES);

  for (const pick of picks) {
    if (remaining <= 0) break;
    const window = Math.min(headBytes, CONTEXT_HEAD_MAX_BYTES, remaining);
    if (window <= 0) break;
    const head = byPath.get(pick.path)?.head ?? '';
    const text = head.slice(0, window).trimEnd();
    if (text === '') continue;
    pick.head = text.split('\n').map((line) => clip(line, CONTEXT_HEAD_COLUMNS)).join('\n');
    remaining -= text.length;
  }
}

/**
 * Rank workspace files against a task, or return nothing.
 *
 * Never throws and never blocks past `budgetMs` for the walk plus
 * `CONTEXT_EMBED_BUDGET_MS` for the embedder, so a caller placing this on the
 * startup path has a ceiling it can state. Everything that can fail inside does:
 * a missing embedder, an unusable response, an expiry or a rejection all end in
 * the lexical ranking and one warning through `deps.log`.
 */
export async function pickContextFiles(input: PickContextFilesInput): Promise<ContextFiles> {
  const deps = input.deps ?? {};
  try {
    return await pick(input);
  } catch (err) {
    // The guards inside cover the paths that are expected to fail. This one
    // covers the rest, because a hint is never worth failing a run over.
    warnOnce(deps, `context file ranking failed (${errorText(err)}); continuing without it`);
    return emptyResult();
  }
}

/**
 * The `## Likely relevant files` section, or `''` when there is nothing to say.
 *
 * The whole section, heading included, matching `formatWorkspaceSection`: the
 * caller appends it as one part and never has to remember the heading. An empty
 * pick list returns an empty string rather than a heading with no content,
 * because a section that says "none" costs prompt space and tells the model
 * nothing it cannot see for itself.
 */
export function formatContextFilesSection(result: ContextFiles): string {
  if (result.picks.length === 0) return '';

  const lines = result.picks.map((pick) => `- ${pick.path} — ${pick.reason}`);
  if (result.sampleCause === 'walk') {
    lines.push(
      `(this listing is a sample: the walk stopped after ${formatCount(result.filesWalked)} files, ` +
        'so files below that were never ranked)',
    );
  } else if (result.sampleCause === 'embed') {
    lines.push(
      `(this listing is a sample: only the ${formatCount(CONTEXT_MAX_EMBED_FILES)} files nearest the ` +
        "task's own words were ranked by meaning, and the rest by path alone)",
    );
  }

  for (const pick of result.picks) {
    if (pick.head === undefined || pick.head === '') continue;
    lines.push('', `Head of ${pick.path}:`, '```', pick.head, '```');
  }

  return `## Likely relevant files\n${lines.join('\n')}`;
}
