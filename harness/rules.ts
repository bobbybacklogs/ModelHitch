/**
 * Remembering an approval decision.
 *
 * A run that writes eight files asks eight times, and by the third one nobody
 * is reading the diff any more — which is worse than not asking, because the
 * gate now produces the feeling of oversight without the substance. So a
 * decision can be remembered, at two scopes:
 *
 *   - **session**: this process only, gone when the run ends.
 *   - **workspace**: persisted for this workspace, so the next run in this
 *     directory does not start the same conversation.
 *
 * Three rules keep that from becoming a blanket yes:
 *
 *   1. **Exact match, never a prefix.** A rule is `(tool, normalized target)`
 *      and the target is compared whole. Widening a rule to "any `npm test`"
 *      from "this `npm test`" is a decision the user has not been shown, and an
 *      unshown widening is how a remembered approval turns into an unapproved
 *      one.
 *   2. **A decline is never overridden, and rules are not consulted at all on
 *      the non-TTY path.** That path declines because nobody can answer, not
 *      because the answer was no; treating it as consent by rule would be
 *      backwards.
 *   3. **A rule loses to a risk label.** A call the classifier calls `caution`
 *      or `dangerous` prompts again and says which rule it overrode. The rule
 *      was recorded for a call that looked safe, and this is not that call.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-file.js';
import { harnessStateDir } from './session.js';
import type { RiskAssessment } from './risk.js';
import type { ApprovalRequest } from './approval.js';

export type RuleScope = 'session' | 'workspace';

export interface ApprovalRule {
  tool: string;
  /** The exact string a later call must reproduce to match. */
  target: string;
  scope: RuleScope;
  recordedAt: string;
}

/** Tools whose remembered target is the command string. */
const COMMAND_TOOLS = new Set(['bash', 'run_command']);

/** Tools whose remembered target is the file path. */
const PATH_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'replace_file_content',
  'read',
  'read_file',
]);

/**
 * The part of a call a rule is allowed to match on.
 *
 * `null` means "this call cannot be remembered", which is the honest answer for
 * a tool whose arguments have no single stable identifier — a delegation, a `gh`
 * invocation, a delegated CLI. Remembering one of those by its whole argument
 * blob would either match nothing or match too much, and either way the user
 * would have been shown a rule that does not do what it says.
 */
export function normalizeTarget(tool: string, args: Record<string, unknown>): string | null {
  if (COMMAND_TOOLS.has(tool)) {
    const command = args['command'];
    return typeof command === 'string' && command.trim() !== '' ? command.trim() : null;
  }
  if (PATH_TOOLS.has(tool)) {
    const path = args['path'];
    return typeof path === 'string' && path.trim() !== '' ? path.trim() : null;
  }
  return null;
}

/** One rule, as a comparable string. */
export function ruleKey(tool: string, target: string): string {
  return `${tool}\u0000${target}`;
}

/**
 * Rules are stored per workspace, keyed by the absolute path.
 *
 * A rule remembered in one repository must not approve the same command in
 * another: `rm -rf build` is a different act in two different trees, and the
 * user only ever saw one of them.
 */
interface RulesFile {
  version: number;
  workspaces: Record<string, ApprovalRule[]>;
}

const RULES_VERSION = 1;

export function rulesPath(stateDir = harnessStateDir()): string {
  return join(stateDir, 'approval-rules.json');
}

export interface RuleStoreOptions {
  workspaceDir: string;
  stateDir?: string;
  /** Called at most once with a load warning. */
  log?: (message: string) => void;
}

export interface RuleMatch {
  rule: ApprovalRule;
  /** True when a risk label overrode the rule and the call must prompt again. */
  overriddenBy?: RiskAssessment;
}

export interface RuleStore {
  /** The rule that would approve this call, if any. */
  match(tool: string, args: Record<string, unknown>): ApprovalRule | undefined;
  /**
   * Remember a decision. Returns the rule, or undefined when this call has no
   * target a rule could match on.
   */
  remember(tool: string, args: Record<string, unknown>, scope: RuleScope): ApprovalRule | undefined;
  list(): ApprovalRule[];
  /** Rules held in memory for this process only. */
  readonly sessionCount: number;
  readonly workspaceCount: number;
}

