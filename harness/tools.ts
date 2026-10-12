import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { exec, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ToolDefinition } from '../src/index.js';
import { GREP_DESCRIPTION, GREP_TOOL_NAME, formatGrepResult, grepWorkspace } from './grep.js';
import {
  DECLINE_MESSAGE,
  buildApprovalPreview,
  isMutatingToolCall,
  type ApprovalHandler,
} from './approval.js';
import type { Snapshotter } from './snapshot.js';
import type { ReadCache } from './read-cache.js';
import { resolveWorkspacePath } from './workspace.js';
import type { RiskClassifier } from './risk.js';
import {
  declined,
  error,
  ok,
  outcomeFromText,
  resultFromText,
  timeout,
  truncated,
  type ToolResult,
} from './result.js';

export const HARNESS_TOOLS: ToolDefinition[] = [
  {
    name: GREP_TOOL_NAME,
    description: GREP_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text to search for. Literal unless regex is true.' },
        path: { type: 'string', description: 'Directory to search, workspace-relative. Defaults to ".".' },
        include: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit to these file extensions, e.g. ["ts","tsx"].',
        },
        maxResults: { type: 'integer', description: 'Maximum matches to return. Defaults to 50.' },
        caseSensitive: { type: 'boolean', description: 'Case-sensitive match. Defaults to false.' },
        regex: { type: 'boolean', description: 'Treat pattern as a regular expression. Defaults to false.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'read',
    description:
      'Read a file from the workspace. Returns UTF-8 text. Reading the same unchanged file again ' +
      'returns a short "unchanged since turn N" line instead of the body.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path' } },
      required: ['path'],
    },
  },
  {
    name: 'write',
    description: 'Write (create or overwrite) a file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Exact string replacement in a file. oldString must match verbatim.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldString: { type: 'string' },
        newString: { type: 'string' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command in the workspace directory. Returns stdout+stderr. Stdin is closed unless `stdin` is given (prevents hangs on prompts). ' +
      'The shell is the platform default, NOT necessarily bash: cmd.exe on Windows (/bin/sh elsewhere). ' +
      'On Windows the POSIX utilities (ls, cat, rm, grep, od, wc, head, tail) do not exist — use dir/type/del/findstr/where, ' +
      'or prefer the read/grep/glob tools, which are cross-platform.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: { type: 'number' },
        stdin: { type: 'string', description: 'Optional text piped to the command on stdin' },
      },
      required: ['command'],
    },
  },
  {
    name: 'agy',
    description:
      "Ask Antigravity's CLI one question (non-interactive). Returns the answer text plus token usage. No shell quoting — prompt goes verbatim.",
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or task for agy' },
        timeoutMs: { type: 'number' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'gh',
    description:
      'Run the GitHub CLI (already authenticated). Args go verbatim, no shell quoting. Prefer --json with a field list for machine-readable output, e.g. {"args":["issue","list","--limit","5","--json","number,title,state"]}.',
    parameters: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' }, description: 'gh argv, e.g. ["pr","view","12","--json","title,body"]' },
        timeoutMs: { type: 'number' },
      },
      required: ['args'],
    },
  },
  {
    name: 'opencode',
    description:
      'Run opencode headless on one message (non-interactive). Returns the final answer text plus token/cost usage — tool chatter is summarized, not dumped. No shell quoting. Requires an explicit model (the `model` arg or HARNESS_OPENCODE_MODEL): without one opencode silently falls back to a free tier that rate-limits long agentic runs into failure. A rate-limited model enters cooldown, and repeat calls to it fail fast instead of re-running.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message/task for opencode' },
        model: {
          type: 'string',
          description:
            'provider/model to run, e.g. "opencode-go/deepseek-v4-flash". Falls back to HARNESS_OPENCODE_MODEL; one of the two is required. `opencode models` lists options. Avoid *-free / :free tiers for long work — they rate-limit mid-run.',
        },
        agent: { type: 'string', description: 'Optional agent to use, e.g. "build"' },
        timeoutMs: { type: 'number' },
      },
      required: ['message'],
    },
  },
];

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`Tool arg "${key}" must be a string`);
  return v;
}

