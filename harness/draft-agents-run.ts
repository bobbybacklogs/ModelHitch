import { loadAgentLibrary, resolveAgentsDir } from './agent-library.js';
import { draftAgents, renderAgentDiff, type DraftCandidate } from './draft-agents.js';
import { confirm } from './readline.js';
import type { HarnessRuntime } from './runtime.js';

/**
 * `--draft-agents`: turn one finished run into candidate agent definitions.
 *
 * `draft-agents.ts` owns the drafting and renders each candidate through the
 * installed `codex2code` CLI. This module is the CLI half: it supplies the
 * evidence, resolves which names are already taken, prints each diff with its
 * warnings, and asks before anything is installed.
 *
 * Nothing is written without an answer: a non-TTY stdin declines through the
 * shared `confirm` helper, so a piped run prints drafts and stops.
 */

export interface DraftRunOptions {
  task: string;
  /** Tool names the run actually called, in order. */
  toolsUsed: string[];
  /** The run's final assistant message. */
  finalText: string;
  runtime: HarnessRuntime;
  workspaceDir: string;
  /** `undefined` auto-discovers, `null` is explicitly disabled. */
  agentsDir?: string | null;
  /** `--yes`: install confirmed drafts without prompting. */
  assumeYes: boolean;
}

/** Anything about a candidate that a human needs to see before saying yes. */
function describeFlags(candidate: DraftCandidate): string[] {
  const flags: string[] = [];
  const agent = candidate.agent;
  if (!agent) return flags;
  if (agent.tier === 'full') {
    flags.push(
      '! tier=full: this agent would be granted both write and shell. Approve only if you mean it.',
    );
  }
  if (!agent.delegatable) {
    flags.push('! subagent: false — this definition is shown but is not delegatable.');
  }
  if (agent.unsupportedTools.length > 0) {
    flags.push(`! unsupported tools: ${agent.unsupportedTools.join(', ')} (reported, not granted)`);
  }
  for (const warning of agent.warnings) flags.push(`! ${warning}`);
  return flags;
}

export async function runDraftAgents(options: DraftRunOptions): Promise<DraftCandidate[]> {
  const dir = resolveAgentsDir(options.agentsDir);
  const existing = dir ? loadAgentLibrary({ dir }) : undefined;
  const existingNames = existing ? existing.agents.map((agent) => agent.name) : [];

  console.log(
    dir
      ? `[harness] drafting agents against ${dir} (${existingNames.length} already loaded)`
      : '[harness] drafting agents with no agents directory configured; drafts will be printed only',
  );

  const candidates = await draftAgents(
    {
      task: options.task,
      toolsUsed: options.toolsUsed,
      finalMessage: options.finalText,
      existingAgents: existing
        ? existing.agents.map((agent) => ({ name: agent.name, description: agent.description }))
        : [],
    },
    {
      workspaceDir: options.workspaceDir,
      agentsDir: dir,
      existingNames,
      complete: async (request: string): Promise<string> => {
        const result = await options.runtime.client.chat({
          provider: options.runtime.provider,
          model: options.runtime.model,
          messages: [{ role: 'user', content: request }],
        });
        const content = result.message.content;
        if (typeof content === 'string') return content;
        return content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .filter((text) => text !== '')
          .join('\n');
      },
      confirm: async (candidate: DraftCandidate, diff: string): Promise<boolean> => {
        if (dir === null) {
          console.log(`\n[draft ${candidate.name}] not installable, no agents directory is configured`);
          console.log(candidate.markdown.trimEnd());
          return false;
        }
        console.log(`\n[draft ${candidate.name}]`);
        console.log(diff.trimEnd());
        for (const flag of describeFlags(candidate)) console.log(flag);
        if (options.assumeYes) {
          console.log(`[draft ${candidate.name}] installing (--yes)`);
          return true;
        }
        return await confirm(`write ${candidate.name}/agent.md? [y/N] `, { defaultAnswer: false });
      },
      log: (message: string): void =>
        console.log(message.startsWith('[') ? message : `[harness] ${message}`),
      // Installs only happen where confirm said yes; this flag is what arms it.
      install: dir !== null,
    },
  );

  const installable = candidates.filter((c) => c.problems.length === 0 && !c.conflictsWith);
  const rejected = candidates.length - installable.length;
  console.log(
    `\n[harness] drafts: ${candidates.length} produced, ${installable.length} valid` +
      (rejected > 0 ? `, ${rejected} rejected (see the problems above)` : ''),
  );
  return candidates;
}