export function createRuleStore(options: RuleStoreOptions): RuleStore {
  const path = rulesPath(options.stateDir);
  const session = new Map<string, ApprovalRule>();
  let workspace = new Map<string, ApprovalRule>();
  let warned = false;

  const workspaceKey = options.workspaceDir;

  // Load once. A file that cannot be read or parsed is treated as absent, with
  // one warning: refusing to run because a convenience file is corrupt would
  // make the convenience the most dangerous thing in the tool.
  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text) as Partial<RulesFile>;
    const rules = parsed.workspaces?.[workspaceKey];
    if (Array.isArray(rules)) {
      workspace = new Map(
        rules
          .filter(
            (rule): rule is ApprovalRule =>
              typeof rule?.tool === 'string' && typeof rule?.target === 'string',
          )
          .map((rule) => [ruleKey(rule.tool, rule.target), { ...rule, scope: 'workspace' as const }]),
      );
    }
  } catch (err) {
    // ENOENT is the ordinary first-run case and says nothing worth printing.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && !warned) {
      warned = true;
      options.log?.(
        `[harness] ignoring approval rules at ${path} (${err instanceof Error ? err.message : String(err)}); ` +
          'every mutating call will prompt',
      );
    }
  }

  const persist = (): void => {
    try {
      writeJsonAtomic(
        path,
        {
          version: RULES_VERSION,
          workspaces: {
            [workspaceKey]: [...workspace.values()],
          },
        } satisfies RulesFile,
        { mode: 0o600 },
      );
    } catch (err) {
      if (!warned) {
        warned = true;
        options.log?.(
          `[harness] could not persist approval rules to ${path} ` +
            `(${err instanceof Error ? err.message : String(err)}); the rule applies to this run only`,
        );
      }
    }
  };

  return {
    get sessionCount(): number {
      return session.size;
    },
    get workspaceCount(): number {
      return workspace.size;
    },
    list(): ApprovalRule[] {
      return [...workspace.values(), ...session.values()];
    },
    match(tool, args): ApprovalRule | undefined {
      const target = normalizeTarget(tool, args);
      if (target === null) return undefined;
      const key = ruleKey(tool, target);
      // Session first: it is the more recent decision, and it is the one the
      // user made in front of this run.
      return session.get(key) ?? workspace.get(key);
    },
    remember(tool, args, scope): ApprovalRule | undefined {
      const target = normalizeTarget(tool, args);
      if (target === null) return undefined;
      const rule: ApprovalRule = { tool, target, scope, recordedAt: new Date().toISOString() };
      const key = ruleKey(tool, target);
      if (scope === 'session') session.set(key, rule);
      else {
        workspace.set(key, rule);
        persist();
      }
      return rule;
    },
  };
}

/** One line naming the rule that approved a call, as the `safe` path already does. */
export function describeRule(rule: ApprovalRule): string {
  return `rule: ${rule.tool} "${rule.target}" (${rule.scope})`;
}

/**
 * Whether an approval request must prompt despite a matching rule.
 *
 * A rule was recorded for a call that looked ordinary. If the classifier now
 * calls it `caution` or `dangerous`, the situation is not the one the user
 * agreed to, and the reason says so rather than silently prompting again for no
 * visible cause.
 */
export function ruleBlockedByRisk(risk: RiskAssessment | undefined): string | undefined {
  if (risk === undefined || risk.unclassified === true) return undefined;
  if (risk.level === 'safe') return undefined;
  return `a rule covers this call, but the risk classifier calls it ${risk.level}: ${risk.reason}`;
}

/** The extra confirmation `bash` needs before a rule is persisted without a classifier. */
export function needsWideningConfirmation(request: ApprovalRequest): boolean {
  return COMMAND_TOOLS.has(request.tool) && request.risk === undefined;
}
