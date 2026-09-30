import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRuleStore,
  describeRule,
  needsWideningConfirmation,
  normalizeTarget,
  ruleBlockedByRisk,
  ruleKey,
  rulesPath,
} from '../harness/rules.js';
import type { ApprovalRequest } from '../harness/approval.js';

/**
 * A remembered approval is the only thing in the harness that can skip the gate,
 * so the cases that matter are the ones where it must *not* apply: a different
 * command, a different file, a different workspace, a decline, a non-TTY stdin,
 * and a call the risk classifier has since called dangerous.
 */

const STATE = resolve(__dirname, '.tmp-rules-state');
const WORKSPACE_A = resolve(__dirname, '.tmp-rules-ws-a');
const WORKSPACE_B = resolve(__dirname, '.tmp-rules-ws-b');

beforeAll(() => {
  for (const dir of [STATE, WORKSPACE_A, WORKSPACE_B]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    mkdirSync(dir, { recursive: true });
  }
});

afterAll(() => {
  for (const dir of [STATE, WORKSPACE_A, WORKSPACE_B]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

const store = (workspaceDir = WORKSPACE_A, stateDir = STATE, log?: (m: string) => void) =>
  createRuleStore({ workspaceDir, stateDir, ...(log ? { log } : {}) });

describe('normalizeTarget', () => {
  it('uses the command for a shell tool', () => {
    expect(normalizeTarget('bash', { command: 'npm test' })).toBe('npm test');
    expect(normalizeTarget('run_command', { command: '  ls  ' })).toBe('ls');
  });

  it('uses the path for a file tool', () => {
    expect(normalizeTarget('write', { path: 'src/app.ts', content: 'x' })).toBe('src/app.ts');
    expect(normalizeTarget('edit', { path: 'src/app.ts', oldString: 'a', newString: 'b' })).toBe('src/app.ts');
  });

  it('refuses to remember a call with no single stable target', () => {
    // A delegation or a `gh` call has no one identifier, and a rule recorded
    // against its whole argument blob would match nothing or too much.
    expect(normalizeTarget('subagent', { agent: 'Scout', task: 'look around' })).toBeNull();
    expect(normalizeTarget('gh', { args: ['pr', 'view', '1'] })).toBeNull();
    expect(normalizeTarget('opencode', { message: 'do a thing' })).toBeNull();
  });

  it('refuses an empty target rather than remembering a blank', () => {
    expect(normalizeTarget('bash', { command: '   ' })).toBeNull();
    expect(normalizeTarget('write', { path: '' })).toBeNull();
    expect(normalizeTarget('bash', {})).toBeNull();
  });

  it('matters that arguments are not part of the key for a file tool', () => {
    // Two different edits to one file are one remembered decision, which is what
    // "always for this path" means to a user.
    expect(ruleKey('edit', normalizeTarget('edit', { path: 'a.ts' }) as string)).toBe(
      ruleKey('edit', normalizeTarget('edit', { path: 'a.ts', oldString: 'x' }) as string),
    );
  });
});

describe('createRuleStore', () => {
  it('starts empty, with nothing persisted', () => {
    const s = store();
    expect(s.list()).toEqual([]);
    expect(s.match('bash', { command: 'npm test' })).toBeUndefined();
  });

  it('remembers an exact target for the session', () => {
    const s = store();
    const rule = s.remember('bash', { command: 'npm test' }, 'session');
    expect(rule?.scope).toBe('session');
    expect(s.match('bash', { command: 'npm test' })?.target).toBe('npm test');
    expect(s.sessionCount).toBe(1);
    // Session rules are not written anywhere.
    expect(() => readFileSync(rulesPath(STATE), 'utf8')).toThrow();
  });

  it('does not match a different command, a prefix, or a superset', () => {
    const s = store();
    s.remember('bash', { command: 'npm test' }, 'session');
    expect(s.match('bash', { command: 'npm test -- --watch' })).toBeUndefined();
    expect(s.match('bash', { command: 'npm' })).toBeUndefined();
    expect(s.match('bash', { command: 'npm test extra' })).toBeUndefined();
  });

  it('does not match the same target under a different tool', () => {
    const s = store();
    s.remember('write', { path: 'src/app.ts' }, 'session');
    expect(s.match('edit', { path: 'src/app.ts' })).toBeUndefined();
    expect(s.match('write', { path: 'src/other.ts' })).toBeUndefined();
  });

  it('refuses to remember a call with nothing to match on', () => {
    const s = store();
    expect(s.remember('subagent', { agent: 'Scout', task: 'x' }, 'session')).toBeUndefined();
    expect(s.list()).toEqual([]);
  });

  it('persists a workspace rule and reads it back in a new process', () => {
    const first = store();
    first.remember('write', { path: 'src/persisted.ts' }, 'workspace');
    expect(first.workspaceCount).toBe(1);

    // A fresh store is the next process.
    const second = store();
    expect(second.match('write', { path: 'src/persisted.ts' })?.scope).toBe('workspace');
    expect(second.workspaceCount).toBe(1);
  });

  it('keeps a workspace rule out of another workspace', () => {
    const writer = store(WORKSPACE_B);
    writer.remember('bash', { command: 'rm -rf build' }, 'workspace');

    // The user saw the command run in one tree; it is a different act in another.
    expect(store(WORKSPACE_B).match('bash', { command: 'rm -rf build' })).toBeDefined();
    expect(store(WORKSPACE_A).match('bash', { command: 'rm -rf build' })).toBeUndefined();
  });

  it('treats a corrupt rules file as no rules, with one warning', () => {
    const stateDir = join(STATE, 'corrupt');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(rulesPath(stateDir), '{ this is not json', 'utf8');

    const warnings: string[] = [];
    const s = createRuleStore({ workspaceDir: WORKSPACE_A, stateDir, log: (m) => warnings.push(m) });
    expect(s.list()).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ignoring approval rules');
    // And the run continues: remembering still works afterwards.
    expect(s.remember('bash', { command: 'echo hi' }, 'session')).toBeDefined();
  });

  it('says nothing about a missing rules file, which is the first-run case', () => {
    const stateDir = join(STATE, 'absent');
    const warnings: string[] = [];
    createRuleStore({ workspaceDir: WORKSPACE_A, stateDir, log: (m) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });

  it('ignores malformed entries inside an otherwise valid file', () => {
    const stateDir = join(STATE, 'partial');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      rulesPath(stateDir),
      JSON.stringify({
        version: 1,
        workspaces: { [WORKSPACE_A]: [{ tool: 'bash', target: 'npm test' }, { tool: 7 }, null] },
      }),
      'utf8',
    );
    const s = createRuleStore({ workspaceDir: WORKSPACE_A, stateDir });
    expect(s.match('bash', { command: 'npm test' })).toBeDefined();
    expect(s.list()).toHaveLength(1);
  });
});

describe('ruleBlockedByRisk', () => {
  it('lets a safe verdict through, because it agrees with the rule', () => {
    expect(ruleBlockedByRisk({ level: 'safe', reason: 'reads a file' })).toBeUndefined();
  });

  it('blocks a rule the classifier has since called caution or dangerous', () => {
    const caution = ruleBlockedByRisk({ level: 'caution', reason: 'overwrites an existing file' });
    expect(caution).toContain('caution');
    expect(caution).toContain('overwrites an existing file');
    expect(ruleBlockedByRisk({ level: 'dangerous', reason: 'recursive delete' })).toContain('dangerous');
  });

  it('does not block when there was no verdict at all', () => {
    expect(ruleBlockedByRisk(undefined)).toBeUndefined();
    expect(ruleBlockedByRisk({ level: 'caution', reason: 'unclassified', unclassified: true })).toBeUndefined();
  });
});

describe('needsWideningConfirmation', () => {
  const request = (tool: string, risk?: ApprovalRequest['risk']): ApprovalRequest => ({
    tool,
    args: { command: 'npm test' },
    preview: '$ npm test',
    ...(risk ? { risk } : {}),
  });

  it('asks again before persisting a shell rule with no classifier', () => {
    expect(needsWideningConfirmation(request('bash'))).toBe(true);
    expect(needsWideningConfirmation(request('run_command'))).toBe(true);
  });

  it('does not ask again when a classifier already looked at it', () => {
    expect(needsWideningConfirmation(request('bash', { level: 'safe', reason: 'runs the tests' }))).toBe(false);
  });

  it('does not ask for a file tool, whose target is the path the user saw', () => {
    expect(needsWideningConfirmation(request('write'))).toBe(false);
  });
});

describe('describeRule', () => {
  it('names the tool, the exact target and the scope', () => {
    const text = describeRule({ tool: 'bash', target: 'npm test', scope: 'workspace', recordedAt: 'x' });
    expect(text).toContain('bash');
    expect(text).toContain('npm test');
    expect(text).toContain('workspace');
  });
});
