import { readFile, stat } from 'node:fs/promises';
import { DIFF_MAX_BYTES, unifiedDiff } from './diff.js';
import { confirm } from './readline.js';
import { isInsideWorkspace, resolveWorkspacePath } from './workspace.js';
import type { RiskAssessment } from './risk.js';

/**
 * The approval gate that runs before a mutating tool call.
 *
 * The gate lives in `executeHarnessTool` because that is the last place a write
 * can be stopped: the tool body has not run yet, so a decline cannot leave a
 * half-written file behind. The gate is only armed when a caller supplies an
 * `onApproval` handler, so library callers that never asked for a prompt keep
 * working unchanged.
 *
 * What counts as mutating is deliberately explicit rather than "anything not on
 * a read list". The delegated CLIs are the awkward case: `opencode` and `agy`
 * are agentic and can edit the workspace, and `gh` mutates a repository (though
 * not this one) for every verb that is not a read. A gate that forgot them
 * would be a gate an agent could walk around by delegating.
 */

/** Tools that can change the workspace, this repository, or a remote. */
export const MUTATING_TOOLS: readonly string[] = [
  // The harness's own tools.
  'write',
  'edit',
  'bash',
  // The same capabilities under the agency library's declared names, so a
  // caller that routes those names through the executor is still gated.
  'write_file',
  'replace_file_content',
  'run_command',
  // Delegation: a subagent, or an agentic CLI, writes with its own hands. The
  // harness cannot gate the calls it never sees, so it gates the handoff.
  'subagent',
  'opencode',
  'agy',
];

/**
 * `gh` verbs that only read. Everything else (`pr create`, `release upload`,
 * `api -X POST`) is treated as mutating. Only tokens before the first flag are
 * considered, so `gh pr merge --subject view` does not sneak through on a flag
 * value that happens to be a read verb.
 */
const GH_READ_VERBS = new Set([
  'view',
  'list',
  'status',
  'diff',
  'checks',
  'search',
  'browse',
  'download',
  'get',
]);

export function isMutatingToolCall(name: string, args: Record<string, unknown> = {}): boolean {
  if (MUTATING_TOOLS.includes(name)) return true;
  if (name !== 'gh') return false;
  const raw = args['args'];
  if (!Array.isArray(raw)) return true;
  const words: string[] = [];
  for (const token of raw) {
    if (typeof token !== 'string') continue;
    if (token.startsWith('-')) break;
    words.push(token.toLowerCase());
  }
  return !words.some((word) => GH_READ_VERBS.has(word));
}

export interface ApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
  /** Human-readable description of the change, printed before the question. */
  preview: string;
  /**
   * An advisory label from the risk classifier, when one is configured.
   *
   * Absent is the normal case and means the same thing it did before this
   * existed: no classifier, no extra latency, no change in behaviour. A handler
   * that ignores it loses nothing.
   */
  risk?: RiskAssessment;
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<boolean>;

/** What the model gets back when the human says no. */
export const DECLINE_MESSAGE = 'Declined by user: no changes made';

/** Approval previews are capped so a huge write cannot flood the terminal. */
const MAX_PREVIEW_CHARS = 6_000;

function previewLine(args: Record<string, unknown>, key: string, fallback: string, limit = 500): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

async function filePreview(pathArg: unknown, nextContent: string, workspaceDir: string): Promise<string> {
  if (typeof pathArg !== 'string') return '[no path given]';
  if (!isInsideWorkspace(workspaceDir, pathArg)) return `[outside the workspace: ${pathArg}]`;
  const abs = resolveWorkspacePath(workspaceDir, pathArg);

  let existing: string | undefined;
  try {
    const info = await stat(abs);
    if (info.size > DIFF_MAX_BYTES) return `[large file: ${info.size} bytes] ${pathArg}`;
    existing = await readFile(abs, 'utf8');
    // A NUL byte in the first chunk is the same signal `grep.ts` uses.
    if (existing.slice(0, 8_000).includes('\u0000')) return `[binary] ${pathArg}`;
  } catch {
    existing = undefined;
  }

  if (existing === undefined) {
    const body = unifiedDiff('', nextContent, { path: pathArg });
    return [`[new file] ${pathArg}`, body].filter(Boolean).join('\n');
  }
  const body = unifiedDiff(existing, nextContent, { path: pathArg });
  return body === '' ? `[no change] ${pathArg}` : body;
}

