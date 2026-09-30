/**
 * The harness TUI.
 *
 * This is the interactive face of a run: one live transcript, a session
 * sidebar, a status line that always says what is happening, a modal gate for
 * mutating tool calls, and a keymap that can be discovered (`?`) rather than
 * guessed.
 *
 * Structure worth knowing before editing:
 *
 *   - `createHarnessTui` builds the view and returns an app handle; it does not
 *     drive the run to completion. `runHarnessTui` is the thin wrapper the CLI
 *     calls. Tests use the handle to drive a scripted event stream through the
 *     real renderables on a test renderer.
 *   - The event loop races each `next()` against the quit signal, so dismissing
 *     the view stops the run immediately instead of waiting for the provider to
 *     send one more token.
 *   - Text deltas bump a revision counter instead of redrawing: a Markdown
 *     renderable re-parses its whole body per assignment, and providers emit
 *     hundreds of deltas a second.
 */

import {
  ASCIIFontRenderable,
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  StyledText,
  SyntaxStyle,
  TextRenderable,
  bold,
  fg,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type TextChunk,
} from '@opentui/core';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { streamHarness, type HarnessOptions } from './index.js';
import type { ModelMessage, ToolLoopEvent } from '../src/index.js';
import { PALETTE, type PaletteKey } from './theme.js';
import { clip, formatClock, formatCount, formatDuration } from './format.js';
import { approvalLabel, describeEnvironment, type RunEnvironment } from './ui/environment.js';
import { mayAutoApprove } from './risk.js';
import { Transcript, type ToolBlock, type TranscriptBlock } from './ui/transcript.js';
import { createBlockView, plainChunk, transcriptDiffStat, type BlockContext, type BlockView } from './ui/blocks.js';
import { harnessStateDir } from './session.js';
import { latestRunId, readManifest, runIds, undoRun, summarizeUndo } from './snapshot.js';
import type { ApprovalHandler, ApprovalRequest } from './approval.js';

export interface TuiOptions {
  /** `--yes`: approve every mutating tool call without asking. */
  assumeYes?: boolean;
  /** Test seam: supply the renderer instead of creating one. */
  createRenderer?: (config: Record<string, unknown>) => Promise<CliRenderer>;
  /** Test seam: supply the event source instead of `streamHarness`. */
  stream?: (prompt: string, options: HarnessOptions) => AsyncGenerator<ToolLoopEvent>;
  /** Test seam: supply the run metadata instead of loading it from disk. */
  environment?: RunEnvironment;
  /** Test seam: clock. */
  now?: () => number;
  /**
   * `--tool-log <path>`: append every tool result, untruncated, as it arrives.
   * The view is a summary; this is the record.
   */
  toolLog?: string;
  /**
   * Session mode: the view starts empty and waits for a task typed into it,
   * and returns to the prompt after each run instead of exiting.
   *
   * This is the difference between a run viewer and a harness UI. The CLI turns
   * it on when no task was given on the command line, which is also what keeps a
   * plaintext `Task:` prompt from ever appearing before the interface does.
   */
  interactive?: boolean;
  /** Called after each run with the accumulated history, for a session. */
  onHistory?: (messages: ModelMessage[]) => void;
}

export interface HarnessTuiApp {
  readonly renderer: CliRenderer;
  readonly transcript: Transcript;
  /** Resolves with the exit code once the view is dismissed. */
  readonly closed: Promise<number>;
  /** Resolves when the run itself has ended (the view stays open). */
  readonly finished: Promise<void>;
  /** Dismiss the view. Idempotent. */
  quit(code?: number): void;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Below this width the sidebar is noise, so it hides. */
const SIDEBAR_MIN_WIDTH = 104;
const SIDEBAR_WIDTH = 38;
const FLUSH_MS = 60;

const chunk = (key: PaletteKey, text: string): TextChunk => fg(PALETTE[key])(text);
const joinRows = (rows: TextChunk[][]): TextChunk[] =>
  rows.flatMap((row, index) => (index === 0 ? row : [plainChunk('\n'), ...row]));

function box(renderer: CliRenderer, options: Record<string, unknown>, children: Renderable[] = []): BoxRenderable {
  const created = new BoxRenderable(renderer, {
    flexDirection: 'column',
    ...options,
  } as ConstructorParameters<typeof BoxRenderable>[1]);
  for (const child of children) created.add(child);
  return created;
}

interface Chrome {
  root: BoxRenderable;
  sidebar: BoxRenderable;
  session: TextRenderable;
  tools: TextRenderable;
  activity: TextRenderable;
  activityScroll: ScrollBoxRenderable;
  status: TextRenderable;
  statusRight: TextRenderable;
  keybar: TextRenderable;
  transcript: ScrollBoxRenderable;
  taskLine: TextRenderable;
  modal: BoxRenderable;
  modalTitle: TextRenderable;
  modalBody: TextRenderable;
  help: BoxRenderable;
  helpBody: TextRenderable;
  palette: BoxRenderable;
  paletteQuery: TextRenderable;
  paletteList: TextRenderable;
  wordmark: ASCIIFontRenderable;
  wordmarkSmall: TextRenderable;
  /** The task input, shown only in session mode while it has focus. */
  promptRow: BoxRenderable;
  prompt: InputRenderable;
}

interface ActivityEntry {
  at: string;
  text: string;
  tone: PaletteKey;
}

interface Command {
  id: string;
  label: string;
  hint: string;
  run(): void;
}

export async function createHarnessTui(
  prompt: string,
  options: HarnessOptions = {},
  tui: TuiOptions = {},
): Promise<HarnessTuiApp> {
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const now = tui.now ?? ((): number => Date.now());
  const sessionId = options.sessionId ?? '';

  const environment = tui.environment ?? (await describeEnvironment({
    prompt,
    options,
    sessionId,
    workspaceDir,
    assumeYes: tui.assumeYes === true,
  }));

  const renderer = tui.createRenderer
    ? await tui.createRenderer({})
    : await createRendererWithConfig();

  const syntax = SyntaxStyle.create();
  // A session resolving its playbook per typed task cannot print the CLI's
  // value in the header either: the sidebar drops the claim, so the header
  // must too.
  const chrome = buildChrome(renderer, environment, prompt, tui.interactive === true);
  const app = new TuiApp(renderer, syntax, chrome, environment, prompt, options, tui, workspaceDir, now);
  return app.start();
}

/** The real renderer, kept behind a function so the test seam stays honest. */
async function createRendererWithConfig(): Promise<CliRenderer> {
  const { createCliRenderer } = await import('@opentui/core');
  return await createCliRenderer({
    screenMode: 'alternate-screen',
    // Ctrl-C is handled as a key event instead: quitting through the renderer
    // would tear the view down without answering a pending approval, and the
    // CLI's own SIGINT banner would print on top of the alternate screen.
    exitOnCtrlC: false,
    consoleMode: 'disabled',
    backgroundColor: PALETTE.bg,
    targetFps: 30,
  });
}

class TuiApp implements HarnessTuiApp {
  readonly transcript = new Transcript();
  private readonly views = new Map<number, BlockView>();
  private readonly ctx: BlockContext;
  private readonly started = Date.now();
  private readonly deferredClosed = deferred<number>();
  private readonly deferredFinished = deferred<void>();
  private readonly deferredQuit = deferred<void>();
  private readonly activity: ActivityEntry[] = [];
  private readonly commands: Command[];
  private runTimer: ReturnType<typeof setInterval> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private settled = false;
  private follow = true;
  private turns = 0;
  private tokens = 0;
  private toolCount = 0;
  /** Per-run counter state; see `runTask`, which resets it. */
  private runTools = 0;
  private runAt = Date.now();
  private cancelledRun = false;
  private phase: 'idle' | 'running' | 'waiting' | 'done' | 'cancelled' | 'error' = 'running';
  private phaseDetail = 'starting';
  private spinnerFrame = 0;
  private pendingDecision: { resolve: (approved: boolean) => void } | null = null;
  private helpOpen = false;
  private paletteOpen = false;
  private paletteQuery = '';
  private paletteIndex = 0;
  private lastEventAt = Date.now();
  private pendingTool: string | undefined;
  private errorMessage: string | undefined;
  /** Which tool card the fold keys act on, by block id. */
  private focusedToolId: number | undefined;
  private toolLogWarned = false;
  /**
   * Session mode state.
   *
   * `history` is what makes a second task a continuation rather than a fresh
   * run: the loop's own `done` event carries the full message array, so the next
   * task is seeded with it exactly as `--resume` seeds a saved session.
   */
  private readonly interactive: boolean;
  private history: ModelMessage[] | undefined;
  private running = false;
  private promptFocused = false;
  private deferredCancel = deferred<void>();

