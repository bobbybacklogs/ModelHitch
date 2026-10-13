import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Build `dist/` once, before any test file runs.
 *
 * Several test files drive the BUILT cli (`dist/cli.js`) end to end rather than
 * importing source, and each one used to run `npm run build` in its own
 * `beforeAll`. Vitest runs files in parallel workers, so those builds raced on
 * the same `dist/` directory: the root tsup config emits two configs that each
 * call `removeFiles`, and one build would delete the other's output mid-flight.
 * The symptom was an intermittent `Command failed: npm run build` failing a
 * whole file while every test in it passed in isolation — and, because
 * `prepublishOnly` runs the same gate, an intermittently failing publish.
 *
 * Building here instead makes the artifact a precondition of the run rather
 * than a race between files: it happens once, before collection, so the files
 * can neither race each other nor decide to skip themselves based on an
 * artifact that does not exist yet.
 *
 * Skipped when `MODELHITCH_SKIP_TEST_BUILD=1`, for a caller that has already
 * built and does not want to pay for it twice.
 */
export default function setup(): void {
  if (process.env['MODELHITCH_SKIP_TEST_BUILD'] === '1') return;
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  execSync('npm run build', { cwd: repoRoot, stdio: 'pipe' });
  if (!existsSync(join(repoRoot, 'dist', 'cli.js'))) {
    throw new Error(
      'globalSetup: `npm run build` completed but dist/cli.js is missing. ' +
        'The build is broken (a DTS-only failure can exit 0 while emitting nothing), ' +
        'and every test that drives the built CLI would otherwise fail confusingly.',
    );
  }
}