/**
 * Build the text shown before the question. For a write this is a unified diff
 * of the current file against the new contents, for a command it is the command
 * verbatim: the human is approving exactly what will run, not a paraphrase.
 */
export async function buildApprovalPreview(
  name: string,
  args: Record<string, unknown>,
  options: { workspaceDir: string },
): Promise<string> {
  const { workspaceDir } = options;
  let preview: string;

  switch (name) {
    case 'write':
    case 'write_file': {
      const content = typeof args['content'] === 'string' ? (args['content'] as string) : '';
      preview = await filePreview(args['path'], content, workspaceDir);
      break;
    }
    case 'edit':
    case 'replace_file_content': {
      const pathArg = args['path'];
      const oldString = typeof args['oldString'] === 'string' ? (args['oldString'] as string) : '';
      const newString = typeof args['newString'] === 'string' ? (args['newString'] as string) : '';
      if (typeof pathArg !== 'string' || !isInsideWorkspace(workspaceDir, pathArg)) {
        preview = `[outside the workspace: ${String(pathArg)}]`;
        break;
      }
      let current: string | undefined;
      try {
        current = await readFile(resolveWorkspacePath(workspaceDir, pathArg), 'utf8');
      } catch (err) {
        preview = `[unreadable: ${err instanceof Error ? err.message : String(err)}]`;
        break;
      }
      if (!current.includes(oldString)) {
        preview = `[no change] oldString does not appear in ${pathArg}; the tool will report an error`;
        break;
      }
      preview = unifiedDiff(current, current.replace(oldString, newString), { path: pathArg });
      if (preview === '') preview = `[no change] ${pathArg}`;
      break;
    }
    case 'bash':
    case 'run_command':
      preview = `$ ${previewLine(args, 'command', '(no command given)', 2_000)}`;
      break;
    case 'subagent':
      preview = `delegate to ${previewLine(args, 'agent', '(no agent given)', 100)}\ntask: ${previewLine(args, 'task', '(no task given)', 2_000)}`;
      break;
    case 'opencode':
      preview = `opencode ${previewLine(args, 'model', '(model from HARNESS_OPENCODE_MODEL)', 100)}\nmessage: ${previewLine(args, 'message', '(no message given)', 2_000)}`;
      break;
    case 'agy':
      preview = `agy\nprompt: ${previewLine(args, 'prompt', '(no prompt given)', 2_000)}`;
      break;
    case 'gh': {
      const raw = Array.isArray(args['args']) ? (args['args'] as unknown[]) : [];
      preview = `$ gh ${raw.filter((a): a is string => typeof a === 'string').join(' ')}`;
      break;
    }
    default:
      preview = JSON.stringify(args).slice(0, 2_000);
      break;
  }

  return preview.length > MAX_PREVIEW_CHARS
    ? `${preview.slice(0, MAX_PREVIEW_CHARS)}\n… (preview truncated)`
    : preview;
}

export interface ApprovalHandlerOptions {
  /** `--yes`: approve everything without asking. */
  assumeYes?: boolean;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  log?: (message: string) => void;
}

/**
 * The plaintext approval handler.
 *
 * A non-TTY stdin declines instead of waiting: a piped run has no human at the
 * keyboard, and blocking there would look like a hang. `--yes` is the explicit
 * way to say "go ahead" in that situation.
 */
export function createApprovalHandler(options: ApprovalHandlerOptions = {}): ApprovalHandler {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const log = options.log ?? ((message: string): void => void output.write(message));

  return async (request: ApprovalRequest): Promise<boolean> => {
    if (options.assumeYes) return true;
    log(`\n[approval] ${request.tool}\n${request.preview}\n`);
    if (input.isTTY !== true) {
      log('[approval] stdin is not a TTY, so this is declined. Re-run with --yes to approve without prompting.\n');
      return false;
    }
    return await confirm('proceed? [y/N] ', { input, output });
  };
}
