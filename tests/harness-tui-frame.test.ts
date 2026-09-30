/**
 * The TUI, driven through a real renderer.
 *
 * This is a bun test on purpose: `@opentui/core`'s renderer needs bun's native
 * FFI, so vitest cannot construct one. It is the only test in the suite that
 * proves the view actually draws — a typecheck cannot tell you that a
 * `ScrollBoxRenderable` was handed a bad option, and this can.
 *
 * Run with: `bun test tests/harness-tui-frame.test.ts`
 */

import { describe, expect, test } from 'bun:test';
import { createTestRenderer, type TestRendererSetup } from '@opentui/core/testing';
import type { ToolLoopEvent } from '../src/agent.js';
import { createHarnessTui } from '../harness/tui.js';
import { unifiedDiff } from '../harness/diff.js';
import type { RunEnvironment } from '../harness/ui/environment.js';

const ENVIRONMENT: RunEnvironment = {
  provider: 'vercel-ai-gateway',
  model: 'anthropic/claude-sonnet-4',
  target: 'vercel-ai-gateway/anthropic/claude-sonnet-4',
  configPath: 'C:/Users/dev/.modelhitch/config.json',
  playbook: 'feature',
  principles: 2,
  workspaceDir: 'C:/work/project',
  workspaceFacts: 'typescript (pnpm), 214 source files',
  sessionId: '20260601-143012-4f2a',
  maxTurns: 8,
  toolTimeoutMs: 120_000,
  approvals: 'prompt',
  snapshots: true,
  agents: 'subagents=on (bihan from @genoventures-labs/bihan; 4 agents from C:/agents)',
  resumed: false,
};

const DIFF = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' export { a, b };',
].join('\n');

function scripted(events: ToolLoopEvent[]): (prompt: string, options: { onApproval?: unknown }) => AsyncGenerator<ToolLoopEvent> {
  return async function* (): AsyncGenerator<ToolLoopEvent> {
    for (const event of events) yield event;
  };
}

/** A stream that asks for approval mid-run, the way `streamHarness` does. */
function scriptedWithApproval(events: ToolLoopEvent[]): (
  prompt: string,
  options: { onApproval?: (request: { tool: string; args: Record<string, unknown>; preview: string }) => Promise<boolean> },
) => AsyncGenerator<ToolLoopEvent> {
  return async function* (_prompt, options): AsyncGenerator<ToolLoopEvent> {
    const handler = options.onApproval;
    if (handler) await handler({ tool: 'write', args: { path: 'src/app.ts' }, preview: DIFF });
    for (const event of events) yield event;
  };
}

async function withSetup(
  run: (setup: TestRendererSetup) => Promise<void>,
  size: { width: number; height: number } = { width: 140, height: 40 },
  rendererOptions: { exitOnCtrlC?: boolean } = {},
): Promise<void> {
  const setup = await createTestRenderer({ ...size, ...rendererOptions });
  try {
    await run(setup);
  } finally {
    setup.renderer.destroy();
  }
}