  readonly closed: Promise<number>;
  readonly finished: Promise<void>;

  constructor(
    readonly renderer: CliRenderer,
    private readonly syntax: SyntaxStyle,
    private readonly chrome: Chrome,
    private readonly environment: RunEnvironment,
    private readonly prompt: string,
    private readonly options: HarnessOptions,
    private readonly tui: TuiOptions,
    private readonly workspaceDir: string,
    private readonly now: () => number,
  ) {
    this.ctx = {
      renderer,
      syntax,
      workspaceDir,
      verbose: false,
      showReasoning: false,
    };
    this.closed = this.deferredClosed.promise;
    this.finished = this.deferredFinished.promise;
    this.commands = this.buildCommands();
    this.interactive = tui.interactive === true;
  }

  /* ---------------------------------------------------------------- *
   * Lifetime
   * ---------------------------------------------------------------- */

  start(): HarnessTuiApp {
    this.renderer.setTerminalTitle('ModelHitch harness');
    this.renderer.keyInput.on('keypress', (key: KeyEvent) => this.onKey(key));
    this.renderer.on('resize', () => this.layoutForWidth());
    // The first paint has no resize event behind it, so the width-based chrome
    // decisions (sidebar, wordmark) have to be applied once here: a run started
    // at 80 columns drew a 38-column sidebar and the wide wordmark it could
    // never fit until the terminal happened to be resized.
    this.layoutForWidth();
    this.transcript.subscribe({
      added: (block) => this.addBlock(block),
      updated: (block) => this.views.get(block.id)?.update(block),
    });

    // Enter submits, so the input needs no separate key to learn. Handled here
    // rather than in onKey because the input owns the keypress while focused.
    this.chrome.prompt.on('enter', () => this.submitTask());

    this.transcript.addNotice(
      'info',
      this.interactive ? 'Session ready' : 'Starting run',
      `${this.environment.target} · ${this.environment.workspaceDir}`,
    );
    this.pushActivity(`session ${this.environment.sessionId}`, 'faint');
    this.renderSidebar();

    this.runTimer = setInterval(() => {
      if (this.phase === 'running' || this.phase === 'waiting') {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
        this.renderStatus();
      }
    }, 120);

    if (this.prompt === '') {
      // Launched with nothing to do: the interface is up, so ask here.
      this.focusPrompt();
    } else {
      void this.runTask(this.prompt);
    }
    return this;
  }

  quit(code = 0): void {
    if (this.settled) return;
    this.settled = true;
    this.deferredQuit.resolve();
    this.pendingDecision?.resolve(false);
    this.pendingDecision = null;
    if (this.runTimer !== undefined) clearInterval(this.runTimer);
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.options.canceller?.abortActive();
    try {
      this.syntax.destroy();
    } catch {
      /* the renderer teardown owns the rest */
    }
    try {
      this.renderer.destroy();
    } catch {
      /* already gone */
    }
    this.deferredClosed.resolve(code);
    this.deferredFinished.resolve();
  }

  /* ---------------------------------------------------------------- *
   * The run
   * ---------------------------------------------------------------- */

  /**
   * Run one task.
   *
   * Called once per submitted task. In session mode the accumulated history
   * seeds the next run, which is what makes a follow-up a continuation instead
   * of a fresh start.
   */
  private async runTask(task: string): Promise<void> {
    const source = this.tui.stream ?? streamHarness;
    const onApproval: ApprovalHandler = this.options.onApproval ?? ((request) => this.askApproval(request));
    const options: HarnessOptions = {
      ...this.options,
      onApproval,
      ...(this.history !== undefined ? { initialMessages: this.history } : {}),
    };
    this.running = true;
    this.transcript.addUser(task);
    this.follow = true;
    this.scrollToBottom();
    // A fresh cancel signal per task: a cancelled run must not poison the next.
    this.deferredCancel = deferred<void>();
    // Per-run state, reset here rather than at the view: a session's second
    // task would otherwise stream under the previous run's status ("turn 5/8",
    // an old error line) and its "Run complete" summary would count the first
    // task's tokens again.
    this.cancelledRun = false;
    this.turns = 0;
    this.tokens = 0;
    this.runTools = 0;
    this.errorMessage = undefined;
    this.runAt = this.now();
    this.updateTaskLine(task);
    this.setPhase('running', 'starting');

    const iterator = source(task, options)[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = iterator.next();
        const raced = await Promise.race([
          next.then((result) => ({ kind: 'event' as const, result })),
          this.deferredQuit.promise.then(() => ({ kind: 'quit' as const })),
          this.deferredCancel.promise.then(() => ({ kind: 'cancel' as const })),
        ]);
        if (raced.kind !== 'event') {
          // The provider may still be mid-stream; closing the generator runs its
          // finally blocks rather than leaving the request parked forever.
          void next.catch(() => undefined);
          void iterator.return?.(undefined).catch(() => undefined);
          if (raced.kind === 'cancel') {
            this.cancelledRun = true;
            this.transcript.addNotice('warn', 'Run cancelled', 'The transcript above is what happened before you stopped it.');
            this.pushActivity('run cancelled', 'warn');
          }
          break;
        }
        if (raced.result.done === true) break;
        this.handleEvent(raced.result.value);
      }
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.running = false;
      this.onRunEnd();
    }
  }

  /** Put the task input on screen and give it the keyboard. */
  private focusPrompt(): void {
    this.promptFocused = true;
    this.chrome.promptRow.visible = true;
    this.chrome.prompt.focus();
    this.setPhase('idle', 'waiting for a task');
    this.renderStatus();
  }

  /** Take the keyboard back for scrolling and folding. */
  private blurPrompt(): void {
    this.promptFocused = false;
    this.chrome.prompt.blur();
    this.chrome.promptRow.visible = false;
    this.renderStatus();
  }

  private submitTask(): void {
    const task = this.chrome.prompt.value.trim();
    if (task === '') return;
    this.chrome.prompt.value = '';
    this.blurPrompt();
    void this.runTask(task);
  }

