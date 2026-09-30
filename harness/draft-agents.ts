import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DECLARED_TOOL_MAP, parseAgentFile } from './agent-library.js';
import type { LibraryAgent } from './agent-library.js';

/**
 * Drafts new agent definitions from a finished harness run.
 *
 * The harness can load an agent library (agent-library.ts) and search the
 * workspace (grep.ts); what it could not do was grow its own library from what
 * it actually did. This module closes that loop. A run's task, the tools it
 * really invoked, and its final message become evidence for a model, which
 * proposes candidate definitions as JSON. Everything after that is mechanical.
 *
 * Three decisions shape the module:
 *
 * 1. The agent file is rendered by `c2c convert --to agent` (codex2code), never
 *    here. The frontmatter is that converter's contract. Hand-writing `name:`
 *    and `tools:` would create a second implementation of a format another tool
 *    owns, and the two would drift silently the first time c2c changed. So the
 *    converter is asked for the file, and the file it writes is the draft.
 *
 * 2. A draft is only real once the library's own parser has accepted it. The
 *    rendered file is copied to `<tmp>/validate/<name>/agent.md` and read back
 *    through `parseAgentFile`, so a draft the loader would reject or mis-read is
 *    reported with the parser's own words instead of being installed and
 *    discovered later.
 *
 * 3. Nothing reaches the agents directory unless the caller passes
 *    `install: true` *and* `confirm()` returns true. A dry run is the default,
 *    because the failure this guards against is not a crash, it is fifty
 *    plausible-looking agents appearing in the user's library.
 *
 * c2c is optional. When it is missing, every draft comes back rejected with the
 * install command; there is deliberately no fallback renderer, since a
 * fallback is exactly the second implementation decision 1 forbids.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Hard cap on drafts kept from one model answer. */
export const MAX_DRAFTS = 5;

/**
 * Character budget for the request built from the evidence.
 *
 * The evidence is run history, which can be arbitrarily large (a long final
 * message, a 57-agent library), and the request goes straight into a prompt.
 * Every section is capped individually, and this is the backstop that makes the
 * bound unconditional.
 */
export const DRAFT_REQUEST_BUDGET = 8000;

/** Per-section caps. Their sum is deliberately below DRAFT_REQUEST_BUDGET. */
const TASK_MAX_CHARS = 1200;
const TOOLS_MAX_CHARS = 400;
const MESSAGE_MAX_CHARS = 1500;
const LIBRARY_BUDGET_CHARS = 2500;
const LIBRARY_DESCRIPTION_MAX_CHARS = 80;
const LIBRARY_NAME_MAX_CHARS = 60;
const LIBRARY_MAX_AGENTS = 60;

/** The tool names a draft is allowed to declare, from the library's own map. */
export const DRAFT_TOOL_NAMES: string[] = Object.keys(DECLARED_TOOL_MAP);

/** The converter binary, and the one command that installs it. */
export const C2C_COMMAND = 'c2c';
export const C2C_INSTALL_COMMAND = 'npm install -g codex2code';
export const C2C_MISSING_MESSAGE =
  `c2c (codex2code) is not installed, so no agent file can be rendered. Install it with: ${C2C_INSTALL_COMMAND}`;

const DEFAULT_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

/** Prefix on every line this module logs, so its output is attributable. */
const LOG_PREFIX = '[draft-agents]';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface DraftEvidence {
  task: string;
  toolsUsed: string[];
  finalMessage: string;
  existingAgents: Array<{ name: string; description: string }>;
}

export interface AgentDraft {
  name: string;
  description: string;
  declaredTools: string[];
  body: string;
}

export interface DraftCandidate {
  name: string;
  /** Rendered agent.md text as produced by c2c. */
  markdown: string;
  /** Result of validating the rendered file through parseAgentFile. */
  agent?: LibraryAgent;
  /** Everything wrong with this candidate; non-empty means it is not installable. */
  problems: string[];
  /** Names already present in the loaded library, so this draft must be refused. */
  conflictsWith?: string;
}

