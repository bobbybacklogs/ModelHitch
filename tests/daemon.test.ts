import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearPid,
  daemonStatus,
  isRunning,
  logFilePath,
  pidFilePath,
  probeBridge,
  readPid,
  stopBackground,
  waitForReady,
  writePid,
} from '../src/daemon.js';

const builtCli = join(import.meta.dirname, '../dist/cli.js');
const repoRoot = join(import.meta.dirname, '..');

let home: string;
const originalHome = process.env.MODELHITCH_HOME;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'mh-daemon-test-'));
  process.env.MODELHITCH_HOME = home;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.MODELHITCH_HOME;
  else process.env.MODELHITCH_HOME = originalHome;
});

describe('daemon pid file', () => {
  it('round-trips the pid file', () => {
    expect(readPid()).toBeNull();
    writePid(4242);
    expect(readPid()).toBe(4242);
    expect(pidFilePath()).toBe(join(home, 'bridge.pid'));
    expect(logFilePath()).toBe(join(home, 'bridge.log'));
    clearPid();
    expect(readPid()).toBeNull();
  });

  it('treats a garbage pid file as null', () => {
    writeFileSync(pidFilePath(), 'not-a-number');
    expect(readPid()).toBeNull();
    clearPid();
  });

  it('ignores non-positive pids', () => {
    writePid(-1);
    expect(readPid()).toBeNull();
    clearPid();
  });
});

describe('daemon liveness', () => {
  it('reports the current process as running', () => {
    expect(isRunning(process.pid)).toBe(true);
  });

  it('reports a bogus pid as not running', () => {
    expect(isRunning(999999999)).toBe(false);
  });
});

describe('daemon status', () => {
  it('reports not running with no pid file', () => {
    clearPid();
    const status = daemonStatus();
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.pidPath).toBe(join(home, 'bridge.pid'));
    expect(status.logPath).toBe(join(home, 'bridge.log'));
  });
});

describe('bridge probe', () => {
  it('reports an unused port as not responding', async () => {
    const probe = await probeBridge(1, '127.0.0.1');
    expect(probe.responding).toBe(false);
  });
});

describe('background bridge spawn', () => {
  const bgHome = mkdtempSync(join(tmpdir(), 'mh-bg-spawn-'));
  const port = 3955 + Math.floor(Math.random() * 100);
  const bgEnv = {
    ...process.env,
    MODELHITCH_HOME: bgHome,
    MODELHITCH_PORT: String(port),
    MODELHITCH_HOST: '127.0.0.1',
  };

  afterAll(async () => {
    process.env.MODELHITCH_HOME = bgHome;
    process.env.MODELHITCH_PORT = String(port);
    await stopBackground();
    rmSync(bgHome, { recursive: true, force: true });
  });

  it.skipIf(!existsSync(builtCli))('stays up when launched via the built CLI', async () => {
    const result = spawnSync(process.execPath, [builtCli, 'bridge', '--background'], {
      env: bgEnv,
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('responding on');
    expect(await waitForReady(port, '127.0.0.1', 3000)).toBe(true);
    const log = readFileSync(join(bgHome, 'bridge.log'), 'utf8');
    expect(log).toContain('listening on');
  });
});
