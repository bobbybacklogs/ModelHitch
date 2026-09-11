/**
 * Background process management for the ModelHitch CLI.
 *
 * `modelhitch bridge --background` spawns a detached server process that keeps
 * running after the terminal exits, tracked via a per-user PID file:
 *   - ~/.modelhitch/bridge.pid  (the running process id)
 *   - ~/.modelhitch/bridge.log  (stdout/stderr of the background process)
 *   - override the directory with MODELHITCH_HOME
 *
 * Companion commands:
 *   status — reads the PID file and probes liveness (+ best-effort /healthz)
 *   front  — stops the background instance and runs the bridge in THIS terminal
 *   stop   — terminates the background instance and removes the PID file
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { currentModuleUrl } from './core/import-meta.js';

function daemonDir(): string {
  return process.env.MODELHITCH_HOME ?? join(homedir(), '.modelhitch');
}

export function pidFilePath(): string {
  return join(daemonDir(), 'bridge.pid');
}

export function logFilePath(): string {
  return join(daemonDir(), 'bridge.log');
}

/** Read the tracked PID, or null when the file is missing or garbage. */
export function readPid(): number | null {
  try {
    if (!existsSync(pidFilePath())) return null;
    const pid = Number.parseInt(readFileSync(pidFilePath(), 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePid(pid: number): void {
  mkdirSync(daemonDir(), { recursive: true });
  writeFileSync(pidFilePath(), String(pid));
}

export function clearPid(): void {
  try {
    rmSync(pidFilePath(), { force: true });
  } catch {
    /* ignore */
  }
}

/** Liveness probe — signal 0 never delivers a signal, only checks existence. */
export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  logPath: string;
  pidPath: string;
}

export interface BridgeProbe {
  responding: boolean;
  url: string;
}

export function daemonStatus(): DaemonStatus {
  const pid = readPid();
  const running = pid !== null && isRunning(pid);
  return { running, pid: running ? pid : null, logPath: logFilePath(), pidPath: pidFilePath() };
}

/** Probe the configured bridge address, including instances not tracked by our PID file. */
export async function probeBridge(port: number, host: string): Promise<BridgeProbe> {
  const url = `http://${host}:${port}`;
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(800) });
    return { responding: res.ok, url };
  } catch {
    return { responding: false, url };
  }
}

/**
 * Path to the CLI entry script to re-exec for background mode.
 *
 * In the bundled `dist/cli.js` artifact, `currentModuleUrl()` resolves to a
 * shared chunk (e.g. `dist/chunk-*.js`), not the CLI entry — spawning that
 * file exits immediately with no bridge. `process.argv[1]` is always the real
 * entry (`dist/cli.js`, an npm `.bin` symlink, or `src/cli.ts` under tsx).
 */
function currentScript(): string {
  if (process.argv[1]) return resolve(process.argv[1]);
  const sibling = join(dirname(fileURLToPath(currentModuleUrl())), 'cli.js');
  if (existsSync(sibling)) return sibling;
  return fileURLToPath(currentModuleUrl());
}

/**
 * How to re-invoke this CLI: plain `node <script>` for the built artifact, and
 * via the local tsx CLI when running from source (dev).
 */
function runnerFor(script: string): [string, string[]] {
  if (!script.endsWith('.ts')) return [process.execPath, [script]];
  const require = createRequire(currentModuleUrl());
  const tsxPkg = require.resolve('tsx/package.json');
  return [process.execPath, [join(dirname(tsxPkg), 'dist', 'cli.mjs'), script]];
}

export interface SpawnedDaemon {
  pid: number;
  logPath: string;
  alreadyRunning: boolean;
}

/**
 * Spawn a detached background instance of this CLI (stdio appended to the log
 * file) and record its PID. Returns `alreadyRunning: true` when a live
 * background instance is already tracked.
 */
export function spawnBackground(args: string[]): SpawnedDaemon {
  const existing = daemonStatus();
  if (existing.running && existing.pid !== null) {
    return { pid: existing.pid, logPath: existing.logPath, alreadyRunning: true };
  }

  mkdirSync(daemonDir(), { recursive: true });
  const logFile = logFilePath();
  const logFd = openSync(logFile, 'a');
  const [cmd, cmdArgs] = runnerFor(currentScript());
  const child = spawn(cmd, [...cmdArgs, ...args], {
    detached: true, // new process group; survives the parent exiting
    windowsHide: true, // no console window pops up on Windows
    stdio: ['ignore', logFd, logFd],
    env: process.env, // inherit keys (AI_GATEWAY_*, OPENAI_*, …) from the launcher
    cwd: process.cwd(),
  });
  child.unref();
  writePid(child.pid ?? 0);
  return { pid: child.pid ?? 0, logPath: logFile, alreadyRunning: false };
}

/** Terminate the tracked background instance (force tree-kill on Windows). */
export async function stopBackground(): Promise<{ stopped: boolean; pid: number | null }> {
  const status = daemonStatus();
  if (!status.running || status.pid === null) {
    if (readPid() !== null) clearPid(); // stale pid file from a dead process
    return { stopped: false, pid: null };
  }

  const pid = status.pid;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
      const end = Date.now() + 2000;
      while (Date.now() < end && isRunning(pid)) await sleep(50);
      if (isRunning(pid)) process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  clearPid();
  return { stopped: true, pid };
}

/** Poll /healthz until the bridge responds (or the timeout elapses). */
export async function waitForReady(
  port: number,
  host: string,
  timeoutMs: number,
  pid?: number,
): Promise<boolean> {
  const url = `http://${host}:${port}/healthz`;
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pid !== undefined && !isRunning(pid)) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}
