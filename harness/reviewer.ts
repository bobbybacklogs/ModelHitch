/**
 * The adversarial reviewer.
 *
 * A run's own model is the worst judge of its own work: it decided the change
 * was complete, and asking it again mostly produces agreement. So the review is
 * a separate pass, by a separate agent, with a read-only toolset — it can look
 * at the workspace but it cannot fix anything, which keeps the critique a
 * critique instead of a second edit nobody approved.
 *
 * Three properties are load-bearing:
 *
 *   1. **The definition is bundled, not installed.** It is never written into
 *      the user's agents directory, so `--draft-agents` cannot see it and a
 *      later run cannot load a stale copy of it.
 *   2. **A mutating declaration refuses to register.** The definition is parsed
 *      through the same frontmatter parser and tool mapper every other agent
 *      goes through, and if the derived grant contains any mutating tool the
 *      agent is dropped with a warning. That check exists because the tier
 *      mapping is the only thing standing between "review this" and "edit this",
 *      and a future edit to the bundled file should not be able to cross it
 *      silently.
 *   3. **A failure is one line.** A review is a courtesy at the end of a run
 *      that has already succeeded; it must never change an exit code.
 */

import { MUTATING_TOOLS } from './approval.js';
import { DECLARED_TOOL_MAP, mapDeclaredTools, parseFrontmatter, type SubagentToolTier } from './agent-library.js';
import { createSubagentRoster, type AgentSpec } from './subagents.js';
import { summarizeToolOutput, type SummarizeDeps } from './summarize.js';
import type { HarnessRuntime } from './runtime.js';

/**
 * The bundled definition, in the same `<name>/agent.md` shape a user's library
 * uses. Declared tools are the Copilot spellings, which `DECLARED_TOOL_MAP`
 * translates; both of these grant read-only capabilities.
 */
export const REVIEWER_AGENT_MARKDOWN = `---
name: Reviewer
description: Adversarially reviews a completed change for correctness, unhandled edge cases, and anything the task asked for that the change does not do.
tools:
  - view_file
  - grep_search
---

You are reviewing work that has just been completed by another agent. You did not
write it and you are not asked to defend it.

Read the change and the surrounding code, then answer with a short critique. Lead
with the most serious problem. Cover, in this order:

1. **Correctness.** Does the change do what it claims? Name a specific input,
   state, or sequence that produces a wrong result, if one exists.
2. **Unhandled cases.** What did the author not consider — empty input, a missing
   file, a concurrent writer, a platform difference, an error path?
3. **Gaps against the task.** What did the task ask for that the change does not
   do, or only partly does?

Rules:

- Cite file paths and line numbers. "This could be a problem" is not a finding.
- Say nothing about style, naming, or formatting.
- If you find nothing wrong in a category, say so in one line and move on. Do not
  invent a problem to fill the section.
- You have no tool that can write. If you believe something should change, say
  what and where; do not attempt to change it.
`;

export interface ReviewerRegistration {
  /** The agent to register, when the definition passed its checks. */
  spec?: AgentSpec;
  /** Why it was refused, when it was. */
  refused?: string;
  /** Non-fatal notes from parsing, e.g. an unsupported declared tool. */
  warnings: string[];
}

/**
 * Parse a reviewer definition and decide whether it may be registered.
 *
 * Exported and parameterised so the refusal path is reachable from a test. A
 * guard that can only be exercised by editing the bundled markdown is a guard
 * nobody checks, and this one is the difference between a reviewer and a second
 * unapproved editor.
 *
 * The tier is derived from the declared tools through the real mapping, not
 * asserted here: a hard-coded `readonly` would be a comment, while a derived
 * tier checked against `MUTATING_TOOLS` is a gate.
 */
export function checkReviewerDefinition(markdown: string): ReviewerRegistration {
  const warnings: string[] = [];
  const parsed = parseFrontmatter(markdown);
  warnings.push(...parsed.warnings);

  const declared = parsed.data['tools'];
  const declaredTools = Array.isArray(declared) ? declared : typeof declared === 'string' ? [declared] : [];
  if (declaredTools.length === 0) {
    return { refused: 'the bundled reviewer declares no tools', warnings };
  }
  const unmapped = declaredTools.filter((tool) => !(tool in DECLARED_TOOL_MAP));
  if (unmapped.length > 0) {
    warnings.push(`reviewer declares unknown tool(s): ${unmapped.join(', ')}`);
  }

  const mapped = mapDeclaredTools(declaredTools);
  warnings.push(...mapped.warnings);
  const mutating = mapped.granted.filter((tool) => MUTATING_TOOLS.includes(tool));
  if (mutating.length > 0) {
    // Refusing is the point: the reviewer's whole value is that it cannot change
    // anything, and a definition that could has stopped being a reviewer.
    return {
      refused: `the bundled reviewer would be granted mutating tool(s): ${mutating.join(', ')}`,
      warnings,
    };
  }
  if (mapped.tier !== 'readonly') {
    return { refused: `the bundled reviewer maps to tier "${mapped.tier}", not "readonly"`, warnings };
  }

  const name = typeof parsed.data['name'] === 'string' ? (parsed.data['name'] as string) : 'Reviewer';
  const description =
    typeof parsed.data['description'] === 'string' ? (parsed.data['description'] as string) : '';
  return {
    spec: {
      name,
      role: description === '' ? 'Adversarial review' : description,
      instructions: parsed.body,
      tools: mapped.tier as SubagentToolTier,
    },
    warnings,
  };
}

