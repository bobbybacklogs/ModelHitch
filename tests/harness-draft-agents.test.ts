import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  C2C_MISSING_MESSAGE,
  DRAFT_REQUEST_BUDGET,
  DRAFT_TOOL_NAMES,
  MAX_DRAFTS,
  buildDraftRequest,
  draftAgents,
  parseDraftResponse,
  probeC2c,
  renderAgentDiff,
} from '../harness/draft-agents.js';
import type { DraftEvidence } from '../harness/draft-agents.js';

/**
 * Drafting is the one part of the harness that can grow the agent library, so
 * these tests cover three separate risks:
 *
 *  1. Parsing. The model's answer is untrusted input: it arrives wrapped in
 *     prose and fences, or truncated, or as an apology. `parseDraftResponse` is
 *     pure, so every one of those shapes is pinned here without a provider.
 *  2. Size. The request is built from run history and a library that both grow
 *     without bound, so the budget is asserted against an oversized library.
 *  3. Rendering and safety. c2c is the only thing allowed to render
 *     frontmatter, and nothing may reach the agents directory without an
 *     explicit install plus an explicit yes. The live test at the bottom proves
 *     that end to end against the real c2c when it is installed.
 */

const tmpDirs: string[] = [];

function makeTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leaked temp dir is not worth failing a test run over */
    }
  }
});

/* ------------------------------------------------------------------ *
 * parseDraftResponse
 * ------------------------------------------------------------------ */

const GOOD_DRAFT = {
  name: 'log-triage',
  description: 'Triage a failing CI log down to the first real error.',
  tools: ['view_file', 'grep_search'],
  body: '# Log triage\n\nFind the first error that is not a consequence of another.',
};

describe('parseDraftResponse', () => {
  it('reads a fenced json block', () => {
    const text = `Here is what I propose:\n\n\`\`\`json\n${JSON.stringify([GOOD_DRAFT])}\n\`\`\`\n`;
    const drafts = parseDraftResponse(text);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.name).toBe('log-triage');
    expect(drafts[0]?.declaredTools).toEqual(['view_file', 'grep_search']);
    expect(drafts[0]?.body).toContain('first error');
  });

  it('reads a bare array with prose around it', () => {
    const text = `Sure. ${JSON.stringify([GOOD_DRAFT])} Let me know if you want more.`;
    expect(parseDraftResponse(text)).toHaveLength(1);
  });

  it('reads a bare array with no prose at all', () => {
    expect(parseDraftResponse(JSON.stringify([GOOD_DRAFT]))).toHaveLength(1);
  });

  it('ignores malformed entries and keeps the good ones', () => {
    const text = JSON.stringify([
      GOOD_DRAFT,
      { name: 5, description: 'numeric name', tools: [], body: 'body' },
      { name: 'no-body', description: 'missing body', tools: [] },
      { name: 'no-description', tools: [], body: 'body' },
      'a bare string',
      null,
      { ...GOOD_DRAFT, name: 'second', tools: ['view_file', 7, 'grep_search', 'view_file'] },
    ]);
    const drafts = parseDraftResponse(text);
    expect(drafts.map((d) => d.name)).toEqual(['log-triage', 'second']);
    // Non-string tool names are dropped and duplicates collapse, so the token
    // that later reaches a command line is always a clean name.
    expect(drafts[1]?.declaredTools).toEqual(['view_file', 'grep_search']);
  });

  it('returns [] for a non-JSON answer', () => {
    expect(parseDraftResponse('I cannot help with that.')).toEqual([]);
    expect(parseDraftResponse('{"not":"an array"}')).toEqual([]);
    expect(parseDraftResponse('```json\n{ broken\n```')).toEqual([]);
    expect(parseDraftResponse('[{"name":"x",')).toEqual([]);
  });

  it('returns [] for empty input rather than throwing', () => {
    expect(parseDraftResponse('')).toEqual([]);
    expect(parseDraftResponse('   \n  ')).toEqual([]);
  });

  it(`caps the number of drafts at ${MAX_DRAFTS}`, () => {
    const many = Array.from({ length: MAX_DRAFTS + 6 }, (_v, i) => ({ ...GOOD_DRAFT, name: `draft-${i}` }));
    expect(parseDraftResponse(JSON.stringify(many))).toHaveLength(MAX_DRAFTS);
  });

  it('refuses to smuggle a path traversal or a shell metacharacter in a tool name', () => {
    const text = JSON.stringify([{ ...GOOD_DRAFT, tools: ['view_file; rm -rf /', '../../etc/passwd'] }]);
    expect(parseDraftResponse(text)[0]?.declaredTools).toEqual(['view_filerm-rf', 'etcpasswd']);
  });
});

/* ------------------------------------------------------------------ *
 * buildDraftRequest
 * ------------------------------------------------------------------ */

