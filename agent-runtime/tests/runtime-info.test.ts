// Phase 1 — deterministic fixture passes discover / validate.
//
// This suite runs against the checked-in fixture plus a synthetic fixture that
// fails validation. It creates nothing in the repo tree and runs inside
// vitest's temp-dir project (see vitest.config.ts) so it cannot interfere with
// the existing ModelHitch root suite.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AGENT_ENTRY_CANDIDATES,
  REQUIRED_SHAPE,
  discover,
  discoverAgent,
  resolveEntry,
} from '../lib/runtime-info.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, '..', 'fixtures', 'minimal-agent');

const INSTRUCTIONS_TEXT = '# minimal-agent\n\nFollow the rules.\n';
const FIXTURE_INSTRUCTIONS = join(FIXTURE, 'instructions.md');

let tmpRoot;
let badAgentDir;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(join(tmpdir(), 'agent-runtime-tests-'));
  const goodDir = join(tmpRoot, 'minimal-agent');
  await fs.mkdir(goodDir);
  await fs.writeFile(join(goodDir, 'instructions.md'), INSTRUCTIONS_TEXT);
  await fs.writeFile(join(goodDir, 'agent.ts'), 'export const agent = { name: "minimal-agent" };\n');

  // A fixture that fails validation: no entry point, no instructions.
  badAgentDir = join(tmpRoot, 'broken');
  await fs.mkdir(badAgentDir);
  await fs.writeFile(join(badAgentDir, 'notes.txt'), 'no required shape here\n');
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('runtime-info discover/validate (deterministic fixtures)', () => {
  it('discovers the checked-in fixture files', async () => {
    const { files, dirs } = await discover(FIXTURE);
    expect(files).toContain('agent.ts');
    expect(files).toContain('instructions.md');
    expect(dirs).toEqual([]);
  });

  it('emits an inspectable manifest for the checked-in fixture', async () => {
    const manifest = await discoverAgent(FIXTURE);
    expect(manifest.format).toBe('agent-runtime.manifest.v1');
    expect(manifest.agentName).toBe('minimal-agent');
    expect(manifest.validation.status).toBe('ok');
    expect(manifest.validation.problems).toEqual([]);
    expect(manifest.required.instructionsFile).toBe('instructions.md');
    expect(manifest.required.entryPoint).toBe('agent.ts');
    expect(manifest.instructions).toEqual({
      path: 'instructions.md',
      bytes: Buffer.byteLength(await fs.readFile(FIXTURE_INSTRUCTIONS, 'utf8')),
      error: null,
    });
    expect(manifest.entry.exists).toBe(true);
    expect(manifest.discoveredFiles).toContain('agent.ts');
    expect(manifest.statShape.files['instructions.md']).toHaveLength(2);
  });

  it('reports validation failure and problems for a broken fixture', async () => {
    const manifest = await discoverAgent(badAgentDir);
    expect(manifest.validation.status).toBe('failed');
    expect(manifest.validation.problems.length).toBeGreaterThan(0);
  });

  it('resolves entry points by declared priority', () => {
    expect(AGENT_ENTRY_CANDIDATES[0]).toBe('agent.ts');
    expect(resolveEntry(['agent.ts', 'agent.tsx', 'agent.js'])).toBe('agent.ts');
    expect(resolveEntry(['agent.js', 'agent.ts'])).toBe('agent.ts');
    expect(resolveEntry(['main.mjs'])).toBeNull();
  });

  it('exposes the documented required shape', () => {
    expect(REQUIRED_SHAPE.instructions).toContain('instructions.md');
    expect(REQUIRED_SHAPE.entry).toContain('agent.ts');
  });
});