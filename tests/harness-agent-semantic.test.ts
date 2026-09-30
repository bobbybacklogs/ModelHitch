import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TIER_TOOLS,
  searchAgents,
  searchAgentsSemantic,
  type EmbedFn,
  type LibraryAgent,
} from '../harness/agent-library.js';

/**
 * Semantic agent selection.
 *
 * The lexical search is pure string matching, so a query worded differently from
 * the definitions finds nothing at all. These tests pin three things: that an
 * embedder actually decides the ranking, that a warm cache makes a repeat search
 * free, and that every way semantic search can fail degrades to the lexical
 * results instead of throwing.
 */

const tempDirs: string[] = [];

function tempCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-semantic-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

function makeAgent(name: string, description: string, body: string): LibraryAgent {
  return {
    name,
    description,
    body,
    declaredTools: [],
    grantedTools: TIER_TOOLS.readonly.slice(),
    unsupportedTools: [],
    tier: 'readonly',
    sandboxed: false,
    delegatable: true,
    sourcePath: `${name}/agent.md`,
    warnings: [],
  };
}

/**
 * Deterministic stand-in for an embedder: two intent bins over the vocabulary of
 * these bodies. It is not a language model, but it reproduces the one property
 * under test, which is that text about stored records lands near a query about
 * "how the records are shaped" without sharing a single word with it.
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

function stubEmbedder(): { embed: EmbedFn; calls: () => number } {
  let calls = 0;
  return {
    embed: (texts: string[]) => {
      calls++;
      return Promise.resolve(fakeVectors(texts));
    },
    calls: () => calls,
  };
}

/** The intent-matching query, and a library whose names share no word with it. */
const QUERY = 'change how the records are shaped';
const AGENTS = [
  makeAgent(
    'atlas',
    'Storage and schema ownership',
    'Database migrations, backfills, and schema evolution for a primary store.',
  ),
  makeAgent(
    'beacon',
    'Interface craft and visual language',
    'Typography, colour tokens, and layout polish for product surfaces.',
  ),
];

