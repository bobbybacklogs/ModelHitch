import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DECLINE_MESSAGE,
  createApprovalHandler,
  isMutatingToolCall,
  buildApprovalPreview,
} from '../harness/approval.js';
import { executeHarnessTool } from '../harness/tools.js';

/**
 * `executeHarnessTool` returns `{ text, outcome }`. These cases are about the
 * text that reaches the model, so they assert on that; the envelope's outcome
 * vocabulary is pinned in `harness-result.test.ts`.
 */
const toolText = async (
  name: string,
  args: Record<string, unknown>,
  opts?: Parameters<typeof executeHarnessTool>[2],
): Promise<string> => (await executeHarnessTool(name, args, opts)).text;

/**
 * The approval gate is the only thing standing between a model's plan and the
 * workspace, so the tests care about two things: that a decline really leaves
 * the workspace untouched, and that the preview shows what will happen rather
 * than a summary of it.
 */

const SANDBOX = resolve(__dirname, '.tmp-approval-sandbox');

beforeAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(join(SANDBOX, 'src'), { recursive: true });
  writeFileSync(join(SANDBOX, 'src', 'tracked.ts'), 'const value = 1;\n');
  writeFileSync(join(SANDBOX, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe('isMutatingToolCall', () => {
  it('gates the harness tools that change files or run commands', () => {
    expect(isMutatingToolCall('write')).toBe(true);
    expect(isMutatingToolCall('edit')).toBe(true);
    expect(isMutatingToolCall('bash')).toBe(true);
  });

  it('gates the library names for the same capabilities', () => {
    expect(isMutatingToolCall('write_file')).toBe(true);
    expect(isMutatingToolCall('run_command')).toBe(true);
    expect(isMutatingToolCall('replace_file_content')).toBe(true);
  });

  it('gates delegation, because a delegate writes with its own hands', () => {
    expect(isMutatingToolCall('subagent')).toBe(true);
    expect(isMutatingToolCall('opencode')).toBe(true);
    expect(isMutatingToolCall('agy')).toBe(true);
  });

  it('leaves read-only tools alone', () => {
    expect(isMutatingToolCall('read')).toBe(false);
    expect(isMutatingToolCall('grep_search')).toBe(false);
    expect(isMutatingToolCall('read_file')).toBe(false);
  });

  it('treats a reading gh verb as safe and anything else as mutating', () => {
    expect(isMutatingToolCall('gh', { args: ['pr', 'view', '12'] })).toBe(false);
    expect(isMutatingToolCall('gh', { args: ['issue', 'list'] })).toBe(false);
    expect(isMutatingToolCall('gh', { args: ['pr', 'create', '--title', 'x'] })).toBe(true);
    expect(isMutatingToolCall('gh', { args: ['api', '-X', 'POST', '/repos'] })).toBe(true);
    // A flag value that happens to be a read verb must not excuse a write.
    expect(isMutatingToolCall('gh', { args: ['pr', 'merge', '--subject', 'view'] })).toBe(true);
    expect(isMutatingToolCall('gh', {})).toBe(true);
  });
});

describe('buildApprovalPreview', () => {
  it('shows a unified diff of the current file against the new contents', async () => {
    const preview = await buildApprovalPreview(
      'write',
      { path: 'src/tracked.ts', content: 'const value = 2;\n' },
      { workspaceDir: SANDBOX },
    );
    expect(preview).toContain('--- a/src/tracked.ts');
    expect(preview).toContain('-const value = 1;');
    expect(preview).toContain('+const value = 2;');
  });

  it('labels a path that does not exist yet', async () => {
    const preview = await buildApprovalPreview(
      'write',
      { path: 'src/added.ts', content: 'export {};\n' },
      { workspaceDir: SANDBOX },
    );
    expect(preview).toContain('[new file] src/added.ts');
    expect(preview).toContain('+export {};');
  });

  it('labels a binary target instead of diffing it', async () => {
    const preview = await buildApprovalPreview(
      'write',
      { path: 'blob.bin', content: 'text now' },
      { workspaceDir: SANDBOX },
    );
    expect(preview).toBe('[binary] blob.bin');
  });

  it('shows the successful edit rather than the raw arguments', async () => {
    const preview = await buildApprovalPreview(
      'edit',
      { path: 'src/tracked.ts', oldString: 'value = 1', newString: 'value = 3' },
      { workspaceDir: SANDBOX },
    );
    expect(preview).toContain('-const value = 1;');
    expect(preview).toContain('+const value = 3;');
  });

  it('says so when the edit cannot apply, rather than showing a diff', async () => {
    const preview = await buildApprovalPreview(
      'edit',
      { path: 'src/tracked.ts', oldString: 'not here', newString: 'x' },
      { workspaceDir: SANDBOX },
    );
    expect(preview).toContain('does not appear');
  });

  it('refuses to read outside the workspace', async () => {
    const preview = await buildApprovalPreview(
      'write',
      { path: '../../escape.txt', content: 'nope' },
      { workspaceDir: SANDBOX },
    );
    expect(preview).toContain('outside the workspace');
  });

  it('shows a shell command verbatim', async () => {
    const preview = await buildApprovalPreview(
      'bash',
      { command: 'rm -rf build && npm test' },
      { workspaceDir: SANDBOX },
    );
    expect(preview).toBe('$ rm -rf build && npm test');
  });

  it('shows what a delegation will hand over', async () => {
    const preview = await buildApprovalPreview(
      'subagent',
      { agent: 'Builder', task: 'implement the widget' },
      { workspaceDir: SANDBOX },
    );
    expect(preview).toContain('Builder');
    expect(preview).toContain('implement the widget');
  });
});

describe('createApprovalHandler', () => {
  it('approves everything under --yes without asking', async () => {
    const handler = createApprovalHandler({ assumeYes: true, log: () => undefined });
    expect(await handler({ tool: 'write', args: {}, preview: 'x' })).toBe(true);
  });

  it('declines on a non-TTY stdin instead of hanging', async () => {
    const lines: string[] = [];
    const handler = createApprovalHandler({
      input: { isTTY: false } as unknown as NodeJS.ReadStream,
      output: { write: (chunk: string) => lines.push(chunk) } as unknown as NodeJS.WriteStream,
    });
    expect(await handler({ tool: 'bash', args: {}, preview: '$ ls' })).toBe(false);
    expect(lines.join('')).toContain('[approval] bash');
    expect(lines.join('')).toContain('not a TTY');
  });
});

describe('the gate inside executeHarnessTool', () => {
  it('runs the preview and the tool body only after approval', async () => {
    const order: string[] = [];
    const out = await toolText(
      'write',
      { path: 'src/gated.ts', content: 'gated\n' },
      {
        workspaceDir: SANDBOX,
        onApproval: async (request) => {
          order.push(`asked:${request.tool}`);
          expect(existsSync(join(SANDBOX, 'src', 'gated.ts'))).toBe(false);
          return true;
        },
      },
    );
    expect(order).toEqual(['asked:write']);
    expect(out).toContain('Wrote src/gated.ts');
    expect(readFileSync(join(SANDBOX, 'src', 'gated.ts'), 'utf8')).toBe('gated\n');
  });

  it('declines without touching the file, distinctly from a failure', async () => {
    const target = join(SANDBOX, 'src', 'declined.ts');
    const declined = await executeHarnessTool(
      'write',
      { path: 'src/declined.ts', content: 'never written\n' },
      { workspaceDir: SANDBOX, onApproval: async () => false },
    );
    expect(declined.text).toBe(DECLINE_MESSAGE);
    expect(declined.text).toContain('no changes made');
    // A decline must not read as a broken tool, or the model chases a bug that
    // does not exist instead of asking for approval differently.
    expect(declined.outcome).toBe('declined');
    expect(existsSync(target)).toBe(false);
  });

  it('leaves an existing file byte-identical after a decline', async () => {
    const target = join(SANDBOX, 'src', 'tracked.ts');
    const before = readFileSync(target, 'utf8');
    const out = await toolText(
      'edit',
      { path: 'src/tracked.ts', oldString: 'value = 1', newString: 'value = 9' },
      { workspaceDir: SANDBOX, onApproval: async () => false },
    );
    expect(out).toBe(DECLINE_MESSAGE);
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('does not run a declined command', async () => {
    const out = await toolText(
      'bash',
      { command: 'echo should-not-appear' },
      { workspaceDir: SANDBOX, onApproval: async () => false },
    );
    expect(out).toBe(DECLINE_MESSAGE);
  });

  it('never asks about a read-only call', async () => {
    let asked = 0;
    await toolText(
      'read',
      { path: 'src/tracked.ts' },
      {
        workspaceDir: SANDBOX,
        onApproval: async () => {
          asked++;
          return true;
        },
      },
    );
    expect(asked).toBe(0);
  });

  it('applies no gate at all when no handler is supplied', async () => {
    const out = await toolText(
      'write',
      { path: 'src/ungated.ts', content: 'ok\n' },
      { workspaceDir: SANDBOX },
    );
    expect(out).toContain('Wrote src/ungated.ts');
  });
});
