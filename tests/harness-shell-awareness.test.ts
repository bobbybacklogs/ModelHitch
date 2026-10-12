import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatWorkspaceSection, shellFacts, unknownWorkspaceFacts } from '../harness/detect-workspace.js';
import { HARNESS_TOOLS, shellHint } from '../harness/tools.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mh-shell-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('shellFacts', () => {
  it('names cmd.exe and warns about POSIX on Windows', () => {
    const facts = shellFacts('win32');
    expect(facts.shell).toBe('cmd.exe');
    expect(facts.note).toMatch(/no POSIX tools/);
    expect(facts.note).toContain('ls');
    expect(facts.note).toContain('dir');
    // One line, because the workspace section budgets itself to a handful.
    expect(facts.note).not.toContain('\n');
  });

  it('reports /bin/sh off Windows', () => {
    const facts = shellFacts('linux');
    expect(facts.shell).toBe('/bin/sh');
    expect(facts.note).toMatch(/POSIX tools available/);
    expect(facts.note).not.toMatch(/no POSIX/);
  });

  it('treats darwin as POSIX', () => {
    expect(shellFacts('darwin').shell).toBe('/bin/sh');
  });
});

describe('## Workspace section names the shell', () => {
  it('includes a shell line even when no language was detected', () => {
    const section = formatWorkspaceSection(unknownWorkspaceFacts());
    expect(section).toContain('Shell:');
  });

  it('includes a shell line alongside detected languages', () => {
    // A populated fact set: the shell line must appear whether or not detection
    // found anything, or a Windows user on an odd tree gets no hint at all.
    const section = formatWorkspaceSection({
      ...unknownWorkspaceFacts(),
      languages: ['typescript'],
      testCommand: 'npm test',
    });
    expect(section).toMatch(/## Workspace/);
    expect(section).toContain('Test command: npm test');
    expect(section).toMatch(/Shell: (cmd\.exe|\/bin\/sh)/);
  });
});

describe('bash tool advertises the real shell', () => {
  it('says the shell is the platform default, not bash', () => {
    const tool = HARNESS_TOOLS.find((t) => t.name === 'bash');
    expect(tool).toBeDefined();
    const description = String(tool?.description ?? '');
    expect(description).toMatch(/cmd\.exe/);
    expect(description).toMatch(/platform default/);
    // The cross-platform escape hatch should be named rather than implied.
    expect(description).toMatch(/read\/grep\/glob|read.*grep.*glob/i);
  });
});

describe('POSIX-on-Windows failure carries a substitution hint', () => {
  const notRecognized = "'ls' is not recognized as an internal or external command";

  it('suggests dir for ls on Windows', () => {
    const hint = shellHint('ls -la', notRecognized, 'win32');
    expect(hint).toContain('cmd.exe');
    expect(hint).toContain('"ls"');
    expect(hint).toContain('"dir"');
    expect(hint).toMatch(/read\/grep\/glob/);
  });

  it('maps the common POSIX utilities to their cmd equivalents', () => {
    expect(shellHint('cat a.txt', notRecognized, 'win32')).toContain('type');
    expect(shellHint('rm -rf x', notRecognized, 'win32')).toContain('del');
    expect(shellHint('grep foo .', notRecognized, 'win32')).toContain('findstr');
    expect(shellHint('which node', notRecognized, 'win32')).toContain('where');
  });

  it('still explains the shell for an unknown command', () => {
    const hint = shellHint('frobnicate', notRecognized, 'win32');
    expect(hint).toContain('cmd.exe');
    expect(hint).toContain('"frobnicate" is not available');
  });

  it('returns nothing off Windows', () => {
    expect(shellHint('ls -la', notRecognized, 'linux')).toBe('');
    expect(shellHint('ls -la', notRecognized, 'darwin')).toBe('');
  });

  it('returns nothing when the failure was not a missing command', () => {
    // A genuine tool failure should not be explained away as a shell mismatch.
    expect(shellHint('npm test', 'Exit 1: Command failed: npm test', 'win32')).toBe('');
  });

  it('picks the first token, so a pipeline still names the real culprit', () => {
    expect(shellHint('ls -la | findstr foo', notRecognized, 'win32')).toContain('"dir"');
  });
});