describe('searchAgentsSemantic', () => {
  it('ranks the intent match first when no name shares a word with the query', async () => {
    // Keyword routing finds nothing here, so the ordering below can only come
    // from the embedder: this replaced lexical matching rather than sitting
    // alongside it.
    expect(searchAgents(AGENTS, QUERY)).toEqual([]);

    const matches = await searchAgentsSemantic(AGENTS, QUERY, 8, {
      embed: (texts) => Promise.resolve(fakeVectors(texts)),
      cacheDir: tempCacheDir(),
      embedderId: 'stub',
    });

    expect(matches.map((m) => m.name)).toEqual(['atlas', 'beacon']);
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
    // Same shape as the lexical search, so the roster needs no adaptation.
    expect(Object.keys(matches[0]!).sort()).toEqual(['description', 'name', 'score', 'tier']);
  });

  it('applies the limit', async () => {
    const matches = await searchAgentsSemantic(AGENTS, QUERY, 1, {
      embed: (texts) => Promise.resolve(fakeVectors(texts)),
      cacheDir: tempCacheDir(),
      embedderId: 'stub',
    });
    expect(matches.map((m) => m.name)).toEqual(['atlas']);
  });

  it('lets the lexical score break ties between equally close agents', async () => {
    // Both bodies land in the same bin, so only the lexical share separates them.
    const twins = [
      makeAgent('atlas', 'Storage ownership', 'Schema and database migrations for the primary store.'),
      makeAgent('beacon', 'Storage helper', 'Database migrations and schema notes for the secondary store.'),
    ];
    const matches = await searchAgentsSemantic(twins, 'secondary store', 8, {
      embed: (texts) => Promise.resolve(texts.map(() => [1, 0])),
      cacheDir: tempCacheDir(),
      embedderId: 'stub',
      semanticWeight: 0,
    });
    expect(matches[0]!.name).toBe('beacon');
  });

  it('caches vectors in one JSON file keyed by embedder id plus text', async () => {
    const cacheDir = tempCacheDir();
    await searchAgentsSemantic(AGENTS, QUERY, 8, {
      embed: (texts) => Promise.resolve(fakeVectors(texts)),
      cacheDir,
      embedderId: 'stub-model',
    });

    const parsed = JSON.parse(readFileSync(join(cacheDir, 'stub-model.json'), 'utf8')) as Record<
      string,
      number[]
    >;
    // One entry per agent plus the query itself.
    expect(Object.keys(parsed)).toHaveLength(3);
    const atlasText = `atlas\nStorage and schema ownership\n${AGENTS[0]!.body}`;
    const key = createHash('sha256').update(`stub-model\u0000${atlasText}`, 'utf8').digest('hex');
    expect(parsed[key]).toEqual([1, 0]);
  });

  it('a warm cache makes no embed call at all, and deleting it changes nothing', async () => {
    const cacheDir = tempCacheDir();
    const counter = stubEmbedder();
    const deps = { embed: counter.embed, cacheDir, embedderId: 'stub' };

    const first = await searchAgentsSemantic(AGENTS, QUERY, 8, deps);
    // One batched call for both agents plus the query.
    expect(counter.calls()).toBe(1);

    const second = await searchAgentsSemantic(AGENTS, QUERY, 8, deps);
    expect(counter.calls()).toBe(1);
    expect(second).toEqual(first);

    // The cache is the only reason the second run was free, so removing it has
    // to cost exactly one more call and produce the same ranking.
    rmSync(cacheDir, { recursive: true, force: true });
    const third = await searchAgentsSemantic(AGENTS, QUERY, 8, deps);
    expect(counter.calls()).toBe(2);
    expect(third).toEqual(first);
  });

  it('re-embeds an entry whose cached vector has the wrong dimension', async () => {
    const cacheDir = tempCacheDir();
    const counter = stubEmbedder();
    const deps = { embed: counter.embed, cacheDir, embedderId: 'stub' };

    const baseline = await searchAgentsSemantic(AGENTS, QUERY, 8, deps);
    const file = join(cacheDir, 'stub.json');
    const cache = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number[]>;

    // A vector a different embedder left behind: same key, unusable width.
    const staleKey = Object.keys(cache)[0]!;
    cache[staleKey] = [1, 0, 0];
    writeFileSync(file, JSON.stringify(cache));

    const repaired = await searchAgentsSemantic(AGENTS, QUERY, 8, deps);

    // Only the stale entry was re-embedded, and the search never crashed.
    expect(counter.calls()).toBe(2);
    expect(repaired).toEqual(baseline);
    const rewritten = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number[]>;
    expect(rewritten[staleKey]).toEqual([1, 0]);
  });

  it('falls back to the lexical results when the embedder rejects, and warns once', async () => {
    const log = vi.fn();
    const deps = {
      embed: () => Promise.reject(new Error('no embedding endpoint')),
      cacheDir: tempCacheDir(),
      embedderId: 'stub',
      log,
    };

    const expected = searchAgents(AGENTS, 'schema migration', 8);
    expect(expected.map((m) => m.name)).toEqual(['atlas']);

    const first = await searchAgentsSemantic(AGENTS, 'schema migration', 8, deps);
    const second = await searchAgentsSemantic(AGENTS, 'schema migration', 8, deps);

    expect(first.map((m) => m.name)).toEqual(['atlas']);
    expect(second).toEqual(first);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('keyword search');
  });

  it('falls back when the embedder throws synchronously, and warns once', async () => {
    const log = vi.fn();
    const matches = await searchAgentsSemantic(AGENTS, 'schema migration', 8, {
      embed: () => {
        throw new Error('misconfigured client');
      },
      cacheDir: tempCacheDir(),
      embedderId: 'stub',
      log,
    });

    expect(matches.map((m) => m.name)).toEqual(['atlas']);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('treats an unusable embedder response as a failure rather than scoring it', async () => {
    const log = vi.fn();
    const matches = await searchAgentsSemantic(AGENTS, 'schema migration', 8, {
      // Three texts were sent (two agents plus the query); one vector came back.
      embed: () => Promise.resolve([[1, 0]]),
      cacheDir: tempCacheDir(),
      embedderId: 'stub',
      log,
    });

    expect(matches.map((m) => m.name)).toEqual(['atlas']);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('returns the lexical results and warns once when no embedder is supplied', async () => {
    const log = vi.fn();
    const matches = await searchAgentsSemantic(AGENTS, 'schema migration', 8, {
      cacheDir: tempCacheDir(),
      log,
    });

    expect(matches.map((m) => m.name)).toEqual(['atlas']);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('degrades silently with no embedder and no logger', async () => {
    // The fallback must never throw, even for a caller that passed nothing.
    await expect(searchAgentsSemantic(AGENTS, 'schema migration')).resolves.toHaveLength(1);
    await expect(searchAgentsSemantic(AGENTS, 'schema migration', 8, {})).resolves.toEqual(
      searchAgents(AGENTS, 'schema migration', 8),
    );
  });

  it('returns nothing for an empty library or an empty query, without embedding', async () => {
    const counter = stubEmbedder();
    const deps = { embed: counter.embed, cacheDir: tempCacheDir(), embedderId: 'stub' };

    expect(await searchAgentsSemantic([], QUERY, 8, deps)).toEqual([]);
    expect(await searchAgentsSemantic(AGENTS, '   ', 8, deps)).toEqual([]);
    expect(await searchAgentsSemantic(AGENTS, '', 8, deps)).toEqual([]);
    expect(counter.calls()).toBe(0);
  });

  it('ignores a corrupt cache file instead of failing the search', async () => {
    const cacheDir = tempCacheDir();
    writeFileSync(join(cacheDir, 'stub.json'), '{ this is not json');

    const matches = await searchAgentsSemantic(AGENTS, QUERY, 8, {
      embed: (texts) => Promise.resolve(fakeVectors(texts)),
      cacheDir,
      embedderId: 'stub',
    });

    expect(matches.map((m) => m.name)).toEqual(['atlas', 'beacon']);
  });

  it('keeps an embedder id out of the filesystem path it does not belong in', async () => {
    const cacheDir = tempCacheDir();
    await searchAgentsSemantic(AGENTS, QUERY, 8, {
      embed: (texts) => Promise.resolve(fakeVectors(texts)),
      cacheDir,
      embedderId: '../escape',
    });

    // The file stays inside the cache directory rather than two levels up.
    expect(readFileSync(join(cacheDir, '.._escape.json'), 'utf8').length).toBeGreaterThan(0);
  });
});