export interface DraftOptions {
  workspaceDir: string;
  /** `null` when the agents directory is disabled. */
  agentsDir: string | null;
  /** Names already loaded by the library. */
  existingNames: string[];
  /** Injected model call, provider-neutral: returns the model's raw text answer. */
  complete(request: string): Promise<string>;
  /** Called for each rendered draft before anything is written. Return false to refuse. */
  confirm(candidate: DraftCandidate, diff: string): Promise<boolean>;
  /** Called with human-readable progress/warnings. */
  log?(message: string): void;
  /** Where the model runs the planned mutating tool calls. Defaults to false so a dry run is the default. */
  install?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/* ------------------------------------------------------------------ *
 * Request building
 * ------------------------------------------------------------------ */

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n[truncated]`;
}

/**
 * The prompt that asks the model for candidate definitions.
 *
 * The request asks for JSON rather than files: the harness decides the file
 * layout, and c2c renders the frontmatter, so the model's only job is the
 * content of a definition. Kept pure and exported so the exact wording and the
 * size bound are testable without a provider.
 */
export function buildDraftRequest(evidence: DraftEvidence): string {
  const sections: string[] = [];

  sections.push(
    [
      'Draft reusable agent definitions from one harness run.',
      '',
      'An agent definition is one job: a system prompt plus the tools it needs. Each',
      'candidate you propose must be narrow enough to be delegated a single task.',
      '',
      '## The run',
      '',
      'Task:',
      truncate(evidence.task, TASK_MAX_CHARS) || '(none recorded)',
      '',
      'Tools actually invoked (in order):',
      truncate(evidence.toolsUsed.join(', '), TOOLS_MAX_CHARS) || '(none)',
      '',
      'Final message:',
      truncate(evidence.finalMessage, MESSAGE_MAX_CHARS) || '(none)',
      '',
    ].join('\n'),
  );

  // The library list is the section that grows without bound, so it is built up
  // against its own budget and reports what it left out. Naming the omission
  // matters: a model told "these are all the agents" would happily re-propose a
  // name that was simply cut off.
  const libraryLines: string[] = [];
  let libraryChars = 0;
  let omitted = 0;
  for (const agent of evidence.existingAgents) {
    if (libraryLines.length >= LIBRARY_MAX_AGENTS) {
      omitted++;
      continue;
    }
    const name = truncate(agent.name, LIBRARY_NAME_MAX_CHARS).split('\n')[0] ?? '';
    const description = truncate(agent.description, LIBRARY_DESCRIPTION_MAX_CHARS).split('\n')[0] ?? '';
    const line = `- ${name}: ${description}`;
    if (libraryChars + line.length + 1 > LIBRARY_BUDGET_CHARS) {
      omitted++;
      continue;
    }
    libraryLines.push(line);
    libraryChars += line.length + 1;
  }
  if (omitted > 0) libraryLines.push(`- (${omitted} more existing agents not listed)`);

  sections.push(
    [
      '## Existing agents (never propose one of these names, and do not duplicate their job)',
      '',
      libraryLines.length > 0 ? libraryLines.join('\n') : '(the library is empty)',
      '',
    ].join('\n'),
  );

  sections.push(
    [
      '## Answer format',
      '',
      `Return ONLY a JSON array of at most ${MAX_DRAFTS} objects, each shaped exactly like this:`,
      '',
      '[{"name":"kebab-case-name","description":"One sentence saying when to use it.",' +
        '"tools":["view_file","grep_search"],"body":"# Title\\n\\nThe system prompt, in markdown."}]',
      '',
      'Rules:',
      `- "tools" may only contain these names: ${DRAFT_TOOL_NAMES.join(', ')}. List only the tools the agent needs.`,
      '- "name" is a new kebab-case identifier that is not in the existing list.',
      '- "body" is the system prompt: what the agent does, how it works, and what it must not do.',
      '- Do not duplicate an existing agent\'s name or job. If this run teaches nothing reusable, return [].',
      '- No prose, no markdown fences, no commentary outside the JSON.',
      '',
    ].join('\n'),
  );

  const request = sections.join('\n');
  if (request.length <= DRAFT_REQUEST_BUDGET) return request;

  // The per-section caps are meant to keep this from ever firing. It is here so
  // the budget is a guarantee rather than an estimate.
  const marker = '\n[request truncated at budget]';
  return `${request.slice(0, DRAFT_REQUEST_BUDGET - marker.length)}${marker}`;
}

/* ------------------------------------------------------------------ *
 * Response parsing
 * ------------------------------------------------------------------ */

/** Normalise one parsed entry, or null when it is not a usable definition. */
function normaliseDraft(entry: unknown): AgentDraft | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;

  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  const description = typeof record['description'] === 'string' ? record['description'].trim() : '';
  const body = typeof record['body'] === 'string' ? record['body'].trim() : '';
  // A definition with no name cannot be installed, and one with no description
  // is invisible to every agent search in the library, so both are malformed
  // rather than merely incomplete.
  if (name === '' || description === '' || body === '') return null;

  // Tool names go on a command line later, so they are restricted to the
  // character set the Copilot names use before anything else looks at them.
  const declaredTools: string[] = [];
  const rawTools = Array.isArray(record['tools']) ? record['tools'] : [];
  for (const tool of rawTools) {
    if (typeof tool !== 'string') continue;
    const clean = tool.trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (clean !== '' && !declaredTools.includes(clean)) declaredTools.push(clean);
  }

  return { name, description, declaredTools, body };
}

/** JSON slices worth trying, best candidate first. */
function jsonSlices(text: string): string[] {
  const slices: string[] = [];
  for (const match of text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g)) {
    const body = (match[1] ?? '').trim();
    if (body !== '') slices.push(body);
  }
  // Bare array amid prose: from the first `[` to the last `]`. Only used when no
  // fenced block parsed, which keeps a stray bracket in prose from winning.
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first >= 0 && last > first) slices.push(text.slice(first, last + 1));
  return slices;
}

/**
 * Read the model's answer into drafts.
 *
 * Never throws. A model answer is untrusted input: it arrives with prose, with
 * fences, with a truncated array, or as an apology. Garbage yields `[]` and a
 * malformed entry is dropped rather than taking the good entries with it, since
 * one bad element should not cost the caller four usable drafts.
 */
export function parseDraftResponse(text: string): AgentDraft[] {
  if (typeof text !== 'string' || text.trim() === '') return [];

  for (const slice of jsonSlices(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;

    const drafts: AgentDraft[] = [];
    for (const entry of parsed) {
      const draft = normaliseDraft(entry);
      if (draft) drafts.push(draft);
      if (drafts.length >= MAX_DRAFTS) break;
    }
    return drafts;
  }

  return [];
}

/* ------------------------------------------------------------------ *
 * c2c
 * ------------------------------------------------------------------ */

/** `c2c --version` and friends, for callers that want to warn early. */
export interface C2cProbe {
  available: boolean;
  command: string;
  version?: string;
  reason?: string;
}

/**
 * Windows quoting for a command string.
 *
 * Node's `shell: true` joins the command and its arguments with spaces and
 * quotes nothing, so an argument containing a space would silently split. Every
 * argument that is not plainly safe is wrapped, and inner quotes escaped the way
 * the Windows CRT expects.
 */
function quoteForShell(arg: string): string {
  if (/^[A-Za-z0-9_\-./\\:=,]+$/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * How to launch c2c on this platform.
 *
 * On Windows `c2c` is a `.cmd` shim, and Node refuses to spawn `.cmd`/`.bat`
 * directly (EINVAL, since the 2024 argument-injection hardening). It has to go
 * through the shell, which is also why `killTree` below walks the process tree:
 * the direct child is the shell, not the converter.
 */
function c2cInvocation(args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform === 'win32') {
    return { command: [C2C_COMMAND, ...args.map(quoteForShell)].join(' '), args: [], shell: true };
  }
  return { command: C2C_COMMAND, args, shell: false };
}

/** Does this run look like "the binary is not on PATH" rather than a failure? */
function looksMissing(code: number | null, stderr: string): boolean {
  return code === 127 || /is not recognized|command not found|not recognized as an internal/i.test(stderr);
}

/** Cheap preflight: is `c2c` installed and runnable? */
export function probeC2c(timeoutMs: number = PROBE_TIMEOUT_MS): C2cProbe {
  const invocation = c2cInvocation(['--version']);
  try {
    const result = spawnSync(invocation.command, invocation.args, {
      shell: invocation.shell,
      windowsHide: true,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (result.error) {
      return { available: false, command: C2C_COMMAND, reason: result.error.message };
    }
    if (result.status !== 0) {
      return {
        available: false,
        command: C2C_COMMAND,
        reason: (stderr.trim() || stdout.trim() || `exit ${String(result.status)}`).slice(0, 200),
      };
    }
    return { available: true, command: C2C_COMMAND, version: stdout.trim().split('\n')[0] ?? '' };
  } catch (err) {
    return { available: false, command: C2C_COMMAND, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Kill a child *and its descendants*.
 *
 * Killing the direct child is not enough: on Windows the child is the shell
 * that c2c was launched through, so the converter survives, keeps running, and
 * holds the stdio pipes open past the deadline. `taskkill /T` walks the tree on
 * Windows; on POSIX the negative pid signals the whole process group, which is
 * why the spawn below is detached there.
 */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

interface C2cRun {
  /** False when the process never started, which is the "not installed" case. */
  started: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** Transport-level failure: timeout, abort, or a spawn error. */
  problem?: string;
}

/**
 * Run one c2c command. Never rejects: every failure mode is a field on the
 * result, because a rejected promise here would have to be caught per draft and
 * the caller would lose the stdout that explains what went wrong.
 */
function runC2c(args: string[], opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }): Promise<C2cRun> {
  return new Promise<C2cRun>((resolve) => {
    const invocation = c2cInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      windowsHide: true,
      // POSIX only: a process group is what `killTree` signals as a group. On
      // Windows the tree kill goes through taskkill instead.
      detached: process.platform !== 'win32',
      // stdin is closed, not merely piped: c2c must never sit waiting for input
      // in a non-interactive harness.
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: invocation.shell,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (run: C2cRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(run);
    };
    const onAbort = (): void => {
      killTree(child);
      finish({ started: true, code: null, stdout, stderr, problem: 'aborted' });
    };

    // No spawn `timeout`: it would kill only the shell and let the converter run
    // on. The timer owns the budget and kills the whole tree.
    const timer = setTimeout(() => {
      killTree(child);
      finish({ started: true, code: null, stdout, stderr, problem: `timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      finish({ started: false, code: null, stdout, stderr, problem: err.message });
    });
    child.on('close', (code) => {
      const started = !looksMissing(code, stderr);
      finish({ started, code, stdout, stderr, problem: started ? undefined : `could not be run (exit ${String(code)})` });
    });
  });
}

