import { describe, expect, it, vi, afterEach } from 'vitest';
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

describe('subagent roster', () => {
  maybe('exposes one subagent tool declaring the registered specialists', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
    });

    expect(roster).not.toBeNull();
    expect(roster!.tool.name).toBe('subagent');
    expect(roster!.names).toEqual(['Scout', 'Builder', 'Verifier']);
    expect(roster!.tool.parameters!['required']).toEqual(['agent', 'task']);
    const description = String(roster!.tool.description);
    for (const name of roster!.names) expect(description).toContain(`"${name}"`);
  });

  maybe('delegates to a named subagent and returns its answer', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
    });

    const out = await roster!.execute({ agent: 'Scout', task: 'survey the repo' });

    // The mock provider echoes the task back, proving the subagent's own loop ran.
    expect(out).toContain('survey the repo');
  });

  maybe('rejects an unknown subagent without throwing', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
    });

    const out = await roster!.execute({ agent: 'Nobody', task: 'x' });
    expect(out).toContain('unknown subagent "Nobody"');
    expect(out).toContain('Scout');
  });

  maybe('rejects a dispatch missing its task', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
    });
    expect(await roster!.execute({ agent: 'Scout' })).toContain('needs both');
  });

  maybe('accepts a custom agent list', async () => {
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
      agents: [{ name: 'Only', role: 'Solo', instructions: 'do it', tools: 'readonly' }],
    });
    expect(roster!.names).toEqual(['Only']);
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
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
    });

    // Only `readonly` is an enforceable restriction: no edit tool AND no shell.
    const scout = roster!.toolNamesFor('Scout');
    expect(scout).toContain('read_file');
    expect(scout).toContain('list_files');
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

  maybe('returns null (not a throw) when bihan is unavailable', async () => {
    vi.stubEnv('HARNESS_BIHAN_DIR', 'D:\\definitely\\not\\here');
    const roster = await createSubagentRoster(mockClient(), {
      model: 'mock/mock-model',
      workspaceDir: process.cwd(),
    });
    // Either it found an installed bihan (fine) or it degraded to null.
    expect(roster === null || roster.tool.name === 'subagent').toBe(true);
  });
});
