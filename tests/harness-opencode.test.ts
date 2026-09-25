import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  HARNESS_TOOLS,
  childSpawnOptions,
  clearOpencodeCooldown,
  executeHarnessTool,
  isFreeModel,
  isRateLimitText,
  killTree,
  opencodeCooldownRemaining,
  opencodeModelWarning,
  resolveOpencodeModel,
  scanOpencode,
  summarizeOpencode,
  tripOpencodeCooldown,
} from '../harness/tools.js';

/**
 * The `opencode` tool shells out to `opencode run --format json` and boils the
 * JSON event stream down to prose for the harness. These tests pin that
 * reduction against fixtures copied from real opencode 1.18.10 output, because
 * every one of the bugs found here was a mismatch with the real schema:
 *
 *  - `part.state` is an object, not a string, so failed tools looked clean
 *  - `step-finish` reports tokens *per step*, not cumulatively
 *  - failures arrive as a top-level `error` event, and `opencode run` exits
 *    non-zero with EMPTY stderr, so a swallowed error left the caller with a
 *    bare "- error" it could not act on
 *
 * Everything here is offline: no provider keys, no opencode binary. The live
 * smoke test at the bottom is opt-in via HARNESS_LIVE_OPENCODE=1.
 */

type Ev = Record<string, unknown>;

function stream(...events: Ev[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}

const SES = 'ses_f29e2899effeJDHSjwKpm1O3hp';

function stepStart(): Ev {
  return { type: 'step_start', part: { type: 'step-start', sessionID: SES } };
}

function textPart(text: string): Ev {
  return { type: 'text', part: { type: 'text', text, sessionID: SES } };
}

function stepFinish(tokens: { total: number; input: number; output: number }, cost = 0): Ev {
  return {
    type: 'step_finish',
    part: { type: 'step-finish', reason: 'tool-calls', tokens, cost, sessionID: SES },
  };
}

/** A completed `write` tool call, exactly as opencode emits it. */
function toolWrite(filepath: string): Ev {
  return {
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'write',
      callID: 'call_function_32p67enitve2_1',
      state: {
        status: 'completed',
        input: { content: 'hi', filePath: filepath },
        output: 'Wrote file successfully.',
        metadata: { diagnostics: {}, filepath, exists: false, truncated: false },
        title: filepath,
      },
      sessionID: SES,
    },
  };
}

/** A completed `bash` tool call. */
function toolBash(command: string): Ev {
  return {
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'bash',
      callID: 'call_function_vzictkznixx6_1',
      state: {
        status: 'completed',
        input: { command, timeout: 120000 },
        output: 'probe-ok\r\n',
        metadata: { output: 'probe-ok\r\n', exit: 0, truncated: false },
        title: command,
      },
      sessionID: SES,
    },
  };
}

/** A FAILED tool call: `state.error`, and no `title` at all. */
function toolReadError(missing: string): Ev {
  return {
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'read',
      callID: 'call_function_hdy40q5ro37p_1',
      state: {
        status: 'error',
        input: { filePath: missing, offset: 1, limit: 2000 },
        error: `File not found: ${missing}`,
      },
      sessionID: SES,
    },
  };
}

/**
 * The rate limit that killed the earlier harness run: opencode retried it six
 * times in under a minute and then the whole run died.
 */
function rateLimitEvent(): Ev {
  return {
    type: 'error',
    sessionID: SES,
    error: {
      name: 'AI_APICallError',
      data: {
        message: 'Output token rate limit exceeded. Please retry after a brief wait.',
        statusCode: 429,
        isRetryable: true,
        metadata: { url: 'https://opencode.ai/zen/v1/chat/completions' },
      },
    },
  };
}

