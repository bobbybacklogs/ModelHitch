import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ModelHitch, StreamChunk } from '../src/index.js';
import { runToolLoop } from '../src/index.js';
import { createBatchExecutor } from '../harness/index.js';
import {
  MAX_READ_CACHE_ENTRIES,
  createReadCache,
  readCacheKey,
  readCacheNotice,
} from '../harness/read-cache.js';
import { summarizeToolOutput } from '../harness/summarize.js';
import { executeHarnessTool } from '../harness/tools.js';

/**
 * Repeated-read deduplication.
 *
 * A run that reads the same file in several turns should pay for it once. These
 * cases pin the three things that make that safe: the key collapses aliases and
 * symlinks, a read is only answered from the cache while the file still matches
 * the entry, and any mutating call drops everything.
 *
 * The cache is per run, so every case here builds its own instance — a shared
 * one would let a test pass on an entry another test left behind.
 */

const SANDBOX = resolve(__dirname, '.tmp-read-cache-sandbox');
const APP = join(SANDBOX, 'src', 'app.ts');
const BODY = 'export const answer = 42;\n';

beforeAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  mkdirSync(join(SANDBOX, 'src'), { recursive: true });
});

beforeEach(() => {
  writeFileSync(APP, BODY);
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

/** One read through the real tool path, as the executor calls it. */
async function read(
  cache: ReturnType<typeof createReadCache>,
  turn?: number,
  path = 'src/app.ts',
): Promise<{ text: string; outcome: string; note?: string }> {
  const result = await executeHarnessTool(
    'read',
    { path },
    { workspaceDir: SANDBOX, readCache: cache, ...(turn === undefined ? {} : { turn }) },
  );
  return { text: result.text, outcome: result.outcome, ...(result.note === undefined ? {} : { note: result.note }) };
}

describe('the dedupe notice', () => {
  it('names the path, the byte length, and the turn', () => {
    expect(readCacheNotice({ label: 'a.ts', size: 3, mtimeMs: 0, body: 'abc', turn: 2 })).toBe(
      'a.ts unchanged since turn 2 (3 bytes)',
    );
  });

  it('says no turn when none is known, rather than printing a wrong one', () => {
    expect(readCacheNotice({ label: 'a.ts', size: 3, mtimeMs: 0, body: 'abc' })).toBe(
      'a.ts unchanged since an earlier read in this run (3 bytes)',
    );
  });

  it('keeps a summarized body saying that it was summarized', () => {
    const notice = readCacheNotice({
      label: 'a.ts',
      size: 900,
      mtimeMs: 0,
      body: 'head [summarized: 900 chars -> 40] tail',
      turn: 1,
    });
    expect(notice).toContain('[summarized: 900 chars -> 40]');
  });
});

describe('the read cache key', () => {
  it('resolves to the real path, so two spellings collapse', () => {
    expect(readCacheKey(join(SANDBOX, 'src', '..', 'src', 'app.ts'))).toBe(readCacheKey(APP));
  });

  it('cannot throw for a path that is not there', () => {
    expect(() => readCacheKey(join(SANDBOX, 'gone', 'nope.ts'))).not.toThrow();
  });

  it('collapses a symlink onto the file it points at', async (ctx) => {
    const link = join(SANDBOX, 'src', 'link.ts');
    try {
      symlinkSync(APP, link, 'file');
    } catch {
      // Windows needs developer mode or an elevated shell to create one.
      ctx.skip();
      return;
    }
    expect(readCacheKey(link)).toBe(readCacheKey(APP));
  });
});

describe('repeated reads through the tool', () => {
  it('serves the first read whole and the second as a notice', async () => {
    const cache = createReadCache();
    const first = await read(cache, 2);
    expect(first.text).toBe(BODY);
    expect(first.outcome).toBe('ok');

    const second = await read(cache, 2);
    expect(second.text).toBe(`src/app.ts unchanged since turn 2 (${Buffer.byteLength(BODY)} bytes)`);
    // Nothing went wrong — the model already holds these bytes.
    expect(second.outcome).toBe('ok');
    // …and nothing is parked in the UI-only note: the notice already says it.
    expect(second.note).toBeUndefined();
    expect(second.text).not.toContain('export const');
  });

  it('names the turn that supplied the read, not the turn asking again', async () => {
    const cache = createReadCache();
    await read(cache, 2);
    expect((await read(cache, 5)).text).toContain('unchanged since turn 2');
  });

  it('degrades the wording when the caller cannot know the turn', async () => {
    const cache = createReadCache();
    await read(cache);
    const second = await read(cache);
    expect(second.text).toContain('unchanged since an earlier read in this run');
    expect(second.text).not.toMatch(/turn \d/);
  });

  it('collapses two spellings of one path onto one entry', async () => {
    const cache = createReadCache();
    await read(cache, 1, 'src/app.ts');
    const alias = await read(cache, 1, './src/../src/app.ts');
    expect(alias.text).toContain('src/app.ts unchanged since turn 1');
  });

  it('starts empty, so a new run never inherits another run', async () => {
    const first = createReadCache();
    await read(first, 1);
    expect((await read(first, 1)).text).toContain('unchanged');

    const second = createReadCache();
    expect(second.size).toBe(0);
    expect((await read(second, 1)).text).toBe(BODY);
  });

  it('reads the file every time when no cache is supplied', async () => {
    // The pre-existing behaviour for a caller that has no run to scope a cache to.
    const one = await executeHarnessTool('read', { path: 'src/app.ts' }, { workspaceDir: SANDBOX });
    const two = await executeHarnessTool('read', { path: 'src/app.ts' }, { workspaceDir: SANDBOX });
    expect(one.text).toBe(BODY);
    expect(two.text).toBe(BODY);
  });

  it('re-reads a file whose mtime moved, rather than serving the old body', async () => {
    const cache = createReadCache();
    expect((await read(cache, 1)).text).toBe(BODY);

    const future = new Date(Date.now() + 5_000);
    utimesSync(APP, future, future);

    const again = await read(cache, 1);
    expect(again.text).toBe(BODY);
    expect(again.text).not.toContain('unchanged');
  });

  it('re-reads a file whose byte length changed even with the mtime put back', async () => {
    const cache = createReadCache();
    // A whole second, so the mtime the cache recorded can be restored exactly.
    const fixed = new Date(1_700_000_000_000);
    utimesSync(APP, fixed, fixed);
    expect((await read(cache, 1)).text).toBe(BODY);

    const longer = `${BODY}// one more line\n`;
    writeFileSync(APP, longer);
    utimesSync(APP, fixed, fixed);
    expect(statSync(APP).mtimeMs).toBe(fixed.getTime());

    expect((await read(cache, 1)).text).toBe(longer);
  });

  it('falls through to the ordinary error for a file deleted between reads', async () => {
    const cache = createReadCache();
    await read(cache, 1);
    unlinkSync(APP);

    const gone = await executeHarnessTool(
      'read',
      { path: 'src/app.ts' },
      { workspaceDir: SANDBOX, readCache: cache, turn: 2 },
    );
    expect(gone.outcome).toBe('error');
    expect(gone.text.startsWith('Error:')).toBe(true);
    expect(gone.text).toContain('ENOENT');
    expect(gone.text).not.toContain('unchanged');
  });

  it('records a summarized body instead of the file it came from', async () => {
    const cache = createReadCache();
    const raw = `${'x'.repeat(200)}\n`;
    writeFileSync(APP, raw);
    await cache.read(APP, { label: 'src/app.ts', turn: 4, load: async () => readFileSync(APP, 'utf8') });

    // `read` is exempt from summarization today, so this stands in for the case
    // where it is not: what matters is that the cache keeps what the model was
    // served, not what the file held.
    const served = await summarizeToolOutput(raw, {
      tool: 'grep_search',
      threshold: 50,
      deps: { digest: async () => 'digest' },
    });
    expect(served).toMatch(/\[summarized: 201 chars -> \d+\]/);
    cache.recordServed(APP, served);

    const again = await cache.read(APP, {
      label: 'src/app.ts',
      turn: 5,
      load: async () => readFileSync(APP, 'utf8'),
    });
    expect(again).toContain('unchanged since turn 4');
    expect(again).toMatch(/\[summarized: 201 chars -> \d+\]/);
  });
});

describe('invalidation', () => {
  it('drops the whole cache when a mutating call runs', async () => {
    const cache = createReadCache();
    expect((await read(cache, 1)).text).toBe(BODY);

    const written = await executeHarnessTool(
      'write',
      { path: 'src/app.ts', content: 'export const answer = 43;\n' },
      { workspaceDir: SANDBOX, readCache: cache, turn: 2 },
    );
    expect(written.outcome).toBe('ok');

    expect((await read(cache, 3)).text).toBe('export const answer = 43;\n');
  });

  it('drops it for a declined mutating call too', async () => {
    const cache = createReadCache();
    await read(cache, 1);

    const denied = await executeHarnessTool(
      'write',
      { path: 'src/app.ts', content: 'never written\n' },
      { workspaceDir: SANDBOX, readCache: cache, turn: 2, onApproval: async () => false },
    );
    expect(denied.outcome).toBe('declined');

    // The decline wrote nothing, but the cache does not get to reason about
    // that: it is dropped, and the next read re-reads the file.
    const again = await read(cache, 2);
    expect(again.text).toBe(BODY);
    expect(again.text).not.toContain('unchanged');
  });

  it('drops it for a mutating call that failed', async () => {
    const cache = createReadCache();
    await read(cache, 1);

    const failed = await executeHarnessTool(
      'edit',
      { path: 'src/app.ts', oldString: 'not in the file', newString: 'x' },
      { workspaceDir: SANDBOX, readCache: cache, turn: 2 },
    );
    expect(failed.outcome).toBe('error');

    const again = await read(cache, 2);
    expect(again.text).toBe(BODY);
    expect(again.text).not.toContain('unchanged');
  });
});

describe('concurrent reads', () => {
  it('answers two identical reads in one batch from one read of the disk', async () => {
    const cache = createReadCache();
    let loads = 0;
    const load = async (): Promise<string> => {
      loads += 1;
      // Long enough that the second call is still in flight when it arrives.
      await new Promise((done) => setTimeout(done, 20));
      return BODY;
    };

    const [first, second] = await Promise.all([
      cache.read(APP, { label: 'src/app.ts', turn: 1, load }),
      cache.read(APP, { label: 'src/app.ts', turn: 1, load }),
    ]);

    expect(loads).toBe(1);
    expect([first, second].filter((text) => text === BODY)).toHaveLength(1);
    expect([first, second].filter((text) => text.includes('unchanged since turn 1'))).toHaveLength(1);
  });

  it('retries the read when the in-flight one failed', async () => {
    const cache = createReadCache();
    let loads = 0;
    const failing = async (): Promise<string> => {
      loads += 1;
      await new Promise((done) => setTimeout(done, 10));
      throw new Error('ENOENT: no such file or directory');
    };

    const results = await Promise.allSettled([
      cache.read(APP, { label: 'src/app.ts', turn: 1, load: failing }),
      cache.read(APP, { label: 'src/app.ts', turn: 1, load: failing }),
    ]);

    // Both callers hear about the failure; neither is answered from a cache that
    // holds nothing.
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(loads).toBe(2);
  });
});

describe('the entry cap', () => {
  it('holds a bounded number of entries, dropping the oldest', async () => {
    const cache = createReadCache();
    const dir = join(SANDBOX, 'many');
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (let index = 0; index <= MAX_READ_CACHE_ENTRIES + 1; index++) {
      const file = join(dir, `f${index}.txt`);
      writeFileSync(file, `body ${index}\n`);
      files.push(file);
    }
    const loadFor = (file: string) => async (): Promise<string> => readFileSync(file, 'utf8');
    const readEach = async (file: string): Promise<string> =>
      cache.read(file, { label: file, turn: 1, load: loadFor(file) });

    for (const file of files) await readEach(file);
    expect(cache.size).toBe(MAX_READ_CACHE_ENTRIES);

    const oldest = files[0] as string;
    const newest = files[files.length - 1] as string;
    expect(await readEach(oldest)).toContain('body 0');
    expect(await readEach(newest)).toContain('unchanged');
  });
});

/** One turn of a scripted stream: the tool calls a test wants the model to make. */
function toolTurn(calls: Array<{ name: string; args: string }>): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  calls.forEach((call, index) => {
    const id = `call_${index}`;
    chunks.push({ type: 'tool-call-start', id, name: call.name });
    chunks.push({ type: 'tool-call-args-delta', id, argsDelta: call.args });
    chunks.push({ type: 'tool-call-end', id });
  });
  chunks.push({ type: 'finish', finishReason: 'tool-calls' });
  return chunks;
}

/**
 * A client that streams one scripted turn per call. `runToolLoop` only needs
 * `stream` from the client, and a harness run needs a provider, so this is how
 * a turn's batch gets driven without one.
 */
function scriptedClient(turns: StreamChunk[][]): ModelHitch {
  let index = 0;
  return {
    stream: async function* (): AsyncGenerator<StreamChunk> {
      const chunks = turns[Math.min(index, turns.length - 1)] ?? [];
      index += 1;
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as ModelHitch;
}

describe('a run over the batch executor', () => {
  it('shows one full body and one unchanged line, and reads fresh after a write', async () => {
    const cache = createReadCache();
    // Stands in for `streamHarness`'s executor, which cannot run without a
    // provider: the tool call, the turn it belongs to, and the run's cache.
    const execute = async (
      name: string,
      args: Record<string, unknown>,
      turn?: number,
    ): Promise<string> => {
      const result = await executeHarnessTool(name, args, {
        workspaceDir: SANDBOX,
        readCache: cache,
        ...(turn === undefined ? {} : { turn }),
      });
      return result.text;
    };

    const client = scriptedClient([
      toolTurn([
        { name: 'read', args: '{"path":"src/app.ts"}' },
        { name: 'read', args: '{"path":"src/app.ts"}' },
      ]),
      toolTurn([{ name: 'write', args: '{"path":"src/app.ts","content":"export const answer = 43;\\n"}' }]),
      toolTurn([{ name: 'read', args: '{"path":"src/app.ts"}' }]),
      [{ type: 'text-delta', text: 'all done' }, { type: 'finish', finishReason: 'stop' }],
    ]);

    const transcript: string[] = [];
    for await (const event of runToolLoop(
      client,
      { provider: 'mock', model: 'mock-model', messages: [{ role: 'user', content: 'read it twice' }] },
      execute,
      {
        maxTurns: 8,
        executeMany: createBatchExecutor({ concurrency: 4, execute, log: () => undefined }),
      },
    )) {
      if (event.type === 'tool') transcript.push(event.output);
    }

    expect(transcript).toEqual([
      BODY,
      `src/app.ts unchanged since turn 1 (${Buffer.byteLength(BODY)} bytes)`,
      'Wrote src/app.ts (26 chars)',
      'export const answer = 43;\n',
    ]);
  });
});
