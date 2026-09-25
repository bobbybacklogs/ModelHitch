import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { exec, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { ToolDefinition } from '../src/index.js';

export const HARNESS_TOOLS: ToolDefinition[] = [
  {
    name: 'read',
    description: 'Read a file from the workspace. Returns UTF-8 text.',
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
      'Run a shell command in the workspace directory. Returns stdout+stderr. Stdin is closed unless `stdin` is given (prevents hangs on prompts).',
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

function resolveWorkspacePath(workspaceDir: string, p: string): string {
  const abs = resolve(workspaceDir, p);
  const rel = relative(workspaceDir, abs);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return abs;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`Tool arg "${key}" must be a string`);
  return v;
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
  opts: { model?: string; agent?: string; timeoutMs: number },
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
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish(`Error: failed to start opencode: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
async function runGh(ghArgs: string[], timeoutMs: number, workspaceDir: string): Promise<string> {
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
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish(`Error: failed to start gh: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
async function runAgy(prompt: string, timeoutMs: number, workspaceDir: string): Promise<string> {
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
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish(`Error: failed to start agy: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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

export async function executeHarnessTool(
  name: string,
  args: Record<string, unknown>,
  opts: { workspaceDir?: string } = {},
): Promise<string> {
  const workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
  try {
    switch (name) {
      case 'read': {
        const file = resolveWorkspacePath(workspaceDir, strArg(args, 'path'));
        return await readFile(file, 'utf8');
      }
      case 'write': {
        const file = resolveWorkspacePath(workspaceDir, strArg(args, 'path'));
        const content = strArg(args, 'content');
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, 'utf8');
        return `Wrote ${args['path']} (${content.length} chars)`;
      }
      case 'edit': {
        const file = resolveWorkspacePath(workspaceDir, strArg(args, 'path'));
        const oldString = strArg(args, 'oldString');
        const newString = strArg(args, 'newString');
        const current = await readFile(file, 'utf8');
        if (!current.includes(oldString)) return `Error: oldString not found in ${args['path']}`;
        await writeFile(file, current.replace(oldString, newString), 'utf8');
        return `Edited ${args['path']}`;
      }
      case 'bash': {
        const command = strArg(args, 'command');
        const timeoutMs =
          typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 30_000;
        const stdin = typeof args['stdin'] === 'string' ? (args['stdin'] as string) : '';
        return await new Promise<string>((res) => {
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
              if (err) res(`Exit ${err.code ?? '?'}: ${err.message}\n${out}`);
              else res(out || '(no output)');
            },
          );
          // exec leaves stdin open: a child awaiting input would hang until
          // timeout. Feed `stdin` when given, otherwise close it for EOF.
          try {
            if (stdin) child.stdin?.write(stdin);
            child.stdin?.end();
          } catch {
            /* stdin already gone — child doesn't want it */
          }
        });
      }
      case 'agy': {
        const timeoutMs =
          typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 120_000;
        return await runAgy(strArg(args, 'prompt'), timeoutMs, workspaceDir);
      }
      case 'gh': {
        const rawArgs = args['args'];
        if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== 'string')) {
          return 'Error: gh "args" must be an array of strings.';
        }
        const timeoutMs =
          typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 60_000;
        return await runGh(rawArgs as string[], timeoutMs, workspaceDir);
      }
      case 'opencode': {
        const timeoutMs =
          typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 180_000;
        const model = typeof args['model'] === 'string' ? (args['model'] as string) : undefined;
        const agent = typeof args['agent'] === 'string' ? (args['agent'] as string) : undefined;
        return await runOpencode(strArg(args, 'message'), { model, agent, timeoutMs }, workspaceDir);
      }
      default:
        return `Error: unknown tool "${name}". Available: ${HARNESS_TOOLS.map((t) => t.name).join(', ')}.`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
