import { describe, expect, it } from 'vitest';
import { BUN_ENV_OVERRIDE, bunVersion, findBunCommand, isBunRuntime } from '../harness/bun.js';

/**
 * The hand-over to bun is the difference between `--tui` working from the
 * installed command and `--tui` printing an instruction to go and find bun.
 *
 * These cases are environment-dependent by nature — bun may or may not be on the
 * machine — so they assert on the *contract*: a probe never throws, a version
 * looks like a version, and a hostile override degrades instead of exploding.
 * The one thing asserted unconditionally is that this process is not bun, which
 * is what makes the hand-over necessary in the first place.
 */

const bun = findBunCommand();

describe('isBunRuntime', () => {
  it('answers for this process, and vitest is node', () => {
    expect(isBunRuntime()).toBe((globalThis as { Bun?: unknown }).Bun !== undefined);
    expect(isBunRuntime()).toBe(false);
  });
});

describe('findBunCommand', () => {
  it('returns a usable command or nothing, and never throws', () => {
    expect(bun === undefined || typeof bun === 'string').toBe(true);
  });

  it('returns a command that can actually report a version', () => {
    if (bun === undefined) return; // bun is genuinely absent on this machine
    const version = bunVersion(bun);
    expect(typeof version).toBe('string');
    expect(version).toMatch(/\d+\.\d+/);
  });

  it('falls back to PATH when the override does not work', () => {
    // A stale `HARNESS_BUN` should not be worse than no override at all: the
    // point of the variable is to help on a machine where PATH does not reach
    // bun, not to become a new way to fail.
    const previous = process.env[BUN_ENV_OVERRIDE];
    process.env[BUN_ENV_OVERRIDE] = 'definitely-not-a-real-bun-binary';
    try {
      const found = findBunCommand();
      expect(found === undefined || found === 'bun').toBe(true);
    } finally {
      if (previous === undefined) delete process.env[BUN_ENV_OVERRIDE];
      else process.env[BUN_ENV_OVERRIDE] = previous;
    }
  });

  it('prefers an override that does work', () => {
    const previous = process.env[BUN_ENV_OVERRIDE];
    // `node` is always present and answers `--version`, which is all the probe
    // asks for, so it stands in for a bun installed off PATH.
    process.env[BUN_ENV_OVERRIDE] = process.execPath;
    try {
      expect(findBunCommand()).toBe(process.execPath);
    } finally {
      if (previous === undefined) delete process.env[BUN_ENV_OVERRIDE];
      else process.env[BUN_ENV_OVERRIDE] = previous;
    }
  });

  it('ignores a blank override rather than treating it as a command', () => {
    const previous = process.env[BUN_ENV_OVERRIDE];
    process.env[BUN_ENV_OVERRIDE] = '   ';
    try {
      const found = findBunCommand();
      expect(found === undefined || found === 'bun').toBe(true);
    } finally {
      if (previous === undefined) delete process.env[BUN_ENV_OVERRIDE];
      else process.env[BUN_ENV_OVERRIDE] = previous;
    }
  });
});

describe('bunVersion', () => {
  it('reports nothing for a command that does not exist, without throwing', () => {
    expect(bunVersion('definitely-not-a-real-binary-xyz')).toBeUndefined();
  });

  it('reports a version for a command that does', () => {
    expect(bunVersion(process.execPath)).toMatch(/\d+\.\d+/);
  });
});