  private handleEvent(event: ToolLoopEvent): void {
    switch (event.type) {
      case 'chunk': {
        const c = event.chunk;
        if (c.type === 'text-delta') {
          this.transcript.appendText(c.text, event.turn);
          this.scheduleFlush();
        } else if (c.type === 'reasoning-delta') {
          this.transcript.appendReasoning(c.text, event.turn);
          this.scheduleFlush();
        } else if (c.type === 'tool-call-start') {
          this.pendingTool = c.name;
          this.lastEventAt = this.now();
          this.pushActivity(`→ ${c.name}`, 'info');
          this.setPhase('running', `calling ${c.name}`);
        }
        return;
      }
      case 'turn': {
        this.turns = event.turn;
        this.tokens += event.result.usage?.totalTokens ?? 0;
        this.flush();
        this.transcript.endTurn(event.turn);
        this.pushActivity(`turn ${event.turn} answered`, 'ok');
        this.setPhase('running', `turn ${event.turn} complete`);
        return;
      }
      case 'tool': {
        const at = this.now();
        const durationMs = Math.max(0, at - this.lastEventAt);
        this.lastEventAt = at;
        this.flush();
        this.pendingTool = undefined;
        const block = this.transcript.addTool({
          turn: event.turn,
          name: event.call.name,
          args: event.call.arguments,
          output: event.output,
          durationMs,
        });
        this.toolCount++;
        this.runTools++;
        this.appendToolLog(event.call.name, event.output, block.outcome);
        const tone: PaletteKey = block.outcome === 'ok' ? 'ok' : block.outcome === 'declined' ? 'warn' : 'error';
        this.pushActivity(`${event.call.name} ${block.outcome} · ${formatDuration(durationMs)}`, tone);
        this.setPhase('running', `${event.call.name} ${block.outcome === 'ok' ? 'finished' : block.outcome}`);
        this.renderSidebar();
        return;
      }
      case 'done': {
        this.turns = event.turns;
        this.tokens = event.usage.totalTokens ?? this.tokens;
        this.flush();
        this.transcript.endTurn(event.turns);
        // The loop's own history, which is what a follow-up task continues from.
        this.history = event.messages;
        this.tui.onHistory?.(event.messages);
        const diff = transcriptDiffStat(this.transcript.toolBlocks);
        this.transcript.addNotice(
          'ok',
          `Run complete in ${formatDuration(this.now() - this.runAt)}`,
          `${event.turns} turns · ${formatCount(this.tokens)} tokens · ${this.runTools} tool call${this.runTools === 1 ? '' : 's'}${diff === '' ? '' : ` · ${diff}`}`,
        );
        this.pushActivity('run complete', 'ok');
        this.setPhase('done', 'complete');
        return;
      }
    }
  }

  private onRunEnd(): void {
    // Any delta still waiting on the flush timer belongs on screen before the
    // run is declared finished, otherwise a fast run can end with its last
    // paragraph missing.
    this.flush();
   
    if (this.phase !== 'error') {
      // The view outlives the run on purpose: a finished run is still worth
      // reading, copying, or undoing. A cancelled one says so instead of
      // masquerading as a success behind a green bar.
      if (this.cancelledRun) { this.setPhase('cancelled', 'stopped before it finished'); }
      else if (this.phase !== 'done') this.setPhase('done', 'stream ended');
    }
    if (this.runTimer !== undefined && !this.interactive) {
      // A session keeps its spinner: another task may start at any moment, and
      // restarting the interval per task is more state to get wrong than
      // leaving one timer alive for the life of the view.
      clearInterval(this.runTimer);
      this.runTimer = undefined;
    }
    if (this.interactive && this.phase === 'done') {
      // A session is not over because one run is. Say how to continue rather
      // than telling the reader to quit, which is what a one-shot run wants.
      this.setPhase('done', 'press i for the next task');
    }
    this.renderStatus();
    this.renderSidebar();
   
    this.deferredFinished.resolve();
  }

  private fail(message: string): void {
    this.errorMessage = message;
    this.transcript.addNotice('error', 'Run failed', message);
    this.pushActivity(`error: ${clip(message, 90)}`, 'error');
    this.setPhase('error', clip(message, 60));
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const active = this.transcript.last;
    if (active === undefined) return;
    this.views.get(active.id)?.update(active);
  }

  private addBlock(block: TranscriptBlock): void {
    const view = createBlockView(block, this.ctx);
    view.view.id = `blk-${block.id}`;
    view.update(block);
    this.views.set(block.id, view);
    this.chrome.transcript.add(view.view);
    if (this.follow) this.scrollToBottom();
  }

  private scrollToBottom(): void {
    const last = this.transcript.last;
    if (last === undefined) return;
    try {
      this.chrome.transcript.scrollChildIntoView(`blk-${last.id}`);
    } catch {
      /* a layout pass may not have run yet; the next event retries */
    }
  }

  private setPhase(phase: typeof this.phase, detail: string): void {
    this.phase = phase;
    this.phaseDetail = detail;
    this.renderStatus();
  }

  private renderStatus(): void {
    const elapsed = this.now() - this.runAt;
    const left: TextChunk[] = [];
    if (this.phase === 'running') {
      left.push(chunk('accent', `${SPINNER[this.spinnerFrame] ?? '⠋'} Running`));
      left.push(chunk('faint', `  turn ${Math.max(1, this.turns)}/${this.environment.maxTurns}`));
      left.push(chunk('faint', `  ${formatClock(elapsed)}`));
      left.push(chunk('info', `  ${formatCount(this.tokens)} tokens`));
      if (this.phaseDetail !== '') left.push(chunk('muted', `  ${clip(this.phaseDetail, 46)}`));
      left.push(chunk('faint', '  ctrl+c stops this run'));
    } else if (this.phase === 'idle') {
      // Two different idle states, and telling them apart matters: with the
      // input hidden, "type it above" is advice about a row that is not there.
      if (this.promptFocused) {
        left.push(chunk('accent', '› Waiting for a task'));
        left.push(chunk('faint', '  type it above and press enter'));
        left.push(chunk('faint', '  · esc returns to the transcript'));
      } else {
        left.push(chunk('accent', '› Session idle'));
        left.push(chunk('muted', '  press i to type the next task'));
      }
    } else if (this.phase === 'waiting') {
      left.push(chunk('warn', `${SPINNER[this.spinnerFrame] ?? '⠋'} Waiting for you`));
      left.push(chunk('muted', `  ${this.phaseDetail}`));
    } else if (this.phase === 'done') {
      left.push(chunk('ok', '✔ Done'));
      left.push(chunk('faint', `  ${this.turns} turn${this.turns === 1 ? '' : 's'}`));
      left.push(chunk('faint', `  ${formatCount(this.tokens)} tokens`));
      left.push(chunk('faint', `  ${formatClock(elapsed)}`));
      left.push(
        chunk('muted', this.interactive ? '  press i for the next task · q to exit' : '  press q to exit'),
      );
    } else if (this.phase === 'cancelled') {
      left.push(chunk('warn', '◼ Stopped'));
      if (this.phaseDetail !== '') left.push(chunk('muted', `  ${clip(this.phaseDetail, 60)}`));
      left.push(chunk('faint', `  ${formatClock(elapsed)}`));
      if (this.interactive) left.push(chunk('muted', '  press i for the next task · q to exit'));
      else left.push(chunk('muted', '  press q to exit'));
    } else {
      left.push(chunk('error', '✖ Failed'));
      left.push(chunk('muted', `  ${this.errorMessage ?? 'see the transcript'}`));
      if (this.interactive) left.push(chunk('faint', '  · i for the next task'));
    }
    this.chrome.status.content = new StyledText(left);

    const diff = transcriptDiffStat(this.transcript.toolBlocks);
    const right: TextChunk[] = [
      chunk('faint', `session ${this.environment.sessionId || '—'}`),
      chunk('faint', `  · ${this.toolCount} tool${this.toolCount === 1 ? '' : 's'}`),
    ];
    if (diff !== '') right.push(chunk('added', `  · ${diff}`));
    this.chrome.statusRight.content = new StyledText(right);
  }

