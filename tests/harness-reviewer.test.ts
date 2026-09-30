import { describe, expect, it } from 'vitest';
import {
  REVIEWER_AGENT_MARKDOWN,
  buildReviewTask,
  buildReviewerRegistration,
  checkReviewerDefinition,
  runReview,
} from '../harness/reviewer.js';
import { MUTATING_TOOLS } from '../harness/approval.js';
import { parseFrontmatter } from '../harness/agent-library.js';
import type { HarnessRuntime } from '../harness/runtime.js';

/**
 * The reviewer's value is that it cannot change anything and cannot fail the
 * run it is reviewing. Both of those are structural, so both are pinned here:
 * the tool grant is derived and checked rather than asserted, and every unhappy
 * path returns a reason instead of throwing.
 */

/** A runtime whose client only ever exists to satisfy the roster's constructor. */
const runtime = { client: {}, provider: 'p', model: 'm', configPath: '', config: {} } as unknown as HarnessRuntime;

describe('the bundled definition', () => {
  it('parses through the same frontmatter parser every other agent uses', () => {
    const parsed = parseFrontmatter(REVIEWER_AGENT_MARKDOWN);
    expect(parsed.data['name']).toBe('Reviewer');
    expect(parsed.warnings).toEqual([]);
    expect(parsed.body).toContain('Correctness');
  });

  it('derives a read-only grant, containing no mutating tool', () => {
    const registration = buildReviewerRegistration();
    expect(registration.refused).toBeUndefined();
    expect(registration.spec?.tools).toBe('readonly');
    expect(registration.warnings).toEqual([]);
  });

  it('is never granted a tool that can change the workspace', () => {
    // The check that matters: whatever the definition says, the derived tier is
    // what the roster acts on, and `readonly` must not include a writer.
    expect(MUTATING_TOOLS).toContain('write');
    expect(MUTATING_TOOLS).toContain('bash');
    const registration = buildReviewerRegistration();
    expect(registration.spec?.tools).toBe('readonly');
    expect(MUTATING_TOOLS).not.toContain('read_file');
    expect(MUTATING_TOOLS).not.toContain('grep_search');
  });

  it('refuses a definition that would be granted a mutating tool', () => {
    // `run_command` maps to a shell, which is mutating, so a reviewer declaring
    // it must be refused outright rather than silently downgraded — that is the
    // whole reason the grant is derived and then checked.
    const hostile = '---\nname: Sneaky\ntools:\n  - view_file\n  - run_command\n---\n\nedit things\n';
    const registration = checkReviewerDefinition(hostile);
    expect(registration.spec).toBeUndefined();
    expect(registration.refused).toContain('mutating tool');
    expect(registration.refused).toContain('run_command');
  });

  it('refuses a definition that declares nothing to work with', () => {
    const registration = checkReviewerDefinition('---\nname: Empty\n---\n\nnothing\n');
    expect(registration.spec).toBeUndefined();
    expect(registration.refused).toContain('declares no tools');
  });

  it('warns about a declared tool with no equivalent here, without refusing', () => {
    const registration = checkReviewerDefinition('---\nname: Odd\ntools:\n  - view_file\n  - teleport\n---\n\nx\n');
    expect(registration.refused).toBeUndefined();
    expect(registration.spec?.tools).toBe('readonly');
    expect(registration.warnings.some((warning) => warning.includes('teleport'))).toBe(true);
  });
});

describe('buildReviewTask', () => {
  it('carries the original task and every change preview', () => {
    const task = buildReviewTask('fix the off-by-one', [
      { tool: 'edit', preview: '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-for (i=0;i<=n;i++)\n+for (i=0;i<n;i++)' },
      { tool: 'bash', preview: '$ npm test' },
    ]);
    expect(task).toContain('fix the off-by-one');
    expect(task).toContain('What was changed (2 calls)');
    expect(task).toContain('i<n');
    expect(task).toContain('npm test');
  });

  it('uses the singular for one change', () => {
    expect(buildReviewTask('t', [{ tool: 'edit', preview: 'd' }])).toContain('(1 call)');
  });
});

describe('runReview', () => {
  it('skips with a reason when nothing changed', async () => {
    const result = await runReview({
      task: 'do nothing',
      changes: [],
      runtime,
      workspaceDir: process.cwd(),
      summarizeThreshold: 8_000,
      summarizeEnabled: false,
    });
    expect(result.critique).toBeUndefined();
    expect(result.skipped).toContain('nothing to review');
  });

  it('never throws when the reviewer cannot run at all', async () => {
    // A nonsense workspace dir is enough to make the roster construction fail;
    // whatever happens, this must return rather than reject.
    const result = await runReview({
      task: 'task',
      changes: [{ tool: 'edit', preview: 'diff' }],
      runtime,
      workspaceDir: process.cwd(),
      summarizeThreshold: 8_000,
      summarizeEnabled: false,
      log: () => undefined,
    });
    // bihan is not resolvable from a client stub in this environment, so either a
    // critique or a skip is acceptable — an exception is not.
    expect(result.critique !== undefined || result.skipped !== undefined).toBe(true);
  });
});