describe('buildDraftRequest', () => {
  const evidence: DraftEvidence = {
    task: 'Fix the failing harness grep test.',
    toolsUsed: ['grep_search', 'read_file', 'write_file'],
    finalMessage: 'The test failed because the pattern was unescaped.',
    existingAgents: [
      { name: 'ui-qa', description: 'Final product-quality pass.' },
      { name: 'orchestrator', description: 'Fan work out to workers.' },
    ],
  };

  it('carries the task, the tools actually used, and the existing agents', () => {
    const request = buildDraftRequest(evidence);
    expect(request).toContain('Fix the failing harness grep test.');
    expect(request).toContain('grep_search, read_file, write_file');
    expect(request).toContain('The test failed because the pattern was unescaped.');
    expect(request).toContain('ui-qa');
    expect(request).toContain('orchestrator');
    expect(request).toContain('Final product-quality pass.');
    expect(request).toContain(`at most ${MAX_DRAFTS}`);
  });

  it('names the exact tools a draft is allowed to declare', () => {
    const request = buildDraftRequest(evidence);
    for (const tool of DRAFT_TOOL_NAMES) expect(request).toContain(tool);
  });

  it('stays under the documented budget with a large library and a long run', () => {
    const big: DraftEvidence = {
      task: `BUDGETTEST ${'task '.repeat(1000)}`,
      toolsUsed: Array.from({ length: 400 }, (_v, i) => `tool_${i}`),
      finalMessage: 'message '.repeat(3000),
      existingAgents: Array.from({ length: 200 }, (_v, i) => ({
        name: `agent-number-${i}`,
        description: `A description that goes on for a while, for agent ${i}. `.repeat(4),
      })),
    };
    const request = buildDraftRequest(big);
    expect(request.length).toBeLessThanOrEqual(DRAFT_REQUEST_BUDGET);
    // The head of the task survives truncation, and the omitted library entries
    // are declared rather than silently dropped.
    expect(request).toContain('BUDGETTEST');
    expect(request).toContain('more existing agents not listed');
  });

  it('truncates a long description in the library list', () => {
    const request = buildDraftRequest({
      ...evidence,
      existingAgents: [{ name: 'long-winded', description: 'x'.repeat(500) }],
    });
    expect(request).not.toContain('x'.repeat(200));
  });
});

/* ------------------------------------------------------------------ *
 * renderAgentDiff
 * ------------------------------------------------------------------ */

describe('renderAgentDiff', () => {
  const NEW_FILE = '---\nname: probe\n---\n\nBody\n';

  it('renders a new-file diff when there is no target', () => {
    const diff = renderAgentDiff(NEW_FILE, null);
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('@@ -0,0 +1,5 @@');
    expect(diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))).toHaveLength(5);
  });

  it('renders a new-file diff when the target path does not exist yet', () => {
    const target = join(makeTmp('harness-draft-diff-'), 'probe', 'agent.md');
    const diff = renderAgentDiff(NEW_FILE, target);
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+name: probe');
  });

  it('renders -/+ lines for the changed content of an existing file', () => {
    const dir = makeTmp('harness-draft-diff-');
    const target = join(dir, 'probe', 'agent.md');
    writeFileSync(join(dir, 'agent.md'), '---\nname: probe\n---\n\nOld body\n', 'utf8');
    const diff = renderAgentDiff(NEW_FILE, join(dir, 'agent.md'));
    const lines = diff.split('\n');
    expect(lines[0]).toBe(`--- a/${join(dir, 'agent.md').split('\\').join('/')}`);
    expect(lines[1]).toBe(`+++ b/${join(dir, 'agent.md').split('\\').join('/')}`);
    expect(lines).toContain('-Old body');
    expect(lines).toContain('+Body');
    // Unchanged context is kept, which is what makes the diff reviewable.
    expect(lines).toContain(' name: probe');

    // The unreadable target is treated as new rather than as an error.
    expect(renderAgentDiff(NEW_FILE, target)).toContain('--- /dev/null');
  });

  it('reports no changes for identical content', () => {
    const dir = makeTmp('harness-draft-diff-');
    const target = join(dir, 'agent.md');
    writeFileSync(target, NEW_FILE, 'utf8');
    expect(renderAgentDiff(NEW_FILE, target)).toContain('no changes');
  });
});

/* ------------------------------------------------------------------ *
 * Live c2c: the rendering and install path
 * ------------------------------------------------------------------ */

/**
 * `spawnSync('c2c', ['--version'])` cannot be used as the PATH check on Windows:
 * c2c installs as a `.cmd` shim, and Node refuses to spawn `.cmd`/`.bat`
 * directly (ENOENT, then EINVAL once the extension is spelled out). The
 * module's own probe already handles that, so it is what decides the skip.
 */
const c2cProbe = probeC2c();
const hasC2c = c2cProbe.available;

const DRAFT_ANSWER = JSON.stringify([
  {
    name: 'tmp-harness-probe',
    description: 'Probe an injected draft through c2c and the library parser.',
    tools: ['view_file', 'grep_search'],
    body: '# Tmp Harness Probe\n\nDo the probe thing and report what you found.',
  },
]);

const EVIDENCE: DraftEvidence = {
  task: 'Probe the drafting path.',
  toolsUsed: ['grep_search', 'read_file'],
  finalMessage: 'Probed.',
  existingAgents: [],
};

