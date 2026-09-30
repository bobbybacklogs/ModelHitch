import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  WORKSPACE_BUDGET_MS,
  detectWorkspace,
  formatManifestList,
  formatWorkspaceFacts,
  formatWorkspaceSection,
  unknownWorkspaceFacts,
} from '../harness/detect-workspace.js';
import { buildSystemPrompt } from '../harness/prompt.js';

/**
 * Detection runs before the first token of a run, so these cases are about the
 * two things that matter there: the facts a caller reads, and the promise that
 * nothing in the module throws or hangs.
 */

const SANDBOX = resolve(__dirname, '.tmp-detect-workspace');
const TS_REPO = join(SANDBOX, 'ts-repo');
const PY_REPO = join(SANDBOX, 'py-repo');
const EMPTY_DIR = join(SANDBOX, 'empty');
const MANY_MANIFESTS = join(SANDBOX, 'many-manifests');
const NOISY = join(SANDBOX, 'noisy');
const WIDE = join(SANDBOX, 'wide');

function fill(dir: string, name: string, content = 'x\n'): void {
  writeFileSync(join(dir, name), content);
}

beforeAll(() => {
  for (const dir of [TS_REPO, PY_REPO, EMPTY_DIR, MANY_MANIFESTS, NOISY, WIDE]) {
    mkdirSync(dir, { recursive: true });
  }

  // A TypeScript repository: two manifests, a lockfile, and sources below the root.
  mkdirSync(join(TS_REPO, 'src', 'nested'), { recursive: true });
  fill(TS_REPO, 'package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest run' } }));
  fill(TS_REPO, 'package-lock.json', '{}');
  fill(TS_REPO, 'tsconfig.json', '{}');
  fill(join(TS_REPO, 'src'), 'a.ts');
  fill(join(TS_REPO, 'src'), 'b.ts');
  fill(join(TS_REPO, 'src'), 'b.test.ts');
  fill(join(TS_REPO, 'src', 'nested'), 'c.ts');
  fill(TS_REPO, 'README.md');

  // A Python repository with no Node manifest at all.
  mkdirSync(join(PY_REPO, 'app'), { recursive: true });
  fill(PY_REPO, 'pyproject.toml', '[project]\nname = "demo"\n');
  fill(join(PY_REPO, 'app'), 'main.py');
  fill(join(PY_REPO, 'app'), 'util.py');
  fill(join(PY_REPO, 'app'), 'test_main.py');

  // Five manifests, so the reported list has to collapse two of them.
  for (const name of ['package.json', 'tsconfig.json', 'pyproject.toml', 'go.mod', 'Cargo.toml']) {
    fill(MANY_MANIFESTS, name, name === 'package.json' ? '{}' : '');
  }

  // Dependency, build and VCS directories whose sources must not be counted.
  mkdirSync(join(NOISY, 'src'), { recursive: true });
  mkdirSync(join(NOISY, 'dist'), { recursive: true });
  mkdirSync(join(NOISY, '.git'), { recursive: true });
  fill(NOISY, 'pyproject.toml', '[project]\n');
  fill(join(NOISY, 'src'), 'kept.py');
  for (let i = 0; i < 25; i++) {
    mkdirSync(join(NOISY, 'node_modules', `pkg${i}`), { recursive: true });
    fill(join(NOISY, 'node_modules', `pkg${i}`), 'index.js');
    fill(join(NOISY, 'dist'), `bundle${i}.js`);
    fill(join(NOISY, '.git'), `object${i}.js`);
  }

  // Many directories rather than one, so a short budget has to be checked
  // against real directory reads instead of a single listing.
  for (let i = 0; i < 150; i++) {
    const dir = join(WIDE, `d${i}`);
    mkdirSync(dir, { recursive: true });
    fill(dir, 'a.ts');
    fill(dir, 'b.ts');
  }
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe('detectWorkspace', () => {
  it('reports a TypeScript repository as typescript with npm', () => {
    const facts = detectWorkspace({ dir: TS_REPO });
    expect(facts.languages[0]).toBe('typescript');
    expect(facts.packageManager).toBe('npm');
    expect(facts.testCommand).toBe('npm test');
    expect(facts.manifests).toEqual(['package.json', 'tsconfig.json']);
  });

  it('counts source files and leaves documentation out of the count', () => {
    const facts = detectWorkspace({ dir: TS_REPO });
    // Four .ts files, one of them a test; README.md is not source.
    expect(facts.sourceFiles).toBe(4);
  });

  it('reports a Python repository as python with pytest', () => {
    const facts = detectWorkspace({ dir: PY_REPO });
    expect(facts.languages).toEqual(['python']);
    expect(facts.manifests).toEqual(['pyproject.toml']);
    expect(facts.testCommand).toBe('pytest');
    expect(facts.sourceFiles).toBe(3);
  });

  it('reports unknown for an empty directory instead of throwing', () => {
    const facts = detectWorkspace({ dir: EMPTY_DIR });
    expect(facts).toEqual(unknownWorkspaceFacts());
    expect(formatWorkspaceFacts(facts)).toBe('unknown');
  });

  it('reports unknown for a directory that does not exist', () => {
    const facts = detectWorkspace({ dir: join(SANDBOX, 'does-not-exist') });
    expect(facts.languages).toEqual([]);
    expect(facts.manifests).toEqual([]);
  });

  it('lists three manifests and counts the rest', () => {
    const facts = detectWorkspace({ dir: MANY_MANIFESTS });
    expect(facts.manifests.length).toBe(5);
    expect(formatManifestList(facts.manifests)).toBe('package.json, tsconfig.json, pyproject.toml +2 more');
  });

  it('never descends into node_modules, dist or .git', () => {
    const facts = detectWorkspace({ dir: NOISY });
    // 1 + 25 * 3 files exist below those directories; only src/kept.py counts.
    expect(facts.sourceFiles).toBe(1);
    expect(facts.languages).toEqual(['python']);
  });

  it('returns a result for an already-aborted signal', () => {
    const controller = new AbortController();
    controller.abort();
    const facts = detectWorkspace({ dir: TS_REPO, signal: controller.signal });
    expect(facts.aborted).toBe(true);
    expect(facts.truncated).toBe(true);
    // The root manifests are read before the walk, so they survive the abort.
    expect(facts.languages[0]).toBe('typescript');
  });

  it('honours a budget that is already spent', () => {
    const facts = detectWorkspace({ dir: TS_REPO, budgetMs: 0 });
    expect(facts.truncated).toBe(true);
    expect(facts.languages[0]).toBe('typescript');
  });

  it('returns rather than hanging on a budget it cannot finish in', () => {
    const started = Date.now();
    const facts = detectWorkspace({ dir: WIDE, budgetMs: 1 });
    const elapsed = Date.now() - started;
    // Whether 150 directory reads fit in a millisecond is the machine's
    // business, so this asserts a well-formed result rather than a truncation.
    expect(facts.sourceFiles).toBeLessThanOrEqual(300);
    expect(Array.isArray(facts.languages)).toBe(true);
    // The bound is loose on purpose: a cold filesystem cache must not fail it.
    expect(elapsed).toBeLessThan(WORKSPACE_BUDGET_MS + 2000);
  });

  it('finishes a tree it can afford', () => {
    // A budget far above the default, because this case is about the histogram
    // rather than about how much of a tree fits in 150ms on a busy machine.
    const facts = detectWorkspace({ dir: WIDE, budgetMs: WORKSPACE_BUDGET_MS * 40 });
    expect(facts.truncated).toBe(false);
    expect(facts.sourceFiles).toBe(300);
    expect(facts.languages).toEqual(['typescript']);
  });

  it('terminates when a directory links back to its own ancestor', () => {
    const looped = join(SANDBOX, 'looped');
    mkdirSync(looped, { recursive: true });
    fill(looped, 'package.json', '{}');
    fill(looped, 'index.ts');
    // A junction works without elevation on Windows, where a plain directory
    // symlink needs it; a host that refuses both still gets the plain counts.
    let linked = true;
    try {
      symlinkSync(looped, join(looped, 'self'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      linked = false;
    }
    const facts = detectWorkspace({ dir: looped });
    expect(facts.sourceFiles).toBe(1);
    expect(facts.languages[0]).toBe('typescript');
    if (linked) expect(facts.truncated).toBe(false);
  });

  it('prefers an explicit packageManager field over a lockfile', () => {
    const dir = join(SANDBOX, 'declared-manager');
    mkdirSync(dir, { recursive: true });
    fill(dir, 'package.json', JSON.stringify({ packageManager: 'yarn@4.1.0' }));
    fill(dir, 'package-lock.json', '{}');
    expect(detectWorkspace({ dir }).packageManager).toBe('yarn');
  });

  it('reads the test command from the manifest that justifies it', () => {
    const go = join(SANDBOX, 'go-repo');
    mkdirSync(go, { recursive: true });
    fill(go, 'go.mod', 'module demo\n');
    fill(go, 'main.go');
    const facts = detectWorkspace({ dir: go });
    expect(facts.languages).toEqual(['go']);
    expect(facts.testCommand).toBe('go test ./...');
    expect(facts.packageManager).toBe('go modules');
  });

  it('leaves the test command empty when no manifest supports one', () => {
    const plain = join(SANDBOX, 'no-testing');
    mkdirSync(plain, { recursive: true });
    fill(plain, 'script.py');
    fill(plain, 'other.py');
    const facts = detectWorkspace({ dir: plain });
    expect(facts.languages).toEqual(['python']);
    expect(facts.testCommand).toBe('');
    expect(facts.packageManager).toBe('');
  });
});

describe('formatWorkspaceFacts', () => {
  it('has the shape the headers print', () => {
    const facts = detectWorkspace({ dir: TS_REPO });
    expect(formatWorkspaceFacts(facts)).toMatch(/^typescript \(npm\), \d+ source files$/);
  });

  it('says unknown when nothing was recognised', () => {
    expect(formatWorkspaceFacts(unknownWorkspaceFacts())).toBe('unknown');
  });

  it('drops the package manager when there is none and counts 1 file in the singular', () => {
    const facts = { ...unknownWorkspaceFacts(), languages: ['go' as const], sourceFiles: 1 };
    expect(formatWorkspaceFacts(facts)).toBe('go, 1 source file');
  });
});

describe('formatManifestList', () => {
  it('prints up to three names with no suffix', () => {
    expect(formatManifestList(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('counts the names it did not print', () => {
    expect(formatManifestList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c +2 more');
  });

  it('is empty for no manifests', () => {
    expect(formatManifestList([])).toBe('');
  });
});

describe('formatWorkspaceSection', () => {
  it('names the language, the manifests and the test command', () => {
    const section = formatWorkspaceSection(detectWorkspace({ dir: TS_REPO }));
    expect(section.startsWith('## Workspace\n')).toBe(true);
    expect(section).toContain('Detected: typescript (npm), 4 source files');
    expect(section).toContain('Manifests: package.json, tsconfig.json');
    expect(section).toContain('Test command: npm test');
    // A handful of lines, not an inventory.
    expect(section.split('\n').length).toBeLessThanOrEqual(4);
  });

  it('still emits a section when the directory is unrecognised', () => {
    const section = formatWorkspaceSection(detectWorkspace({ dir: EMPTY_DIR }));
    expect(section.startsWith('## Workspace\n')).toBe(true);
    expect(section).toContain('unknown');
  });

  it('says when the walk was cut short', () => {
    const section = formatWorkspaceSection(detectWorkspace({ dir: TS_REPO, budgetMs: 0 }));
    expect(section).toContain('scan cut short');
  });
});

describe('buildSystemPrompt and the workspace section', () => {
  it('describes a TypeScript repository and a Python one differently', async () => {
    const ts = await buildSystemPrompt('add a function', { noZstack: true, workspaceDir: TS_REPO });
    const py = await buildSystemPrompt('add a function', { noZstack: true, workspaceDir: PY_REPO });
    expect(ts.systemPrompt).not.toBe(py.systemPrompt);
    expect(ts.systemPrompt).toContain('## Workspace');
    expect(ts.systemPrompt).toContain('typescript (npm)');
    expect(ts.workspace.packageManager).toBe('npm');
    expect(py.systemPrompt).toContain('python');
    expect(py.systemPrompt).toContain('pytest');
    expect(py.systemPrompt).not.toContain('typescript');
  });

  it('emits the section under --no-zstack, which the playbook does not control', async () => {
    const ctx = await buildSystemPrompt('add a function', { noZstack: true, workspaceDir: TS_REPO });
    expect(ctx.playbook).toBe('none');
    expect(ctx.systemPrompt).toContain('## Workspace');
  });

  it('keeps the facts for a caller that also prints a header', async () => {
    const ctx = await buildSystemPrompt('add a function', { noZstack: true, workspaceDir: PY_REPO });
    expect(formatWorkspaceFacts(ctx.workspace)).toBe('python, 3 source files');
  });

  it('emits one line for an unrecognised directory rather than nothing', async () => {
    const ctx = await buildSystemPrompt('add a function', { noZstack: true, workspaceDir: EMPTY_DIR });
    expect(ctx.systemPrompt).toContain('## Workspace\nNothing in this directory identified a language');
    expect(ctx.workspace.languages).toEqual([]);
  });

  it('falls back to the cwd when no workspace root is given', async () => {
    const ctx = await buildSystemPrompt('add a function', { noZstack: true });
    // The suite runs inside this repository, so the cwd is a TypeScript tree.
    expect(ctx.workspace.languages.length).toBeGreaterThan(0);
  });
});
