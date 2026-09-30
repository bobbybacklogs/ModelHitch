/**
 * `mhh doctor` — what is wrong with this setup, without starting a run.
 *
 * Every check here reuses the code the run itself uses (`loadHarnessRuntime`,
 * `resolveAgentsDir`, `snapshotRoot`, `harnessStateDir`) rather than
 * reimplementing the resolution. A doctor that answers from its own copy of the
 * rules will disagree with the run the moment either changes, which is worse
 * than having no doctor at all.
 *
 * Hard constraints, because a diagnostic that causes the problem it is
 * diagnosing is useless:
 *   - never makes a network call and never needs an API key;
 *   - never starts a run and never touches the workspace;
 *   - probes writability by writing and deleting a real temp file, not by
 *     asking the filesystem for permission, and removes it even on failure.
 */

import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConfigFile, defaultConfigPath } from '../src/config-file.js';
import { validateConfig } from '../src/config.js';
import { loadHarnessRuntime } from './runtime.js';
import { resolveAgentsDir, loadAgentLibrary, defaultAgentsDir } from './agent-library.js';
import { snapshotRoot } from './snapshot.js';
import { harnessStateDir } from './session.js';
import { bunVersion, findBunCommand, isBunRuntime } from './bun.js';
import { PALETTE, Painter, colorCapability, type PaletteKey } from './theme.js';
import { clip } from './format.js';

/**
 * Three states, and the middle one carries most of the meaning: `warn` is
 * "this works, but not the way you probably expect".
 */
export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  /** Stable id. Output is sorted by it so two runs are diffable. */
  id: string;
  status: CheckStatus;
  /** Short label, padded in the report. */
  label: string;
  /** What was found. One line. */
  detail: string;
  /** What to do about it, for anything not `ok`. */
  hint?: string;
}

export interface DoctorReport {
  checks: Check[];
  /** 0 when nothing failed, 1 otherwise. */
  exitCode: number;
  failures: number;
  warnings: number;
}

export interface DoctorOptions {
  configPath?: string;
  modelOverride?: string;
  /** `--no-agents` passes null. */
  agentsDir?: string | null;
  workspaceDir?: string;
  /** Overridden by tests so a probe never touches the real state directory. */
  stateDir?: string;
  snapshotDir?: string;
}

const statusOf = (checks: Check[]): Pick<DoctorReport, 'exitCode' | 'failures' | 'warnings'> => {
  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return { exitCode: failures > 0 ? 1 : 0, failures, warnings };
};

/** One line out of an unknown throwable. A stack trace is not a diagnosis. */
function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'unknown error';
}

/**
 * Write and delete a real file.
 *
 * `access()` reports what the *user* may do, which is not the same question as
 * "can this process create a file here" — a read-only mount, a full disk, or a
 * Windows ACL all pass `access()` and fail the write.
 */
export function probeWritable(dir: string): { ok: boolean; detail: string } {
  const probe = join(dir, `.mhh-doctor-${process.pid}-${Date.now()}`);
  const cleanup = (): void => {
    try {
      rmSync(probe, { force: true });
    } catch {
      /* the probe is already gone, or the directory is unwritable anyway */
    }
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, 'ok', { mode: 0o600 });
    cleanup();
    return { ok: true, detail: dir };
  } catch (err) {
    cleanup();
    return { ok: false, detail: `${dir} — ${oneLine(err)}` };
  }
}

/**
 * Is the TUI reachable?
 *
 * Two different questions that the obvious check conflates: is bun installed on
 * this machine, and is *this process* bun. The installed command runs under
 * node, so a doctor that only asked the second would report "bun not found" on
 * a machine where bun is on PATH — and since the CLI now hands a run over to bun
 * when the TUI is wanted, that machine has a working TUI one re-exec away.
 */
export function probeBun(): { usable: boolean; detail: string; hint?: string } {
  if (isBunRuntime()) return { usable: true, detail: 'running under bun — the TUI is available' };
  const command = findBunCommand();
  if (command === undefined) {
    return {
      usable: false,
      detail: 'not on PATH — the TUI is unavailable and every run is plaintext',
      hint: 'install bun from https://bun.sh',
    };
  }
  const version = bunVersion(command);
  if (isBunRuntime()) {
    return { usable: true, detail: `running under bun ${version ?? ''}`.trim() };
  }
  return {
    usable: false,
    detail: `installed (${version ?? command}) — a run hands over to bun when the TUI is wanted`,
    hint: 'nothing to do: `mhh --tui "<task>"` re-executes under bun automatically',
  };
}

