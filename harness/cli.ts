#!/usr/bin/env node
/**
 * The harness CLI.
 *
 * Two views of one run: an interactive TUI when a terminal is available under
 * bun, and a plaintext transcript everywhere else. Both are fed the same
 * `RunEnvironment`, so a run cannot describe itself one way in the TUI and
 * another way in a log file.
 *
 * The argument parser is table-driven rather than a scan of `process.argv`,
 * because the previous one had to guess which flags take a value — and a
 * mistyped task that happened to look like a flag's value would silently become
 * one.
 */

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { streamHarness, type HarnessOptions } from './index.js';
import { ask } from './readline.js';
import type { ApprovalRequest } from './approval.js';import { DEFAULT_TOOL_TIMEOUT_MS, createToolCanceller, parseToolTimeout } from './cancel.js';
import { latestRunId, undoRun } from './snapshot.js';
import { listSessions, loadSession, newSessionId } from './session.js';
import { DEFAULT_SUMMARIZE_THRESHOLD, parseSummarizeThreshold } from './summarize.js';
import { runDraftAgents } from './draft-agents-run.js';
import { TerminalRenderer } from './render.js';
import { describeEnvironment } from './ui/environment.js';
import { diffStat, looksLikeDiff, clip } from './format.js';
import { outcomeFromText } from './result.js';
import { RISK_TIMEOUT_MS, createRiskClassifier, mayAutoApprove } from './risk.js';
import { EventStream } from './events.js';
import { DEFAULT_COMPACT_THRESHOLD } from './compact.js';
import { findBunCommand, isBunRuntime } from './bun.js';
import {
  createRuleStore,
  describeRule,
  needsWideningConfirmation,
  normalizeTarget,
  ruleBlockedByRisk,
} from './rules.js';
import { runReview, type ReviewedChange } from './reviewer.js';
import type { SessionsVerb } from './sessions.js';
import { loadHarnessRuntime } from './runtime.js';

/**
 * A subcommand, when the first token names one. These report or repair
 * something and exit; none of them starts a run, and none may end up inside a
 * task prompt.
 */
export type CliCommand = 'doctor' | 'setup' | 'sessions';

export interface CliArgs {
  prompt: string;
  command?: CliCommand;
  /**
   * The token after a subcommand: `sessions show <id>`. Kept apart from the
   * prompt so `mhh sessions rm 20260101-000000-abcd` cannot become a task.
   */
  commandArgs: string[];
  model?: string;
  config?: string;
  maxTurns: number;
  agentsDir: string | null | undefined;
  toolTimeoutMs: number;
  summarizeThreshold: number;
  assumeYes: boolean;
  noZstack: boolean;
  snapshots: boolean;
  saveSession: boolean;
  summarizeTools: boolean;
  draftAgents: boolean;
  forceTui: boolean;
  forcePlain: boolean;
  verbose: boolean;
  help: boolean;
  json: boolean;
  undo: { requested: boolean; runId?: string };
  resume?: string;
  /** `--tool-log`: append every untruncated tool body here. */
  toolLog?: string;
  /** `--risk`: label each mutating call with an advisory risk level. */
  risk: boolean;
  /** `--auto-approve-safe`: skip the prompt only for calls classified `safe`. */
  autoApproveSafe: boolean;
  /** `--review`: run an adversarial review pass after the run. */
  review: boolean;
  /** `--context-bytes`: characters of each likely-relevant file to append. */
  contextBytes: number;
  /**
   * `--json-events`: emit NDJSON records on stdout instead of a transcript.
   * Distinct from `--json`, which is `doctor`'s machine-readable report.
   */
  jsonEvents: boolean;
  /**
   * `--compact` / `--compact-threshold <n>`: message characters above which the
   * oldest completed turns are digested. `0` means off, which is the default.
   */
  compactThreshold: number;
}

/** Positional subcommands, matched against the first non-flag token. */
const COMMANDS = ['run', 'doctor', 'setup', 'sessions'] as const;