describe.skipIf(!hasC2c)('draftAgents with the real c2c', () => {
  it('renders and validates a draft without writing anything on a dry run', async () => {
    const agentsDir = makeTmp('harness-draft-live-');
    const logs: string[] = [];
    let confirmedDiff = '';

    const candidates = await draftAgents(EVIDENCE, {
      workspaceDir: process.cwd(),
      agentsDir,
      existingNames: [],
      complete: async () => DRAFT_ANSWER,
      confirm: async (_candidate, diff) => {
        confirmedDiff = diff;
        return true;
      },
      log: (message) => logs.push(message),
      install: false,
      timeoutMs: 60_000,
    });

    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    expect(candidate?.problems).toEqual([]);
    expect(candidate?.name).toBe('tmp-harness-probe');
    expect(candidate?.markdown).toContain('name: tmp-harness-probe');
    expect(candidate?.markdown).toContain('- view_file');
    // The rendered file must be parseable by the library's own loader, with the
    // tier and delegatable flags the caller needs to decide.
    expect(candidate?.agent?.name).toBe('tmp-harness-probe');
    expect(candidate?.agent?.delegatable).toBe(true);
    expect(candidate?.agent?.tier).toBe('readonly');
    expect(candidate?.agent?.declaredTools).toEqual(['view_file', 'grep_search']);
    expect(candidate?.agent?.unsupportedTools).toEqual([]);
    expect(confirmedDiff).toContain('--- /dev/null');
    expect(logs.join('\n')).toContain('dry run');

    // The install-safety rule: a dry run writes nothing, anywhere.
    expect(readdirSync(agentsDir)).toEqual([]);
  }, 90_000);

  it('writes nothing when confirm refuses, even with install: true', async () => {
    const agentsDir = makeTmp('harness-draft-live-');
    const candidates = await draftAgents(EVIDENCE, {
      workspaceDir: process.cwd(),
      agentsDir,
      existingNames: [],
      complete: async () => DRAFT_ANSWER,
      confirm: async () => false,
      install: true,
      timeoutMs: 60_000,
    });

    expect(candidates[0]?.problems).toContain('refused at confirmation');
    expect(readdirSync(agentsDir)).toEqual([]);
  }, 90_000);

  it('installs exactly one agent.md when install is true and confirm agrees', async () => {
    const agentsDir = makeTmp('harness-draft-live-');
    const candidates = await draftAgents(EVIDENCE, {
      workspaceDir: process.cwd(),
      agentsDir,
      existingNames: [],
      complete: async () => DRAFT_ANSWER,
      confirm: async () => true,
      install: true,
      timeoutMs: 60_000,
    });

    expect(candidates[0]?.problems).toEqual([]);
    const installed = join(agentsDir, 'tmp-harness-probe', 'agent.md');
    expect(existsSync(installed)).toBe(true);
    expect(readdirSync(agentsDir)).toEqual(['tmp-harness-probe']);
    expect(readdirSync(join(agentsDir, 'tmp-harness-probe'))).toEqual(['agent.md']);
  }, 90_000);

  it('refuses a draft whose name collides with the library', async () => {
    const agentsDir = makeTmp('harness-draft-live-');
    const candidates = await draftAgents(EVIDENCE, {
      workspaceDir: process.cwd(),
      agentsDir,
      existingNames: ['tmp-harness-probe'],
      complete: async () => DRAFT_ANSWER,
      confirm: async () => true,
      install: true,
      timeoutMs: 60_000,
    });

    expect(candidates[0]?.conflictsWith).toBe('tmp-harness-probe');
    expect(candidates[0]?.problems.join(' ')).toContain('already exists');
    expect(readdirSync(agentsDir)).toEqual([]);
  }, 90_000);

  it('returns zero candidates and does not crash on a garbage answer', async () => {
    const agentsDir = makeTmp('harness-draft-live-');
    const candidates = await draftAgents(EVIDENCE, {
      workspaceDir: process.cwd(),
      agentsDir,
      existingNames: [],
      complete: async () => 'Sorry, I could not work out what you wanted. Here is some prose instead.',
      confirm: async () => true,
      timeoutMs: 60_000,
    });

    expect(candidates).toEqual([]);
    expect(readdirSync(agentsDir)).toEqual([]);
  }, 90_000);
});

describe.skipIf(hasC2c)('draftAgents without c2c', () => {
  it('rejects every draft with the install command instead of hand-rendering', async () => {
    const agentsDir = makeTmp('harness-draft-live-');
    const candidates = await draftAgents(EVIDENCE, {
      workspaceDir: process.cwd(),
      agentsDir,
      existingNames: [],
      complete: async () => DRAFT_ANSWER,
      confirm: async () => true,
      install: true,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.markdown).toBe('');
    expect(candidates[0]?.problems).toEqual([C2C_MISSING_MESSAGE]);
    expect(candidates[0]?.problems.join(' ')).toContain('npm install -g codex2code');
    expect(readdirSync(agentsDir)).toEqual([]);
  }, 30_000);
});