/** The check applied to the definition this module ships. */
export function buildReviewerRegistration(): ReviewerRegistration {
  return checkReviewerDefinition(REVIEWER_AGENT_MARKDOWN);
}

/** One recorded change, as `cli.ts` accumulates them. */
export interface ReviewedChange {
  /** The tool that made the change, and the preview the human approved. */
  tool: string;
  preview: string;
}

export interface ReviewOptions {
  task: string;
  changes: ReviewedChange[];
  runtime: HarnessRuntime;
  workspaceDir: string;
  agentsDir?: string | null;
  /** Same budget every other subagent gets. */
  timeoutMs?: number;
  signal?: AbortSignal;
  summarizeThreshold: number;
  summarizeEnabled: boolean;
  digest?: SummarizeDeps['digest'];
  log?: (message: string) => void;
}

/** The reviewer's instructions: the original task, plus what actually changed. */
export function buildReviewTask(task: string, changes: ReviewedChange[]): string {
  const blocks = changes.map(
    (change, index) => `### Change ${index + 1}: \`${change.tool}\`\n\n\`\`\`diff\n${change.preview}\n\`\`\``,
  );
  return [
    '## The original task',
    '',
    task,
    '',
    `## What was changed (${changes.length} call${changes.length === 1 ? '' : 's'})`,
    '',
    ...blocks,
    '',
    '## What to do',
    '',
    'Review the change above against the task. Follow your standing instructions.',
  ].join('\n');
}

export interface ReviewResult {
  /** The critique, when one was produced. */
  critique?: string;
  /** Why there is no critique. Never an exception: see the module comment. */
  skipped?: string;
}

/**
 * Run the review pass.
 *
 * Returns rather than throws. A reviewer that is unavailable, refused, slow, or
 * broken is a line in the log, not a failed run — the work it is reviewing
 * already succeeded and is already on disk.
 */
export async function runReview(options: ReviewOptions): Promise<ReviewResult> {
  const log = options.log ?? ((message: string): void => void process.stderr.write(`${message}\n`));

  if (options.changes.length === 0) {
    // Nothing was written, so there is nothing to adversarially review, and a
    // reviewer asked to critique a no-op will invent something.
    return { skipped: 'no changes were recorded, so there is nothing to review' };
  }

  const registration = buildReviewerRegistration();
  for (const warning of registration.warnings) log(`[review] ${warning}`);
  if (registration.spec === undefined) {
    return { skipped: registration.refused ?? 'the reviewer could not be registered' };
  }

  try {
    const roster = await createSubagentRoster(options.runtime.client, {
      model: `${options.runtime.provider}/${options.runtime.model}`,
      workspaceDir: options.workspaceDir,
      ...(options.agentsDir !== undefined ? { agentsDir: options.agentsDir } : {}),
      extraAgents: [registration.spec],
    });
    if (roster === null) {
      return { skipped: 'subagent delegation is unavailable (bihan not found)' };
    }

    // Previews are the largest thing here and the least likely to be read whole;
    // the summarizer that already exists is the right tool for that.
    const summarized: ReviewedChange[] = [];
    for (const change of options.changes) {
      const preview = await summarizeToolOutput(change.preview, {
        tool: `${change.tool}-preview`,
        threshold: options.summarizeThreshold,
        enabled: options.summarizeEnabled,
        ...(options.digest ? { deps: { digest: options.digest } } : {}),
      });
      summarized.push({ tool: change.tool, preview });
    }

    const output = await roster.execute(
      'subagent',
      { agent: registration.spec.name, task: buildReviewTask(options.task, summarized) },
      options.signal,
    );
    const trimmed = output.trim();
    if (trimmed === '' || trimmed.startsWith('Error:')) {
      return { skipped: trimmed === '' ? 'the reviewer returned nothing' : trimmed.split('\n')[0] };
    }
    return { critique: trimmed };
  } catch (err) {
    return { skipped: err instanceof Error ? err.message : String(err) };
  }
}

