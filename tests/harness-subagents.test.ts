import { describe, expect, it, vi, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { ModelHitch } from '../src/index.js';
import {
  DEFAULT_SUBAGENTS,
  bihanCandidates,
  createSubagentRoster,
  describeSubagents,
  isFileTarget,
  loadBihan,
  toFlatDefinition,
  toImportSpecifier,
} from '../harness/subagents.js';

/**
 * The subagent adapter bridges bihan (a separate, sibling package) into the
 * harness's tool loop. bihan is resolved at runtime rather than declared as a
 * dependency, so these tests cover both states: present (delegation works) and
 * absent (the harness is unchanged and still starts).
 */

const bihanAvailable = (await loadBihan()) !== null;
const maybe = bihanAvailable ? it : it.skip;

function mockClient(): ModelHitch {
  return new ModelHitch({ defaultProviderId: 'mock', defaultModel: 'mock-model' });
}

/**
 * Most tests here pin the built-in roster, so they disable folder discovery with
 * `agentsDir: null`. Library-backed behaviour is covered separately.
 */
async function builtinRoster(overrides: Record<string, unknown> = {}) {
  return createSubagentRoster(mockClient(), {
    model: 'mock/mock-model',
    workspaceDir: process.cwd(),
    agentsDir: null,
    ...overrides,
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('bihan resolution', () => {
  it('lists the sibling checkout as a candidate', () => {
    const candidates = bihanCandidates();
    expect(candidates.some((c) => c.includes('bihan_harness'))).toBe(true);
    // Normalise separators: these are native Windows paths.
    expect(candidates.every((c) => c.replace(/\\/g, '/').endsWith('dist/index.js'))).toBe(true);
  });

  it('honours HARNESS_BIHAN_DIR when set', () => {
    vi.stubEnv('HARNESS_BIHAN_DIR', 'D:\\somewhere\\bihan');
    expect(bihanCandidates()[0]).toContain('somewhere');
  });

  it('returns null instead of throwing when bihan cannot be found', async () => {
    vi.stubEnv('HARNESS_BIHAN_DIR', 'D:\\definitely\\not\\here');
    // The bare specifier is not installed in this repo, and the stubbed path
    // does not exist, so there is nothing to load.
    const loaded = await loadBihan();
    expect(loaded === null || typeof loaded.module.Bihan === 'function').toBe(true);
  });

  it('describes availability without throwing either way', async () => {
    const line = await describeSubagents();
    expect(line).toMatch(/^subagents=(on|off)/);
    if (!bihanAvailable) expect(line).toContain('bihan not found');
  });
});

describe('import specifier handling', () => {
  // Regression: the original check required a forward slash, so a Windows path
  // like C:\...\bihan_harness\dist\index.js was treated as a package name and
  // import() failed under Node's real loader — while vitest's resolver happily
  // resolved it. That is why this is asserted purely, with no loader involved.
  it('treats Windows absolute paths as files, not packages', () => {
    expect(isFileTarget('C:\\Users\\me\\bihan_harness\\dist\\index.js')).toBe(true);
    expect(isFileTarget('C:/Users/me/bihan_harness/dist/index.js')).toBe(true);
    expect(isFileTarget('D:\\other\\bihan\\dist\\index.js')).toBe(true);
  });

  it('treats relative and posix paths as files', () => {
    expect(isFileTarget('./x.js')).toBe(true);
    expect(isFileTarget('../x.js')).toBe(true);
    expect(isFileTarget('/usr/lib/x.js')).toBe(true);
  });

  it('treats a package name as a package', () => {
    expect(isFileTarget('@genoventures-labs/bihan')).toBe(false);
    expect(isFileTarget('modelhitch')).toBe(false);
  });

  it('converts a Windows path to a file:// URL that Node can import', () => {
    const url = toImportSpecifier('C:\\Users\\me\\bihan_harness\\dist\\index.js');
    expect(url.startsWith('file:///')).toBe(true);
    expect(url).toContain('bihan_harness');
    // Backslashes must not survive into the URL.
    expect(url).not.toContain('\\');
  });

  it('leaves a package name untouched', () => {
    expect(toImportSpecifier('@genoventures-labs/bihan')).toBe('@genoventures-labs/bihan');
  });

  it('every candidate it generates is importable as a file URL', () => {
    for (const candidate of bihanCandidates()) {
      expect(isFileTarget(candidate)).toBe(true);
      expect(toImportSpecifier(candidate).startsWith('file:///')).toBe(true);
    }
  });
});

describe('toFlatDefinition', () => {
  const fake = (shape: Record<string, unknown>) =>
    ({ name: 'fallback_name', description: 'fallback', toModelHitch: () => shape }) as never;

  it('passes through the flat shape bihan now returns', () => {
    const def = toFlatDefinition(
      fake({ name: 'echo_value', description: 'echo', parameters: { type: 'object', properties: {} } }),
    );
    expect(def).toEqual({
      name: 'echo_value',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
    });
  });

  it('unwraps a pre-wrapped tool from older bihan versions', () => {
    // bihan 0.1.0 returned the OpenAI-wrapped shape, which ModelHitch would
    // double-wrap into function.function with no top-level name.
    const def = toFlatDefinition(
      fake({
        type: 'function',
        function: { name: 'echo_value', description: 'echo', parameters: { type: 'object' } },
      }),
    );
    expect(def.name).toBe('echo_value');
    expect(def.parameters).toEqual({ type: 'object' });
    expect(def).not.toHaveProperty('function');
  });

  it('never emits a nested function key', () => {
    const def = toFlatDefinition(fake({ function: { name: 'x' } }));
    expect(def).not.toHaveProperty('function');
    expect(def.name).toBe('x');
  });

  it('falls back to an object schema when parameters are missing', () => {
    const def = toFlatDefinition(fake({ name: 'bare' }));
    expect(def.parameters).toEqual({ type: 'object', properties: {} });
  });
});

describe('subagent roster (built-ins)', () => {
  maybe('exposes one subagent tool declaring the registered specialists', async () => {
    const roster = await builtinRoster();

    expect(roster).not.toBeNull();
    expect(roster!.tool.name).toBe('subagent');
    expect(roster!.source.kind).toBe('builtin');
    expect(roster!.names).toEqual(['Scout', 'Builder', 'Verifier']);
    expect(roster!.tool.parameters!['required']).toEqual(['agent', 'task']);
    const description = String(roster!.tool.description);
    for (const name of roster!.names) expect(description).toContain(name);
  });

  maybe('delegates to a named subagent and returns its answer', async () => {
    const roster = await builtinRoster();

    const out = await roster!.execute('subagent', { agent: 'Scout', task: 'survey the repo' });

    // The mock provider echoes the task back, proving the subagent's own loop ran.
    expect(out).toContain('survey the repo');
  });

  maybe('rejects an unknown subagent without throwing', async () => {
    const roster = await builtinRoster();

    const out = await roster!.execute('subagent', { agent: 'Nobody', task: 'x' });
    expect(out).toContain('unknown subagent "Nobody"');
    expect(out).toContain('Scout');
  });

  maybe('rejects a dispatch missing its task', async () => {
    const roster = await builtinRoster();
    expect(await roster!.execute('subagent', { agent: 'Scout' })).toContain('needs both');
  });

  maybe('accepts a custom agent list, which overrides the library and built-ins', async () => {
    const roster = await builtinRoster({
      agentsDir: undefined,
      agents: [{ name: 'Only', role: 'Solo', instructions: 'do it', tools: 'readonly' }],
    });
    expect(roster!.names).toEqual(['Only']);
    expect(roster!.source.kind).toBe('explicit');
  });

  maybe('ships read-only, shell, and full tool tiers', async () => {
    expect(DEFAULT_SUBAGENTS.map((a) => [a.name, a.tools])).toEqual([
      ['Scout', 'readonly'],
      ['Builder', 'full'],
      ['Verifier', 'shell'],
    ]);
    // The Scout must not be able to modify the workspace.
    expect(DEFAULT_SUBAGENTS[0]!.instructions).toContain('cannot modify');
    // The Verifier must be able to run tests, and its instructions must be
    // honest that shell access is write access — an absolute "cannot write"
    // claim would be false, since `echo x> f` works without any edit tool.
    expect(DEFAULT_SUBAGENTS[2]!.instructions).toContain('run the relevant build and tests');
    expect(DEFAULT_SUBAGENTS[2]!.instructions).toContain('must not modify the workspace');
    expect(DEFAULT_SUBAGENTS[2]!.instructions).toContain('shell can');
  });

  maybe('wires the tool tiers for real, not just in the spec', async () => {
    const roster = await builtinRoster();

    // Only `readonly` is an enforceable restriction: no edit tool AND no shell.
    const scout = roster!.toolNamesFor('Scout');
    expect(scout).toContain('read_file');
    expect(scout).toContain('list_files');
    expect(scout).toContain('grep_search');
    expect(scout).not.toContain('write_file');
    expect(scout).not.toContain('run_command');

    const verifier = roster!.toolNamesFor('Verifier');
    // Can run the tests...
    expect(verifier).toContain('run_command');
    expect(verifier).toContain('read_file');
    // ...and holds no edit tool. NOTE: this does not make it read-only — its
    // shell can still write files. Only `readonly` (no shell) is enforceable.
    expect(verifier).not.toContain('write_file');

    const builder = roster!.toolNamesFor('Builder');
    expect(builder).toContain('write_file');
    expect(builder).toContain('run_command');
  });

  maybe('ownsTool distinguishes its tools from the harness tools', async () => {
    const roster = await builtinRoster();
    expect(roster!.ownsTool('subagent')).toBe(true);
    expect(roster!.ownsTool('find_subagent')).toBe(false); // built-ins: no catalogue
    expect(roster!.ownsTool('bash')).toBe(false);
  });

  maybe('returns null (not a throw) when bihan is unavailable', async () => {
    vi.stubEnv('HARNESS_BIHAN_DIR', 'D:\\definitely\\not\\here');
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: null,
    });
    // Either it found an installed bihan (fine) or it degraded to null.
    expect(roster === null || roster.tool.name === 'subagent').toBe(true);
  });
});

describe('subagent roster (agent library)', () => {
  const FIXTURES = resolve(__dirname, 'fixtures', 'agents');

  maybe('loads agents from a folder instead of the built-ins', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: FIXTURES,
    });

    expect(roster!.source).toEqual({ kind: 'library', dir: resolve(FIXTURES) });
    expect(roster!.names).toContain('alpha');
    expect(roster!.names).toContain('beta');
    expect(roster!.names).not.toContain('Scout');
    // The orchestrator definition excludes itself.
    expect(roster!.names).not.toContain('orchestrator');
  });

  maybe('exposes find_subagent only for a library roster', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: FIXTURES,
    });

    expect(roster!.tools.map((t) => t.name)).toEqual(['subagent', 'find_subagent']);
    expect(roster!.ownsTool('find_subagent')).toBe(true);
    const found = await roster!.execute('find_subagent', { query: 'sandbox shell' });
    expect(found).toContain('delta');
  });

  maybe('find_subagent reports no match rather than failing', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: FIXTURES,
    });
    expect(await roster!.execute('find_subagent', { query: 'zzzzqqqq' })).toContain('No subagent matched');
    expect(await roster!.execute('find_subagent', { query: '' })).toContain('non-empty query');
  });

  maybe('delegates to a library agent', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: FIXTURES,
    });

    const out = await roster!.execute('subagent', { agent: 'alpha', task: 'inspect the repo' });
    expect(out).toContain('inspect the repo');
  });

  maybe('points at find_subagent when asked for an unknown agent', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: FIXTURES,
    });
    const out = await roster!.execute('subagent', { agent: 'Nobody', task: 'x' });
    expect(out).toContain('unknown subagent');
    expect(out).toContain('find_subagent');
  });

  maybe('grants each library agent its derived tier tools', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: FIXTURES,
    });

    // alpha declares only read tools.
    const alpha = roster!.toolNamesFor('alpha');
    expect(alpha).toContain('read_file');
    expect(alpha).toContain('grep_search');
    expect(alpha).not.toContain('write_file');
    expect(alpha).not.toContain('run_command');

    // beta declares edits and shell.
    const beta = roster!.toolNamesFor('beta');
    expect(beta).toContain('write_file');
    expect(beta).toContain('run_command');

    // delta is sandboxed, so its declared shell is withheld.
    const delta = roster!.toolNamesFor('delta');
    expect(delta).not.toContain('run_command');
    expect(delta).toContain('grep_search');
  });

  maybe('reports per-agent descriptors for diagnostics', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: FIXTURES,
    });

    const epsilon = roster!.entries.find((e) => e.name === 'epsilon')!;
    expect(epsilon.unsupportedTools).toEqual(['manage_task']);
    expect(epsilon.tier).toBe('readonly');

    const delta = roster!.entries.find((e) => e.name === 'delta')!;
    expect(delta.sandboxed).toBe(true);
  });

  maybe('falls back to built-ins when the folder does not exist', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: resolve(FIXTURES, 'nope'),
    });
    expect(roster!.source.kind).toBe('builtin');
    expect(roster!.names).toEqual(['Scout', 'Builder', 'Verifier']);
  });

  maybe('honours an exclude override', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agentsDir: FIXTURES,
      exclude: [],
    });
    expect(roster!.names).toContain('orchestrator');
  });
});
