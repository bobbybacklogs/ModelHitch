import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CONTEXT_MAX_EMBED_FILES,
  CONTEXT_MAX_FILE_BYTES,
  CONTEXT_MAX_FILES,
  DEFAULT_CONTEXT_FILES,
  DEFAULT_CONTEXT_HEAD_BYTES,
  formatContextFilesSection,
  pathLexicalScore,
  pickContextFiles,
  tokenizePath,
  tokenizeTask,
  type ContextFiles,
  type EmbedFn,
} from '../harness/context-files.js';
import { buildSystemPrompt } from '../harness/prompt.js';

/**
 * The workspace context picker.
 *
 * Three properties are worth pinning: that a lexical ranking over path tokens is
 * deterministic and never throws, that an injected embedder can surface a file
 * whose path shares no word with the task, and that every way the semantic half
 * can fail ends in the lexical picks plus exactly one warning. The CACHE and the
 * walk caps are exercised against real directories on disk, because both are
 * about what the filesystem actually holds.
 */

const SANDBOX = resolve(__dirname, '.tmp-context-files');
const REPO = join(SANDBOX, 'context-repo');
const EMPTY_DIR = join(SANDBOX, 'empty');
const BULK_REPO = join(SANDBOX, 'bulk-repo');
const MID_REPO = join(SANDBOX, 'mid-repo');

function fill(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
}

