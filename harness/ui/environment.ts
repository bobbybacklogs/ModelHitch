/**
 * What a run is, before it runs.
 *
 * The TUI header and the plaintext banner want the same facts — which model is
 * answering, which playbook was selected, where the config lives, whether the
 * workspace is about to be written to without asking — and a run that prints
 * them differently depending on which renderer won the TTY check is a run that
 * cannot be trusted twice. Resolving them once, here, also keeps the renderers
 * free of config plumbing.
 */

import { buildSystemPrompt } from '../prompt.js';
import { detectWorkspace, formatWorkspaceFacts, type WorkspaceFacts } from '../detect-workspace.js';
import { loadHarnessRuntime } from '../runtime.js';
import { describeSubagents } from '../subagents.js';
import { DEFAULT_TOOL_TIMEOUT_MS } from '../cancel.js';
import type { HarnessOptions } from '../index.js';

/** How a mutating tool call gets past the gate. */
export type ApprovalMode = 'auto' | 'prompt' | 'unattended';

export interface RunEnvironment {
  provider: string;
  model: string;
  /** `provider/model`, the form a human reads and a session records. */
  target: string;
  configPath: string;
  playbook: string;
  principles: number;
  workspaceDir: string;
  /**
   * One line from `formatWorkspaceFacts`, e.g. `typescript (npm), 214 source
   * files`. The sidebar and the plaintext header print this same string, so the
   * two cannot describe one directory two ways.
   */
  workspaceFacts: string;
  sessionId: string;
  maxTurns: number;
  toolTimeoutMs: number;
  approvals: ApprovalMode;
  snapshots: boolean;
  /** One line from `describeSubagents`, e.g. `subagents=on (...)`. */
  agents: string;
  /** True when `streamHarness` will produce text the header cannot know yet. */
  resumed: boolean;
}

export interface EnvironmentInput {
  prompt: string;
  options: HarnessOptions;
  sessionId: string;
  workspaceDir: string;
  assumeYes?: boolean;
}

export async function describeEnvironment(input: EnvironmentInput): Promise<RunEnvironment> {
  const runtime = await loadHarnessRuntime({
    configPath: input.options.configPath,
    modelOverride: input.options.model,
  });

  // A resumed run restores its system prompt from the transcript, so asking
  // zstack for a playbook here would describe work that is not happening.
  const resumed = (input.options.initialMessages?.length ?? 0) > 0;
  let playbook = 'resumed';
  let principles = 0;
  let workspace: WorkspaceFacts | undefined;
  if (!resumed) {
    try {
      const ctx = await buildSystemPrompt(input.prompt, {
        extraSystem: input.options.extraSystem,
        noZstack: input.options.noZstack,
        workspaceDir: input.workspaceDir,
        // Forwarded so this call describes the run the same way `streamHarness`
        // will. Without them the picker would rank lexically for a run that has
        // an embedder, and its "no embedder" warning would be the one the real
        // failure never gets to report.
        ...(input.options.embedder !== undefined ? { embedder: input.options.embedder } : {}),
        ...(input.options.contextBytes !== undefined ? { contextBytes: input.options.contextBytes } : {}),
      });
      playbook = ctx.playbook;
      principles = ctx.principles.length;
      // Reused rather than detected twice: the section in the prompt and this
      // header line describe the same walk of the same directory.
      workspace = ctx.workspace;
    } catch {
      playbook = 'unknown';
    }
  }

  // Nothing to reuse on a resumed run, and the header still has to describe the
  // directory it is about to write into. The scan is budgeted, so a fallback
  // call costs a bounded amount even when the first one already failed.
  const workspaceFacts = formatWorkspaceFacts(workspace ?? detectWorkspace({ dir: input.workspaceDir }));

  let agents = 'subagents=unknown';
  try {
    agents = await describeSubagents({ agentsDir: input.options.agentsDir });
  } catch {
    /* a missing roster must not stop a run from starting */
  }

  const approvals: ApprovalMode = input.assumeYes === true
    ? 'auto'
    : process.stdin.isTTY === true
      ? 'prompt'
      : 'unattended';

  return {
    provider: runtime.provider,
    model: runtime.model,
    target: `${runtime.provider}/${runtime.model}`,
    configPath: runtime.configPath,
    playbook,
    principles,
    workspaceDir: input.workspaceDir,
    workspaceFacts,
    sessionId: input.sessionId,
    maxTurns: input.options.maxTurns ?? 8,
    toolTimeoutMs: input.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    approvals,
    snapshots: input.options.snapshots === true,
    agents,
    resumed,
  };
}

/** Short human label for the header strip: `prompt`, `auto`, `unattended`. */
export function approvalLabel(mode: ApprovalMode): string {
  if (mode === 'auto') return 'auto-approve';
  if (mode === 'prompt') return 'ask before writes';
  return 'unattended (writes declined)';
}