  private renderSidebar(): void {
    const width = SIDEBAR_WIDTH - 4;
    const env = this.environment;
    // In a session each task picks its own playbook from its own text, so the
    // one the CLI resolved from an empty prompt would be a claim about a run
    // that has not happened. Say what is actually true instead.
    const playbook = this.interactive
      ? this.history === undefined
        ? 'per task'
        : 'resumed'
      : env.playbook + (env.principles > 0 ? ` +${env.principles}p` : '');
    this.chrome.session.content = new StyledText(joinRows([
      [chunk('faint', 'model    '), chunk('info', clip(env.model, width - 9))],
      [chunk('faint', 'provider '), chunk('text', clip(env.provider, width - 9))],
      [chunk('faint', 'playbook '), chunk('accent', clip(playbook, width - 9))],
      [chunk('faint', 'workdir  '), chunk('muted', clip(env.workspaceDir.replace(/\\/g, '/'), width - 9))],
      // The same one-liner the plaintext header prints, clipped to the panel
      // like every other row: the sidebar is 38 columns whatever the facts say.
      [chunk('faint', 'detected '), chunk('muted', clip(env.workspaceFacts, width - 9))],
      [chunk('faint', 'writes   '), chunk(env.approvals === 'auto' ? 'warn' : 'ok', clip(approvalLabel(env.approvals), width - 9))],
      [chunk('faint', 'undo     '), chunk(env.snapshots ? 'ok' : 'faint', env.snapshots ? 'snapshots on' : 'snapshots off')],
      [chunk('faint', 'limit    '), chunk('muted', `${env.maxTurns} turns · ${env.toolTimeoutMs === 0 ? 'no' : formatDuration(env.toolTimeoutMs)} per tool`)],
      [chunk('faint', 'agents   '), chunk('agent', clip(env.agents.replace(/^subagents=/, ''), width - 9))],
    ]));

    const histogram = this.transcript.toolHistogram().slice(0, 7);
    if (histogram.length === 0) {
      this.chrome.tools.content = new StyledText([chunk('faint', 'no tool calls yet')]);
    } else {
      const peak = histogram[0]?.count ?? 1;
      this.chrome.tools.content = new StyledText(joinRows(histogram.map((entry) => {
        const bar = '▇'.repeat(Math.max(1, Math.round((entry.count / peak) * 6)));
        const tone: PaletteKey = entry.failures > 0 ? 'warn' : 'agent';
        return [
          chunk('text', clip(entry.name, 13).padEnd(14)),
          chunk(tone, bar),
          chunk('faint', ` ${entry.count}`),
          ...(entry.failures > 0 ? [chunk('error', ` (${entry.failures} failed)`)] : []),
        ];
      })));
    }
  }