/**
 * The shell `exec` will use, and a hint when a POSIX command was attempted on
 * Windows.
 *
 * The `bash` tool name is aspirational: `exec` uses `cmd.exe` on Windows. A
 * model that emits `ls -la` gets an opaque "'ls' is not recognized" and spends a
 * turn rediscovering the shell. Naming the substitution turns that into one
 * corrected call. Detected from the command rather than the platform alone, so
 * a Windows user with Git Bash on PATH is never told otherwise.
 */
export function shellHint(command: string, message: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return '';
  if (!/is not recognized|not found/i.test(message)) return '';
  const first = command.trim().split(/[\s;|&]/)[0] ?? '';
  const substitutes: Record<string, string> = {
    ls: 'dir',
    cat: 'type',
    rm: 'del',
    rmdir: 'rmdir',
    cp: 'copy',
    mv: 'move',
    grep: 'findstr',
    head: '(no direct equivalent; use the read tool with a line count)',
    tail: '(no direct equivalent; use the read tool with a line count)',
    wc: '(no direct equivalent; use the read tool)',
    od: '(no direct equivalent)',
    which: 'where',
    touch: '(use the write tool)',
  };
  const replacement = substitutes[first];
  const known = replacement !== undefined;
  return (
    `\n[harness] This shell is cmd.exe (Windows): ${known ? `"${first}" is not available — use "${replacement}".` : `"${first}" is not available.`}` +
    ' Prefer the read/grep/glob tools over shell equivalents.'
  );
}

/** Everything `executeHarnessTool` needs beyond the call itself. */
export interface ToolExecutionOptions {
  workspaceDir?: string;
  /**
   * Overrides `process.platform` for the shell-availability hint.
   *
   * Injected so the Windows path is testable on any machine: the hint exists
   * because a POSIX command on Windows fails opaquely, and a test that could
   * only run on Windows would not guard it.
   */
  platform?: NodeJS.Platform;
  /** Cancels the call: a timeout, or Ctrl-C. */
  signal?: AbortSignal;
  /** When set, mutating calls are shown and confirmed before they run. */
  onApproval?: ApprovalHandler;
  /** When set, pre-change bytes are copied aside for `/undo` and `--undo`. */
  snapshot?: Snapshotter;
  /**
   * Labels the risk of a mutating call before the gate asks.
   *
   * Advisory only: it adds a field to the request and never decides anything
   * here. `--auto-approve-safe` is implemented by the handler, not by this.
   */
  risk?: RiskClassifier;
  /**
   * The per-run read cache, when the caller has one. `index.ts` builds one per
   * run and passes it here; a caller that omits it reads the file every time,
   * which is what this did before the cache existed.
   */
  readCache?: ReadCache;
  /**
   * The model turn this call belongs to, when the caller knows it.
   *
   * Used only for the "unchanged since turn N" line. The batch executor knows
   * the turn, the serial path does not, and a wrong number is worse than none —
   * so an absent turn degrades the wording instead of inventing a count.
   */
  turn?: number;
}

/**
 * Shared spawn options for the delegated CLIs: piped stdio, no console flash,
 * and on POSIX its own process group so `killTree` can signal descendants too.
 */
export function childSpawnOptions(cwd: string, extra: SpawnOptions = {}): SpawnOptions {
  return {
    cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...extra,
  };
}

/**
 * Rate-limit cooldowns, keyed by the model we asked opencode to run.
 *
 * opencode retries a rate-limited model internally until the whole run dies
 * rather than surfacing it (observed: six straight `Output token rate limit
 * exceeded` failures in 56s on a free tier). Re-issuing the same doomed call
 * just burns the budget again, so a rate-limited model is parked and callers
 * fail fast with the retry window. Mirrors ModelHitch's circuit-breaker intent:
 * base delay, doubling per consecutive trip, capped.
 */
const OPENCODE_COOLDOWN_BASE_MS = 60_000;
const OPENCODE_COOLDOWN_MAX_MS = 10 * 60_000;
const opencodeCooldowns = new Map<string, { until: number; strikes: number }>();

/** Park `model` after a rate limit; returns the cooldown applied, in ms. */
export function tripOpencodeCooldown(model: string, now: number = Date.now()): number {
  const strikes = (opencodeCooldowns.get(model)?.strikes ?? 0) + 1;
  const ms = Math.min(OPENCODE_COOLDOWN_BASE_MS * 2 ** (strikes - 1), OPENCODE_COOLDOWN_MAX_MS);
  opencodeCooldowns.set(model, { until: now + ms, strikes });
  return ms;
}