/**
 * Pull the JSON object out of c2c's stdout.
 *
 * c2c prints a human "Conversion preview" block before the report, and its
 * stream split is not a contract this module can rely on (0.4.0 sends the
 * preview to stderr, an earlier shape sent it to stdout). So the search runs
 * backwards from the last `{` and returns the first suffix that parses: for a
 * pretty-printed report the nested objects fail and the top-level one wins.
 */
export function extractTrailingJson(text: string): Record<string, unknown> | undefined {
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    const slice = text.slice(start).trim();
    try {
      const parsed: unknown = JSON.parse(slice);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not the start of the report: keep walking back */
    }
  }
  return undefined;
}

/** Last few lines of a stream, for a problem message a human can act on. */
function tail(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(-max);
}

/**
 * Find the file c2c wrote for this draft.
 *
 * `<name>.agent.md` is the documented shape, but the basename is a slug of the
 * name, not the name: c2c renders `My_Agent.v2` as `my-agent-v2.agent.md` while
 * keeping `name: My_Agent.v2` in the frontmatter (verified against 0.4.0). So
 * the lookup also accepts the only-`.agent.md`-in-the-folder case, which is
 * unambiguous because exactly one source is converted per invocation. Slugging
 * is not reimplemented here: that rule belongs to c2c.
 */
