import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release scripts', () => {
  it('builds dist before tests in prepublishOnly so integration tests use a fresh CLI', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
      scripts: { prepublishOnly: string };
    };
    const script = pkg.scripts.prepublishOnly;
    const buildAt = script.indexOf('npm run build');
    const testAt = script.indexOf('npm test');
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(testAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeLessThan(testAt);
  });
});