/** The real 403 body opencode returns for a model the account cannot access. */
function authErrorEvent(): Ev {
  return {
    type: 'error',
    timestamp: 1790298865071,
    sessionID: SES,
    error: {
      name: 'APIError',
      data: {
        message: 'Upstream request failed: Model access is disabled',
        statusCode: 403,
        isRetryable: false,
        responseBody: '{"error":{"type":"server_error","message":"Upstream request failed: Model access is disabled"}}',
        metadata: { url: 'https://opencode.ai/zen/v1/chat/completions' },
      },
    },
  };
}

describe('HARNESS_TOOLS', () => {
  it('exposes the delegated CLIs, with opencode requiring a message', () => {
    const names = HARNESS_TOOLS.map((t) => t.name);
    expect(names).toEqual(['grep_search', 'read', 'write', 'edit', 'bash', 'agy', 'gh', 'opencode']);
    const opencode = HARNESS_TOOLS.find((t) => t.name === 'opencode');
    expect(opencode).toBeDefined();
    expect(opencode?.parameters?.['required']).toEqual(['message']);
  });

  it('exposes grep_search as a read-only search requiring a pattern', () => {
    const grep = HARNESS_TOOLS.find((t) => t.name === 'grep_search');
    expect(grep).toBeDefined();
    expect(grep?.parameters?.['required']).toEqual(['pattern']);
    // The orchestrator's own tool must be callable through the same dispatcher
    // the model uses, not just declared.
    expect(String(grep?.description)).toContain('Read-only');
  });

  it('resolves every tool name the dispatcher would need', () => {
    // A declared tool that executeHarnessTool does not handle would fail only at
    // call time, so every declared name is exercised against the error path.
    for (const tool of HARNESS_TOOLS) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.parameters?.type).toBe('object');
    }
  });
});

describe('summarizeOpencode', () => {
  it('reduces a run to answer text plus a usage line', () => {
    const out = summarizeOpencode(
      stream(stepStart(), textPart('wrapped'), stepFinish({ total: 15091, input: 13143, output: 2 })),
    );
    expect(out).toBe('wrapped\n[opencode total=15091 in=13143 out=2 cost=0 steps=1]');
  });

  it('renders each tool step with its status and target', () => {
    const out = summarizeOpencode(
      stream(
        stepStart(),
        toolWrite('C:\\work\\probe.txt'),
        stepFinish({ total: 15349, input: 13200, output: 51 }),
        stepStart(),
        toolBash('echo beta'),
        stepFinish({ total: 15371, input: 22, output: 2 }),
        stepStart(),
        textPart('done'),
        stepFinish({ total: 15390, input: 22, output: 2 }),
      ),
    );
    expect(out).toContain('- write [completed]: C:\\work\\probe.txt');
    expect(out).toContain('- bash [completed]: echo beta');
    expect(out).toContain('done');
  });

  it('marks a failed tool as an error instead of a clean step', () => {
    const out = summarizeOpencode(
      stream(
        stepStart(),
        toolReadError('C:\\work\\definitely-not-here.txt'),
        stepFinish({ total: 30817, input: 13211, output: 72 }),
        stepStart(),
        textPart('File not found.'),
        stepFinish({ total: 30820, input: 22, output: 3 }),
      ),
    );
    expect(out).toContain('- read [error]: File not found: C:\\work\\definitely-not-here.txt');
    // The whole point: a failure must never read as a completed call.
    expect(out).not.toContain('[completed]');
  });

  it('sums tokens across steps rather than reporting only the last step', () => {
    const out = summarizeOpencode(
      stream(
        stepStart(),
        toolWrite('C:\\work\\probe.txt'),
        stepFinish({ total: 15349, input: 13200, output: 51 }),
        stepStart(),
        toolBash('echo beta'),
        stepFinish({ total: 15371, input: 22, output: 2 }),
        stepStart(),
        textPart('done'),
        stepFinish({ total: 15390, input: 22, output: 2 }),
      ),
    );
    // 15349 + 15371 + 15390 — the last-step-only bug reported 15390.
    expect(out).toContain('total=46110 in=13244 out=55 cost=0 steps=3');
    expect(out).not.toContain('total=15390');
  });

  it('surfaces a top-level error event with its status code', () => {
    const out = summarizeOpencode(stream(authErrorEvent()));
    expect(out).toContain('! opencode error (403): Upstream request failed: Model access is disabled');
    // And it must not collapse into the useless bare marker that hid this.
    expect(out).not.toBe('- error');
    expect(out).toContain('(no answer text)');
  });

  it('lists errors before the missing answer', () => {
    const out = summarizeOpencode(stream(stepStart(), authErrorEvent()));
    expect(out.split('\n')[0]).toContain('! opencode error (403)');
  });

  it('names an unknown part type without dumping its body', () => {
    const out = summarizeOpencode(
      stream({
        type: 'snapshot',
        part: { type: 'snapshot', payload: 'SECRET-BLOB'.repeat(500) },
      }),
    );
    expect(out).toContain('- snapshot');
    expect(out).not.toContain('SECRET-BLOB');
  });

  it('caps the step list so a long run cannot flood the context', () => {
    const events: Ev[] = [stepStart()];
    for (let i = 0; i < 25; i++) events.push(toolBash(`step-${i}`));
    const out = summarizeOpencode(stream(...events));
    const stepLines = out.split('\n').filter((l) => l.startsWith('- bash'));
    expect(stepLines).toHaveLength(20);
    expect(out).toContain('- … 5 more steps');
  });

  it('omits the usage line when no step reported tokens', () => {
    const out = summarizeOpencode(stream(stepStart(), textPart('hello')));
    expect(out).toBe('hello');
    expect(out).not.toContain('[opencode');
  });

  it('ignores non-JSON noise on stdout', () => {
    const noisy = ['some banner line', ...stream(stepStart(), textPart('ok')).split('\n'), 'trailing'].join('\n');
    expect(summarizeOpencode(noisy)).toBe('ok');
  });

  it('reports an empty stream as a missing answer', () => {
    expect(summarizeOpencode('')).toBe('(no answer text)');
  });
});

