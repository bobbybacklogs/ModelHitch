import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { EmbedFn } from './agent-library.js';
import {
  formatContextFilesSection,
  pickContextFiles,
  type ContextFiles,
} from './context-files.js';
import {
  detectWorkspace,
  formatWorkspaceSection,
  type WorkspaceFacts,
} from './detect-workspace.js';
import { harnessLogger } from './subagents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const FALLBACK_SYSTEM = `You are an expert engineer executing a coding task.
Write short, direct code with no fluff. Verify against real artifacts (files, command output, tests), never mocks.
Cite concrete files and commands in your final summary.`;

export interface ZstackContext {
  systemPrompt: string;
  playbook: string;
  principles: string[];
  modelHint?: string;
  /**
   * The facts the `## Workspace` section was built from. Returned so a caller
   * that prints a header can use the same detection instead of walking the
   * directory a second time.
   */
  workspace: WorkspaceFacts;
  /**
   * The picks the `## Likely relevant files` section was built from. Returned
   * for the same reason as `workspace`: a caller that wants to show or reuse the
   * ranking should not have to run it again.
   */
  contextFiles: ContextFiles;
}

export interface BuildSystemPromptOptions {
  extraSystem?: string;
  noZstack?: boolean;
  workspaceDir?: string;
  /**
   * Embeds the task and the candidate files so the picker can rank by meaning as
   * well as by path tokens. Absent, the picks are lexical and the section still
   * appears.
   */
  embedder?: EmbedFn;
  /** Characters of each pick's head to include in the section. Default off. */
  contextBytes?: number;
  /** Where the picker's warnings go. Defaults to the harness logger. */
  log?: (message: string) => void;
}

/**
 * `HARNESS_CONTEXT_BYTES`, read the way `HARNESS_NO_ZSTACK` is read below.
 *
 * The flag is the intended route to this setting, and until the CLI carries one
 * this is what makes the option reachable from a shell without a code change.
 */
function envContextBytes(): number | undefined {
  const raw = process.env['HARNESS_CONTEXT_BYTES'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function zstackRoot(): string | null {
  const candidates = [
    process.env.ZSTACK_DIR,
    resolve(__dirname, '../../zstack'),
    resolve(__dirname, '../zstack'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(join(c, 'playbooks')) && existsSync(join(c, 'principles'))) return c;
  }
  return null;
}

export async function buildSystemPrompt(
  taskPrompt: string,
  opts: BuildSystemPromptOptions = {},
): Promise<ZstackContext> {
  // The workspace directory is the one directory this whole function describes,
  // so it is resolved once and every section below is built from it. The cwd
  // fallback keeps this in step with the zstack context further down, which is
  // told the same directory when no root is passed in.
  const workspaceDir = opts.workspaceDir ?? process.cwd();

  // Detection runs before the zstack branch and outside every try/catch below,
  // because the workspace section is about the directory rather than the
  // playbook: `--no-zstack` and a zstack that throws both still get it. It is
  // the same facts the header prints, so the two cannot disagree.
  const workspace = detectWorkspace({ dir: workspaceDir });
  const workspaceSection = formatWorkspaceSection(workspace);

  // The likely-files section is built here, beside the workspace section and
  // outside the zstack branch, for the same reason: the playbook is advice about
  // how to work and these two sections are facts about the directory being
  // worked in. `--no-zstack` asking for no playbook is not a request to be sent
  // into the tree without knowing which files matter. The picker's own budget
  // bounds what this costs before the first turn.
  const headBytes = opts.contextBytes ?? envContextBytes();
  const contextFiles = await pickContextFiles({
    dir: workspaceDir,
    task: taskPrompt,
    ...(opts.embedder !== undefined ? { embedder: opts.embedder } : {}),
    ...(headBytes !== undefined ? { headBytes } : {}),
    // The logger is wired only when an embedder was actually supplied. Nothing
    // in this repo injects one yet, so a default run would otherwise print a
    // "semantic ranking is off" line every single time — a permanent warning
    // about a setting nobody turned on. Lexical ranking is the configured
    // behaviour, not a degraded one; the warning is for a caller that asked for
    // semantic ranking and did not get it.
    ...(opts.embedder !== undefined ? { deps: { log: opts.log ?? harnessLogger } } : {}),
  });
  const contextSection = formatContextFilesSection(contextFiles);

  const withWorkspace = (parts: Array<string | undefined>): string =>
    [...parts, workspaceSection, contextSection]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('\n\n');

  if (opts.noZstack || process.env.HARNESS_NO_ZSTACK === '1') {
    return {
      systemPrompt: withWorkspace([FALLBACK_SYSTEM, opts.extraSystem]),
      playbook: 'none',
      principles: [],
      workspace,
      contextFiles,
    };
  }
  const root = zstackRoot();
  if (!root) {
    return {
      systemPrompt: withWorkspace([FALLBACK_SYSTEM, opts.extraSystem]),
      playbook: 'none',
      principles: [],
      workspace,
      contextFiles,
    };
  }
  try {
    const mod = (await import(pathToFileURL(join(root, 'src/sdk.mjs')).href)) as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;
    const ZStack = mod['ZStack'];
    const zs = new ZStack({ rootDir: root, workspaceDir: process.cwd() });
    const detailed = zs.classifyPromptDetailed(taskPrompt);
    const playbookType: string = detailed.type ?? 'feature';
    const principleNames: string[] = detailed.principles ?? [];
    let playbookContent = '';
    try {
      playbookContent = zs.getPlaybook(playbookType) as string;
    } catch {
      playbookContent = `# Task: ${playbookType}`;
    }
    const principleTexts: string[] = [];
    for (const p of principleNames.slice(0, 4)) {
      try {
        principleTexts.push(`### Principle: ${p}\n${zs.getPrinciple(p) as string}`.slice(0, 4000));
      } catch {
        principleTexts.push(`### Principle: ${p}`);
      }
    }
    const systemPrompt = withWorkspace([
      zs.defaultSystemPrompt ?? FALLBACK_SYSTEM,
      opts.extraSystem,
      `## Applicable Task Playbook (${playbookType}):\n${playbookContent.slice(0, 8000)}`,
      principleTexts.length > 0 ? `## Applicable Principles:\n${principleTexts.join('\n\n')}` : '',
    ]);
    return { systemPrompt, playbook: playbookType, principles: principleNames, workspace, contextFiles };
  } catch {
    // The playbook failed, not the detection, so this path reports the fallback
    // playbook and keeps the workspace facts and the picks.
    return {
      systemPrompt: withWorkspace([FALLBACK_SYSTEM, opts.extraSystem]),
      playbook: 'fallback',
      principles: [],
      workspace,
      contextFiles,
    };
  }
}