/** `value` consumes the next token; `optional` only when it does not look like a flag. */
const FLAGS: Record<string, 'value' | 'optional' | 'bool'> = {
  '--model': 'value',
  '--config': 'value',
  '--max-turns': 'value',
  '--agents-dir': 'value',
  '--tool-timeout': 'value',
  '--summarize-threshold': 'value',
  '--resume': 'value',
  '--undo': 'optional',
  '--tool-log': 'value',
  '--context-bytes': 'value',
  '--compact': 'bool',
  '--no-compact': 'bool',
  '--compact-threshold': 'value',
  '--auto-approve-safe': 'bool',
  '--risk': 'bool',
  '--review': 'bool',
  '--yes': 'bool',
  '-y': 'bool',
  '--no-zstack': 'bool',
  '--no-agents': 'bool',
  '--no-snapshot': 'bool',
  '--save-session': 'bool',
  '--summarize-tools': 'bool',
  '--draft-agents': 'bool',
  '--tui': 'bool',
  '--plain': 'bool',
  '--no-tui': 'bool',
  '--verbose': 'bool',
  '--json': 'bool',
  '--json-events': 'bool',
  '--help': 'bool',
  '-h': 'bool',
};

export function parseArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  const present = new Set<string>();
  const promptTokens: string[] = [];
  const commandArgs: string[] = [];
  let command: CliCommand | undefined;
  let readingCommandArgs = false;

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] as string;
    // A leading positional is a subcommand, not a task. `run` stays accepted
    // as a no-op spelling so existing invocations keep working.
    if (index === 0 && (COMMANDS as readonly string[]).includes(token)) {
      if (token !== 'run') command = token as CliCommand;
      readingCommandArgs = command !== undefined;
      continue;
    }
    if (token.startsWith('--') || token === '-y' || token === '-h') {
      readingCommandArgs = false;
      const kind = FLAGS[token];
      present.add(token);
      if (kind === 'value') {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          values.set(token, next);
          index++;
        }
      } else if (kind === 'optional') {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          values.set(token, next);
          index++;
        }
      }
      continue;
    }
    // Everything positional after a subcommand belongs to it, not to the task.
    if (readingCommandArgs) {
      commandArgs.push(token);
      continue;
    }
    promptTokens.push(token);
  }

  const maxTurns = Number(values.get('--max-turns') ?? '8');
  return {
    prompt: promptTokens.join(' ').trim(),
    ...(command !== undefined ? { command } : {}),
    commandArgs,
    ...(values.has('--model') ? { model: values.get('--model') as string } : {}),
    ...(values.has('--config') ? { config: values.get('--config') as string } : {}),
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : 8,
    agentsDir: present.has('--no-agents') ? null : values.get('--agents-dir'),
    toolTimeoutMs: parseToolTimeout(values.get('--tool-timeout')),
    summarizeThreshold: parseSummarizeThreshold(values.get('--summarize-threshold')),
    assumeYes: present.has('--yes') || present.has('-y'),
    noZstack: present.has('--no-zstack'),
    snapshots: !present.has('--no-snapshot'),
    saveSession: present.has('--save-session'),
    summarizeTools: present.has('--summarize-tools'),
    draftAgents: present.has('--draft-agents'),
    forceTui: present.has('--tui'),
    forcePlain: present.has('--plain') || present.has('--no-tui') || present.has('--draft-agents'),
    verbose: present.has('--verbose'),
    json: present.has('--json'),
    help: present.has('--help') || present.has('-h'),
    undo: values.has('--undo')
      ? { requested: true, runId: values.get('--undo') as string }
      : { requested: present.has('--undo') },
    ...(values.has('--resume') ? { resume: values.get('--resume') as string } : {}),
    ...(values.has('--tool-log') ? { toolLog: values.get('--tool-log') as string } : {}),
    risk: present.has('--risk'),
    autoApproveSafe: present.has('--auto-approve-safe'),
    review: present.has('--review'),
    contextBytes: parseNonNegative(values.get('--context-bytes')),
    jsonEvents: present.has('--json-events'),
    compactThreshold: resolveCompactThreshold(present, values),
  };
}

/**
 * Resolve the three compaction flags into one number.
 *
 * Off unless asked for: compaction rewrites history, and a run that silently
 * replaced its own transcript would be a surprise. `--no-compact` wins over
 * everything, because it is the one the user typed to turn something off.
 */
function resolveCompactThreshold(present: Set<string>, values: Map<string, string>): number {
  if (present.has('--no-compact')) return 0;
  const explicit = values.get('--compact-threshold');
  if (explicit !== undefined) return parseNonNegative(explicit);
  return present.has('--compact') ? DEFAULT_COMPACT_THRESHOLD : 0;
}

/**
 * Parse a count that cannot sensibly be negative, falling back to `0` — which
 * for `--context-bytes` means "off", the same way `--tool-timeout 0` means
 * "no timeout" rather than "use the default".
 */
function parseNonNegative(raw: string | undefined, fallback = 0): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

