import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  declined,
  dryRun,
  error as errorResult,
  isFailure,
  ok,
  outcomeFromText,
  outcomeLabel,
  resultFromText,
  timeout,
  truncated,
} from '../harness/result.js';
import { executeHarnessTool } from '../harness/tools.js';

/**
 * The tool-result envelope.
 *
 * The harness used to infer a call's outcome from substrings in its result
 * text, which cannot express "succeeded but cut short" and misfires whenever a
 * tool prints the word being matched. These cases pin the explicit outcomes,
 * and pin the text fallback that the `tool` event still needs.
 */

const SANDBOX = resolve(__dirname, '.tmp-result-sandbox');

beforeAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  mkdirSync(join(SANDBOX, 'src'), { recursive: true });
  writeFileSync(join(SANDBOX, 'src', 'a.ts'), 'const needle = 1;\n');
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

describe('outcomeFromText', () => {
  it('reads each shape the tools actually emit', () => {
    expect(outcomeFromText('Wrote src/app.ts (10 chars)')).toBe('ok');
    expect(outcomeFromText('Error: ENOENT: no such file')).toBe('error');
    expect(outcomeFromText('Declined by user: no changes made')).toBe('declined');
  });

  it('treats every abort as a timeout, including Ctrl-C', () => {
    // From the model's side the distinction that matters is "this did not
    // finish"; the message still says which one happened.
    expect(outcomeFromText('Error: bash timed out after 30000ms')).toBe('timeout');
    expect(outcomeFromText('Error: gh was interrupted before it finished')).toBe('timeout');
  });

  it('treats a non-zero shell exit as a failure, not a success', () => {
    // `bash` reports a failing command as `Exit 1: ...` rather than `Error: ...`
    // because it is a result the model should read. A card that coloured it
    // green would say the opposite of what happened.
    expect(outcomeFromText('Exit 1: Command failed: ls\nls is not recognized')).toBe('error');
    expect(outcomeFromText('Exit 127: not found')).toBe('error');
  });

  it('recognises a failure the opencode wrapper parsed out of its JSON stream', () => {
    expect(outcomeFromText('! opencode error (429): rate limited\n(no answer text)')).toBe('error');
  });

  it('recognises a result that is a sample rather than an answer', () => {
    expect(outcomeFromText('3 matches for "x":\n(results truncated — narrow the pattern)')).toBe('truncated');
    expect(outcomeFromText('No matches for "x" before the search was cancelled (scanned 2 files).')).toBe(
      'truncated',
    );
  });

  it('does not mistake ordinary output for a failure', () => {
    expect(outcomeFromText('Exit 1 is what you would see here')).toBe('ok');
    expect(outcomeFromText('! a free tier warning\nreal answer')).toBe('ok');
    expect(outcomeFromText('(no output)')).toBe('ok');
  });
});

describe('result constructors', () => {
  it('carry the outcome and keep the note out of the text', () => {
    const result = truncated('3 matches', 'the match list was capped');
    expect(result.outcome).toBe('truncated');
    expect(result.text).toBe('3 matches');
    // The note is a UI concern; it must never reach the model's message.
    expect(result.text).not.toContain('capped');
    expect(result.note).toBe('the match list was capped');
  });

  it('omits the note key entirely when there is none', () => {
    expect('note' in ok('fine')).toBe(false);
  });

  it('classifies a bare string through the fallback', () => {
    expect(resultFromText('Error: nope').outcome).toBe('error');
    expect(resultFromText('fine').outcome).toBe('ok');
  });

  it('separates the failure outcomes from the rest', () => {
    expect(isFailure('error')).toBe(true);
    expect(isFailure('timeout')).toBe(true);
    // A partial answer is still an answer, and a decline is a decision.
    expect(isFailure('truncated')).toBe(false);
    expect(isFailure('declined')).toBe(false);
    expect(isFailure('dry-run')).toBe(false);
    expect(isFailure('ok')).toBe(false);
  });

  it('labels every outcome, with no label for success', () => {
    expect(outcomeLabel('ok')).toBe('');
    expect(outcomeLabel('timeout')).toBe('did not finish');
    expect(outcomeLabel('dry-run')).toBe('dry run');
    for (const outcome of ['ok', 'error', 'timeout', 'truncated', 'declined', 'dry-run'] as const) {
      expect(typeof outcomeLabel(outcome)).toBe('string');
    }
  });

  it('round-trips every constructor through the text fallback', () => {
    // The fallback and the constructors must agree, or a renderer reading the
    // `tool` event would colour a card differently from the executor.
    expect(outcomeFromText(ok('Wrote a.ts (1 chars)').text)).toBe('ok');
    expect(outcomeFromText(timeout('Error: bash timed out after 10ms').text)).toBe('timeout');
    expect(outcomeFromText(errorResult('Error: broke').text)).toBe('error');
    expect(outcomeFromText(declined('Declined by user: no changes made').text)).toBe('declined');
    // `dry-run` has no textual form, so it legitimately reads back as `ok`.
    expect(dryRun('nothing to do').outcome).toBe('dry-run');
  });
});