function findRenderedAgent(outDir: string, name: string): string | undefined {
  const agentsDir = join(outDir, 'agents');
  const direct = join(agentsDir, `${name}.agent.md`);
  if (existsSync(direct)) return direct;

  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return undefined;
  }
  const rendered = entries.filter((entry) => entry.endsWith('.agent.md'));
  if (rendered.length === 1) return join(agentsDir, rendered[0] as string);
  return undefined;
}

/** The SKILL.md c2c consumes: frontmatter name + description, body below. */
function renderSkillFile(draft: AgentDraft): string {
  // JSON quoting is a compatible subset of the YAML double-quoted scalar the
  // loader parses, so a description with a colon, a quote, or a newline cannot
  // break the frontmatter it is written into.
  const description = JSON.stringify(draft.description);
  return `---\nname: ${draft.name}\ndescription: ${description}\n---\n\n${draft.body}\n`;
}

/* ------------------------------------------------------------------ *
 * Unified diff
 * ------------------------------------------------------------------ */

const DIFF_CONTEXT = 3;
/** Above this many (old x new) line pairs the LCS table is skipped. */
const DIFF_MAX_CELLS = 1_000_000;

type DiffKind = ' ' | '-' | '+';
interface DiffOp {
  kind: DiffKind;
  line: string;
}

