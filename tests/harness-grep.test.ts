import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GREP_TOOL_NAME, createGrepTool, formatGrepResult, grepWorkspace } from '../harness/grep.js';
import { executeHarnessTool } from '../harness/tools.js';

/** The executor returns `{ text, outcome }`; these cases assert on the text. */
const toolText = async (
  name: string,
  args: Record<string, unknown>,
  opts?: Parameters<typeof executeHarnessTool>[2],
): Promise<string> => (await executeHarnessTool(name, args, opts)).text;

/**
 * `grep_search` is the most commonly declared tool in the agency agent library
 * (49 of 57 agents), so it needs a real implementation — otherwise the only way
 * to satisfy it would be to hand read-only agents a shell, which can write.
 */

const SANDBOX = resolve(__dirname, '.tmp-grep-sandbox');

beforeAll(() => {
  mkdirSync(join(SANDBOX, 'src', 'nested'), { recursive: true });
  mkdirSync(join(SANDBOX, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(SANDBOX, 'dist'), { recursive: true });
  writeFileSync(join(SANDBOX, 'src', 'a.ts'), 'const needle = 1;\nconst other = 2;\nNEEDLE upper\n');
  writeFileSync(join(SANDBOX, 'src', 'b.txt'), 'no match here\nneedle in text\n');
  writeFileSync(join(SANDBOX, 'src', 'nested', 'c.ts'), 'deep needle\n');
  writeFileSync(join(SANDBOX, 'node_modules', 'pkg', 'index.js'), 'needle in dependencies\n');
  writeFileSync(join(SANDBOX, 'dist', 'bundle.js'), 'needle in build output\n');
  writeFileSync(join(SANDBOX, 'secret.bin'), Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe('grepWorkspace', () => {
  it('finds matches and reports path, line and text', () => {
    const result = grepWorkspace({ pattern: 'needle', dir: SANDBOX });
    const files = new Set(result.matches.map((m) => m.file));
    expect(files.has('src/a.ts')).toBe(true);
    expect(files.has('src/b.txt')).toBe(true);
    expect(files.has('src/nested/c.ts')).toBe(true);
  });

  it('reports 1-based line numbers', () => {
    const result = grepWorkspace({ pattern: 'deep needle', dir: SANDBOX, include: ['ts'] });
    const hit = result.matches.find((m) => m.file === 'src/nested/c.ts');
    expect(hit?.line).toBe(1);
  });

  it('is case-insensitive by default and case-sensitive on request', () => {
    expect(grepWorkspace({ pattern: 'needle', dir: SANDBOX, include: ['ts'] }).matches.length).toBeGreaterThan(0);
    const upper = grepWorkspace({ pattern: 'NEEDLE', dir: SANDBOX, include: ['ts'], caseSensitive: true });
    expect(upper.matches.map((m) => m.line)).toEqual([3]);
  });

  it('skips node_modules and dist', () => {
    const result = grepWorkspace({ pattern: 'needle', dir: SANDBOX, maxResults: 200 });
    expect(result.matches.some((m) => m.file.includes('node_modules'))).toBe(false);
    expect(result.matches.some((m) => m.file.includes('dist/'))).toBe(false);
  });

  it('skips binary files', () => {
    const result = grepWorkspace({ pattern: 'needle', dir: SANDBOX, maxResults: 200 });
    expect(result.matches.some((m) => m.file.includes('secret.bin'))).toBe(false);
    expect(result.filesSkippedBinary).toBeGreaterThanOrEqual(1);
  });

  it('honours the include extension filter', () => {
    const tsOnly = grepWorkspace({ pattern: 'needle', dir: SANDBOX, include: ['ts'] });
    expect(tsOnly.matches.every((m) => m.file.endsWith('.ts'))).toBe(true);
  });

  it('accepts extensions with or without a leading dot', () => {
    const dotted = grepWorkspace({ pattern: 'needle', dir: SANDBOX, include: ['.ts'] });
    const bare = grepWorkspace({ pattern: 'needle', dir: SANDBOX, include: ['ts'] });
    expect(dotted.matches.length).toBe(bare.matches.length);
  });

  it('caps results and flags truncation', () => {
    const result = grepWorkspace({ pattern: 'needle', dir: SANDBOX, maxResults: 2 });
    expect(result.matches.length).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('treats the pattern literally by default, and as a regex only on request', () => {
    // src/regex.txt contains "a.b" then "axb".
    writeFileSync(join(SANDBOX, 'src', 'regex.txt'), 'a.b\naxb\n');
    // Literal: only the exact "a.b" line matches, not "axb".
    const literal = grepWorkspace({ pattern: 'a.b', dir: SANDBOX, include: ['txt'] });
    expect(literal.matches.map((m) => m.text)).toEqual(['a.b']);
    // Regex: the dot matches any character, so both lines match.
    const asRegex = grepWorkspace({ pattern: 'a.b', dir: SANDBOX, include: ['txt'], regex: true });
    expect(asRegex.matches.map((m) => m.text)).toEqual(['a.b', 'axb']);
  });

  it('supports regex mode', () => {
    const asRegex = grepWorkspace({ pattern: 'needle\\s+in', dir: SANDBOX, include: ['txt'], regex: true });
    expect(asRegex.matches.length).toBeGreaterThanOrEqual(1);
  });

  it('reports an invalid regex rather than throwing', () => {
    const result = grepWorkspace({ pattern: '([unclosed', dir: SANDBOX, regex: true });
    expect(result.error).toContain('Invalid regular expression');
    expect(result.matches).toEqual([]);
  });

  it('reports an empty pattern', () => {
    expect(grepWorkspace({ pattern: '', dir: SANDBOX }).error).toContain('non-empty pattern');
  });

  it('reports a missing directory instead of throwing', () => {
    const result = grepWorkspace({ pattern: 'x', dir: join(SANDBOX, 'nope') });
    expect(result.error).toContain('Directory not found');
  });

  it('returns an empty match list with no error when nothing matches', () => {
    const result = grepWorkspace({ pattern: 'zzzznomatch', dir: SANDBOX });
    expect(result.matches).toEqual([]);
    expect(result.error).toBeUndefined();
  });
});

describe('formatGrepResult', () => {
  it('renders matches as path:line: text', () => {
    const text = formatGrepResult(
      { matches: [{ file: 'src/a.ts', line: 3, text: 'needle' }], truncated: false, filesScanned: 1, filesSkippedBinary: 0 },
      'needle',
    );
    expect(text).toContain('src/a.ts:3: needle');
  });

  it('labels the second count as files scanned, not files containing matches', () => {
    // A real subagent read the old wording ("1 match(es) ... in 2 file(s)") as
    // self-contradictory, so the counts are stated unambiguously now.
    const text = formatGrepResult(
      { matches: [{ file: 'notes.md', line: 2, text: 'x' }], truncated: false, filesScanned: 2, filesSkippedBinary: 0 },
      'x',
    );
    expect(text).toContain('1 match for "x" (scanned 2 files)');
    expect(text).not.toContain('match(es)');
    expect(text).not.toContain('file(s)');
  });

  it('pluralises counts correctly', () => {
    const one = formatGrepResult(
      { matches: [{ file: 'a', line: 1, text: 'x' }], truncated: false, filesScanned: 1, filesSkippedBinary: 0 },
      'x',
    );
    expect(one).toContain('1 match for "x" (scanned 1 file)');
    const two = formatGrepResult(
      {
        matches: [
          { file: 'a', line: 1, text: 'x' },
          { file: 'b', line: 2, text: 'x' },
        ],
        truncated: false,
        filesScanned: 3,
        filesSkippedBinary: 0,
      },
      'x',
    );
    expect(two).toContain('2 matches for "x" (scanned 3 files)');
  });

  it('says so when nothing matched', () => {
    const text = formatGrepResult(
      { matches: [], truncated: false, filesScanned: 5, filesSkippedBinary: 0 },
      'needle',
    );
    expect(text).toContain('No matches');
    expect(text).toContain('scanned 5 files');
  });

  it('notes truncation', () => {
    const text = formatGrepResult(
      { matches: [{ file: 'a', line: 1, text: 'x' }], truncated: true, filesScanned: 1, filesSkippedBinary: 0 },
      'x',
    );
    expect(text).toContain('truncated');
  });

  it('renders an error cleanly', () => {
    const text = formatGrepResult({ matches: [], truncated: false, filesScanned: 0, filesSkippedBinary: 0, error: 'boom' }, 'x');
    expect(text).toBe('Error: boom');
  });
});

describe('the bihan-shaped grep tool', () => {
  it('exposes the flat ModelHitch shape', () => {
    const tool = createGrepTool(SANDBOX);
    expect(tool.name).toBe(GREP_TOOL_NAME);
    const def = tool.toModelHitch();
    expect(def.name).toBe(GREP_TOOL_NAME);
    expect(def.parameters.type).toBe('object');
    expect(def.parameters.required).toEqual(['pattern']);
    // Must not be pre-wrapped: ModelHitch wraps tools itself.
    expect((def as Record<string, unknown>)['function']).toBeUndefined();
  });

  it('runs a search and returns text', async () => {
    const out = await createGrepTool(SANDBOX).run({ pattern: 'needle' });
    expect(out).toContain('src/a.ts');
  });

  it('defaults to the workspace root when no path is given', async () => {
    const out = await createGrepTool(SANDBOX).run({ pattern: 'deep needle' });
    expect(out).toContain('src/nested/c.ts');
  });

  it('resolves a relative path inside the workspace', async () => {
    const out = await createGrepTool(SANDBOX).run({ pattern: 'needle', path: 'src/nested' });
    expect(out).toContain('c.ts');
    expect(out).not.toContain('a.ts');
  });

  it('accepts a JSON string of arguments, as bihan may pass through', async () => {
    const out = await createGrepTool(SANDBOX).run('{"pattern":"needle","include":["ts"]}');
    expect(out).toContain('src/');
  });

  it('returns an error string for unparseable arguments instead of throwing', async () => {
    const out = await createGrepTool(SANDBOX).run('{not json');
    expect(out).toContain('Error');
  });

  it('runs with no context argument, since bihan calls run(rawArgs)', async () => {
    // bihan invokes run(rawArgs, context); the tool must not depend on context.
    await expect(createGrepTool(SANDBOX).run({ pattern: 'needle' })).resolves.toBeTypeOf('string');
  });
});

describe('grep_search through the harness dispatcher', () => {
  it('is actually wired, not merely declared', async () => {
    // Declaring a tool that the dispatcher does not handle would fail only at
    // call time, so this drives the real dispatch path.
    const out = await toolText('grep_search', { pattern: 'deep needle' }, { workspaceDir: SANDBOX });
    expect(out).toContain('src/nested/c.ts');
  });

  it('resolves the search directory against the workspace', async () => {
    const out = await toolText(
      'grep_search',
      { pattern: 'needle', path: 'src/nested' },
      { workspaceDir: SANDBOX },
    );
    expect(out).toContain('c.ts');
    expect(out).not.toContain('a.ts');
  });

  it('honours include and caseSensitive through the dispatcher', async () => {
    const out = await toolText(
      'grep_search',
      { pattern: 'NEEDLE', include: ['ts'], caseSensitive: true },
      { workspaceDir: SANDBOX },
    );
    expect(out).toContain('a.ts:3');
  });

  it('returns an error string rather than throwing on a bad path', async () => {
    const out = await toolText('grep_search', { pattern: 'x', path: 'nope' }, { workspaceDir: SANDBOX });
    expect(out).toContain('Error');
  });
});
