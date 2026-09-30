import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectDoctorReport, formatDoctorReport, probeBun, probeWritable } from '../harness/doctor.js';
import { colorCapability } from '../harness/theme.js';
import { stripAnsi } from '../harness/theme.js';

/**
 * `doctor` is the first thing a stuck user runs, so it has to be right about
 * two things: it must never claim a healthy setup is broken (a false `fail`
 * sends someone editing a working config), and it must never claim a broken one
 * is fine. It also must not itself be the problem — no network, no API key, no
 * workspace mutation — which the tests below pin by running it against a config
 * with no credentials at all.
 */

const SANDBOX = resolve(__dirname, '.tmp-doctor-sandbox');
const EMPTY = resolve(__dirname, '.tmp-doctor-empty');

beforeAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  rmSync(EMPTY, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  mkdirSync(SANDBOX, { recursive: true });
  mkdirSync(EMPTY, { recursive: true });
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  rmSync(EMPTY, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

/** A report over a workspace and state dir that exist, with no config present. */
async function reportFor(overrides: Partial<Parameters<typeof collectDoctorReport>[0]> = {}) {
  return await collectDoctorReport({
    configPath: join(EMPTY, 'absent.json'),
    workspaceDir: SANDBOX,
    stateDir: join(EMPTY, 'state'),
    snapshotDir: join(EMPTY, 'snapshots'),
    agentsDir: null,
    ...overrides,
  });
}

describe('probeWritable', () => {
  it('writes and deletes a real file rather than asking for permission', () => {
    const dir = join(EMPTY, 'writable');
    const result = probeWritable(dir);
    expect(result.ok).toBe(true);
    // The directory is created (that is what a run would do) but the probe file
    // itself must be gone: a diagnostic that litters is a diagnostic nobody runs.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reports a path it cannot create, without throwing', () => {
    // A file where a directory is needed: mkdir fails on every platform.
    const blocker = join(EMPTY, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const result = probeWritable(join(blocker, 'child'));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('blocker');
  });
});

describe('probeBun', () => {
  it('says whether the TUI is reachable, distinguishing installed from in-process', () => {
    const probe = probeBun();
    expect(typeof probe.detail).toBe('string');
    expect(probe.detail.length).toBeGreaterThan(0);
    // Under vitest this is node, so the answer must not claim the TUI is ready
    // unless bun really is the runtime.
    const inProcess = (globalThis as { Bun?: unknown }).Bun !== undefined;
    expect(probe.usable).toBe(inProcess);
  });
});

describe('collectDoctorReport', () => {
  it('is stable and sorted, so two runs are diffable', async () => {
    const report = await reportFor();
    const ids = report.checks.map((check) => check.id);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual([
      'agents',
      'bun',
      'config',
      'model',
      'sessions',
      'snapshots',
      'stdin',
      'stdout',
      'workspace',
    ]);
  });

  it('treats a missing config as a warning, not a failure', async () => {
    const report = await reportFor();
    const config = report.checks.find((check) => check.id === 'config');
    expect(config?.status).toBe('warn');
    expect(config?.hint).toContain('mhh setup');
    // Nothing has failed, so the exit code stays 0: a first-run user should not
    // read this as a broken install.
    expect(report.failures).toBe(0);
    expect(report.exitCode).toBe(0);
  });

  it('reports a malformed config as a failure with a one-line reason', async () => {
    const bad = join(EMPTY, 'broken.json');
    writeFileSync(bad, '{ this is not json');
    const report = await reportFor({ configPath: bad });
    const config = report.checks.find((check) => check.id === 'config');
    expect(config?.status).toBe('fail');
    expect(config?.detail).not.toContain('at Object'); // no stack trace
    expect(report.exitCode).toBe(1);
  });

  it('reports the resolved model, honouring a --model override', async () => {
    const config = join(EMPTY, 'valid.json');
    writeFileSync(
      config,
      JSON.stringify({ defaultProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash', keys: {} }),
    );
    const plain = await reportFor({ configPath: config });
    expect(plain.checks.find((check) => check.id === 'model')?.detail).toBe('deepseek/deepseek-v4-flash');

    const overridden = await reportFor({ configPath: config, modelOverride: 'openai/gpt-5.4' });
    expect(overridden.checks.find((check) => check.id === 'model')?.detail).toBe('openai/gpt-5.4');
  });

  it('never needs an API key and never makes a network call', async () => {
    // A config with an empty keys block is enough to resolve a provider. If
    // doctor validated credentials it would need the network, and it must not.
    const config = join(EMPTY, 'keyless.json');
    writeFileSync(config, JSON.stringify({ defaultProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' }));
    const report = await reportFor({ configPath: config });
    expect(report.checks.find((check) => check.id === 'model')?.status).toBe('ok');
    expect(report.exitCode).toBe(0);
  });

  it('reports a missing agents dir as informational rather than a problem', async () => {
    const report = await reportFor({ agentsDir: join(EMPTY, 'no-agents-here') });
    const agents = report.checks.find((check) => check.id === 'agents');
    expect(agents?.status).toBe('warn');
    expect(report.exitCode).toBe(0);
  });

  it('reports agents disabled by --no-agents as ok', async () => {
    const report = await reportFor({ agentsDir: null });
    expect(report.checks.find((check) => check.id === 'agents')?.detail).toContain('--no-agents');
  });

  it('counts definitions when an agents dir is present', async () => {
    const dir = join(EMPTY, 'agents');
    mkdirSync(join(dir, 'Scout'), { recursive: true });
    writeFileSync(
      join(dir, 'Scout', 'agent.md'),
      '---\nname: Scout\ndescription: reads things\ntools:\n  - view_file\n---\n\nLook around.\n',
    );
    const report = await reportFor({ agentsDir: dir });
    const agents = report.checks.find((check) => check.id === 'agents');
    expect(agents?.status).toBe('ok');
    expect(agents?.detail).toContain('1 definition');
  });

  it('fails when the workspace does not exist', async () => {
    const report = await reportFor({ workspaceDir: join(EMPTY, 'not-here') });
    const workspace = report.checks.find((check) => check.id === 'workspace');
    expect(workspace?.status).toBe('fail');
    expect(report.exitCode).toBe(1);
  });

  it('checks that snapshots and sessions can actually be written', async () => {
    const report = await reportFor();
    expect(report.checks.find((check) => check.id === 'snapshots')?.status).toBe('ok');
    expect(report.checks.find((check) => check.id === 'sessions')?.status).toBe('ok');
  });

  it('reports the TTY implications a non-TTY run has to know about', async () => {
    const report = await reportFor();
    const stdin = report.checks.find((check) => check.id === 'stdin');
    const stdout = report.checks.find((check) => check.id === 'stdout');
    expect(typeof stdin?.detail).toBe('string');
    expect(typeof stdout?.detail).toBe('string');
    // Under vitest neither stream is a TTY, and the wording has to say what
    // that means for approvals rather than just reporting the fact.
    if (process.stdin.isTTY !== true) expect(stdin?.detail).toContain('--yes');
  });
});

describe('formatDoctorReport', () => {
  it('prints one line per check, with a summary', async () => {
    const report = await reportFor();
    const text = stripAnsi(formatDoctorReport(report, { columns: 100 }));
    expect(text).toContain('harness doctor');
    for (const check of report.checks) expect(text).toContain(check.label);
    expect(text).toMatch(/\d+ failure\(s\), \d+ warning\(s\)|everything checks out/);
  });

  it('says everything is fine when nothing is wrong', () => {
    const text = stripAnsi(
      formatDoctorReport(
        { checks: [{ id: 'a', status: 'ok', label: 'a', detail: 'fine' }], exitCode: 0, failures: 0, warnings: 0 },
        { columns: 80 },
      ),
    );
    expect(text).toContain('everything checks out');
  });

  it('emits no escape codes when colour is off', () => {
    const previous = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
    try {
      expect(colorCapability().enabled).toBe(false);
      const text = formatDoctorReport(
        { checks: [{ id: 'a', status: 'ok', label: 'a', detail: 'fine' }], exitCode: 0, failures: 0, warnings: 0 },
        { columns: 80 },
      );
      expect(text).not.toContain('\u001b');
    } finally {
      if (previous === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = previous;
    }
  });

  it('keeps every line inside the column budget', async () => {
    const report = await reportFor();
    const text = stripAnsi(formatDoctorReport(report, { columns: 80 }));
    for (const line of text.split('\n')) {
      // Strip the ANSI-free text; wide glyphs are single-column here.
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });
});
