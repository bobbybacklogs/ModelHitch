/**
 * Finding bun.
 *
 * The TUI needs it — `@opentui/core` loads a native library through bun's FFI —
 * and the installed command is a node shim, so the two facts have to be brought
 * together somewhere. They are: `cli.ts` re-executes itself under bun when the
 * TUI is wanted, which is what makes "the TUI is used automatically" true for
 * the command people actually type rather than only for the one in the docs.
 *
 * `HARNESS_BUN` overrides the lookup for a machine where bun is installed
 * somewhere PATH does not reach.
 */

import { spawnSync } from 'node:child_process';

/** Override the bun executable. Useful when bun is not on PATH. */
export const BUN_ENV_OVERRIDE = 'HARNESS_BUN';

/** How long the probe may take before bun counts as absent. */
export const BUN_PROBE_TIMEOUT_MS = 3_000;

/** True when this process *is* bun, which is the question the renderer asks. */
export function isBunRuntime(): boolean {
  return (globalThis as { Bun?: unknown }).Bun !== undefined;
}

/**
 * The bun executable to spawn, or undefined when there is not one.
 *
 * Probed by running `bun --version` rather than by looking for a file: on
 * Windows the PATH entry is a shim, and a shim that cannot start is the same
 * answer as no shim at all.
 */
export function findBunCommand(): string | undefined {
  const override = process.env[BUN_ENV_OVERRIDE];
  const candidates = override !== undefined && override.trim() !== '' ? [override.trim(), 'bun'] : ['bun'];
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: BUN_PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim() !== '') {
        return candidate;
      }
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

/** The probed version, for a report that wants to name it. */
export function bunVersion(command = 'bun'): string | undefined {
  try {
    const result = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      timeout: BUN_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const out = result.status === 0 ? result.stdout : '';
    return typeof out === 'string' && out.trim() !== '' ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}
