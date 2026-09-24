import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkills } from '../src/skill-installer.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'modelhitch-skills-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('skill installer', () => {
  it('installs the shared skill in the Codex user directory', () => {
    const homeDir = temporaryDirectory();
    const [result] = installSkills({ target: 'codex', homeDir });

    expect(result?.path).toBe(join(homeDir, '.codex', 'skills', 'modelhitch'));
    expect(readFileSync(join(result!.path, 'SKILL.md'), 'utf8')).toContain('name: modelhitch');
    expect(existsSync(join(result!.path, 'references', 'api-and-operations.md'))).toBe(true);
  });

  it('installs both focused Claude skills', () => {
    const homeDir = temporaryDirectory();
    const results = installSkills({ target: 'claude', homeDir });

    expect(results.map(({ path }) => path)).toEqual([
      join(homeDir, '.claude', 'skills', 'modelhitch-integrate'),
      join(homeDir, '.claude', 'skills', 'modelhitch-bridge'),
    ]);
  });

  it('preflights collisions before an all-agent install', () => {
    const homeDir = temporaryDirectory();
    installSkills({ target: 'cursor', homeDir });

    expect(() => installSkills({ target: 'all', homeDir })).toThrow('--force');
    expect(existsSync(join(homeDir, '.codex'))).toBe(false);
  });

  it('supports dry runs and project-scoped destinations', () => {
    const projectDir = temporaryDirectory();
    const results = installSkills({ target: 'all', scope: 'project', projectDir, dryRun: true });

    expect(results).toHaveLength(5);
    expect(results[0]?.path).toBe(join(projectDir, '.agents', 'skills', 'modelhitch'));
    expect(results[4]?.path).toBe(join(projectDir, '.github', 'skills', 'modelhitch'));
    expect(existsSync(join(projectDir, '.agents'))).toBe(false);
  });

  it('updates managed files with force', () => {
    const homeDir = temporaryDirectory();
    const [first] = installSkills({ target: 'vscode', homeDir });
    installSkills({ target: 'vscode', homeDir, force: true });

    expect(readFileSync(join(first!.path, 'SKILL.md'), 'utf8')).toContain('# ModelHitch');
  });

  it('installs zstack and setup-zstack workflow skills across agents', () => {
    const homeDir = temporaryDirectory();
    const results = installSkills({ target: 'all', package: 'zstack', homeDir });

    expect(results).toHaveLength(8); // 4 agents * 2 skills (zstack + setup-zstack)
    const cursorZstack = results.find((r) => r.agent === 'cursor' && r.path.endsWith('zstack'));
    expect(cursorZstack).toBeDefined();
    expect(readFileSync(join(cursorZstack!.path, 'SKILL.md'), 'utf8')).toContain('name: z-mode');
    expect(existsSync(join(cursorZstack!.path, 'playbooks', 'feature.md'))).toBe(true);
    expect(existsSync(join(cursorZstack!.path, 'principles', 'prove-it-works.md'))).toBe(true);
    expect(existsSync(join(cursorZstack!.path, 'references', 'evidence-schema.json'))).toBe(true);

    const cursorSetup = results.find((r) => r.agent === 'cursor' && r.path.endsWith('setup-zstack'));
    expect(cursorSetup).toBeDefined();
    expect(readFileSync(join(cursorSetup!.path, 'SKILL.md'), 'utf8')).toContain('name: setup-zstack');
  });
});