/** Ms left before `model` may run again; 0 when it is clear. */
export function opencodeCooldownRemaining(model: string, now: number = Date.now()): number {
  const entry = opencodeCooldowns.get(model);
  if (!entry) return 0;
  const remaining = entry.until - now;
  if (remaining <= 0) {
    opencodeCooldowns.delete(model);
    return 0;
  }
  return remaining;
}

/** Clear a model's cooldown — called on a clean run, and by tests. */
export function clearOpencodeCooldown(model?: string): void {
  if (model === undefined) opencodeCooldowns.clear();
  else opencodeCooldowns.delete(model);
}

/** Does this error text mean "come back later" rather than "never"? */
export function isRateLimitText(text: string): boolean {
  return /rate limit|too many requests|\b429\b|quota exceeded|overloaded/i.test(text);
}

/** `*-free` / `:free` tiers rate-limit long agentic runs mid-flight. */
export function isFreeModel(model: string): boolean {
  return /-free$|:free$/i.test(model.trim());
}

/**
 * Advisory appended to a run's result when a free tier was used. A free model
 * can still be named explicitly — the harness model may pick one on its own —
 * and this is the exact class of model that rate-limited the run that motivated
 * the cooldown. Empty string when the model is not a free tier.
 */
export function opencodeModelWarning(model: string): string {
  return isFreeModel(model)
    ? `\n! ${model} is a free tier — long agentic runs can rate-limit mid-flight. Prefer a paid/stable model for real work.`
    : '';
}

/**
 * Which model opencode should run. Unpinned runs must not be allowed to fall
 * through to opencode's own default, which is a free tier here
 * (`space-bunny-free`) — that is what turned a long run into a rate-limit
 * death spiral. One of the `model` arg or HARNESS_OPENCODE_MODEL is required.
 */
export function resolveOpencodeModel(explicit?: string): string {
  const model = explicit?.trim() || process.env['HARNESS_OPENCODE_MODEL']?.trim();
  if (!model) {
    throw new Error(
      'opencode needs an explicit model: pass "model" or set HARNESS_OPENCODE_MODEL ' +
        '(e.g. "opencode-go/deepseek-v4-flash"; `opencode models` lists options). Unpinned runs ' +
        "fall through to opencode's own default, a free tier that rate-limits long runs into failure.",
    );
  }
  return model;
}

/**
 * Kill a child *and its descendants*. Killing the direct child is not enough:
 * on Windows `opencode` resolves to a launcher shim, so the real process is
 * orphaned — it keeps working and holds the stdio pipes open, delaying `close`
 * far past the budget (measured: a 3s budget closed at 14.4s). `taskkill /T`
 * walks the tree on Windows; on POSIX the negative pid signals the process
 * group created by `childSpawnOptions`.
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

/**
 * Headless `opencode run` with --format json parsed down to what renders well:
 * final answer text + one line per tool step + token/cost usage. Snapshots and
 * ids are dropped — the TUI markdown block gets prose, not JSONL.
 *
 * The model is always passed explicitly (never left to opencode's own default),
 * and a rate-limited model is parked so the next call fails fast.
 */