/** Split into lines, ignoring a trailing newline so it is not a diff line. */
function splitLines(text: string): string[] {
  const normalised = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return normalised === '' ? [] : normalised.split('\n');
}

/** Longest-common-subsequence line diff, degrading to a whole-file replace. */
function diffLines(oldLines: string[], newLines: string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  if (n * m > DIFF_MAX_CELLS) {
    return [
      ...oldLines.map((line): DiffOp => ({ kind: '-', line })),
      ...newLines.map((line): DiffOp => ({ kind: '+', line })),
    ];
  }

  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        oldLines[i] === newLines[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const before = oldLines[i] as string;
    const after = newLines[j] as string;
    if (before === after) {
      // Both cursors advance on a match. Advancing only one desynchronises the
      // walk and turns an identical file into a diff of insertions.
      ops.push({ kind: ' ', line: before });
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: '-', line: before });
      i++;
    } else {
      ops.push({ kind: '+', line: after });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', line: oldLines[i] as string });
    i++;
  }
  while (j < m) {
    ops.push({ kind: '+', line: newLines[j] as string });
    j++;
  }
  return ops;
}

/** Group the ops into hunks with context, and format the hunk headers. */
function formatHunks(ops: DiffOp[]): string {
  if (!ops.some((op) => op.kind !== ' ')) return '';

  let oldNo = 1;
  let newNo = 1;
  const annotated = ops.map((op) => {
    const record = { ...op, oldNo, newNo };
    if (op.kind !== '+') oldNo++;
    if (op.kind !== '-') newNo++;
    return record;
  });

  const ranges: Array<{ start: number; end: number }> = [];
  for (let k = 0; k < annotated.length; k++) {
    if ((annotated[k] as { kind: DiffKind }).kind === ' ') continue;
    const start = Math.max(0, k - DIFF_CONTEXT);
    const end = Math.min(annotated.length - 1, k + DIFF_CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  const out: string[] = [];
  for (const range of ranges) {
    const slice = annotated.slice(range.start, range.end + 1);
    const oldCount = slice.filter((entry) => entry.kind !== '+').length;
    const newCount = slice.filter((entry) => entry.kind !== '-').length;
    const first = slice[0] as (typeof annotated)[number];
    // A hunk with no lines on one side (a new or emptied file) starts at 0,
    // which is the convention `patch` expects.
    const oldStart = oldCount === 0 ? first.oldNo - 1 : first.oldNo;
    const newStart = newCount === 0 ? first.newNo - 1 : first.newNo;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const entry of slice) out.push(`${entry.kind}${entry.line}`);
  }
  return out.join('\n');
}

/**
 * Render a draft as a unified diff against its target file.
 *
 * A `null` target, or a target that does not exist yet, becomes a new-file diff
 * (`--- /dev/null`) with every line added. Self-contained on purpose: this is a
 * presentation detail of drafting, and the module must not take a dependency on
 * a diff helper that may not exist. It handles line changes only, which is all
 * a replaced agent file ever is.
 */
export function renderAgentDiff(markdown: string, targetPath: string | null): string {
  const label = (targetPath === null ? 'agents/<new>/agent.md' : targetPath).split('\\').join('/');

  let existing: string | null = null;
  if (targetPath !== null) {
    try {
      existing = readFileSync(targetPath, 'utf8');
    } catch {
      existing = null; // absent or unreadable: treated as a new file
    }
  }

  const hunks = formatHunks(diffLines(existing === null ? [] : splitLines(existing), splitLines(markdown)));
  if (hunks === '') return `(no changes: ${label})`;

  const header = existing === null ? `--- /dev/null\n+++ b/${label}` : `--- a/${label}\n+++ b/${label}`;
  return `${header}\n${hunks}\n`;
}

/* ------------------------------------------------------------------ *
 * Drafting
 * ------------------------------------------------------------------ */

/** Names become directory names under the agents dir, so they must be tame. */
function unsafeNameProblem(name: string): string | undefined {
  if (name === '') return 'the model returned an empty agent name';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return `unsafe agent name "${name}": names must be letters, digits, dot, dash or underscore`;
  }
  if (name.includes('..')) return `unsafe agent name "${name}": ".." is a path traversal`;
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Report the flags a human needs before saying yes to a draft. */
function logCandidateSummary(candidate: DraftCandidate, log: (message: string) => void): void {
  const agent = candidate.agent;
  if (!agent) return;
  const notes: string[] = [];
  // A full-tier draft gets write *and* shell. That is the single most important
  // thing to see before installing, so it is stated in words, not implied by a
  // tier name.
  if (agent.tier === 'full') {
    notes.push('TIER FULL: this agent would hold write_file AND run_command, so it can change the workspace and run anything.');
  }
  if (!agent.delegatable) {
    notes.push('NOT DELEGATABLE: the definition sets subagent: false, so the library will exclude it from the roster.');
  }
  if (agent.unsupportedTools.length > 0) {
    notes.push(`unsupported declared tools (reported, not granted): ${agent.unsupportedTools.join(', ')}`);
  }
  if (agent.sandboxed) notes.push('sandboxed: shell is withheld from this agent');
  if (agent.warnings.length > 0) notes.push(`parser warnings: ${agent.warnings.join('; ')}`);
  if (notes.length > 0) log(`${LOG_PREFIX} "${candidate.name}"\n  ${notes.join('\n  ')}`);
}

/**
 * Turn one model-proposed draft into a candidate: render it with c2c, validate
 * it with the library parser, and work out whether it may be installed.
 */
async function renderCandidate(
  draft: AgentDraft,
  index: number,
  options: DraftOptions,
  tmpRoot: string,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<DraftCandidate> {
  const problems: string[] = [];
  const candidate: DraftCandidate = { name: draft.name, markdown: '', problems };
  let confirmed = false;

  const unsafe = unsafeNameProblem(draft.name);
  if (unsafe !== undefined) {
    problems.push(unsafe);
    return candidate;
  }

  const existing = options.existingNames.includes(draft.name);
  if (existing) {
    // Recorded twice on purpose: `conflictsWith` is the machine-readable refusal
    // (a caller can offer "pick another name"), `problems` is the explanation.
    candidate.conflictsWith = draft.name;
    problems.push(`an agent named "${draft.name}" already exists in the library`);
  }

  const srcDir = join(tmpRoot, String(index));
  const outDir = join(tmpRoot, `out-${index}`);
  try {
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, 'SKILL.md'), renderSkillFile(draft), 'utf8');

    const args = ['convert', srcDir, '--to', 'agent'];
    // Without `--tools` c2c warns `agent-tools-default` and omits the key, which
    // parses as a readonly agent. That is the honest reading of a draft that
    // declared nothing, so the flag is simply left off rather than sent empty.
    if (draft.declaredTools.length > 0) args.push('--tools', draft.declaredTools.join(','));
    args.push('--output', outDir, '-y', '--json');

    const run = await runC2c(args, { cwd: options.workspaceDir, timeoutMs, signal: options.signal });
    if (!run.started) {
      // The preflight above catches an uninstalled c2c, so reaching here means
      // it could not be launched for some other reason. The install command is
      // still the actionable half of the message, so it leads.
      problems.push(run.problem === undefined ? C2C_MISSING_MESSAGE : `${C2C_MISSING_MESSAGE} (${run.problem})`);
      return candidate;
    }
    if (run.problem) {
      // A killed or unstartable converter cannot have left a trustworthy file
      // behind, so the transport failure is the one thing worth reporting.
      problems.push(`c2c ${run.problem}`);
      return candidate;
    }

    const report = extractTrailingJson(run.stdout);
    if (report === undefined) {
      problems.push(
        `c2c produced no JSON report on stdout (exit ${String(run.code)}): ${tail(run.stdout || run.stderr)}`,
      );
    } else if (report['status'] !== undefined && report['status'] !== 'committed') {
      problems.push(`c2c reported status "${String(report['status'])}"`);
    }

    const rendered = findRenderedAgent(outDir, draft.name);
    if (rendered === undefined) {
      problems.push(`c2c wrote no agents/${draft.name}.agent.md into ${outDir}`);
      return candidate;
    }

    candidate.markdown = readFileSync(rendered, 'utf8');

    // Validate through the same parser that will load the installed file. A
    // draft that cannot be validated is reported, never dropped: silently
    // discarding it would leave the caller with fewer candidates and no reason.
    const validateDir = join(tmpRoot, 'validate', draft.name);
    mkdirSync(validateDir, { recursive: true });
    const validatePath = join(validateDir, 'agent.md');
    writeFileSync(validatePath, candidate.markdown, 'utf8');

    const { agent, error } = parseAgentFile(validatePath, draft.name);
    if (!agent) {
      problems.push(`c2c output is not a usable agent file: ${error ?? 'unknown parse failure'}`);
      return candidate;
    }
    candidate.agent = agent;
    for (const warning of agent.warnings) problems.push(`parser warning: ${warning}`);

    // The requested name is what the caller will install under, so a rendered
    // name that drifted from it is a refusal, not a rename.
    if (agent.name !== draft.name) {
      candidate.conflictsWith = agent.name;
      problems.push(`rendered name "${agent.name}" differs from the requested name "${draft.name}"`);
    }
  } catch (err) {
    problems.push(`draft failed: ${messageOf(err)}`);
    return candidate;
  }

  if (candidate.markdown === '') return candidate;

  const targetPath = options.agentsDir === null ? null : join(options.agentsDir, draft.name, 'agent.md');
  // Only an install can destroy a file. A dry run against an existing path is
  // legitimate (the diff is exactly what the user wants to see), so the refusal
  // is scoped to the run that would actually write.
  if (options.install === true && targetPath !== null && existsSync(targetPath)) {
    problems.push(`refusing to overwrite the existing file ${targetPath}`);
  }

  const diff = renderAgentDiff(candidate.markdown, targetPath);
  if (options.agentsDir === null) {
    // Nothing can be installed, so the draft itself is the deliverable. It is
    // printed in full rather than described.
    log(`${LOG_PREFIX} no agents directory is configured, so nothing can be installed here. Draft "${draft.name}":\n${candidate.markdown}`);
  } else {
    log(`${LOG_PREFIX} draft "${draft.name}" -> ${targetPath}`);
  }
  logCandidateSummary(candidate, log);

  // Approval is asked for even in a dry run: the diff is the whole point of the
  // exercise, and `confirm` is the one place a caller sees it. Writing still
  // requires install === true below.
  try {
    confirmed = await options.confirm(candidate, diff);
  } catch (err) {
    problems.push(`confirm failed: ${messageOf(err)}`);
    return candidate;
  }
  if (!confirmed) {
    problems.push('refused at confirmation');
    return candidate;
  }

  if (options.install !== true) {
    log(`${LOG_PREFIX} dry run: "${draft.name}" was rendered and validated, nothing was written.`);
    return candidate;
  }
  if (problems.length > 0) {
    log(`${LOG_PREFIX} not installing "${draft.name}": ${problems.length} problem(s) above`);
    return candidate;
  }
  const agentsDir = options.agentsDir;
  if (targetPath === null || agentsDir === null) {
    log(`${LOG_PREFIX} not installing "${draft.name}": no agents directory is configured`);
    return candidate;
  }

  try {
    mkdirSync(join(agentsDir, draft.name), { recursive: true });
    writeFileSync(targetPath, candidate.markdown, 'utf8');
    log(`${LOG_PREFIX} installed ${targetPath}`);
  } catch (err) {
    problems.push(`install failed: ${messageOf(err)}`);
  }
  return candidate;
}

