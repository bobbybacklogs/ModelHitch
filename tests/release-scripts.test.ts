import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release scripts', () => {
  it('package.json version is 2.2.0', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe('2.2.0');
  });

  it('verify typechecks, then builds dist before tests so CLI integration uses a fresh binary', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
      scripts: { verify: string; prepublishOnly: string };
    };
    expect(pkg.scripts.verify).toBe('npm run typecheck && npm run build && npm test');
    expect(pkg.scripts.prepublishOnly).toBe('npm run verify');
    const buildAt = pkg.scripts.verify.indexOf('npm run build');
    const testAt = pkg.scripts.verify.indexOf('npm test');
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(testAt).toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeLessThan(testAt);
  });
});