describe('harness TUI', () => {
  test('paints the header, the transcript and a tool card', async () => {
    await withSetup(async (setup) => {
      const app = await createHarnessTui('fix the failing test', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: scripted([
          { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: 'Looking at the failing test.' } },
          {
            type: 'tool',
            turn: 1,
            call: { id: 'c1', name: 'read', arguments: { path: 'tests/app.test.ts' } },
            output: 'export const x = 1;',
          },
          {
            type: 'turn',
            turn: 1,
            result: {
              message: { role: 'assistant', content: 'Looking at the failing test.' },
              finishReason: 'tool-calls',
              usage: { totalTokens: 1_234 },
            },
          },
        ]) as never,
      });

      await setup.waitForFrame((frame) => frame.includes('src/app.ts') || frame.includes('fix the failing test'));
      const frame = await setup.waitForFrame((value) => value.includes('Read'));

      // The wordmark is ASCII art, so assert on the text beside it and on the
      // small-screen fallback rather than on the banner's glyphs.
      expect(frame).toContain('harness · playbook feature');
      expect(frame).toContain('fix the failing test');
      expect(frame).toContain('Transcript');
      expect(frame).toContain('Session');
      expect(frame).toContain('tests/app.test.ts');
      expect(frame).toContain('ask before writes');

      await app.finished;
      setup.renderer.keyInput.emit('keypress', { name: 'q', preventDefault() {} } as never);
      expect(await app.closed).toBe(0);
    });
  });

  test('renders a unified diff through the diff renderable and badges the outcome', async () => {
    await withSetup(async (setup) => {
      const app = await createHarnessTui('change b', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: scripted([
          {
            type: 'tool',
            turn: 1,
            call: { id: 'c1', name: 'bash', arguments: { command: 'git diff' } },
            output: DIFF,
          },
          {
            type: 'tool',
            turn: 1,
            call: { id: 'c2', name: 'read', arguments: { path: 'missing.ts' } },
            output: 'Error: ENOENT: no such file or directory',
          },
        ]) as never,
      });

      // A successful diff folds like any other card, so open it first — the
      // point of this case is that the diff view itself renders.
      await app.finished;
      setup.renderer.keyInput.emit('keypress', { name: 'e', shift: true, preventDefault() {} } as never);
      const frame = await setup.waitForFrame((value) => value.includes('const c = 4'));
      expect(frame).toContain('+const c = 4');
      expect(frame).toContain('-const b = 2;');
      expect(frame).toContain('error');
      expect(frame).toContain('missing.ts');

      app.quit(0);
    });
  });

  test('an approval blocks the run until a key answers it', async () => {
    await withSetup(async (setup) => {
      let approved: boolean | undefined;
      const stream = async function* (
        _prompt: string,
        options: { onApproval?: (request: { tool: string; args: Record<string, unknown>; preview: string }) => Promise<boolean> },
      ): AsyncGenerator<ToolLoopEvent> {
        approved = await options.onApproval?.({ tool: 'write', args: { path: 'src/app.ts' }, preview: DIFF });
        yield {
          type: 'done',
          turns: 1,
          messages: [],
          usage: { totalTokens: 10 },
          final: { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
        };
      };

      const app = await createHarnessTui('write a file', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: stream as never,
      });

      const frame = await setup.waitForFrame((value) => value.includes('Approve Write?'));
      expect(frame).toContain('y approve');
      expect(approved).toBeUndefined();

      setup.renderer.keyInput.emit('keypress', { name: 'y', preventDefault() {} } as never);
      const after = await setup.waitForFrame((value) => value.includes('approved'));
      expect(after).toContain('approved');
      expect(approved).toBe(true);

      await app.finished;
      app.quit(0);
    });
  });

  test('the command palette filters and runs a command', async () => {
    await withSetup(async (setup) => {
      const app = await createHarnessTui('do a thing', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: scripted([
          { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: 'ok' } },
        ]) as never,
      });
      await app.finished;

      setup.renderer.keyInput.emit('keypress', { name: 'p', ctrl: true, preventDefault() {} } as never);
      const opened = await setup.waitForFrame((value) => value.includes('Commands'));
      expect(opened).toContain('Undo last run');

      setup.renderer.keyInput.emit('keypress', { name: 'r', sequence: 'r', preventDefault() {} } as never);
      const filtered = await setup.waitForFrame((value) => value.includes('Toggle reasoning'));
      expect(filtered).toContain('Toggle reasoning');

      app.quit(0);
    });
  });

  test('q quits and resolves the closed promise exactly once', async () => {    await withSetup(async (setup) => {
      const app = await createHarnessTui('quit me', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: scripted([]) as never,
      });
      await app.finished;
      app.quit(0);
      app.quit(0);
      expect(await app.closed).toBe(0);
    });
  });

  test('truncates a large diff between hunks, never mid-hunk', async () => {
    await withSetup(async (setup) => {
      // A hundred separate changes, far enough apart to produce a hundred hunks:
      // more than the expanded budget, so the diff view has to drop some. Cutting
      // this like a log would corrupt a hunk header and the view would render
      // "Error parsing diff" instead of the change.
      const before = Array.from({ length: 1_200 }, (_, index) => `line ${index}`).join('\n');
      let after = before;
      for (let index = 5; index < 1_200; index += 12) {
        after = after.replace(`line ${index}\n`, `line ${index} changed\n`);
      }
      const long = unifiedDiff(before, after, { path: 'src/big.ts' });

      const app = await createHarnessTui('change a hundred lines', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: scripted([
          {
            type: 'tool',
            turn: 1,
            call: { id: 'c1', name: 'edit', arguments: { path: 'src/big.ts' } },
            output: long,
          },
        ]) as never,
      });

      const frame = await setup.waitForFrame((value) => value.includes('Edit'));
      expect(frame).not.toContain('Error parsing diff');
      // Folded, a diff shows its stat and its size rather than its hunks, and
      // gets no first-line preview: `--- a/path` says nothing the badge does not.
      expect(frame).toMatch(/\+\d+ -\d+/);
      expect(frame).toContain('lines');
      expect(frame).not.toContain('line 5 changed');

      // The property under test is that expanding a large diff still yields a
      // parseable diff rather than a parse error. The card is taller than the
      // pane, so its top is off-screen and only the absence of the error is
      // assertable from the viewport; the hunk count of a truncated window is
      // asserted directly in harness-format.test.ts, with no viewport in the way.
      await app.finished;
      setup.renderer.keyInput.emit('keypress', { name: 'e', shift: true, preventDefault() {} } as never);
      await setup.flush();
      const opened = setup.captureCharFrame();
      expect(opened).toContain('Transcript');
      expect(opened).not.toContain('Error parsing diff');

      app.quit(0);
    });
  });

  test('folds a successful card, opens a failed one, and folds on demand', async () => {
    await withSetup(async (setup) => {
      const app = await createHarnessTui('two calls', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: scripted([
          {
            type: 'tool',
            turn: 1,
            call: { id: 'c1', name: 'read', arguments: { path: 'src/ok.ts' } },
            output: 'const ok = true;\nconst hidden = "not visible while folded";',
          },
          {
            type: 'tool',
            turn: 1,
            call: { id: 'c2', name: 'bash', arguments: { command: 'npm test' } },
            output: 'Exit 1: Command failed\nboom: assertion failed',
          },
        ]) as never,
      });

      const frame = await setup.waitForFrame((value) => value.includes('Bash'));
      // The success is folded: its first line previews, its body does not show.
      expect(frame).toContain('const ok = true;');
      expect(frame).not.toContain('not visible while folded');
      // The failure opened itself, because the reason it broke is the point.
      expect(frame).toContain('boom: assertion failed');

      await app.finished;
      setup.renderer.keyInput.emit('keypress', { name: 'e', shift: true, preventDefault() {} } as never);
      const allOpen = await setup.waitForFrame((value) => value.includes('not visible while folded'));
      expect(allOpen).toContain('not visible while folded');

      setup.renderer.keyInput.emit('keypress', { name: 'c', shift: true, preventDefault() {} } as never);
      const allFolded = await setup.waitForFrame((value) => !value.includes('boom: assertion failed'));
      // Collapsing hides a failure's body too, but its outcome stays on screen.
      expect(allFolded).toContain('error');

      // With no cursor `t` acts on the newest card, and `[` steps backwards from
      // it, so two presses land on the first card.
      setup.renderer.keyInput.emit('keypress', { name: '[', preventDefault() {} } as never);
      setup.renderer.keyInput.emit('keypress', { name: '[', preventDefault() {} } as never);
      setup.renderer.keyInput.emit('keypress', { name: 't', preventDefault() {} } as never);
      const toggled = await setup.waitForFrame(
        (value) => value.includes('const ok = true;') && value.includes('not visible while folded'),
      );
      expect(toggled).toContain('not visible while folded');
      // The cursor is visible, so a keyboard user can see what `t` will act on.
      expect(toggled).toContain('▸');

      app.quit(0);
    });
  });

  test('keeps fold keys away from the approval prompt', async () => {
    await withSetup(async (setup) => {
      const stream = async function* (
        _prompt: string,
        options: { onApproval?: (request: { tool: string; args: Record<string, unknown>; preview: string }) => Promise<boolean> },
      ): AsyncGenerator<ToolLoopEvent> {
        await options.onApproval?.({ tool: 'write', args: { path: 'src/app.ts' }, preview: DIFF });
        yield {
          type: 'done',
          turns: 1,
          messages: [],
          usage: { totalTokens: 5 },
          final: { message: { role: 'assistant', content: 'done' }, finishReason: 'stop' },
        };
      };

      const app = await createHarnessTui('write a file', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: stream as never,
      });

      await setup.waitForFrame((value) => value.includes('Approve Write?'));
      // While a decision is pending the fold keys are inert, and so is everything
      // else except y / n / Esc — otherwise a stray `c` would fold the whole
      // transcript behind a modal nobody could dismiss.
      setup.renderer.keyInput.emit('keypress', { name: 'c', shift: true, preventDefault() {} } as never);
      setup.renderer.keyInput.emit('keypress', { name: 'e', shift: true, preventDefault() {} } as never);
      const stillWaiting = await setup.waitForFrame((value) => value.includes('Approve Write?'));
      expect(stillWaiting).toContain('y approve');

      setup.renderer.keyInput.emit('keypress', { name: 'y', preventDefault() {} } as never);
      await app.finished;
      app.quit(0);
    });
  });

  test('Ctrl+O forces every folded card open, and back', async () => {
    await withSetup(async (setup) => {
      const app = await createHarnessTui('many cards', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: scripted([
          {
            type: 'tool',
            turn: 1,
            call: { id: 'c1', name: 'read', arguments: { path: 'src/ok.ts' } },
            output: 'const ok = true;\nconst hidden = "deep inside";',
          },
        ]) as never,
      });
      await app.finished;

      // The card is folded by default; Ctrl+O (the docs' "force every tool
      // body open") must show the body without touching the fold state.
      setup.renderer.keyInput.emit('keypress', { name: 'o', ctrl: true, preventDefault() {} } as never);
      const open = await setup.waitForFrame((value) => value.includes('deep inside'));
      expect(open).toContain('deep inside');

      setup.renderer.keyInput.emit('keypress', { name: 'o', ctrl: true, preventDefault() {} } as never);
      const closed = await setup.waitForFrame((value) => value.includes('Read') && !value.includes('deep inside'));
      expect(closed).not.toContain('deep inside');

      app.quit(0);
    });
  });

  test('ctrl+c during a run stops it visibly and aborts the tool', async () => {
    await withSetup(async (setup) => {
      let aborted = 0;
      const stream = async function* (): AsyncGenerator<ToolLoopEvent> {
        yield { type: 'chunk', turn: 1, chunk: { type: 'tool-call-start', id: 'c1', name: 'bash' } } as ToolLoopEvent;
        // Park the stream: the run only ends when Ctrl-C cancels it.
        await new Promise<void>(() => undefined);
      };
      const app = await createHarnessTui('long run', {
        canceller: { activeTool: 'bash', abortActive: () => { aborted++; } },
      } as never, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: stream as never,
      });

      await setup.waitForFrame((value) => value.includes('Running'));
      setup.renderer.keyInput.emit('keypress', { name: 'c', ctrl: true, preventDefault() {} } as never);
      const stopped = await setup.waitForFrame((value) => value.includes('Stopped') && value.includes('Run cancelled'));
      expect(stopped).toContain('Stopped');
      expect(stopped).not.toContain('✔ Done');
      // The cancel path aborts the tool the run is parked on, the way quit does;
      // without it the tool keeps executing under a view that says stopped.
      expect(aborted).toBe(1);

      app.quit(0);
    }, { width: 140, height: 40 }, { exitOnCtrlC: false });
  });

  test('session mode: the interface asks for the task, and letters are not shortcuts', async () => {
    await withSetup(async (setup) => {
      const tasks: string[] = [];
      const stream = async function* (prompt: string): AsyncGenerator<ToolLoopEvent> {
        tasks.push(prompt);
        yield { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: `answered ${prompt}` } };
        yield {
          type: 'done',
          turns: 1,
          messages: [
            { role: 'system', content: 's' },
            { role: 'user', content: prompt },
            { role: 'assistant', content: `answered ${prompt}` },
          ],
          usage: { totalTokens: 10 },
          final: { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' },
        };
      };

      const app = await createHarnessTui('', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: stream as never,
        interactive: true,
      });

      // The interface is up and asking, with nothing run yet — and no plaintext
      // `Task:` prompt anywhere in this path, which is what made `--tui` look
      // like it had degraded into the plaintext view.
      const ready = await setup.waitForFrame((value) => value.includes('describe the task'));
      expect(ready).toContain('Waiting for a task');
      expect(ready).not.toContain('Task:');
      expect(tasks).toEqual([]);

      // `q` and `t` are letters while the input has focus. A global handler that
      // ate them would quit mid-word or fold a card instead of typing.
      await setup.mockInput.typeText('quiet');
      const typed = await setup.waitForFrame((value) => value.includes('quiet'));
      expect(typed).toContain('quiet');

      await setup.mockInput.pressEnter();
      const ran = await setup.waitForFrame((value) => value.includes('answered quiet'));
      expect(tasks).toEqual(['quiet']);
      expect(ran).toContain('answered quiet');

      app.quit(0);
    });
  });

  test('session mode continues from the previous run and lets the next task be typed', async () => {
    await withSetup(async (setup) => {
      const seen: Array<{ task: string; seeded: number }> = [];
      const stream = async function* (
        prompt: string,
        options: { initialMessages?: Array<{ role: string }> },
      ): AsyncGenerator<ToolLoopEvent> {
        seen.push({ task: prompt, seeded: options.initialMessages?.length ?? 0 });
        yield { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: `done: ${prompt}` } };
        yield {
          type: 'done',
          turns: 1,
          messages: [
            { role: 'system', content: 's' },
            { role: 'user', content: prompt },
            { role: 'assistant', content: `done: ${prompt}` },
          ],
          usage: { totalTokens: 5 },
          final: { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' },
        };
      };

      const app = await createHarnessTui('', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: stream as never,
        interactive: true,
      });

      await setup.mockInput.typeText('first task');
      await setup.mockInput.pressEnter();
      await setup.waitForFrame((value) => value.includes('done: first task'));
      await app.finished;

      // A session is not over because one run is: the status line offers the
      // next task rather than telling the reader to quit.
      const afterFirst = await setup.waitForFrame((value) => value.includes('press i for the next task'));
      expect(afterFirst).toContain('press i for the next task');

      // `i` takes the keyboard back, and the second task is a continuation: the
      // first run's messages seed it, exactly as --resume seeds a saved session.
      setup.renderer.keyInput.emit('keypress', { name: 'i', preventDefault() {} } as never);
      await setup.waitForFrame((value) => value.includes('describe the task'));
      await setup.mockInput.typeText('second task');
      await setup.mockInput.pressEnter();
      await setup.waitForFrame((value) => value.includes('done: second task'));

      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual({ task: 'first task', seeded: 0 });
      expect(seen[1]?.task).toBe('second task');
      expect(seen[1]?.seeded).toBe(3);

      app.quit(0);
    });
  });

  test('session mode: escape hands the keyboard back so the fold keys work', async () => {
    await withSetup(async (setup) => {
      const app = await createHarnessTui('', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: scripted([]) as never,
        interactive: true,
      });

      // While the input has focus, `q` is a letter and must not exit.
      await setup.mockInput.typeText('q');
      const typed = await setup.waitForFrame((value) => value.includes('q'));
      expect(typed).toContain('q');

      setup.renderer.keyInput.emit('keypress', { name: 'escape', preventDefault() {} } as never);
      // The status line states the mode, because the activity note is clipped to
      // the sidebar's width and cannot carry the instruction on its own.
      const blurred = await setup.waitForFrame((value) => value.includes('Session idle'));
      expect(blurred).toContain('Session idle');
      expect(blurred).toContain('press i to type the next task');

      // With the input blurred, `q` is a shortcut again.
      setup.renderer.keyInput.emit('keypress', { name: 'q', preventDefault() {} } as never);
      expect(await app.closed).toBe(0);
    });
  });

  test('drops the sidebar and the wordmark when the terminal is narrow', async () => {
    await withSetup(async (setup) => {
      const app = await createHarnessTui('narrow pane', {}, {
        createRenderer: async () => setup.renderer,
        environment: ENVIRONMENT,
        stream: scripted([
          { type: 'chunk', turn: 1, chunk: { type: 'text-delta', text: 'answer' } },
        ]) as never,
      });
      await app.finished;

      const wide = await setup.waitForFrame((value) => value.includes('Session'));
      expect(wide).toContain('Tools');

      setup.resize(80, 30);
      // The predicate has to require something from the new layout as well as
      // the absence of the old one: a frame captured mid-resize is blank, and
      // "does not contain Session" would happily match it.
      const narrow = await setup.waitForFrame(
        (value) => value.includes('MODELHITCH') && value.includes('Transcript') && !value.includes('Activity'),
      );
      // The fallback wordmark replaces the ASCII banner, and the transcript
      // keeps the whole width instead of wrapping into noise.
      expect(narrow).not.toContain('Session');

      app.quit(0);
    });
  });
});