describe('executeHarnessTool outcomes', () => {
  it('reports a successful read and write', async () => {
    const read = await executeHarnessTool('read', { path: 'src/a.ts' }, { workspaceDir: SANDBOX });
    expect(read.outcome).toBe('ok');
    expect(read.text).toBe('const needle = 1;\n');

    const write = await executeHarnessTool(
      'write',
      { path: 'src/b.ts', content: 'x\n' },
      { workspaceDir: SANDBOX },
    );
    expect(write.outcome).toBe('ok');
    expect(write.text).toContain('Wrote src/b.ts');
  });

  it('reports a missing file as an error, not a timeout', async () => {
    const result = await executeHarnessTool('read', { path: 'src/nope.ts' }, { workspaceDir: SANDBOX });
    expect(result.outcome).toBe('error');
    expect(result.text.startsWith('Error:')).toBe(true);
  });

  it('returns the whole body on a repeat read when no cache is supplied', async () => {
    // The read cache is per run and opt-in: a caller with no run to scope one to
    // keeps reading the file, which is what every case above relies on.
    const first = await executeHarnessTool('read', { path: 'src/a.ts' }, { workspaceDir: SANDBOX });
    const second = await executeHarnessTool('read', { path: 'src/a.ts' }, { workspaceDir: SANDBOX });
    expect(first.text).toBe('const needle = 1;\n');
    expect(second.text).toBe(first.text);
  });

  it('reports an edit that cannot match as an error', async () => {
    const result = await executeHarnessTool(
      'edit',
      { path: 'src/a.ts', oldString: 'not present', newString: 'x' },
      { workspaceDir: SANDBOX },
    );
    expect(result.outcome).toBe('error');
  });

  it('reports an unknown tool as an error', async () => {
    const result = await executeHarnessTool('nonsense', {}, { workspaceDir: SANDBOX });
    expect(result.outcome).toBe('error');
    expect(result.text).toContain('unknown tool');
  });

  it('reports a non-zero shell exit as an error', async () => {
    const result = await executeHarnessTool(
      'bash',
      { command: 'node -e "process.exit(3)"' },
      { workspaceDir: SANDBOX },
    );
    expect(result.outcome).toBe('error');
    expect(result.text.startsWith('Exit 3')).toBe(true);
  });

  it('reports a clean shell exit as ok', async () => {
    const result = await executeHarnessTool('bash', { command: 'echo hi' }, { workspaceDir: SANDBOX });
    expect(result.outcome).toBe('ok');
    expect(result.text.trim()).toBe('hi');
  });

  it('reports a capped match list as truncated rather than failed', async () => {
    // A capped search still answered the question; it answered it partially.
    // Calling that an error would tell the model its tool broke.
    const capped = await executeHarnessTool(
      'grep_search',
      { pattern: 'needle', maxResults: 1 },
      { workspaceDir: SANDBOX },
    );
    expect(capped.outcome).toBe('truncated');
    expect(capped.text).not.toContain('Error:');

    const uncapped = await executeHarnessTool(
      'grep_search',
      { pattern: 'needle' },
      { workspaceDir: SANDBOX },
    );
    expect(uncapped.outcome).toBe('ok');

    const missing = await executeHarnessTool(
      'grep_search',
      { pattern: 'needle', path: 'no-such-dir' },
      { workspaceDir: SANDBOX },
    );
    expect(missing.outcome).toBe('error');
  });

  it('reports an already-aborted signal as a timeout', async () => {
    const controller = new AbortController();
    controller.abort('interrupt');
    const result = await executeHarnessTool(
      'read',
      { path: 'src/a.ts' },
      { workspaceDir: SANDBOX, signal: controller.signal },
    );
    expect(result.outcome).toBe('timeout');
    expect(result.text).toContain('cancelled before it started');
  });

  it('reports a declined call as declined, with the text unchanged', async () => {
    const result = await executeHarnessTool(
      'write',
      { path: 'src/never.ts', content: 'x' },
      { workspaceDir: SANDBOX, onApproval: async () => false },
    );
    expect(result.outcome).toBe('declined');
    expect(result.text).toBe('Declined by user: no changes made');
  });
});