export async function collectDoctorReport(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: Check[] = [];
  const configPath = options.configPath ?? process.env['MODELHITCH_CONFIG'] ?? defaultConfigPath();
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const stateDir = options.stateDir ?? harnessStateDir();
  const snapshotDir = options.snapshotDir ?? snapshotRoot();

  /* ---- config ---------------------------------------------------- */
  let configStatus: CheckStatus = 'ok';
  let configDetail = configPath;
  let configHint: string | undefined;
  if (!existsSync(configPath)) {
    configStatus = 'warn';
    configDetail = `${configPath} — not found`;
    configHint = 'run `mhh setup` to create one, or pass --config <path>';
  } else {
    try {
      const config = readConfigFile(configPath);
      if (config === null) {
        configStatus = 'warn';
        configDetail = `${configPath} — empty`;
        configHint = 'run `mhh setup` to fill it in';
      } else {
        const { errors } = validateConfig(config);
        if (errors.length > 0) {
          configStatus = 'fail';
          configDetail = `${configPath} — invalid: ${errors.join('; ')}`;
          configHint = 'fix the keys named above, or re-run `mhh setup`';
        }
      }
    } catch (err) {
      // A malformed document is a failure, not a warning: the run cannot start.
      configStatus = 'fail';
      configDetail = `${configPath} — ${oneLine(err)}`;
      configHint = 'the file is not valid JSON; fix or replace it';
    }
  }
  checks.push({
    id: 'config',
    status: configStatus,
    label: 'config',
    detail: configDetail,
    ...(configHint !== undefined ? { hint: configHint } : {}),
  });

  /* ---- resolved model -------------------------------------------- */
  try {
    const runtime = await loadHarnessRuntime({
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.modelOverride !== undefined ? { modelOverride: options.modelOverride } : {}),
      // The report says whether the config is missing in its own `config` line;
      // the loader's one-line hint would say it a second time.
      hintOnMissing: false,
    });
    checks.push({
      id: 'model',
      status: 'ok',
      label: 'model',
      detail: `${runtime.provider}/${runtime.model}`,
    });
  } catch (err) {
    checks.push({
      id: 'model',
      status: 'fail',
      label: 'model',
      detail: oneLine(err),
      hint: 'a run cannot resolve a provider until this loads',
    });
  }

  /* ---- interface -------------------------------------------------- */
  const stdoutTty = process.stdout.isTTY === true;
  const stdinTty = process.stdin.isTTY === true;
  const bun = probeBun();
  checks.push({
    id: 'bun',
    status: bun.usable ? 'ok' : 'warn',
    label: 'bun',
    detail: bun.detail,
    ...(bun.hint !== undefined ? { hint: bun.hint } : {}),
  });
  checks.push({
    id: 'stdin',
    status: stdinTty ? 'ok' : 'warn',
    label: 'stdin',
    detail: stdinTty
      ? 'a TTY — mutating tool calls will prompt'
      : 'not a TTY — mutating tool calls are declined unless --yes is passed',
    ...(stdinTty ? {} : { hint: 'pass --yes to approve writes without a prompt' }),
  });
  checks.push({
    id: 'stdout',
    status: stdoutTty ? 'ok' : 'warn',
    label: 'stdout',
    detail: stdoutTty
      ? 'a TTY — the TUI is chosen automatically under bun'
      : 'not a TTY — output is a plaintext transcript with no colour',
    ...(stdoutTty ? {} : { hint: 'pass --tui to force the interface anyway' }),
  });

  /* ---- agents ----------------------------------------------------- */
  const resolvedAgents = resolveAgentsDir(options.agentsDir);
  if (options.agentsDir === null) {
    checks.push({
      id: 'agents',
      status: 'ok',
      label: 'agents',
      detail: 'disabled by --no-agents',
    });
  } else if (resolvedAgents === null) {
    checks.push({
      id: 'agents',
      status: 'warn',
      label: 'agents',
      detail: `no definitions found at ${defaultAgentsDir()}`,
      hint: 'delegation still works with the built-in agents; --agents-dir points elsewhere',
    });
  } else {
    try {
      const library = loadAgentLibrary({ dir: resolvedAgents });
      const count = library.agents.length;
      checks.push({
        id: 'agents',
        status: 'ok',
        label: 'agents',
        detail:
          `${count} definition${count === 1 ? '' : 's'} in ${resolvedAgents}` +
          (library.excluded.length > 0 ? ` (${library.excluded.length} excluded)` : ''),
        ...(library.warnings.length > 0
          ? { hint: `${library.warnings.length} warning(s) while loading; the roster logs them` }
          : {}),
      });
    } catch (err) {
      checks.push({
        id: 'agents',
        status: 'warn',
        label: 'agents',
        detail: `${resolvedAgents} — ${oneLine(err)}`,
        hint: 'delegation falls back to the built-in agents',
      });
    }
  }

  /* ---- storage ---------------------------------------------------- */
  const sessionsProbe = probeWritable(join(stateDir, 'sessions'));
  checks.push({
    id: 'sessions',
    status: sessionsProbe.ok ? 'ok' : 'fail',
    label: 'sessions',
    detail: sessionsProbe.ok
      ? `${sessionsProbe.detail} — --save-session can write here`
      : `${sessionsProbe.detail} — --save-session will fail`,
    ...(sessionsProbe.ok ? {} : { hint: 'set HARNESS_STATE_DIR to a writable directory' }),
  });

  const snapshotProbe = probeWritable(snapshotDir);
  checks.push({
    id: 'snapshots',
    status: snapshotProbe.ok ? 'ok' : 'fail',
    label: 'snapshots',
    detail: snapshotProbe.ok
      ? `${snapshotProbe.detail} — undo is available`
      : `${snapshotProbe.detail} — undo will be unavailable`,
    ...(snapshotProbe.ok ? {} : { hint: 'set HARNESS_SNAPSHOT_DIR to a writable directory' }),
  });

  /* ---- workspace --------------------------------------------------- */
  try {
    const real = realpathSync(workspaceDir);
    if (!statSync(real).isDirectory()) throw new Error('not a directory');
    checks.push({ id: 'workspace', status: 'ok', label: 'workspace', detail: real });
  } catch (err) {
    checks.push({
      id: 'workspace',
      status: 'fail',
      label: 'workspace',
      detail: `${workspaceDir} — ${oneLine(err)}`,
      hint: 'run from a directory that exists',
    });
  }

  checks.sort((a, b) => a.id.localeCompare(b.id));
  return { checks, ...statusOf(checks) };
}