/**
 * Draft agent definitions from one run, render them with c2c, and install them
 * only with explicit approval.
 *
 * The returned candidates carry everything needed to explain the outcome:
 * `markdown` when c2c rendered one, `agent` when the library parser accepted it,
 * and `problems` (with `conflictsWith`) when it must be refused. An empty array
 * means the model proposed nothing usable, which is a normal answer for a run
 * that taught nothing reusable.
 */
export async function draftAgents(evidence: DraftEvidence, options: DraftOptions): Promise<DraftCandidate[]> {
  const log = options.log ?? ((): void => {});
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const candidates: DraftCandidate[] = [];

  if (options.signal?.aborted) {
    log(`${LOG_PREFIX} aborted before the request was sent`);
    return candidates;
  }

  let answer: string;
  try {
    answer = await options.complete(buildDraftRequest(evidence));
  } catch (err) {
    // The model call is injected, so its failures belong to the caller's
    // provider. Reported rather than thrown: drafting is an optional extra on
    // top of a run that already finished successfully.
    log(`${LOG_PREFIX} the model call failed: ${messageOf(err)}`);
    return candidates;
  }

  const drafts = parseDraftResponse(answer);
  if (drafts.length === 0) {
    log(`${LOG_PREFIX} the model proposed no usable agent definitions`);
    return candidates;
  }
  log(`${LOG_PREFIX} ${drafts.length} candidate definition(s) proposed`);

  // One preflight for the whole batch: if c2c is absent, every draft gets the
  // same actionable rejection instead of N identical failed spawns.
  const probe = probeC2c();
  if (!probe.available) {
    log(`${LOG_PREFIX} ${C2C_MISSING_MESSAGE} (${probe.reason ?? 'not found on PATH'})`);
    return drafts.map((draft) => ({
      name: draft.name,
      markdown: '',
      problems: [C2C_MISSING_MESSAGE],
    }));
  }
  log(`${LOG_PREFIX} using ${C2C_COMMAND} ${probe.version ?? ''}`.trim());

  const tmpRoot = mkdtempSync(join(tmpdir(), 'harness-draft-agents-'));
  try {
    for (let index = 0; index < drafts.length; index++) {
      if (options.signal?.aborted) {
        log(`${LOG_PREFIX} aborted after ${candidates.length} candidate(s)`);
        break;
      }
      const draft = drafts[index] as AgentDraft;
      candidates.push(await renderCandidate(draft, index, options, tmpRoot, timeoutMs, log));
    }
  } finally {
    // The SKILL.md sources, the c2c output trees and their `.codex2code`
    // receipts are all scratch. Cleanup must never be the thing that fails a
    // run, hence the swallow.
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      log(`${LOG_PREFIX} could not remove the temp directory ${tmpRoot}: ${messageOf(err)}`);
    }
  }

  return candidates;
}