const USAGE = `modelhitch-harness — run one task with tools, in a terminal UI or as plain text
(also installed as \`mhh\`, which is the same command; the long name stays for scripts)

Usage
  mhh "<task>" [options]
  mhh doctor [--json]          report environment health without starting a run
  mhh setup                    create a config interactively, then verify it
  mhh sessions [--json]        list saved runs
  mhh sessions show <id>       print one saved run
  mhh sessions rm <id>         delete a saved run (--yes to skip the prompt)
  mhh --undo [run-id]          restore the files the last (or given) run changed

Run options
  --model <provider>/<model>   Override the configured model for this run only
  --config <path>              ModelHitch config file (default ~/.modelhitch/config.json)
  --max-turns <n>              Model turns before the loop stops (default 8)
  --tool-timeout <ms>          Budget for one tool call (default ${DEFAULT_TOOL_TIMEOUT_MS}; 0 disables)

Workspace
  --agents-dir <path>          Folder of <name>/agent.md definitions (default ~/.agents/agents)
  --no-agents                  Disable subagent delegation entirely
  --no-snapshot                Do not copy pre-change bytes aside for --undo
  --summarize-tools            Replace long tool output with a head/digest/tail form
  --summarize-threshold <n>    Character count above which a result is summarized (default ${DEFAULT_SUMMARIZE_THRESHOLD})
  --no-zstack                  Skip the zstack system prompt and playbook
                               (the ## Workspace and ## Likely relevant files sections stay)
  --context-bytes <n>          Characters of each likely-relevant file to append (default 0, off)
  --compact                    Digest the oldest completed turns once the history grows past a budget
  --compact-threshold <n>      Total message characters that triggers compaction (default ${DEFAULT_COMPACT_THRESHOLD})
  --no-compact                 Never compact (the default; wins over the two flags above)

Safety
  --yes, -y                    Approve every mutating tool call. Required for a non-TTY stdin,
                               which otherwise declines rather than hanging on a question.
  --risk                       Label each mutating call safe/caution/dangerous before asking
  --auto-approve-safe          Skip the prompt only for calls classified safe, never caution
  --review                     After the run, have a read-only reviewer critique the change
                               (printed to stderr; a review never changes the exit code)

Approval answers
  y   approve this call once
  a   approve every call matching this tool and target, for this session
  p   the same, persisted for this workspace (~/.modelhitch/harness/approval-rules.json)
  n   decline
  A rule matches on an exact tool + target (a command, or a file path), never a prefix,
  and a call the risk classifier calls caution or dangerous prompts again regardless.

Sessions
  --save-session               Write the finished run to the harness state directory
  --resume <id>                Continue a saved session
  --draft-agents               Draft new agent definitions from this run and print them as diffs

Interface
  --tui                        Force the terminal UI (needs bun: npm run harness:tui -- ...)
  --plain, --no-tui            Force plain text
  --verbose                    Print every tool body instead of folding successes
  --tool-log <path>            Append every untruncated tool body to a file
  --json                       With \`doctor\`: machine-readable checks
  --json-events                Emit NDJSON run records on stdout (forces --plain)
  --help, -h                   This text

Output
  A successful tool call is folded to one line; a failed one prints its body.
  --verbose unfolds everything, and --tool-log keeps full bodies in a file.

Repair
  --undo [run-id]              Restore the files the last (or given) run changed

The terminal UI is used automatically when stdout is a TTY. Under a plain node
install the command hands the run over to bun, so --tui works from the installed
\`mhh\`; install bun from https://bun.sh, or set HARNESS_BUN to its path.
With no task argument, the task is read from stdin, or typed when prompted.`;