const STATUS_TONE: Record<CheckStatus, PaletteKey> = { ok: 'ok', warn: 'warn', fail: 'error' };
const STATUS_MARK: Record<CheckStatus, string> = { ok: '✔', warn: '!', fail: '✖' };

/** The human-readable report. Sorted, one line per check, hints underneath. */
export function formatDoctorReport(report: DoctorReport, options: { columns?: number } = {}): string {
  const painter = new Painter(colorCapability());
  const columns = Math.max(60, Math.min(options.columns ?? process.stdout.columns ?? 100, 200));
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${painter.bold(painter.color('accent', 'MODELHITCH'))}${painter.color('faint', ' · harness doctor')}`);
  lines.push('');
  const width = Math.max(...report.checks.map((check) => check.label.length));
  for (const check of report.checks) {
    const tone = STATUS_TONE[check.status];
    lines.push(
      `  ${painter.color(tone, STATUS_MARK[check.status])} ${painter.color(tone, check.status.padEnd(4))}` +
        ` ${painter.color('muted', check.label.padEnd(width))}  ` +
        painter.color(check.status === 'ok' ? 'text' : tone, clip(check.detail, columns - width - 14)),
    );
    if (check.hint !== undefined && check.hint !== '') {
      lines.push(`    ${' '.repeat(width + 3)}${painter.color('faint', clip(check.hint, columns - width - 6))}`);
    }
  }
  lines.push('');
  const summary =
    report.failures === 0 && report.warnings === 0
      ? 'everything checks out'
      : `${report.failures} failure(s), ${report.warnings} warning(s)`;
  lines.push(
    `  ${painter.color(report.failures > 0 ? 'error' : report.warnings > 0 ? 'warn' : 'ok', summary)}`,
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * The subcommand. Prints the report and returns the exit code; it does not set
 * `process.exitCode` itself, so a caller can decide.
 */
export async function runDoctor(
  options: DoctorOptions & { json?: boolean; output?: NodeJS.WriteStream } = {},
): Promise<number> {
  const report = await collectDoctorReport(options);
  const out = options.output ?? process.stdout;
  if (options.json === true) {
    out.write(`${JSON.stringify({ checks: report.checks, failures: report.failures, warnings: report.warnings }, null, 2)}\n`);
  } else {
    out.write(formatDoctorReport(report));
  }
  return report.exitCode;
}