async function runOpencode(
  message: string,
  opts: { model?: string; agent?: string; timeoutMs: number; signal?: AbortSignal },
  workspaceDir: string,
): Promise<string> {
  const model = resolveOpencodeModel(opts.model);
  const cooling = opencodeCooldownRemaining(model);
  if (cooling > 0) {
    const retryAt = new Date(Date.now() + cooling).toLocaleTimeString();
    return `Error: opencode model ${model} is cooling down for another ${Math.ceil(cooling / 1000)}s after a rate limit (ready ~${retryAt}). Pick another model or wait it out.`;
  }
  const argv = ['run', message, '--format', 'json', '-m', model];
  if (opts.agent) argv.push('--agent', opts.agent);
  const freeWarning = opencodeModelWarning(model);
  return await new Promise<string>((res) => {
    // No spawn `timeout`: it would kill only the shim and let the real process
    // run on. The timer below owns the budget and kills the whole tree.
    const child = spawn('opencode', argv, childSpawnOptions(workspaceDir));
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (msg: string): void => {
      if (done) return;
      done = true;
      res(msg);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(`Error: opencode timed out after ${opts.timeoutMs}ms\n${summarizeOpencode(stdout).slice(-2000)}`);
    }, opts.timeoutMs);
    // The caller's signal (a tool budget, or Ctrl-C) must reach the process
    // tree: abandoning the promise without killing the child leaves an agentic
    // CLI editing the workspace after the run has moved on.
    const onAbort = (): void => {
      killTree(child);
      finish('Error: opencode was interrupted before it finished');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      finish(`Error: failed to start opencode: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const scan = scanOpencode(stdout);
      // A rate limit is the one failure worth remembering: opencode retries it
      // until the run dies, so without a cooldown every retry repeats the wait.
      if (scan.errors.some(isRateLimitText)) {
        const ms = tripOpencodeCooldown(model);
        return finish(
          `${scan.summary}${freeWarning}\n! cooling down ${model} for ${Math.round(ms / 1000)}s after a rate limit — ` +
            'retry this model later, or run a different one.',
        );
      }
      if (scan.errors.length === 0) clearOpencodeCooldown(model);
      if (code !== 0 && !scan.summary) {
        finish(`Error: opencode exited ${code ?? '?'}\n${stdout.slice(-2000)}\n${stderr.slice(-1000)}`);
      } else {
        finish(`${scan.summary || '(no output)'}${freeWarning}`);
      }
    });
    try {
      child.stdin?.end();
    } catch {
      /* stdin already gone */
    }
  });
}

/**
 * One line for an opencode `tool` part. `part.state` is an object
 * (`{status, title, output | error}`) — not the string the first pass assumed —
 * so a failed tool would otherwise render identically to a successful one.
 */
function formatOpencodeStep(part: Record<string, unknown>): string {
  const tool = typeof part['tool'] === 'string' ? (part['tool'] as string) : 'tool';
  const rawState = part['state'];
  const state =
    rawState !== null && typeof rawState === 'object' ? (rawState as Record<string, unknown>) : {};
  const status = typeof state['status'] === 'string' ? (state['status'] as string) : '';
  const error = typeof state['error'] === 'string' ? (state['error'] as string) : '';
  const title = typeof state['title'] === 'string' ? (state['title'] as string) : '';
  // Error text wins over title: a failed call must not read as a clean one.
  const detail = (error || title).replace(/\s+/g, ' ').trim();
  return `- ${tool}${status ? ` [${status}]` : ''}${detail ? `: ${detail.slice(0, 140)}` : ''}`.slice(
    0,
    200,
  );
}

/**
 * `opencode run` reports failures as a top-level `error` event, NOT on stderr,
 * and still exits non-zero. `{error:{name,data:{message,statusCode}}}` — without
 * this the caller sees a bare "- error" and cannot tell a bad model pin from a
 * plan limit.
 */
function formatOpencodeError(error: Record<string, unknown>): string {
  const rawData = error['data'];
  const data =
    rawData !== null && typeof rawData === 'object' ? (rawData as Record<string, unknown>) : {};
  const message =
    typeof data['message'] === 'string'
      ? data['message']
      : typeof error['name'] === 'string'
        ? error['name']
        : 'unknown error';
  const status = typeof data['statusCode'] === 'number' ? ` (${data['statusCode']})` : '';
  return `! opencode error${status}: ${message.replace(/\s+/g, ' ').slice(0, 240)}`;
}

export interface OpencodeScan {
  /** What the harness model sees: errors, tool steps, answer, usage. */
  summary: string;
  /** Raw formatted error lines, so the caller can classify them. */
  errors: string[];
}

export function scanOpencode(stdout: string): OpencodeScan {
  const texts: string[] = [];
  const toolSteps: string[] = [];
  const errors: string[] = [];
  let total = 0;
  let input = 0;
  let output = 0;
  let cost = 0;
  let steps = 0;
  let sawUsage = false;
  for (const raw of stdout.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev: { type?: string; part?: Record<string, unknown>; error?: Record<string, unknown> };
    try {
      ev = JSON.parse(trimmed) as {
        type?: string;
        part?: Record<string, unknown>;
        error?: Record<string, unknown>;
      };
    } catch {
      continue;
    }
    if (ev.error !== undefined && ev.error !== null && typeof ev.error === 'object') {
      errors.push(formatOpencodeError(ev.error));
      continue;
    }
    const part = ev.part ?? {};
    const partType = typeof part['type'] === 'string' ? (part['type'] as string) : ev.type ?? '';
    if (partType === 'text' && typeof part['text'] === 'string') {
      texts.push(part['text'] as string);
    } else if (partType === 'step-finish') {
      // opencode reports tokens per step, not cumulatively: sum them for the run.
      // Overwriting per step reported only the last step's tokens for a multi-step run.
      const tokens = part['tokens'] as { total?: number; input?: number; output?: number } | undefined;
      if (tokens) {
        sawUsage = true;
        if (typeof tokens.total === 'number') total += tokens.total;
        if (typeof tokens.input === 'number') input += tokens.input;
        if (typeof tokens.output === 'number') output += tokens.output;
      }
      if (typeof part['cost'] === 'number') cost += part['cost'] as number;
      steps++;
    } else if (partType === 'tool') {
      toolSteps.push(formatOpencodeStep(part));
    } else if (partType && partType !== 'step-start' && partType !== 'reasoning') {
      // Unknown future part type: name it, never dump its body.
      toolSteps.push(`- ${partType}`.slice(0, 200));
    }
  }
  const answer = texts.join('\n\n').trim();
  const lines: string[] = [];
  // Errors first: they explain a missing answer.
  lines.push(...errors.slice(0, 5));
  if (errors.length > 5) lines.push(`! … ${errors.length - 5} more errors`);
  lines.push(...toolSteps.slice(0, 20));
  if (toolSteps.length > 20) lines.push(`- … ${toolSteps.length - 20} more steps`);
  lines.push(answer || '(no answer text)');
  if (sawUsage) {
    const costText = Math.round(cost * 10000) / 10000;
    lines.push(`[opencode total=${total} in=${input} out=${output} cost=${costText} steps=${steps}]`);
  }
  return { summary: lines.join('\n'), errors };
}

export function summarizeOpencode(stdout: string): string {
  return scanOpencode(stdout).summary;
}

/**
 * argv-based gh runner: no shell quoting, pager off, interactive prompts
 * disabled, stdin closed. Read-only friendly; write commands work too and
 * return gh's own output (or its error) as the result string.
 */
async function runGh(
  ghArgs: string[],
  timeoutMs: number,
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<string> {
  return await new Promise<string>((res) => {
    const child = spawn(
      'gh',
      ghArgs,
      childSpawnOptions(workspaceDir, {
        env: { ...process.env, GH_PAGER: '', GH_PROMPT_DISABLED: '1' },
      }),
    );
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (msg: string): void => {
      if (done) return;
      done = true;
      res(msg);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(`Error: gh timed out after ${timeoutMs}ms\n${stdout.slice(-2000)}`);
    }, timeoutMs);
    const onAbort = (): void => {
      killTree(child);
      finish('Error: gh was interrupted before it finished');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      finish(`Error: failed to start gh: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.slice(0, 20_000);
      if (code !== 0) finish(`Error: gh exited ${code ?? '?'}\n${out}`);
      else finish(out || '(no output)');
    });
    try {
      child.stdin?.end();
    } catch {
      /* stdin already gone */
    }
  });
}