beforeAll(() => {
  // A small repository with one lexical target, one semantic target, and one of
  // every kind of file the walk is supposed to refuse.
  mkdirSync(SANDBOX, { recursive: true });
  mkdirSync(EMPTY_DIR, { recursive: true });
  fill(REPO, 'package.json', JSON.stringify({ name: 'demo' }));
  fill(join(REPO, 'src', 'router'), 'config.ts', 'export const ROUTER = { timeout: 30 };\n');
  fill(join(REPO, 'src', 'router'), 'handlers.ts', 'export function handle(): void {}\n');
  fill(join(REPO, 'src', 'core'), 'store.ts', 'Database migrations, backfill, and stored records.\n');
  fill(join(REPO, 'src', 'core'), 'cache.ts', 'export const cache = new Map<string, string>();\n');
  fill(join(REPO, 'src', 'ui'), 'theme.ts', 'Typography, colour and layout for product surfaces.\n');
  fill(join(REPO, 'docs'), 'notes.md', '# Notes\n');

  // A binary file and an oversized one, both named as though they matter: the
  // only thing that can keep them out is the read.
  fill(join(REPO, 'src', 'router'), 'blob.ts', '\u0000\u0001\u0002 binary payload\n');
  fill(join(REPO, 'src', 'router'), 'gigantic.ts', `export const big = 1;\n${'x'.repeat(CONTEXT_MAX_FILE_BYTES)}`);

  // Directories that hold dependencies or build output, each with a file the
  // task's own words would match if the walk ever reached it.
  for (const dir of ['node_modules/pkg', '.git', 'dist', 'build', 'out', 'coverage', 'target']) {
    fill(join(REPO, dir), 'router-clone.ts', 'export const ROUTER = {};\n');
  }

  // More files than the walk may visit, so the sample note can be produced by a
  // count rather than by a machine-dependent millisecond. The file the task
  // matches sits at the root, because the walk is breadth-first and the bulk
  // directory is visited before anything inside a sibling directory.
  fill(BULK_REPO, 'router-config.ts', 'export const ROUTER = { timeout: 30 };\n');
  for (let i = 0; i < CONTEXT_MAX_FILES + 10; i++) {
    fill(join(BULK_REPO, 'zzz-bulk'), `b${i}.ts`, 'export const bulk = 1;\n');
  }

  // More files than the embedder is given, but few enough for the walk to
  // finish, which is what separates the two sample causes.
  fill(join(MID_REPO, 'src', 'router'), 'config.ts', 'export const ROUTER = { timeout: 30 };\n');
  for (let i = 0; i < CONTEXT_MAX_EMBED_FILES + 5; i++) {
    fill(join(MID_REPO, 'bulk'), `b${i}.ts`, 'export const bulk = 1;\n');
  }
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

const tempDirs: string[] = [];

function tempCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-context-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

/**
 * Deterministic stand-in for an embedder: the same two intent bins the semantic
 * agent search is tested with. It is not a language model, but it reproduces the
 * one property under test — text about stored records lands near a query about
 * "how the records are shaped" without sharing a word with it.
 */
const BINS: RegExp[] = [
  /\b(database|migration|schema|backfill|records|shaped|stored|change)\b/,
  /\b(design|typography|colour|color|layout|pixel|visual|surface)\b/,
];

function fakeVectors(texts: string[]): number[][] {
  return texts.map((text) => {
    const lower = text.toLowerCase();
    return BINS.map((bin) => (bin.test(lower) ? 1 : 0));
  });
}

function stubEmbedder(): { embed: EmbedFn; calls: () => number; texts: () => string[] } {
  const sent: string[] = [];
  let calls = 0;
  return {
    embed: (texts: string[]) => {
      calls++;
      sent.push(...texts);
      return Promise.resolve(fakeVectors(texts));
    },
    calls: () => calls,
    texts: () => sent,
  };
}

/** The lexical task: `router` is the only token in it that a path shares. */
const LEXICAL_TASK = 'tighten the router timeouts';

/** The semantic task: no file in the fixture shares a token with it. */
const SEMANTIC_TASK = 'change how the records are shaped';

const STORE_PATH = 'src/core/store.ts';
const STORE_TEXT = 'Database migrations, backfill, and stored records.\n';

describe('tokenizePath and pathLexicalScore', () => {
  it('splits segments, extensions and camelCase words', () => {
    expect(tokenizePath('harness/context-files.ts')).toEqual(['harness', 'context', 'files']);
    expect(tokenizePath('src/XmlHttpParser.ts')).toEqual(['src', 'xml', 'http', 'parser']);
    // Digits stay with the word before them: `base64` is one word.
    expect(tokenizePath('src/base64-codec.ts')).toEqual(['src', 'base64', 'codec']);
  });

  it('prefers an exact token and says which one it matched', () => {
    const match = pathLexicalScore(tokenizePath('src/router/config.ts'), tokenizeTask(LEXICAL_TASK));
    expect(match.token).toBe('router');
    expect(match.score).toBeGreaterThan(0);
  });

  it('scores nothing for a task made only of plumbing words', () => {
    // `index`, `src` and `the` all appear in paths and say nothing about which
    // file a task is about.
    expect(pathLexicalScore(tokenizePath('src/index.ts'), tokenizeTask('fix the index')).score).toBe(0);
  });
});

describe('pickContextFiles, lexical path', () => {
  it('picks the file its path names, deterministically', async () => {
    const first = await pickContextFiles({ dir: REPO, task: LEXICAL_TASK });
    const second = await pickContextFiles({ dir: REPO, task: LEXICAL_TASK });

    // Both files sit under a directory named `router`, and a directory name is
    // evidence for every file in it: `handlers.ts` shares no word with the task,
    // but where it lives does.
    expect(first.picks.map((pick) => pick.path)).toEqual([
      'src/router/config.ts',
      'src/router/handlers.ts',
    ]);
    expect(first.picks[0]?.reason).toBe('path token "router" matched the task');
    expect(first.picks[1]?.reason).toBe('path token "router" matched the task');
    expect(first.semantic).toBe(false);
    expect(first.sampleCause).toBe('none');
    expect(second.picks).toEqual(first.picks);
  });

  it('fills the remaining slots from the directory a pick came from', async () => {
    // Only `store.ts` shares a token with this task, and the slot beside it goes
    // to the file next to it rather than to a file that shares nothing.
    const result = await pickContextFiles({ dir: REPO, task: 'rebuild the store index' });
    expect(result.picks.map((pick) => pick.path)).toEqual(['src/core/store.ts', 'src/core/cache.ts']);
    expect(result.picks[1]?.reason).toBe('shares directory with 1 other pick');
    expect(result.picks[1]?.score).toBe(0);
  });

  it('offers at most the documented number of files', async () => {
    const result = await pickContextFiles({ dir: REPO, task: LEXICAL_TASK, limit: 1 });
    expect(result.picks).toHaveLength(1);
    expect(DEFAULT_CONTEXT_FILES).toBe(5);
    expect(DEFAULT_CONTEXT_HEAD_BYTES).toBe(0);
  });

  it('skips dependency, build and version-control directories', async () => {
    const result = await pickContextFiles({ dir: REPO, task: 'router' });
    // Every `router-clone.ts` in those directories would win on the token
    // `router`; none of them may appear.
    expect(result.picks[0]?.path).toBe('src/router/config.ts');
    for (const dir of ['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'target']) {
      expect(result.picks.some((pick) => pick.path.startsWith(`${dir}/`))).toBe(false);
      expect(result.picks.some((pick) => pick.path.includes('router-clone'))).toBe(false);
    }
    // Those seven files are never visited: the small repository holds nine
    // readable files, and the binary and oversized ones among them still count
    // as visited because only the read can rule them out.
    expect(result.filesWalked).toBe(9);
  });

  it('skips a binary file and an oversized one even when their names match the task', async () => {
    const blob = await pickContextFiles({ dir: REPO, task: 'blob' });
    const gigantic = await pickContextFiles({ dir: REPO, task: 'gigantic' });
    expect(blob.picks).toEqual([]);
    expect(gigantic.picks).toEqual([]);
    // Both files exist and were visited; only the read keeps them out.
    expect(blob.filesWalked).toBe(9);
    expect(CONTEXT_MAX_FILE_BYTES).toBe(256 * 1024);
  });

  it('returns an empty list for an empty task and an empty directory, without throwing', async () => {
    const log = vi.fn();
    const counter = stubEmbedder();
    const blank = await pickContextFiles({
      dir: REPO,
      task: '   ',
      embedder: counter.embed,
      deps: { log },
    });
    const empty = await pickContextFiles({ dir: EMPTY_DIR, task: LEXICAL_TASK });

    expect(blank.picks).toEqual([]);
    expect(blank.filesWalked).toBe(0);
    expect(empty.picks).toEqual([]);
    expect(empty.filesWalked).toBe(0);
    // Nothing to rank against means nothing is embedded either.
    expect(counter.calls()).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('degrades silently with no embedder and no logger', async () => {
    await expect(pickContextFiles({ dir: REPO, task: LEXICAL_TASK })).resolves.toMatchObject({
      semantic: false,
    });
    await expect(
      pickContextFiles({ dir: join(SANDBOX, 'does-not-exist'), task: LEXICAL_TASK }),
    ).resolves.toMatchObject({ picks: [] });
  });
});

describe('pickContextFiles, semantic path', () => {
  it('surfaces a file whose path shares no token with the task', async () => {
    // The lexical build cannot see this file: no token of its path is a token of
    // the task, so the ranking below can only come from the embedder.
    const lexical = await pickContextFiles({ dir: REPO, task: SEMANTIC_TASK, deps: { log: () => {} } });
    expect(lexical.picks).toEqual([]);

    const semantic = await pickContextFiles({
      dir: REPO,
      task: SEMANTIC_TASK,
      embedder: (texts) => Promise.resolve(fakeVectors(texts)),
      deps: { cacheDir: tempCacheDir(), embedderId: 'stub', log: () => {} },
    });

    expect(semantic.picks.map((pick) => pick.path)).toEqual([STORE_PATH, 'src/core/cache.ts']);
    expect(semantic.picks[0]?.reason).toBe('semantically close to the task');
    // The slot beside it goes to the file next to it, which the embedder did not
    // rank either.
    expect(semantic.picks[1]?.reason).toBe('shares directory with 1 other pick');
    expect(semantic.semantic).toBe(true);
    expect(semantic.embedded).toBeGreaterThan(0);
  });

  it('lets the path tokens break a tie between files the embedder finds equally close', async () => {
    // Every candidate lands in one bin, so all seven are equally close and only
    // the lexical share can order them: the two files under `router/` win on the
    // directory name, and the rest follow in path order.
    const result = await pickContextFiles({
      dir: REPO,
      task: LEXICAL_TASK,
      embedder: (texts) => Promise.resolve(texts.map(() => [1, 0])),
      deps: { cacheDir: tempCacheDir(), embedderId: 'flat', log: () => {} },
    });
    expect(result.picks.map((pick) => pick.path)).toEqual([
      'src/router/config.ts',
      'src/router/handlers.ts',
      'docs/notes.md',
      'package.json',
      'src/core/cache.ts',
    ]);
  });

  it('caches vectors on disk keyed by embedder id, relative path and content', async () => {
    const cacheDir = tempCacheDir();
    await pickContextFiles({
      dir: REPO,
      task: SEMANTIC_TASK,
      embedder: (texts) => Promise.resolve(fakeVectors(texts)),
      deps: { cacheDir, embedderId: 'stub-model', log: () => {} },
    });

    const parsed = JSON.parse(readFileSync(join(cacheDir, 'stub-model.context.json'), 'utf8')) as Record<
      string,
      number[]
    >;
    const key = createHash('sha256')
      .update(`stub-model\u0000${STORE_PATH}\n${STORE_TEXT}`, 'utf8')
      .digest('hex');
    expect(parsed[key]).toEqual([1, 0]);
    // One entry per candidate plus the query itself.
    expect(Object.keys(parsed).length).toBeGreaterThan(1);
  });

  it('a warm cache costs no embed call, and deleting it changes nothing', async () => {
    const cacheDir = tempCacheDir();
    const counter = stubEmbedder();
    const input = {
      dir: REPO,
      task: SEMANTIC_TASK,
      embedder: counter.embed,
      deps: { cacheDir, embedderId: 'stub', log: () => {} },
    };

    const first = await pickContextFiles(input);
    expect(counter.calls()).toBe(1);

    const second = await pickContextFiles(input);
    expect(counter.calls()).toBe(1);
    expect(second).toEqual(first);

    // The cache is the only reason the second call was free, so removing it has
    // to cost exactly one more call and produce the same picks.
    rmSync(cacheDir, { recursive: true, force: true });
    const third = await pickContextFiles(input);
    expect(counter.calls()).toBe(2);
    expect(third).toEqual(first);
  });

  it('invalidates only the cache entry whose vector has the wrong dimension', async () => {
    const cacheDir = tempCacheDir();
    const counter = stubEmbedder();
    const input = {
      dir: REPO,
      task: SEMANTIC_TASK,
      embedder: counter.embed,
      deps: { cacheDir, embedderId: 'stub', log: () => {} },
    };

    const baseline = await pickContextFiles(input);
    const file = join(cacheDir, 'stub.context.json');
    const cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number[]>;
    const staleKey = createHash('sha256')
      .update(`stub\u0000${STORE_PATH}\n${STORE_TEXT}`, 'utf8')
      .digest('hex');
    // A vector a different embedder left behind: same key, unusable width.
    cache[staleKey] = [1, 0, 0];
    writeFileSync(file, JSON.stringify(cache));

    const repaired = await pickContextFiles(input);

    expect(counter.calls()).toBe(2);
    expect(repaired.picks).toEqual(baseline.picks);
    expect(JSON.parse(readFileSync(file, 'utf8'))[staleKey]).toEqual([1, 0]);
  });

  it('falls back to the lexical picks with exactly one warning when the embedder throws', async () => {
    const log = vi.fn();
    const result = await pickContextFiles({
      dir: REPO,
      task: LEXICAL_TASK,
      embedder: () => Promise.reject(new Error('no embedding endpoint')),
      deps: { cacheDir: tempCacheDir(), embedderId: 'stub', log },
    });

    expect(result.picks.map((pick) => pick.path)).toEqual([
      'src/router/config.ts',
      'src/router/handlers.ts',
    ]);
    expect(result.semantic).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('ranking by path names only');
  });

  it('warns once for an unusable embedder response and once for a missing embedder', async () => {
    const shortLog = vi.fn();
    const short = await pickContextFiles({
      dir: REPO,
      task: LEXICAL_TASK,
      // Eight texts were sent (seven candidates plus the query); one came back.
      embedder: () => Promise.resolve([[1, 0]]),
      deps: { cacheDir: tempCacheDir(), embedderId: 'stub', log: shortLog },
    });
    expect(short.picks[0]?.path).toBe('src/router/config.ts');
    expect(shortLog).toHaveBeenCalledTimes(1);

    const noneLog = vi.fn();
    const none = await pickContextFiles({ dir: REPO, task: LEXICAL_TASK, deps: { log: noneLog } });
    expect(none.picks[0]?.path).toBe('src/router/config.ts');
    expect(noneLog).toHaveBeenCalledTimes(1);
    expect(String(noneLog.mock.calls[0]?.[0])).toContain('no embedder injected');
  });
});

describe('formatContextFilesSection', () => {
  function result(overrides: Partial<ContextFiles> = {}): ContextFiles {
    return {
      picks: [
        { path: 'src/router/config.ts', reason: 'path token "router" matched the task', score: 0.2 },
        { path: 'src/router/handlers.ts', reason: 'shares directory with 1 other pick', score: 0 },
      ],
      sampleCause: 'none',
      filesWalked: 8,
      embedded: 0,
      semantic: false,
      aborted: false,
      ...overrides,
    };
  }

  it('lists every path with its reason', () => {
    const section = formatContextFilesSection(result());
    expect(section.startsWith('## Likely relevant files\n')).toBe(true);
    expect(section).toContain('- src/router/config.ts — path token "router" matched the task');
    expect(section).toContain('- src/router/handlers.ts — shares directory with 1 other pick');
    expect(section).not.toContain('sample');
  });

  it('says the listing is a sample when a walk cap was hit', async () => {
    const section = formatContextFilesSection(result({ sampleCause: 'walk', filesWalked: 4000 }));
    expect(section).toContain('sample');
    expect(section).toContain('4k files');

    // And the walk itself reports it: the bulk repository has more files than
    // the cap allows, so the count is what stops the ranking.
    const bulk = await pickContextFiles({
      dir: BULK_REPO,
      task: LEXICAL_TASK,
      budgetMs: 60_000,
    });
    expect(bulk.sampleCause).toBe('walk');
    expect(bulk.filesWalked).toBe(CONTEXT_MAX_FILES);
    expect(bulk.picks.map((pick) => pick.path)).toContain('router-config.ts');
    expect(formatContextFilesSection(bulk)).toContain('sample');
  });

  it('says the listing is a sample when the embed cap cut the candidates', async () => {
    const section = formatContextFilesSection(result({ sampleCause: 'embed', embedded: 200 }));
    expect(section).toContain('sample');
    expect(section).toContain('ranked by meaning');

    // The mid repository is small enough to walk and too large to embed whole,
    // so it is the embed cap rather than the walk that cuts the ranking.
    const mid = await pickContextFiles({
      dir: MID_REPO,
      task: LEXICAL_TASK,
      embedder: (texts) => Promise.resolve(texts.map(() => [1, 0])),
      budgetMs: 60_000,
      deps: { cacheDir: tempCacheDir(), embedderId: 'flat', log: () => {} },
    });
    expect(mid.sampleCause).toBe('embed');
    expect(mid.filesWalked).toBeGreaterThan(CONTEXT_MAX_EMBED_FILES);
    expect(mid.embedded).toBe(CONTEXT_MAX_EMBED_FILES);
    expect(formatContextFilesSection(mid)).toContain('sample');
  });

  it('adds a head window per pick when one was asked for', async () => {
    const result = await pickContextFiles({ dir: REPO, task: LEXICAL_TASK, headBytes: 40 });
    const section = formatContextFilesSection(result);
    expect(section).toContain('Head of src/router/config.ts:');
    expect(section).toContain('```');
    expect(section).toContain('ROUTER');
    // The window is capped: the second pick gets one too, and neither runs on.
    expect(section).toContain('Head of src/router/handlers.ts:');
  });

  it('is empty when there is nothing to list', () => {
    expect(formatContextFilesSection(result({ picks: [] }))).toBe('');
  });
});

describe('buildSystemPrompt and the likely-files section', () => {
  it('emits the section under --no-zstack, which the playbook does not control', async () => {
    const ctx = await buildSystemPrompt(LEXICAL_TASK, {
      noZstack: true,
      workspaceDir: REPO,
      log: () => {},
    });
    expect(ctx.playbook).toBe('none');
    expect(ctx.systemPrompt).toContain('## Likely relevant files');
    expect(ctx.systemPrompt).toContain('- src/router/config.ts — path token "router" matched the task');
    // The section is reusable without running the picker again.
    expect(ctx.contextFiles.picks.map((pick) => pick.path)).toEqual([
      'src/router/config.ts',
      'src/router/handlers.ts',
    ]);
  });

  it('omits the section when there is nothing to list', async () => {
    const ctx = await buildSystemPrompt(LEXICAL_TASK, {
      noZstack: true,
      workspaceDir: EMPTY_DIR,
      log: () => {},
    });
    expect(ctx.systemPrompt).not.toContain('## Likely relevant files');
    expect(ctx.contextFiles.picks).toEqual([]);
  });

  it('includes head windows when contextBytes asks for them', async () => {
    const ctx = await buildSystemPrompt(LEXICAL_TASK, {
      noZstack: true,
      workspaceDir: REPO,
      contextBytes: 40,
      log: () => {},
    });
    expect(ctx.systemPrompt).toContain('Head of src/router/config.ts:');
    expect(ctx.systemPrompt).toContain('ROUTER');
  });

  it('ranks by meaning through the prompt when an embedder is supplied', async () => {
    const ctx = await buildSystemPrompt(SEMANTIC_TASK, {
      noZstack: true,
      workspaceDir: REPO,
      embedder: (texts) => Promise.resolve(fakeVectors(texts)),
      log: () => {},
    });
    expect(ctx.systemPrompt).toContain(`- ${STORE_PATH} — semantically close to the task`);
    expect(ctx.contextFiles.semantic).toBe(true);
  });

  it('keeps the workspace section and the picks separate', async () => {
    const ctx = await buildSystemPrompt(LEXICAL_TASK, { noZstack: true, workspaceDir: REPO, log: () => {} });
    expect(ctx.systemPrompt.indexOf('## Workspace')).toBeLessThan(
      ctx.systemPrompt.indexOf('## Likely relevant files'),
    );
  });
});