  /**
   * `--tool-log`: the untruncated record.
   *
   * The view folds successful calls to one line and caps what it keeps, which
   * is right on screen and wrong in a file someone is grepping later. This
   * writes the body as the model received it, before either of those.
   */
  private appendToolLog(name: string, output: string, outcome: string): void {
    const path = this.tui.toolLog;
    if (path === undefined) return;
    try {
      appendFileSync(
        path,
        `\n=== ${name} [${outcome}] ${new Date().toISOString()} ===\n${output}\n`,
        'utf8',
      );
    } catch (err) {
      // A log that cannot be written must not take the run with it; say so once.
      if (!this.toolLogWarned) {
        this.toolLogWarned = true;
        this.transcript.addNotice(
          'warn',
          `Could not write --tool-log ${path}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private pushActivity(text: string, tone: PaletteKey): void {
    const at = formatClock(this.now() - this.started);
    this.activity.push({ at, text, tone });
    if (this.activity.length > 200) this.activity.splice(0, this.activity.length - 200);
    const visible = this.activity.slice(-40);
    this.chrome.activity.content = new StyledText(joinRows(visible.map((entry) => [
      chunk('faint', `${entry.at} `),
      chunk(entry.tone, entry.text),
    ])));
    try {
      this.chrome.activityScroll.scrollTo({ x: 0, y: 1_000_000 });
    } catch {
      /* not laid out yet */
    }
  }

  private layoutForWidth(): void {
    const width = this.renderer.width;
    this.chrome.sidebar.visible = width >= SIDEBAR_MIN_WIDTH;
    this.chrome.wordmark.visible = width >= 96;
    this.chrome.wordmarkSmall.visible = width < 96;
    this.renderStatus();
  }

  /**
   * The header's task line tracks the task the session is actually running.
   * In session mode the header starts without one, and each submitted task
   * replaces it — a header that still shows `task: ` under a run that is
   * obviously running its text above is one nobody re-reads.
   */
  private updateTaskLine(task: string): void {
    this.chrome.taskLine.content = new StyledText([
      chunk('muted', `task: ${clip(task.replace(/\s+/g, ' '), 160)}`),
    ]);
  }

  /* ---------------------------------------------------------------- *
   * Decisions: approvals and confirmations
   * ---------------------------------------------------------------- */

  private async askApproval(request: ApprovalRequest): Promise<boolean> {
    if (this.tui.assumeYes === true) return true;
    // `--auto-approve-safe` is the one path where nobody looks, so it is stated
    // on the record rather than passed over silently.
    if (mayAutoApprove(request.risk)) {
      this.transcript.addNotice(
        'warn',
        `Auto-approved ${request.tool}`,
        `risk: safe — ${request.risk?.reason ?? ''}`,
      );
      this.pushActivity(`auto-approved ${request.tool} (safe)`, 'warn');
      return true;
    }
    const block = this.transcript.addApproval(request.tool, request.preview, request.risk);
    this.follow = true;
    this.scrollToBottom();
    this.setPhase('waiting', `${request.tool} needs approval`);
    this.pushActivity(
      `approval requested: ${request.tool}${request.risk ? ` (${request.risk.level})` : ''}`,
      'warn',
    );
    const approved = await this.decide({
      title: `Approve ${request.tool}?`,
      body: 'The change is shown in the transcript. y approve · n decline · esc decline',
    });
    this.transcript.decideApproval(block.id, approved ? 'approved' : 'declined');
    this.pushActivity(`${request.tool} ${approved ? 'approved' : 'declined'}`, approved ? 'ok' : 'warn');
    this.setPhase('running', approved ? `${request.tool} approved` : `${request.tool} declined`);
    return approved;
  }

  private decide(input: { title: string; body: string }): Promise<boolean> {
    this.chrome.modalTitle.content = new StyledText([bold(chunk('accent', input.title))]);
    this.chrome.modalBody.content = new StyledText([chunk('muted', input.body)]);
    this.chrome.modal.visible = true;
    return new Promise<boolean>((resolve) => {
      this.pendingDecision = { resolve };
    });
  }

  private resolveDecision(approved: boolean): void {
    const pending = this.pendingDecision;
    this.pendingDecision = null;
    this.chrome.modal.visible = false;
    pending?.resolve(approved);
  }

  private askUndo(): void {
    const id = runIds().includes(this.environment.sessionId)
      ? this.environment.sessionId
      : latestRunId() ?? undefined;
    if (id === undefined || id === null) {
      this.transcript.addNotice('warn', 'Nothing to undo', 'No run snapshot was recorded for this workspace.');
      return;
    }
    let summary = 'the recorded snapshot';
    try {
      const manifest = readManifest(id);
      const restore = manifest.entries.filter((entry) => entry.existed).length;
      const remove = manifest.entries.length - restore;
      summary = `${restore} file(s) restored, ${remove} created file(s) removed`;
      if (manifest.notes.length > 0) summary += ` · ${manifest.notes.length} caveat(s) recorded`;
    } catch (err) {
      this.transcript.addNotice('error', 'Undo unavailable', err instanceof Error ? err.message : String(err));
      return;
    }
    const previousPhase = this.phase;
    this.phase = 'waiting';
    this.phaseDetail = 'confirm undo';
    this.renderStatus();
    void this.decide({ title: `Undo run ${id}?`, body: `${summary}. y undo · n cancel` }).then((approved) => {
      this.phase = previousPhase;
      if (!approved) {
        this.pushActivity('undo cancelled', 'faint');
        this.renderStatus();
        return;
      }
      try {
        const result = undoRun(id);
        this.transcript.addNotice('ok', 'Undo complete', summarizeUndo(result).join('\n'));
        this.pushActivity(`undo ${id}`, 'ok');
      } catch (err) {
        this.transcript.addNotice('error', 'Undo failed', err instanceof Error ? err.message : String(err));
      }
      this.renderStatus();
    });
  }

  /* ---------------------------------------------------------------- *
   * Commands and keys
   * ---------------------------------------------------------------- */

  private buildCommands(): Command[] {
    return [
      { id: 'undo', label: 'Undo last run', hint: 'restore files this run changed', run: () => this.askUndo() },
      { id: 'copy', label: 'Copy transcript', hint: 'OSC 52 clipboard', run: () => this.copyTranscript() },
      { id: 'save', label: 'Save transcript', hint: 'write a markdown file', run: () => this.saveTranscript() },
      { id: 'output', label: 'Toggle full tool output', hint: 'expand every result', run: () => this.toggleVerbose() },
      { id: 'reasoning', label: 'Toggle reasoning', hint: 'show model thinking', run: () => this.toggleReasoning() },
      { id: 'sidebar', label: 'Toggle sidebar', hint: 'session and tool panels', run: () => this.toggleSidebar() },
      { id: 'top', label: 'Jump to start', hint: 'stop following', run: () => this.jump('top') },
      { id: 'bottom', label: 'Follow the run', hint: 'jump to the end', run: () => this.jump('bottom') },
      { id: 'help', label: 'Keyboard help', hint: '?', run: () => this.toggleHelp() },
      { id: 'quit', label: 'Quit', hint: 'q', run: () => this.quit(0) },
    ];
  }

  private toggleVerbose(): void {
    this.ctx.verbose = !this.ctx.verbose;
    for (const block of this.transcript.blocks) this.views.get(block.id)?.update(block);
    this.pushActivity(`tool output ${this.ctx.verbose ? 'expanded' : 'collapsed'}`, 'faint');
  }

  /* ---------------------------------------------------------------- *
   * Folding tool cards
   * ---------------------------------------------------------------- */

  /**
   * Move the card cursor. Wraps, so `[` from the first card lands on the last:
   * a run with forty cards should not require forty presses to get back.
   */
  private moveCardFocus(delta: number): void {
    const cards = this.transcript.toolBlocks;
    if (cards.length === 0) {
      this.pushActivity('no tool cards to fold', 'faint');
      return;
    }
    const current = cards.findIndex((card) => card.id === this.focusedToolId);
    const next = current === -1
      ? delta > 0
        ? 0
        : cards.length - 1
      : (current + delta + cards.length) % cards.length;
    const card = cards[next] as (typeof cards)[number];
    const previous = this.focusedToolId;
    this.focusedToolId = card.id;
    this.ctx.focusedToolId = card.id;
    if (previous !== undefined) this.rerender(previous);
    this.rerender(card.id);
    try {
      this.chrome.transcript.scrollChildIntoView(`blk-${card.id}`);
    } catch {
      /* not laid out yet; the next move retries */
    }
    this.pushActivity(`card ${next + 1}/${cards.length}: ${card.name}`, 'faint');
  }

  private rerender(id: number): void {
    const block = this.transcript.blocks.find((candidate) => candidate.id === id);
    if (block !== undefined) this.views.get(id)?.update(block);
  }

  private toggleFocusedCard(): void {
    const card = this.focusedCard();
    if (card === undefined) {
      this.pushActivity('press [ or ] to pick a tool card first', 'faint');
      return;
    }
    this.transcript.setExpanded(card.id, !card.expanded);
    this.pushActivity(`${card.name} ${card.expanded ? 'expanded' : 'collapsed'}`, 'faint');
  }

  private setAllCards(expanded: boolean): void {
    const changed = this.transcript.setAllExpanded(expanded);
    this.pushActivity(
      changed === 0
        ? `all cards already ${expanded ? 'expanded' : 'collapsed'}`
        : `${changed} card${changed === 1 ? '' : 's'} ${expanded ? 'expanded' : 'collapsed'}`,
      'faint',
    );
  }

  private focusedCard(): ToolBlock | undefined {
    const cards = this.transcript.toolBlocks;
    // With no cursor, the newest card is the one a reader means: it is the one
    // that just appeared.
    return cards.find((card) => card.id === this.focusedToolId) ?? cards[cards.length - 1];
  }

  /**
   * Write the focused card's whole body to stdout.
   *
   * The alternate screen owns the terminal, so the renderer has to hand it back
   * for the duration: writing into a live alternate screen corrupts the frame
   * and the reader loses both the text and the view. Suspend, write, resume.
   */
  private dumpFocusedCard(): void {
    const card = this.focusedCard();
    if (card === undefined) {
      this.pushActivity('no tool card to print', 'faint');
      return;
    }
    const header = `--- ${card.name} [${card.outcome}] ${card.output.length + card.omittedBytes} bytes ---`;
    const note =
      card.omittedBytes > 0
        ? `\n[the view kept all but ${card.omittedBytes} bytes; --tool-log has the untruncated body]`
        : '';
    try {
      this.renderer.suspend();
      process.stdout.write(`\n${header}\n${card.output}\n${note}\n`);
      this.renderer.resume();
    } catch (err) {
      try {
        this.renderer.resume();
      } catch {
        /* already resumed, or never suspended */
      }
      this.transcript.addNotice('warn', 'Could not print the card', err instanceof Error ? err.message : String(err));
    }
  }

  private toggleReasoning(): void {
    this.ctx.showReasoning = !this.ctx.showReasoning;
    for (const block of this.transcript.blocks) this.views.get(block.id)?.update(block);
    this.pushActivity(`reasoning ${this.ctx.showReasoning ? 'shown' : 'hidden'}`, 'faint');
  }

  private toggleSidebar(): void {
    this.chrome.sidebar.visible = !this.chrome.sidebar.visible;
    this.pushActivity(`sidebar ${this.chrome.sidebar.visible ? 'shown' : 'hidden'}`, 'faint');
  }

  private jump(where: 'top' | 'bottom'): void {
    this.follow = where === 'bottom';
    try {
      if (where === 'top') this.chrome.transcript.scrollTo({ x: 0, y: 0 });
      else this.chrome.transcript.scrollTo({ x: 0, y: 1_000_000 });
    } catch {
      /* not laid out yet */
    }
  }

  private copyTranscript(): void {
    const text = this.transcript.toMarkdown({ reasoning: this.ctx.showReasoning });
    if (!this.renderer.isOsc52Supported()) {
      this.transcript.addNotice('warn', 'Clipboard unavailable', 'This terminal does not support OSC 52; use Ctrl+S to save a file instead.');
      return;
    }
    const ok = this.renderer.copyToClipboardOSC52(text);
    this.transcript.addNotice(
      ok ? 'ok' : 'error',
      ok ? 'Transcript copied' : 'Copy failed',
      `${text.length} chars${ok ? '' : ' — the terminal rejected the OSC 52 sequence'}`,
    );
    this.pushActivity('transcript copied to clipboard', ok ? 'ok' : 'error');
  }

  private saveTranscript(): void {
    try {
      const dir = join(harnessStateDir(), 'transcripts');
      mkdirSync(dir, { recursive: true });
      const name = this.environment.sessionId === '' ? `run-${this.started}` : this.environment.sessionId;
      const path = join(dir, `${name}.md`);
      writeFileSync(path, this.transcript.toMarkdown({ reasoning: this.ctx.showReasoning }), 'utf8');
      this.transcript.addNotice('ok', 'Transcript saved', path);
      this.pushActivity('transcript saved to disk', 'ok');
    } catch (err) {
      this.transcript.addNotice('error', 'Could not save transcript', err instanceof Error ? err.message : String(err));
    }
  }

  private toggleHelp(): void {
    this.helpOpen = !this.helpOpen;
    this.chrome.help.visible = this.helpOpen;
  }

  private openPalette(): void {
    this.paletteOpen = true;
    this.paletteQuery = '';
    this.paletteIndex = 0;
    this.chrome.palette.visible = true;
    this.renderPalette();
  }

  private closePalette(): void {
    this.paletteOpen = false;
    this.chrome.palette.visible = false;
  }

  private filteredCommands(): Command[] {
    const query = this.paletteQuery.trim().toLowerCase();
    if (query === '') return this.commands;
    return this.commands.filter((command) => `${command.label} ${command.hint}`.toLowerCase().includes(query));
  }

  private renderPalette(): void {
    const matches = this.filteredCommands();
    if (matches.length > 0) this.paletteIndex = Math.min(this.paletteIndex, matches.length - 1);
    this.chrome.paletteQuery.content = new StyledText([
      chunk('accent', '› '),
      chunk('text', this.paletteQuery),
      chunk('faint', '▌'),
    ]);
    const rows = matches.map((command, index) => {
      const selected = index === this.paletteIndex;
      const label = selected ? bold(chunk('text', command.label)) : chunk('muted', command.label);
      return [chunk('accent', selected ? '▌ ' : '  '), label, chunk('faint', `  ${command.hint}`)];
    });
    this.chrome.paletteList.content = new StyledText(
      matches.length === 0 ? [chunk('faint', 'no matching command')] : joinRows(rows),
    );
  }

  private onKey(key: KeyEvent): void {
    const name = key.name ?? '';

    /*
     * While the task input has focus it owns every ordinary key.
     *
     * Without this the fold and scroll shortcuts would eat the letters people
     * type into a task — `q` would quit mid-sentence and `t` would fold a card.
     * Only the modifier combinations the input cannot use are handled here.
     */
    if (this.promptFocused) {
      if (key.ctrl && name === 'c') {
        key.preventDefault();
        this.quit(130);
        return;
      }
      if (name === 'escape') {
        key.preventDefault();
        // Hand the keyboard back so the transcript can be scrolled and folded.
        this.blurPrompt();
        this.pushActivity('transcript keys active — press i to type again', 'faint');
        return;
      }
      if (key.ctrl && name === 'p') {
        key.preventDefault();
        this.openPalette();
        return;
      }
      if (key.ctrl && name === 'b') {
        key.preventDefault();
        this.toggleSidebar();
        return;
      }
      if (name === 'f1') {
        key.preventDefault();
        this.toggleHelp();
        return;
      }
      // Enter is handled by the input's own `enter` event.
      return;
    }

    if (this.paletteOpen) {
      key.preventDefault();
      this.paletteKey(key, name);
      return;
    }
    if (this.helpOpen) {
      key.preventDefault();
      if (name === 'escape' || name === 'q' || name === '?') this.toggleHelp();
      return;
    }
    if (this.pendingDecision !== null) {
      key.preventDefault();
      if (key.ctrl && name === 'c') {
        this.resolveDecision(false);
        this.quit(130);
        return;
      }
      if (name === 'y' || name === 'return') {
        this.resolveDecision(true);
        return;
      }
      if (name === 'n' || name === 'escape') this.resolveDecision(false);
      return;
    }

    if (key.ctrl && name === 'c') {
      key.preventDefault();
      if (this.running) {
        // In a session, Ctrl-C means "stop this run", not "throw away the
        // session" — losing the transcript to cancel one task would make the
        // key useless the moment it mattered. Aborting the active tool matters
        // just as much: breaking the event loop alone returns control while the
        // tool keeps executing — and writing — underneath a view that shows the
        // run as stopped.
        this.options.canceller?.abortActive();
        this.deferredCancel.resolve();
        this.setPhase('waiting', 'stopping…');
        return;
      }
      this.quit(130);
      return;
    }
    if (name === 'i' && this.interactive && !this.running) {
      key.preventDefault();
      this.focusPrompt();
      return;
    }
    if (key.ctrl && name === 'p') {
      key.preventDefault();
      this.openPalette();
      return;
    }
    if (name === ':' && !key.shift) {
      key.preventDefault();
      this.openPalette();
      return;
    }
    if (key.ctrl && name === 's') {
      key.preventDefault();
      this.saveTranscript();
      return;
    }
    if (key.ctrl && name === 'o') {
      key.preventDefault();
      this.toggleVerbose();
      return;
    }
    if (key.ctrl && name === 'r') {
      key.preventDefault();
      this.toggleReasoning();
      return;
    }
    if (key.ctrl && name === 'b') {
      key.preventDefault();
      this.toggleSidebar();
      return;
    }
    if (name === '?' || name === 'f1') {
      key.preventDefault();
      this.toggleHelp();
      return;
    }

    /* ---- folding a tool card ------------------------------------- */
    // These are deliberately all unmodified letters and brackets: the approval
    // prompt owns y/n and return, and this handler never runs while a decision
    // is pending (see the guard above), so the two cannot collide.
    if (name === '[' || name === ']') {
      key.preventDefault();
      this.moveCardFocus(name === ']' ? 1 : -1);
      return;
    }
    if (name === 't') {
      key.preventDefault();
      this.toggleFocusedCard();
      return;
    }
    if (name === 'e' && key.shift) {
      key.preventDefault();
      this.setAllCards(true);
      return;
    }
    if (name === 'c' && key.shift) {
      key.preventDefault();
      this.setAllCards(false);
      return;
    }
    if (name === 'o') {
      key.preventDefault();
      this.dumpFocusedCard();
      return;
    }

    switch (name) {
      case 'q':
        key.preventDefault();
        this.quit(0);
        return;
      case 'escape':
        key.preventDefault();
        this.quit(0);
        return;
      case 'u':
        key.preventDefault();
        this.askUndo();
        return;
      case 'y':
        key.preventDefault();
        this.copyTranscript();
        return;
      case 'up':
      case 'k':
        key.preventDefault();
        this.follow = false;
        this.scrollBy(-3);
        return;
      case 'down':
      case 'j':
        key.preventDefault();
        this.scrollBy(3);
        return;
      case 'pageup':
        key.preventDefault();
        this.follow = false;
        this.scrollBy(-1, 'viewport');
        return;
      case 'pagedown':
        key.preventDefault();
        this.scrollBy(1, 'viewport');
        return;
      case 'home':
        key.preventDefault();
        this.jump('top');
        return;
      case 'end':
        key.preventDefault();
        this.jump('bottom');
        return;
      case 'tab':
        key.preventDefault();
        this.follow = true;
        this.scrollToBottom();
        return;
      default:
        return;
    }
  }

  private scrollBy(delta: number, unit: 'absolute' | 'viewport' = 'absolute'): void {
    try {
      if (unit === 'viewport') this.chrome.transcript.scrollBy(delta, 'viewport');
      else this.chrome.transcript.scrollBy({ x: 0, y: delta });
    } catch {
      /* not laid out yet */
    }
  }

  private paletteKey(key: KeyEvent, name: string): void {
    const matches = this.filteredCommands();
    if (name === 'escape') {
      this.closePalette();
      return;
    }
    if (name === 'up') {
      this.paletteIndex = (this.paletteIndex - 1 + matches.length) % Math.max(1, matches.length);
      this.renderPalette();
      return;
    }
    if (name === 'down') {
      this.paletteIndex = (this.paletteIndex + 1) % Math.max(1, matches.length);
      this.renderPalette();
      return;
    }
    if (name === 'return') {
      const chosen = matches[this.paletteIndex];
      this.closePalette();
      chosen?.run();
      return;
    }
    if (name === 'backspace') {
      this.paletteQuery = this.paletteQuery.slice(0, -1);
      this.renderPalette();
      return;
    }
    const sequence = key.sequence ?? '';
    if (!key.ctrl && !key.meta && sequence.length === 1 && sequence >= ' ') {
      this.paletteQuery += sequence;
      this.renderPalette();
    }
  }
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function buildChrome(renderer: CliRenderer, environment: RunEnvironment, prompt: string, interactive = false): Chrome {
  const root = box(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    backgroundColor: PALETTE.bg,
  });

  const wordmark = new ASCIIFontRenderable(renderer, {
    text: 'MODELHITCH',
    font: 'tiny',
    color: PALETTE.accent,
    backgroundColor: PALETTE.bg,
    selectable: false,
  });
  const wordmarkSmall = new TextRenderable(renderer, {
    content: new StyledText([bold(chunk('accent', '▌ MODELHITCH'))]),
    height: 1,
    visible: false,
  });

  const headerRight = box(renderer, { flexDirection: 'column', alignItems: 'flex-end' }, [
    new TextRenderable(renderer, {
      // In a session the playbook is per typed task, so naming the CLI's
      // value here would be the same false claim the sidebar refuses to make.
      content: new StyledText([
        chunk(
          'muted',
          interactive
            ? 'harness · playbook per task'
            : `harness · playbook ${environment.playbook}`,
        ),
      ]),
      height: 1,
    }),
    new TextRenderable(renderer, {
      content: new StyledText([bold(chunk('info', environment.target))]),
      height: 1,
    }),
  ]);

  const taskLine = new TextRenderable(renderer, {
    content: new StyledText([chunk('muted', `task: ${clip(prompt.replace(/\s+/g, ' '), 160)}`)]),
    height: 1,
    wrapMode: 'none',
  });

  const header = box(
    renderer,
    { flexDirection: 'column', width: '100%', paddingLeft: 1, paddingRight: 1, flexShrink: 0 },
    [
      box(renderer, { flexDirection: 'row', width: '100%', justifyContent: 'space-between' }, [
        box(renderer, { flexDirection: 'column', flexShrink: 0 }, [wordmark, wordmarkSmall]),
        headerRight,
      ]),
      new TextRenderable(renderer, {
        content: new StyledText([
          chunk('faint', `${environment.workspaceDir.replace(/\\/g, '/')}  ·  session ${environment.sessionId || '—'}  ·  `),
          chunk(environment.approvals === 'prompt' ? 'ok' : environment.approvals === 'auto' ? 'warn' : 'error',
            approvalLabel(environment.approvals)),
        ]),
        height: 1,
        wrapMode: 'none',
      }),
      taskLine,
    ],
  );

  const transcript = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    borderStyle: 'rounded',
    borderColor: PALETTE.border,
    focusedBorderColor: PALETTE.borderFocus,
    title: ' Transcript ',
    titleColor: PALETTE.accent,
    titleAlignment: 'left',
    backgroundColor: PALETTE.panel,
    stickyScroll: true,
    stickyStart: 'bottom',
    scrollY: true,
    viewportCulling: true,
    rootOptions: { backgroundColor: PALETTE.panel },
    viewportOptions: { backgroundColor: PALETTE.panel },
    contentOptions: { backgroundColor: PALETTE.panel, flexDirection: 'column', gap: 1 },
    verticalScrollbarOptions: {
      showArrows: false,
      trackOptions: { foregroundColor: PALETTE.border, backgroundColor: PALETTE.panel },
    },
    paddingLeft: 1,
    paddingRight: 1,
  });
  const transcriptPanel = box(renderer, { flexGrow: 1, flexDirection: 'column', minWidth: 0 }, [transcript]);

  const session = new TextRenderable(renderer, { content: '', wrapMode: 'none' });
  const tools = new TextRenderable(renderer, { content: '', wrapMode: 'none' });
  const activity = new TextRenderable(renderer, { content: '', wrapMode: 'none' });
  const activityScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    scrollY: true,
    viewportCulling: true,
    verticalScrollbarOptions: {
      showArrows: false,
      trackOptions: { foregroundColor: PALETTE.border, backgroundColor: PALETTE.panel },
    },
  });
  activityScroll.add(activity);

  const sessionPanel = box(
    renderer,
    {
      borderStyle: 'rounded',
      borderColor: PALETTE.border,
      title: ' Session ',
      titleColor: PALETTE.accent,
      backgroundColor: PALETTE.panel,
      paddingLeft: 1,
      paddingRight: 1,
      height: 10,
      flexShrink: 0,
    },
    [session],
  );
  const toolsPanel = box(
    renderer,
    {
      borderStyle: 'rounded',
      borderColor: PALETTE.border,
      title: ' Tools ',
      titleColor: PALETTE.accent,
      backgroundColor: PALETTE.panel,
      paddingLeft: 1,
      paddingRight: 1,
      height: 11,
      flexShrink: 0,
    },
    [tools],
  );
  const activityPanel = box(
    renderer,
    {
      borderStyle: 'rounded',
      borderColor: PALETTE.border,
      title: ' Activity ',
      titleColor: PALETTE.accent,
      backgroundColor: PALETTE.panel,
      paddingLeft: 1,
      paddingRight: 1,
      flexGrow: 1,
      flexDirection: 'column',
      minHeight: 5,
    },
    [activityScroll],
  );
  const sidebar = box(
    renderer,
    { width: SIDEBAR_WIDTH, flexDirection: 'column', gap: 1, flexShrink: 0 },
    [sessionPanel, toolsPanel, activityPanel],
  );

  const main = box(
    renderer,
    { flexDirection: 'row', flexGrow: 1, gap: 1, paddingLeft: 1, paddingRight: 1, minHeight: 0 },
    [transcriptPanel, sidebar],
  );

  const status = new TextRenderable(renderer, { content: '', height: 1, wrapMode: 'none' });
  const statusRight = new TextRenderable(renderer, { content: '', height: 1, wrapMode: 'none' });

  /*
   * The task input.
   *
   * A harness UI collects its own tasks; borrowing readline for the first one
   * would draw a plain prompt over the interface and then hand a half-typed
   * line to a full-screen renderer. Hidden until something focuses it, so the
   * transcript keeps the rows when there is nothing to type.
   */
  const promptLabel = new TextRenderable(renderer, {
    content: new StyledText([bold(chunk('accent', '›'))]),
    height: 1,
    width: 2,
    wrapMode: 'none',
  });
  const promptInput = new InputRenderable(renderer, {
    id: 'task-input',
    value: '',
    placeholder: 'describe the task, then press enter',
    flexGrow: 1,
    backgroundColor: PALETTE.bg,
    focusedBackgroundColor: PALETTE.panelAlt,
    textColor: PALETTE.text,
    cursorColor: PALETTE.accent,
    placeholderColor: PALETTE.faint,
  });
  const promptRow = box(
    renderer,
    {
      flexDirection: 'row',
      width: '100%',
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
      gap: 1,
      flexShrink: 0,
      visible: false,
    },
    [promptLabel, promptInput],
  );

  const statusBar = box(
    renderer,
    {
      flexDirection: 'row',
      width: '100%',
      height: 1,
      paddingLeft: 1,
      paddingRight: 1,
      justifyContent: 'space-between',
      flexShrink: 0,
    },
    [status, statusRight],
  );

  const keybar = new TextRenderable(renderer, {
    content: new StyledText([
      chunk('accent', '?'), chunk('faint', ' help  '),
      chunk('accent', '^P'), chunk('faint', ' commands  '),
      chunk('accent', '↑↓'), chunk('faint', ' scroll  '),
      chunk('accent', 'u'), chunk('faint', ' undo  '),
      chunk('accent', 'y'), chunk('faint', ' copy  '),
      chunk('accent', '^O'), chunk('faint', ' output  '),
      chunk('accent', 'q'), chunk('faint', ' quit'),
    ]),
    height: 1,
    wrapMode: 'none',
    paddingLeft: 1,
  });

  const modalTitle = new TextRenderable(renderer, { content: '', height: 1, wrapMode: 'none' });
  const modalBody = new TextRenderable(renderer, { content: '', wrapMode: 'word' });
  const modal = box(
    renderer,
    {
      position: 'absolute',
      bottom: 3,
      left: '10%',
      width: '80%',
      zIndex: 50,
      visible: false,
      flexDirection: 'column',
      borderStyle: 'heavy',
      borderColor: PALETTE.accent,
      backgroundColor: PALETTE.panelAlt,
      paddingLeft: 2,
      paddingRight: 2,
      gap: 0,
    },
    [modalTitle, modalBody],
  );

  const helpBody = new TextRenderable(renderer, { content: new StyledText(helpLines()), wrapMode: 'none' });
  const help = box(
    renderer,
    {
      position: 'absolute',
      top: 2,
      left: '12%',
      width: '76%',
      zIndex: 60,
      visible: false,
      borderStyle: 'rounded',
      borderColor: PALETTE.borderFocus,
      title: ' Keyboard ',
      titleColor: PALETTE.accent,
      backgroundColor: PALETTE.panel,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
    },
    [helpBody],
  );

  const paletteQuery = new TextRenderable(renderer, { content: '', height: 1, wrapMode: 'none' });
  const paletteList = new TextRenderable(renderer, { content: '', wrapMode: 'none' });
  const palette = box(
    renderer,
    {
      position: 'absolute',
      bottom: 3,
      left: '20%',
      width: '60%',
      zIndex: 70,
      visible: false,
      borderStyle: 'rounded',
      borderColor: PALETTE.borderFocus,
      title: ' Commands ',
      titleColor: PALETTE.accent,
      backgroundColor: PALETTE.panelAlt,
      paddingLeft: 1,
      paddingRight: 1,
      paddingBottom: 1,
    },
    [paletteQuery, paletteList],
  );

  for (const child of [header, main, promptRow, statusBar, keybar, help, palette, modal]) root.add(child);
  renderer.root.add(root);

  return {
    root,
    sidebar,
    session,
    tools,
    activity,
    activityScroll,
    status,
    statusRight,
    keybar,
    transcript,
    taskLine,
    modal,
    modalTitle,
    modalBody,
    help,
    helpBody,
    palette,
    paletteQuery,
    paletteList,
    wordmark,
    wordmarkSmall,
    promptRow,
    prompt: promptInput,
  };
}

function helpLines(): TextChunk[] {
  const rows: Array<[string, string]> = [
    ['Navigation', ''],
    ['↑ ↓ / j k', 'scroll one line'],
    ['PgUp / PgDn', 'scroll one screen'],
    ['Home / End', 'jump to the start / follow the run'],
    ['tab', 'scroll back to the newest output'],
    ['Actions', ''],
    ['u', 'undo the file changes this run made'],
    ['y', 'copy the transcript (OSC 52 clipboard)'],
    ['Ctrl+S', 'save the transcript as markdown'],
    ['Ctrl+O', 'expand or collapse tool output'],
    ['Ctrl+R', 'show or hide the model reasoning'],
    ['Ctrl+B', 'show or hide the sidebar'],
    ['Ctrl+P / :', 'command palette'],
    ['?', 'this help'],
    ['Approvals', ''],
    ['y', 'approve the pending change'],
    ['n / Esc', 'decline it'],
    ['q / Ctrl+C', 'quit (a pending approval is declined)'],
  ];
  return rows.flatMap(([key, description], index): TextChunk[] => {
    const line: TextChunk[] = [];
    if (index > 0) line.push(plainChunk('\n'));
    if (description === '') line.push(bold(chunk('accent', key)));
    else {
      line.push(chunk('text', key.padEnd(12)));
      line.push(chunk('muted', description));
    }
    return line;
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * The CLI entry point: build the view, run to completion, wait for the human to
 * dismiss it, and report the exit code.
 */
export async function runHarnessTui(
  prompt: string,
  options: HarnessOptions = {},
  tui: TuiOptions = {},
): Promise<void> {
  const app = await createHarnessTui(prompt, options, tui);
  const code = await app.closed;
  if (code !== 0) process.exitCode = code;
}