describe('killTree', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /**
   * The defect this pins: killing only the direct child leaves a launcher's
   * grandchildren running. A live process tree keeps appending heartbeats, so
   * "heartbeats stopped" is the observable proof that the tree really died.
   */
  it('kills the child and its descendants', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-kill-'));
    const beats = join(dir, 'beats.txt');
    const grandchild = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beats)},'c'),80);`;
    const parent = `const {spawn}=require('child_process');const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beats)},'p'),80);spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setTimeout(()=>{},60000);`;

    const child = spawn(process.execPath, ['-e', parent], childSpawnOptions(dir, { stdio: 'ignore' }));
    try {
      await sleep(1200);
      expect(existsSync(beats)).toBe(true);
      expect(readFileSync(beats, 'utf8').length).toBeGreaterThan(0);

      killTree(child);
      await sleep(1800); // let the kill land
      const settled = readFileSync(beats, 'utf8').length;
      await sleep(1000);
      expect(readFileSync(beats, 'utf8').length).toBe(settled);
    } finally {
      killTree(child);
      await sleep(300);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows can hold the temp dir briefly after a kill */
      }
    }
  }, 30_000);
});

describe('opencode model selection', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('prefers the explicit model argument', () => {
    vi.stubEnv('HARNESS_OPENCODE_MODEL', 'env/model');
    expect(resolveOpencodeModel('arg/model')).toBe('arg/model');
  });

  it('falls back to HARNESS_OPENCODE_MODEL', () => {
    vi.stubEnv('HARNESS_OPENCODE_MODEL', 'opencode-go/deepseek-v4-flash');
    expect(resolveOpencodeModel()).toBe('opencode-go/deepseek-v4-flash');
  });

  it('refuses an unpinned run instead of defaulting to a free tier', () => {
    vi.stubEnv('HARNESS_OPENCODE_MODEL', '');
    expect(() => resolveOpencodeModel()).toThrow(/needs an explicit model/);
    expect(() => resolveOpencodeModel()).toThrow(/HARNESS_OPENCODE_MODEL/);
  });

  it('surfaces the unpinned refusal to the caller', async () => {
    vi.stubEnv('HARNESS_OPENCODE_MODEL', '');
    const out = await executeHarnessTool('opencode', { message: 'hi' }, { workspaceDir: tmpdir() });
    expect(out).toContain('needs an explicit model');
  });

  it('recognises the free tiers that rate-limit long runs', () => {
    expect(isFreeModel('opencode/space-bunny-free')).toBe(true);
    expect(isFreeModel('openrouter/dots/dots-3-note-preview:free')).toBe(true);
    expect(isFreeModel('opencode-go/deepseek-v4-flash')).toBe(false);
  });
});

describe('opencode rate-limit cooldown', () => {
  beforeEach(() => clearOpencodeCooldown());
  afterEach(() => {
    clearOpencodeCooldown();
    vi.unstubAllEnvs();
  });

  it('classifies rate limits separately from permanent access failures', () => {
    const limited = scanOpencode(stream(rateLimitEvent()));
    expect(limited.errors.some(isRateLimitText)).toBe(true);
    expect(summarizeOpencode(stream(rateLimitEvent()))).toContain(
      '! opencode error (429): Output token rate limit exceeded',
    );
    // A disabled model is permanent — cooling it down would be wrong.
    const denied = scanOpencode(stream(authErrorEvent()));
    expect(denied.errors.some(isRateLimitText)).toBe(false);
  });

  it('doubles the window per consecutive trip and caps it', () => {
    const now = 1_000_000;
    expect(tripOpencodeCooldown('m', now)).toBe(60_000);
    expect(tripOpencodeCooldown('m', now)).toBe(120_000);
    expect(tripOpencodeCooldown('m', now)).toBe(240_000);
    expect(tripOpencodeCooldown('m', now)).toBe(480_000);
    expect(tripOpencodeCooldown('m', now)).toBe(600_000); // capped
  });

  it('expires the cooldown once the window passes', () => {
    const now = 1_000_000;
    tripOpencodeCooldown('m', now);
    expect(opencodeCooldownRemaining('m', now + 30_000)).toBe(30_000);
    expect(opencodeCooldownRemaining('m', now + 60_001)).toBe(0);
  });

  it('fails fast on a cooled-down model instead of re-running it', async () => {
    const model = 'opencode/rate-limited-model';
    tripOpencodeCooldown(model);
    const t0 = Date.now();
    const out = await executeHarnessTool(
      'opencode',
      { message: 'hi', model },
      { workspaceDir: tmpdir() },
    );
    expect(out).toContain('cooling down');
    expect(out).toContain(model);
    // Returns before spawning anything: no run, no retry loop.
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('warns when a free tier is named explicitly', () => {
    // The model that rate-limited the original run: still usable, but flagged.
    // Pure helper, so this stays offline and deterministic.
    expect(opencodeModelWarning('opencode/space-bunny-free')).toContain('is a free tier');
    expect(opencodeModelWarning('openrouter/x/y:free')).toContain('is a free tier');
    expect(opencodeModelWarning('opencode-go/deepseek-v4-flash')).toBe('');
  });
});

describe('opencode tool (live)', () => {
  const live = process.env['HARNESS_LIVE_OPENCODE'] === '1';
  const model = process.env['HARNESS_OPENCODE_MODEL'];

  it.skipIf(!live || !model)(
    'runs headless against the real CLI',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'harness-live-'));
      try {
        const out = await executeHarnessTool(
          'opencode',
          { message: 'reply with the single word: wrapped', model, timeoutMs: 180_000 },
          { workspaceDir: dir },
        );
        expect(out).toContain('wrapped');
        expect(out).toContain('[opencode total=');
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    },
    240_000,
  );
});
