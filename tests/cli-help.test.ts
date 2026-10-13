import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..');
const builtCli = join(repoRoot, 'dist/cli.js');

function runCli(argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [builtCli, ...argv], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The build happens once in `tests/global-setup.ts`, not here: a per-file build
 * raced the other CLI test files on the same `dist/` directory.
 *
 * The artifact is asserted rather than skipped for a second reason. `skipIf` is
 * evaluated at collection time, which was before this file's own `beforeAll`
 * build, so a missing artifact skipped every test here instead of failing the
 * build that should have produced it — and a stray backtick inside the help
 * template literal (which broke only the DTS build, while ESM still reported
 * success and emitted nothing) went green because of it.
 */
describe('CLI help output', () => {
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
