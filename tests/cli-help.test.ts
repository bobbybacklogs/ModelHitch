import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const builtCli = join(repoRoot, 'dist/cli.js');

function runCli(argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [builtCli, ...argv], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  execSync('npm run build', { cwd: repoRoot, stdio: 'pipe' });
}, 30_000);

describe('CLI help output', () => {
  /**
   * Asserted rather than skipped.
   *
   * These tests must exercise the BUILT cli: if the artifact is missing the
   * build is broken, and a broken build has to fail here. A `skipIf` would make
   * it green instead — and it would key off the artifact state at collection
   * time, which is before `beforeAll` builds, so a fresh clone would skip every
   * test in this file even though the build then succeeds.
   */
  it('has a built CLI to test', () => {
    expect(existsSync(builtCli)).toBe(true);
  });

  it('documents implemented commands and flags', () => {
    const { status, stdout } = runCli(['--help']);
    expect(status).toBe(0);
    for (const token of [
      'modelhitch config',
      'config init',
      'config --path',
      'bridge --background',
      '| -b',
      '--config <file>',
      '--image-quality',
      '--image-size',
      '--cloud-agent-lane',
      '--cloud-agent',
      '--local-agent',
      '--local-agent-workspace',
      '--local-agent-model',
      '--local-agent-max-turns',
      'modelhitch cloud run',
      'modelhitch cloud list',
      'Agent lane flags',
      '--provider <id>',
      '--opencode-byok-connection',
      '--opencode-byok-mode',
      '--opencode-byok-import',
      '--custom-lane',
      '--custom-lane-models',
      '--custom-lanes-placement',
      '--chatgpt-plan',
      '--chatgpt-plan-models',
      '--chatgpt-plan-mode',
      '--chatgpt-plan-placement',
      '--chatgpt-plan-on-limit',
      '--chatgpt-plan-pin',
      '--chatgpt-plan-account',
      'modelhitch chatgpt-plan sign-in',
      'chatgpt-plan/<slug>',
      'modelhitch setup',
      'settings --web',
      'settings --config',
      'MODELHITCH_HOME',
      'MODELHITCH_DEBUG',
      'cursor-cloud/<model>',
      'modelhitch chat',
      'modelhitch work',
    ]) {
      expect(stdout).toContain(token);
    }
  });

  it('prints the package version', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    const { status, stdout } = runCli(['--version']);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it('reports unknown commands and reprints help', () => {
    const { status, stdout } = runCli(['not-a-command']);
    expect(status).toBe(1);
    expect(stdout).toContain('Unknown command: not-a-command');
    expect(stdout).toContain('modelhitch config');
  });
});