export function helpText(): string {
  return USAGE;
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let out = '';
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

interface ChangeLogEntry {
  name: string;
  added: number;
  removed: number;
}

/**
 * Check that `--tool-log` can be written before the run starts.
 *
 * Discovering an unwritable path at the end of a twenty-minute run, after the
 * bodies are gone, is the one failure mode worth spending a syscall to avoid.
 */
function openToolLog(path: string): { ok: true } | { ok: false; error: string } {
  try {
    appendFileSync(path, '', 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Append one tool body, untruncated.
 *
 * Deliberately silent on failure: the path was checked at startup, and a log
 * that becomes unwritable mid-run (a full disk, a pulled USB stick) must not
 * turn into a stream of errors interrupting the transcript.
 */
function appendToolLog(path: string | undefined, name: string, outcome: string, output: string): void {
  if (path === undefined) return;
  try {
    appendFileSync(path, `\n=== ${name} [${outcome}] ${new Date().toISOString()} ===\n${output}\n`, 'utf8');
  } catch {
    /* see above */
  }
}

/**
 * Hand this run over to bun.
 *
 * The installed `mhh` is a node shim, so `--tui` from a global install used to
 * be a message telling the user to go and find bun themselves — after they had
 * already typed a task into the plaintext prompt. Spawning the same entry point
 * under bun is what makes `--tui` and the automatic TUI behave the way the help
 * text says they do.
 *
 * Never returns: the child owns the terminal from here, and its exit code is
 * this process's exit code. `HARNESS_NO_REEXEC` is the loop guard — if the child
 * somehow is not bun either, it continues as plaintext rather than spawning
 * forever.
 */
function reexecUnderBun(bun: string): never {
  const script = process.argv[1];
  if (script === undefined || process.env['HARNESS_NO_REEXEC'] === '1') {
    throw new Error('--tui needs the bun runtime, and this process could not hand over to it');
  }
  const result = spawnSync(bun, [script, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, HARNESS_NO_REEXEC: '1' },
    windowsHide: false,
  });
  if (result.error !== undefined) {
    throw new Error(`--tui could not start ${bun}: ${result.error.message}`);
  }
  process.exit(result.status ?? 1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  // `doctor` reports environment health and exits; it never starts a run.
  if (args.command === 'doctor') {
    const { runDoctor } = await import('./doctor.js');
    const code = await runDoctor({
      json: args.json,
      ...(args.config !== undefined ? { configPath: args.config } : {}),
      ...(args.model !== undefined ? { modelOverride: args.model } : {}),
      agentsDir: args.agentsDir,
      workspaceDir: process.cwd(),
    });
    if (code !== 0) process.exitCode = code;
    return;
  }

  // `setup` writes a config and exits; it never starts a run.
  if (args.command === 'setup') {
    const { runSetup } = await import('./setup.js');
    const result = await runSetup({
      ...(args.config !== undefined ? { configPath: args.config } : {}),
    });
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }

  // `sessions` inspects and prunes saved runs; it never starts one.
  if (args.command === 'sessions') {
    const { runSessions } = await import('./sessions.js');
    const [verb, id] = args.commandArgs;
    const known: SessionsVerb[] = ['list', 'show', 'rm'];
    if (verb !== undefined && !(known as string[]).includes(verb)) {
      console.error(`[harness] unknown sessions verb "${verb}". Use: ${known.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const code = await runSessions({
      // No verb means list: `mhh sessions` alone is the obvious default.
      verb: (verb as SessionsVerb | undefined) ?? 'list',
      ...(id !== undefined ? { id } : {}),
      json: args.json,
      assumeYes: args.assumeYes,
    });
    if (code !== 0) process.exitCode = code;
    return;
  }

  // `--undo` is a repair command, not a run.
  if (args.undo.requested) {
    const runId = args.undo.runId ?? latestRunId() ?? undefined;
    const render = new TerminalRenderer();
    try {
      render.undo(undoRun(runId));
      return;
    } catch (err) {
      render.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }

  /*
   * Decide the interface before collecting a task.
   *
   * It used to be decided after, which meant `mhh --tui` with no task asked for
   * one and only then said the interface was unavailable — wasting the answer and
   * looking like the TUI had silently degraded. Anything that can fail here
   * fails before the user has typed anything.
   */
  const runtimeIsBun = isBunRuntime();
  /*
   * `--tui` needs a terminal, not just bun.
   *
   * A renderer handed a pipe has nowhere to draw and nothing to read keys from,
   * so it waits — and a run that hangs with no output is worse than one that
   * refuses. Checked here, before the hand-over to bun, so a piped `--tui` fails
   * in a second instead of after a timeout.
   */
  if (args.forceTui && process.stdout.isTTY !== true) {
    console.error(
      '[harness] --tui needs a terminal: stdout is not a TTY, so there is nothing to draw on. ' +
        'Drop --tui for a plaintext transcript.',
    );
    process.exitCode = 1;
    return;
  }
  if (args.jsonEvents && (args.forceTui || (!args.forcePlain && process.stdout.isTTY === true))) {
    // A record stream and a full-screen interface cannot share stdout. Silently
    // emitting nothing would be the worst outcome: an empty pipe and no reason.
    console.error(
      '[harness] --json-events cannot be combined with the terminal UI; it forces the plaintext path. ' +
        'Drop --tui, or drop --json-events.',
    );
    process.exitCode = 1;
    return;
  }
  let useTui = !args.jsonEvents && (args.forceTui || (!args.forcePlain && process.stdout.isTTY === true));
  if (useTui && !runtimeIsBun) {
    const bun = findBunCommand();
    if (bun !== undefined) {
      // Hand the whole run over: the TUI owns the terminal, so it cannot be a
      // child process this one keeps printing around.
      reexecUnderBun(bun);
    }
    if (args.forceTui) {
      console.error(
        '[harness] --tui needs bun, which is not on PATH. Install it from https://bun.sh, ' +
          'or set HARNESS_BUN to its path.',
      );
      process.exitCode = 1;
      return;
    }
    useTui = false;
  }

  /*
   * With no task and a real interface available, the interface collects it.
   *
   * `Task:` is the one thing a harness UI must never show: borrowing readline
   * draws a plain prompt over the terminal, takes a line, and only then hands
   * over to a full-screen renderer — which is what made `--tui` look like it had
   * silently degraded into the plaintext path.
   */
  const sessionMode = args.prompt === '' && useTui;
  let prompt = args.prompt;
  if (!sessionMode) {
    if (prompt === '' && process.stdin.isTTY !== true) prompt = (await readStdin()).trim();
    if (prompt === '' && process.stdin.isTTY === true && process.stdout.isTTY === true) {
      prompt = (await ask('Task: ')).trim();
    }
    if (prompt === '') {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
  }

  const sessionId = newSessionId();
  const workspaceDir = process.cwd();

  // Resuming restores the stored history, including its system prompt.
  let initialMessages: HarnessOptions['initialMessages'];
  let resumedFrom: { id: string; model: string; turns: number } | undefined;
  if (args.resume !== undefined) {
    try {
      const session = loadSession(args.resume);
      initialMessages = session.messages;
      resumedFrom = { id: session.id, model: session.model, turns: session.turns };
      if (args.model !== undefined && args.model !== session.model) {
        console.warn(`[harness] warning: --model ${args.model} overrides the session model ${session.model || 'unknown'}`);
      } else if (args.config !== undefined) {
        console.warn(`[harness] warning: --config may replace the session model (session ran on ${session.model || 'unknown'})`);
      }
    } catch (err) {
      console.error(`[harness] ${err instanceof Error ? err.message : String(err)}`);
      const known = listSessions();
      if (known.length > 0) console.error(`[harness] saved sessions: ${known.join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  const canceller = createToolCanceller(args.toolTimeoutMs);
  // Only built when asked for: with no classifier there is no extra call, no
  // extra latency, and an approval request identical to what it was before.
  const risk =
    args.risk || args.autoApproveSafe
      ? createRiskClassifier({
          complete: async (request, signal) => {
            const runtime = await loadHarnessRuntime({
              ...(args.config !== undefined ? { configPath: args.config } : {}),
              ...(args.model !== undefined ? { modelOverride: args.model } : {}),
            });
            const result = await runtime.client.chat({
              provider: runtime.provider,
              model: runtime.model,
              messages: [{ role: 'user', content: request }],
              maxTokens: 120,
              signal,
            });
            const content = result.message.content;
            return typeof content === 'string'
              ? content
              : content.map((part) => (part.type === 'text' ? part.text : '')).join('');
          },
          // The budget the call itself is under, so a slow classifier costs a
          // label rather than the run.
          timeoutMs: Math.min(args.toolTimeoutMs > 0 ? args.toolTimeoutMs : RISK_TIMEOUT_MS, RISK_TIMEOUT_MS),
          log: (message) => console.error(message),
        })
      : undefined;
  const harnessOpts: HarnessOptions = {
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.config !== undefined ? { configPath: args.config } : {}),
    maxTurns: args.maxTurns,
    noZstack: args.noZstack,
    workspaceDir,
    ...(args.agentsDir !== undefined ? { agentsDir: args.agentsDir } : {}),
    ...(initialMessages !== undefined ? { initialMessages } : {}),
    sessionId,
    saveSession: args.saveSession,
    toolTimeoutMs: args.toolTimeoutMs,
    canceller,
    snapshots: args.snapshots,
    summarizeTools: args.summarizeTools,
    summarizeThreshold: args.summarizeThreshold,
    ...(risk !== undefined ? { risk, autoApproveSafe: args.autoApproveSafe } : {}),
    // `--no-agents` passes agentsDir: null, which is also what disables the
    // bundled reviewer: one flag should not leave half of delegation switched on.
    ...(args.review ? { review: true } : {}),
    ...(args.contextBytes > 0 ? { contextBytes: args.contextBytes } : {}),
    ...(args.compactThreshold > 0 ? { compactThreshold: args.compactThreshold } : {}),
  };

  const environment = await describeEnvironment({
    prompt,
    options: harnessOpts,
    sessionId,
    workspaceDir,
    assumeYes: args.assumeYes,
  });

  if (useTui) {
    try {
      // Lazy: @opentui/core's renderer needs bun's FFI, and loading it on the
      // plaintext path would cost every piped run.
      const { runHarnessTui } = await import('./tui.js');
      await runHarnessTui(prompt, harnessOpts, {
        assumeYes: args.assumeYes,
        environment,
        interactive: sessionMode,
        ...(args.toolLog !== undefined ? { toolLog: args.toolLog } : {}),
      });
      return;
    } catch (err) {
      if (args.forceTui) throw err;
      console.log(
        `[harness] TUI unavailable (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); falling back to plaintext`,
      );
    }
  }

  await runPlaintext({ prompt, args, harnessOpts, environment, resumedFrom, sessionId, workspaceDir });
}

/**
 * The plaintext run.
 *
 * Progress goes to stdout as part of the transcript; diagnostics go to stderr,
 * so `> run.log` captures the run without the harness talking about itself.
 */
async function runPlaintext(input: {
  prompt: string;
  args: CliArgs;
  harnessOpts: HarnessOptions;
  environment: Awaited<ReturnType<typeof describeEnvironment>>;
  resumedFrom?: { id: string; model: string; turns: number };
  sessionId: string;
  workspaceDir: string;
}): Promise<void> {
  const { prompt, args, harnessOpts, environment, sessionId, workspaceDir } = input;
  // With a record stream on stdout, the human-readable view moves to stderr: an
  // operator watching the terminal still sees the run, and a pipe consumer gets
  // pure NDJSON. Without the flag this is the ordinary stdout renderer.
  const humanStream = args.jsonEvents ? process.stderr : process.stdout;
  const render = new TerminalRenderer({
    output: humanStream,
    error: process.stderr,
    verbose: args.verbose,
  });
  const events = args.jsonEvents ? new EventStream({ output: process.stdout }) : undefined;
  const canceller = harnessOpts.canceller;
  // Remembered approvals live for this run. Built even when nothing is
  // remembered yet, because `a` and `p` need somewhere to record into.
  const rules = createRuleStore({
    workspaceDir,
    log: (message) => process.stderr.write(`${message}\n`),
  });
  // `--tool-log` is the untruncated record. Open it before the run so a bad path
  // fails now, while the user is still watching, instead of silently at the end.
  const toolLog = args.toolLog === undefined ? undefined : openToolLog(args.toolLog);
  if (toolLog !== undefined && !toolLog.ok) {
    render.error(`--tool-log ${args.toolLog}: ${toolLog.error}`);
    process.exitCode = 1;
    return;
  }

  render.header(environment, prompt, input.resumedFrom);
  events?.runStart({
    task: prompt,
    model: environment.target,
    provider: environment.provider,
    sessionId,
    workspace: workspaceDir,
    playbook: environment.playbook,
    approvals: environment.approvals,
  });

  // Wall-clock per tool call: the harness emits `tool` after the call settles,
  // so the gap since the previous event is the call's duration.
  let lastEventAt = Date.now();
  const changes: ChangeLogEntry[] = [];
  /** Tool + preview per approved change, for the `--review` pass. */
  const reviewed: ReviewedChange[] = [];
  const autoApproved: Array<{ name: string; level: string }> = [];

  /** Records what an approved write contained, for the summary and the review. */
  const recordChange = (request: ApprovalRequest): void => {
    if (!looksLikeDiff(request.preview)) {
      // A command preview is not a diff, but it is still what changed, and the
      // reviewer needs it: `run_command` is how most of the damage happens.
      if (request.tool === 'bash' || request.tool === 'run_command') {
        reviewed.push({ tool: request.tool, preview: request.preview });
      }
      return;
    }
    const stat = diffStat(request.preview);
    const existing = changes.find((entry) => entry.name === request.tool);
    if (existing) {
      existing.added += stat.added;
      existing.removed += stat.removed;
    } else {
      changes.push({ name: request.tool, added: stat.added, removed: stat.removed });
    }
    reviewed.push({ tool: request.tool, preview: request.preview });
  };

  /**
   * The plaintext gate.
   *
   * `createApprovalHandler` is not used here because it writes its own
   * `[approval] <tool>` block straight to stdout, which would print the diff a
   * second time in a plainer form than the card above it.
   *
   * The order of the checks is the policy, so it is worth reading top to bottom:
   * a `safe` verdict, then `--yes`, then the non-TTY decline, and only then a
   * remembered rule. A rule must never be what answers a question nobody could
   * have answered.
   */
  const onApproval = async (request: ApprovalRequest): Promise<boolean> => {
    recordChange(request);
    render.approval(request.tool, request.preview, request.risk);

    const announce = (decision: 'approved' | 'auto-approved' | 'declined', note: string): void => {
      events?.approval({
        tool: request.tool,
        decision,
        ...(request.risk !== undefined ? { risk: request.risk.level, reason: request.risk.reason } : {}),
      });
      void note;
    };

    if (mayAutoApprove(request.risk)) {
      // The one case where nobody looks. It is said out loud, every time.
      render.progress(`auto-approved ${request.tool} (risk: safe — ${request.risk?.reason ?? ''})`, 'warn');
      autoApproved.push({ name: request.tool, level: request.risk?.level ?? 'safe' });
      announce('auto-approved', 'risk: safe');
      return true;
    }
    if (args.assumeYes) {
      render.progress(`approved ${request.tool} (--yes)`, 'warn');
      announce('approved', '--yes');
      return true;
    }
    if (process.stdin.isTTY !== true) {
      render.notice(
        'warn',
        `Declined: ${request.tool}`,
        'stdin is not a TTY, so nobody could answer. Re-run with --yes to approve without prompting.',
      );
      announce('declined', 'no TTY');
      return false;
    }

    // A remembered rule, which a risk label can veto.
    const remembered = rules?.match(request.tool, request.args);
    const blocked = ruleBlockedByRisk(request.risk);
    if (remembered !== undefined && blocked === undefined) {
      render.progress(
        `auto-approved ${request.tool} — ${describeRule(remembered)}` +
          (request.risk !== undefined ? `, risk: ${request.risk.level}` : ''),
        'warn',
      );
      autoApproved.push({ name: request.tool, level: request.risk?.level ?? 'rule' });
      announce('auto-approved', describeRule(remembered));
      return true;
    }
    if (remembered !== undefined && blocked !== undefined) {
      // Say why the rule did not apply, or the prompt looks arbitrary.
      render.notice('warn', `${request.tool} is prompting again`, blocked);
    }

    const answer = (
      await render.askLine('  [y] once  [a] always this session  [p] always here  [n] no > ')
    ).toLowerCase();
    if (answer === '') {
      // An empty line at an interactive prompt is a no, not a crash.
      render.progress(`declined ${request.tool}`, 'warn');
      announce('declined', 'empty answer');
      return false;
    }

    const persist = answer === 'p';
    const remember = answer === 'a' || answer === 'p';
    const approved = answer === 'y' || answer === 'yes' || remember;

    if (!approved) {
      render.progress(`declined ${request.tool}`, 'warn');
      announce('declined', 'answered no');
      return false;
    }

    if (remember) {
      // `bash` without a classifier gets a second question: the first one
      // approved this command, and this one approves every future command that
      // matches it exactly, which the user has not been shown yet.
      let confirmed = true;
      if (persist && needsWideningConfirmation(request)) {
        const target = normalizeTarget(request.tool, request.args) ?? '(unmatchable)';
        const widened = await render.ask(
          `  persist a rule that auto-approves ${request.tool} exactly "${clip(target, 80)}" in this workspace? [y/N] `,
        );
        confirmed = widened;
        if (!widened) {
          render.progress(`approved ${request.tool} once (rule not persisted)`, 'ok');
          announce('approved', 'rule declined, approved once');
          return true;
        }
      }
      const rule = remember && confirmed
        ? rules?.remember(request.tool, request.args, persist ? 'workspace' : 'session')
        : undefined;
      if (rule !== undefined) {
        render.progress(
          `approved ${request.tool} and remembered — ${describeRule(rule)}`,
          'warn',
        );
        announce('approved', describeRule(rule));
        return true;
      }
      // No normalizable target, or persistence failed: the approval still stands.
      render.progress(
        `approved ${request.tool} once (${request.tool} has no target a rule could match)`,
        'warn',
      );
      announce('approved', 'not memorable');
      return true;
    }

    render.progress(`approved ${request.tool}`, 'ok');
    announce('approved', 'answered yes');
    return true;
  };

  const opts: HarnessOptions = { ...harnessOpts, onApproval: harnessOpts.onApproval ?? onApproval };

  // First Ctrl-C aborts the running tool, the second exits. Without this a tool
  // that ignored its budget would leave no way out but closing the window.
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts++;
    if (interrupts === 1) {
      const tool = canceller?.activeTool;
      const aborted = canceller?.abortActive() ?? false;
      render.notice(
        'warn',
        aborted ? `Cancelling ${tool ?? 'the running tool'}` : 'No tool is running',
        'Ctrl-C again to exit.',
      );
      return;
    }
    process.exit(1);
  };
  process.on('SIGINT', onSigint);

  const started = Date.now();
  const toolsUsed: string[] = [];
  let turns = 0;
  let tokens = 0;
  let finalText = '';

  try {
    for await (const ev of streamHarness(prompt, opts)) {
      if (ev.type === 'chunk') {
        if (ev.chunk.type === 'text-delta') {
          render.text(ev.chunk.text);
          events?.text(ev.turn, ev.chunk.text);
        } else if (ev.chunk.type === 'tool-call-start') lastEventAt = Date.now();
        continue;
      }
      if (ev.type === 'turn') {
        tokens += ev.result.usage?.totalTokens ?? 0;
        turns = ev.turn;
        render.endText();
        events?.turn({ turn: ev.turn, tokens: ev.result.usage?.totalTokens ?? 0, totalTokens: tokens });
        continue;
      }
      if (ev.type === 'tool') {
        const at = Date.now();
        const durationMs = Math.max(0, at - lastEventAt);
        lastEventAt = at;
        toolsUsed.push(ev.call.name);
        const outcome = outcomeFromText(ev.output);
        render.tool({
          name: ev.call.name,
          args: ev.call.arguments,
          output: ev.output,
          outcome,
          durationMs,
        });
        events?.tool({
          turn: ev.turn,
          name: ev.call.name,
          args: ev.call.arguments,
          outcome,
          durationMs,
          body: ev.output,
        });
        // Written whether or not the card was folded: the log is the record.
        appendToolLog(args.toolLog, ev.call.name, outcome, ev.output);
        continue;
      }
      if (ev.type === 'done') {
        turns = ev.turns;
        tokens = ev.usage.totalTokens ?? tokens;
        const final = ev.final.message;
        finalText = typeof final.content === 'string' ? final.content : '';
      }
    }
  } catch (err) {
    render.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  render.summary({
    turns,
    tokens,
    tools: toolsUsed.length,
    elapsedMs: Date.now() - started,
    changes,
    ...(harnessOpts.saveSession === true ? { sessionId } : {}),
    ...(args.toolLog !== undefined ? { toolLogPath: args.toolLog } : {}),
    ...(autoApproved.length > 0 ? { autoApproved } : {}),
  });

  events?.done({
    turns,
    tokens,
    tools: toolsUsed.length,
    durationMs: Date.now() - started,
    ...(changes.length > 0 ? { changes } : {}),
    ...(harnessOpts.saveSession === true ? { sessionId } : {}),
  });
  if (args.review) {
    const runtime = await loadHarnessRuntime({
      ...(args.config !== undefined ? { configPath: args.config } : {}),
      ...(args.model !== undefined ? { modelOverride: args.model } : {}),
    });
    const outcome = await runReview({
      task: prompt,
      changes: reviewed,
      runtime,
      workspaceDir,
      agentsDir: args.agentsDir,
      ...(harnessOpts.toolTimeoutMs !== undefined ? { timeoutMs: harnessOpts.toolTimeoutMs } : {}),
      summarizeThreshold: harnessOpts.summarizeThreshold ?? 8_000,
      summarizeEnabled: harnessOpts.summarizeTools === true,
      log: (message) => process.stderr.write(`${message}\n`),
    });
    if (outcome.critique !== undefined) {
      // stderr, not stdout: a review is an annotation on the run, and a run
      // redirected to a file should not have a second document appended to it.
      process.stderr.write(`\n## Adversarial review\n\n${outcome.critique}\n`);
    } else {
      render.notice('info', 'Review skipped', outcome.skipped ?? 'no critique was produced');
    }
  }

  if (args.draftAgents) {
    const { loadHarnessRuntime } = await import('./runtime.js');
    const runtime = await loadHarnessRuntime({
      ...(args.config !== undefined ? { configPath: args.config } : {}),
      ...(args.model !== undefined ? { modelOverride: args.model } : {}),
    });
    await runDraftAgents({
      task: prompt,
      toolsUsed,
      finalText,
      runtime,
      workspaceDir,
      agentsDir: args.agentsDir,
      assumeYes: args.assumeYes,
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