/**
 * One-shot Antigravity call. argv-based (no shell), stream-json internally so
 * the 25k-token init blob never reaches model context — only answer + usage.
 */
async function runAgy(
  prompt: string,
  timeoutMs: number,
  workspaceDir: string,
  signal?: AbortSignal,
): Promise<string> {
  const line =
    JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n';
  return await new Promise<string>((res) => {
    const child = spawn(
      'agy',
      ['--input-format', 'stream-json', '--output-format', 'stream-json', '--print', ''],
      childSpawnOptions(workspaceDir),
    );
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (msg: string): void => {
      if (done) return;
      done = true;
      res(msg);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(`Error: agy timed out after ${timeoutMs}ms\n${stdout.slice(-2000)}`);
    }, timeoutMs);
    const onAbort = (): void => {
      killTree(child);
      finish('Error: agy was interrupted before it finished');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      finish(`Error: failed to start agy: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let response = '';
      let usage = '';
      let status = '';
      for (const raw of stdout.split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const ev = JSON.parse(trimmed) as {
            event?: string;
            result?: { status?: string; response?: string; usage?: { total_tokens?: number } };
          };
          if (ev.event === 'result' && ev.result) {
            status = ev.result.status ?? '';
            response = ev.result.response ?? '';
            const total = ev.result.usage?.total_tokens;
            usage = total !== undefined ? `${total}` : '';
          }
        } catch {
          /* partial line — ignore */
        }
      }
      if (status && status !== 'SUCCESS') {
        finish(`Error: agy status ${status}\n${response.slice(0, 2000)}\n${stderr.slice(-1000)}`);
      } else if (code !== 0 && !response) {
        finish(`Error: agy exited ${code ?? '?'}\n${stdout.slice(-2000)}\n${stderr.slice(-1000)}`);
      } else {
        finish(`${response.trim() || '(no response)'}${usage ? `\n[agy usage total_tokens=${usage}]` : ''}`);
      }
    });
    try {
      child.stdin?.write(line);
      child.stdin?.end();
    } catch {
      finish('Error: agy stdin unavailable');
    }
  });
}

/**
 * Run one tool call.
 *
 * Returns an explicit envelope rather than a bare string. The envelope's `text`
 * is byte-for-byte what the model receives, so nothing downstream changes; the
 * `outcome` is what the harness and the UI use to stop guessing from
 * substrings. Where a helper below still returns a plain string — the delegated
 * CLI wrappers, which parse their own JSON — `resultFromText` classifies it
 * through the documented fallback.
 */
export async function executeHarnessTool(
  name: string,
  args: Record<string, unknown>,
  opts: ToolExecutionOptions = {},
): Promise<ToolResult> {
  const workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
  // Injectable so the Windows-only shell hint is testable from any platform.
  const platform = opts.platform ?? process.platform;
  const signal = opts.signal;
  const snapshot = opts.snapshot;
  const readCache = opts.readCache;
  const turn = opts.turn;
  try {
    // Any mutating call may have changed any file, so the whole cache goes
    // before the call runs rather than after it returns. A decline writes
    // nothing and a failure may still have written something, and telling those
    // apart is more fragile than dropping entries that cost one read each to
    // rebuild. `approval.ts` stays the one authority on what mutates.
    if (readCache !== undefined && isMutatingToolCall(name, args)) readCache.invalidate();
    // The gate runs before the tool body, so a decline cannot leave a partially
    // written file or a half-run command behind. The model gets a plain string
    // back and can adapt, rather than an error it can only retry.
    if (opts.onApproval && isMutatingToolCall(name, args)) {
      const preview = await buildApprovalPreview(name, args, { workspaceDir });
      // Classified before the question, because a label that arrives after the
      // human has decided is worth nothing.
      const risk = await opts.risk?.classify(name, args, preview);
      const approved = await opts.onApproval({ tool: name, args, preview, ...(risk ? { risk } : {}) });
      if (!approved) return declined(DECLINE_MESSAGE, 'the human declined this change');
    }
    if (signal?.aborted === true) {
      // Aborted before it started: reported as a timeout, not an error, so the
      // model reads "this did not run" rather than "this is broken".
      return timeout(`Error: ${name} was cancelled before it started`);
    }

    switch (name) {
      case GREP_TOOL_NAME: {
        const pattern = strArg(args, 'pattern');
        const sub = typeof args['path'] === 'string' ? (args['path'] as string) : '.';
        const result = grepWorkspace({
          pattern,
          dir: resolve(workspaceDir, sub),
          include: Array.isArray(args['include']) ? (args['include'] as string[]) : undefined,
          maxResults: typeof args['maxResults'] === 'number' ? (args['maxResults'] as number) : undefined,
          caseSensitive: args['caseSensitive'] === true,
          regex: args['regex'] === true,
          ...(signal ? { signal } : {}),
        });
        const text = formatGrepResult(result, pattern);
        // The grep result already knows which of these happened; reading it is
        // the whole reason the envelope exists. A search cut short by an abort
        // must not look like a complete one that merely found fewer matches.
        if (result.error !== undefined) return error(text);
        if (result.aborted === true) return timeout(text, 'the search was cancelled');
        if (result.truncated) return truncated(text, 'the match list was capped');
        return ok(text);
      }
      case 'read': {
        const label = strArg(args, 'path');
        const file = resolveWorkspacePath(workspaceDir, label);
        if (readCache === undefined) return ok(await readFile(file, 'utf8'));
        // A repeat read keeps the `ok` outcome: nothing went wrong, the model
        // simply already has these bytes. Nothing goes in `note` either — the
        // notice text says everything a human needs, and a UI-only copy would be
        // a second thing to keep in step with it.
        const text = await readCache.read(file, {
          label,
          ...(turn === undefined ? {} : { turn }),
          load: (): Promise<string> => readFile(file, 'utf8'),
        });
        return ok(text);
      }
      case 'write': {
        const file = resolveWorkspacePath(workspaceDir, strArg(args, 'path'));
        const content = strArg(args, 'content');
        // Capture before the write, never after: undo wants the state the run
        // started from.
        snapshot?.capture(file);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, 'utf8');
        return ok(`Wrote ${args['path']} (${content.length} chars)`);
      }
      case 'edit': {
        const file = resolveWorkspacePath(workspaceDir, strArg(args, 'path'));
        const oldString = strArg(args, 'oldString');
        const newString = strArg(args, 'newString');
        const current = await readFile(file, 'utf8');
        if (!current.includes(oldString)) return error(`Error: oldString not found in ${args['path']}`);
        snapshot?.capture(file);
        await writeFile(file, current.replace(oldString, newString), 'utf8');
        return ok(`Edited ${args['path']}`);
      }
      case 'bash': {
        const command = strArg(args, 'command');
        const timeoutMs =
          typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 30_000;
        const stdin = typeof args['stdin'] === 'string' ? (args['stdin'] as string) : '';
        // A shell can touch anything, so this records the gap instead of
        // pretending the snapshot covers it.
        snapshot?.note(
          'run_command may modify paths the harness never sees; only write/edit targets are ' +
            `captured (command: ${command.slice(0, 200)})`,
        );
        const text = await new Promise<string>((res) => {
          let done = false;
          const finish = (msg: string): void => {
            if (done) return;
            done = true;
            signal?.removeEventListener('abort', onAbort);
            res(msg);
          };
          const child = exec(
            command,
            {
              cwd: workspaceDir,
              timeout: timeoutMs,
              maxBuffer: 2 * 1024 * 1024,
              windowsHide: true,
            },
            (err, stdout, stderr) => {
              const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.slice(0, 20_000);
              if (err) {
                const hint = shellHint(command, err.message, platform);
                finish(`Exit ${err.code ?? '?'}: ${err.message}\n${out}${hint}`);
              } else finish(out || '(no output)');
            },
          );
          // `exec`'s own timeout kills only the direct child, so an interrupt
          // has to walk the tree the same way the delegated CLIs do.
          function onAbort(): void {
            killTree(child);
            finish('Error: bash was interrupted before it finished');
          }
          signal?.addEventListener('abort', onAbort, { once: true });
          // exec leaves stdin open: a child awaiting input would hang until
          // timeout. Feed `stdin` when given, otherwise close it for EOF.
          try {
            if (stdin) child.stdin?.write(stdin);
            child.stdin?.end();
          } catch {
            /* stdin already gone — child doesn't want it */
          }
        });
        // `exec` caps the capture at maxBuffer and the slice above caps the
        // result; either way a successful call can be a partial view.
        const outcome = outcomeFromText(text);
        const capped = outcome === 'ok' && text.length >= 20_000;
        return capped
          ? truncated(`${text}\n[output truncated at 20000 chars]`, 'the command produced more output than was kept')
          : resultFromText(text);
      }
      case 'agy': {
        const timeoutMs =
          typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 120_000;
        snapshot?.note('agy runs its own agentic loop in the workspace; its writes are not captured');
        return resultFromText(await runAgy(strArg(args, 'prompt'), timeoutMs, workspaceDir, signal));
      }
      case 'gh': {
        const rawArgs = args['args'];
        if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string')) {
          return error('Error: gh "args" must be an array of strings.');
        }
        const timeoutMs =
          typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 60_000;
        return resultFromText(await runGh(rawArgs as string[], timeoutMs, workspaceDir, signal));
      }
      case 'opencode': {
        const timeoutMs =
          typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 180_000;
        const model = typeof args['model'] === 'string' ? (args['model'] as string) : undefined;
        const agent = typeof args['agent'] === 'string' ? (args['agent'] as string) : undefined;
        snapshot?.note(
          'opencode runs its own agentic loop in the workspace; its writes are not captured',
        );
        return resultFromText(await runOpencode(
          strArg(args, 'message'),
          { model, agent, timeoutMs, ...(signal ? { signal } : {}) },
          workspaceDir,
        ));
      }
      default:
        return error(
          `Error: unknown tool "${name}". Available: ${HARNESS_TOOLS.map((t) => t.name).join(', ')}.`,
        );
    }
  } catch (err) {
    return error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
