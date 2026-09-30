import { describe, expect, it } from 'vitest';
import { TerminalRenderer, wrapPlain } from '../harness/render.js';
import { colorCapability, Painter, stripAnsi } from '../harness/theme.js';
import type { RunEnvironment } from '../harness/ui/environment.js';

/** Collects writes so a render can be asserted on as text. */
function sink(options: { isTTY?: boolean; env?: NodeJS.ProcessEnv; columns?: number } = {}): {
  stream: NodeJS.WriteStream;
  errorStream: NodeJS.WriteStream;
  text: () => string;
  errorText: () => string;
} {
  let out = '';
  let err = '';
  const stream = {
    isTTY: options.isTTY,
    columns: options.columns ?? 100,
    write(chunk: string) {
      out += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const errorStream = {
    isTTY: false,
    columns: 100,
    write(chunk: string) {
      err += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, errorStream, text: () => out, errorText: () => err };
}

const ENVIRONMENT: RunEnvironment = {
  provider: 'vercel-ai-gateway',
  model: 'anthropic/claude-sonnet-4',
  target: 'vercel-ai-gateway/anthropic/claude-sonnet-4',
  configPath: '/home/dev/.modelhitch/config.json',
  playbook: 'feature',
  principles: 2,
  workspaceDir: '/home/dev/project',
  workspaceFacts: 'typescript (pnpm), 214 source files',
  sessionId: '20260601-143012-4f2a',
  maxTurns: 8,
  toolTimeoutMs: 120_000,
  approvals: 'prompt',
  snapshots: true,
  agents: 'subagents=on (bihan from @genoventures-labs/bihan; 4 agents from /home/dev/.agents/agents)',
  resumed: false,
};

const DIFF = ['--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1,3 +1,4 @@', ' const a = 1;', '-const b = 2;', '+const b = 3;'].join('\n');

describe('colorCapability', () => {
  it('respects NO_COLOR over a TTY', () => {
    const caps = colorCapability({ stream: { isTTY: true }, env: { NO_COLOR: '1' } });
    expect(caps.enabled).toBe(false);
    expect(caps.color('#ff0000', 'x')).toBe('x');
  });

  it('respects FORCE_COLOR over a pipe, which is what CI needs', () => {
    const caps = colorCapability({ stream: { isTTY: false }, env: { FORCE_COLOR: '1' } });
    expect(caps.color('#ff0000', 'x')).toBe('\u001b[38;2;255;0;0mx\u001b[0m');
  });

  it('stays plain when TERM is dumb', () => {
    const caps = colorCapability({ stream: { isTTY: true }, env: { TERM: 'dumb' } });
    expect(caps.color('#ff0000', 'x')).toBe('x');
  });

  it('stays plain on a redirected stdout', () => {
    const caps = colorCapability({ stream: { isTTY: false }, env: {} });
    expect(caps.bold('x')).toBe('x');
  });
});

describe('Painter', () => {
  it('owes a reset after colouring, so a streamed line cannot bleed', () => {
    const painter = new Painter(colorCapability({ stream: { isTTY: true }, env: {} }));
    painter.color('accent', 'x');
    expect(painter.end()).toBe('\u001b[0m');
    expect(painter.end()).toBe('');
  });

  it('strips back to plain text', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });
});

describe('wrapPlain', () => {
  it('wraps on word boundaries within the column budget', () => {
    const lines = wrapPlain('one two three four five', 12);
    expect(lines).toEqual(['one two', 'three four', 'five']);
  });

  it('keeps explicit blank lines', () => {
    expect(wrapPlain('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });
});

describe('TerminalRenderer', () => {
  it('prints the run header with the facts a log needs', () => {
    const s = sink();
    const render = new TerminalRenderer({ output: s.stream, error: s.stream, env: {} });
    render.header(ENVIRONMENT, 'fix the failing test');
    const text = s.text();
    expect(text).toContain('MODELHITCH');
    expect(text).toContain('vercel-ai-gateway/anthropic/claude-sonnet-4');
    expect(text).toContain('playbook feature');
    expect(text).toContain('fix the failing test');
    expect(text).toContain('ask before writes');
    expect(text).toContain('snapshots on');
    expect(text).toContain('8 turns');
  });

  it('reports a resumed session', () => {
    const s = sink();
    const render = new TerminalRenderer({ output: s.stream, error: s.stream, env: {} });
    render.header(ENVIRONMENT, 'continue', { id: '20260601-143012-4f2a', turns: 4 });
    expect(s.text()).toContain('resumed');
    expect(s.text()).toContain('4 turns');
  });

  it('writes assistant text verbatim, with no decoration', () => {
    const s = sink();
    const render = new TerminalRenderer({ output: s.stream, error: s.stream, env: {} });
    render.text('Here is **the answer**.');
    render.endText();
    expect(s.text()).toBe('Here is **the answer**.\n');
  });

  it('folds a successful call to one line, with a preview of its first output line', () => {
    const s = sink();
    const render = new TerminalRenderer({ output: s.stream, error: s.stream, env: {} });
    render.tool({
      name: 'bash',
      args: { command: 'npm test' },
      output: 'ok\n1 passing',
      outcome: 'ok',
      durationMs: 4_200,
    });
    const text = s.text();
    expect(text).toContain('Bash');
    expect(text).toContain('npm test');
    expect(text).toContain('4.2s');
    expect(text).toContain('ok');
    // A success is a header plus a preview, not the body.
    expect(text).not.toContain('1 passing');
    expect(text.trim().split('\n')).toHaveLength(1);
  });

  it('opens a failed call so the reason is visible without asking', () => {
    const s = sink();
    new TerminalRenderer({ output: s.stream, error: s.stream, env: {} }).tool({
      name: 'bash',
      args: { command: 'npm test' },
      output: 'Exit 1: Command failed\n1 failing',
      outcome: 'error',
      durationMs: 900,
    });
    expect(s.text()).toContain('error');
    expect(s.text()).toContain('1 failing');
  });

  it('distinguishes a timeout from a failure', () => {
    const s = sink();
    new TerminalRenderer({ output: s.stream, error: s.stream, env: {} }).tool({
      name: 'bash',
      args: { command: 'sleep 999' },
      output: 'Error: bash timed out after 30000ms',
      outcome: 'timeout',
    });
    expect(s.text()).toContain('◼');
    expect(s.text()).toContain('did not finish');
  });

  it('honours an explicit expansion override', () => {
    const s = sink();
    new TerminalRenderer({ output: s.stream, error: s.stream, env: {} }).tool({
      name: 'read',
      args: { path: 'x' },
      output: 'first\nsecond',
      outcome: 'ok',
      expanded: true,
    });
    expect(s.text()).toContain('second');
  });

  it('counts diff lines and colours them by marker', () => {
    const s = sink({ isTTY: true, env: {} });
    const render = new TerminalRenderer({ output: s.stream, error: s.stream, env: {} });
    render.tool({ name: 'edit', args: { path: 'src/app.ts' }, output: DIFF, outcome: 'ok', expanded: true });
    const text = s.text();
    expect(text).toContain('+1');
    expect(text).toContain('-1');
    // Added and removed lines are not the same colour, which is the whole point.
    expect(text).toMatch(/\u001b\[38;2;63;185;80m\+const b = 3;/);
    expect(text).toMatch(/\u001b\[38;2;248;81;73m-const b = 2;/);
  });

  it('does not preview a diff, whose first line says nothing the badge does not', () => {
    const s = sink();
    new TerminalRenderer({ output: s.stream, error: s.stream, env: {} }).tool({
      name: 'edit',
      args: { path: 'src/app.ts' },
      output: DIFF,
      outcome: 'ok',
    });
    expect(s.text()).not.toContain('--- a/src/app.ts');
  });

  it('marks a failed call and keeps the error visible', () => {
    const s = sink();
    const render = new TerminalRenderer({ output: s.stream, error: s.stream, env: {} });
    render.tool({
      name: 'read',
      args: { path: 'missing.ts' },
      output: 'Error: ENOENT: no such file or directory',
      outcome: 'error',
    });
    const text = s.text();
    expect(text).toContain('✖');
    expect(text).toContain('Error: ENOENT');
  });

  it('clips an expanded body to a head/tail window, and shows it whole when verbose', () => {
    const long = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n');
    const clipped = sink();
    new TerminalRenderer({ output: clipped.stream, error: clipped.stream, env: {}, toolLines: 6 })
      .tool({ name: 'read', args: { path: 'x' }, output: long, outcome: 'ok', expanded: true });
    expect(clipped.text()).toContain('lines omitted');
    expect(clipped.text()).toContain('line 59');

    const full = sink();
    new TerminalRenderer({ output: full.stream, error: full.stream, env: {}, verbose: true })
      .tool({ name: 'read', args: { path: 'x' }, output: long, outcome: 'ok' });
    expect(full.text()).not.toContain('lines omitted');
    expect(full.text()).toContain('line 30');
  });

  it('summarises the run with tokens, turns and the session id when saved', () => {
    const s = sink();
    const render = new TerminalRenderer({ output: s.stream, error: s.stream, env: {} });
    render.summary({
      turns: 3,
      tokens: 12_400,
      tools: 5,
      elapsedMs: 65_000,
      changes: [{ name: 'edit', added: 12, removed: 3 }],
      sessionId: '20260601-143012-4f2a',
    });
    const text = s.text();
    expect(text).toContain('run complete');
    expect(text).toContain('12.4k');
    expect(text).toContain('+12 -3');
    expect(text).toContain('--resume 20260601-143012-4f2a');
  });

  it('emits no escape codes at all when colour is off', () => {
    const s = sink({ isTTY: false, env: {} });
    const render = new TerminalRenderer({ output: s.stream, error: s.stream, env: {} });
    render.header(ENVIRONMENT, 'task');
    render.tool({ name: 'edit', args: { path: 'a.ts' }, output: DIFF, outcome: 'ok' });
    render.notice('error', 'boom', 'details');
    render.summary({ turns: 1, tokens: 10, tools: 1, elapsedMs: 1_000 });
    expect(s.text()).not.toContain('\u001b');
  });

  it('keeps diagnostics on stderr so a redirected transcript stays clean', () => {
    const s = sink();
    const render = new TerminalRenderer({ output: s.stream, error: s.errorStream, env: {} });
    render.diagnostic('session saved: /tmp/x.json');
    expect(s.text()).toBe('');
    expect(s.errorText()).toContain('session saved');
  });

  it('never writes a bare carriage return, which would corrupt a log file', () => {
    const s = sink();
    const render = new TerminalRenderer({ output: s.stream, error: s.stream, env: {} });
    render.header(ENVIRONMENT, 'task');
    render.progress('turn 1');
    render.tool({ name: 'bash', args: { command: 'ls' }, output: 'a\nb', outcome: 'ok' });
    expect(s.text()).not.toContain('\r');
  });
});
