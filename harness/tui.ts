import {
  BoxRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SyntaxStyle,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
} from '@opentui/core';
import { streamHarness, type HarnessOptions } from './index.js';
import { buildSystemPrompt } from './prompt.js';
import { loadHarnessRuntime } from './runtime.js';

const ACCENT = '#d4a72c';
const MUTED = '#8b949e';
const PANEL = '#161b22';
const TEXT = '#e6edf3';
const OK = '#3fb950';
const ERROR = '#f85149';
const BG = '#0d1117';

export async function runHarnessTui(prompt: string, options: HarnessOptions = {}): Promise<void> {
  const runtime = await loadHarnessRuntime({
    configPath: options.configPath,
    modelOverride: options.model,
  });
  const ctx = await buildSystemPrompt(prompt, {
    extraSystem: options.extraSystem,
    noZstack: options.noZstack,
  });

  const renderer = await createCliRenderer({
    screenMode: 'alternate-screen',
    exitOnCtrlC: true,
    consoleMode: 'disabled',
    backgroundColor: BG,
    targetFps: 30,
  });
  const syntax = SyntaxStyle.create();

  const root = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    padding: 1,
    gap: 1,
    backgroundColor: BG,
  });
  const heading = new TextRenderable(renderer, {
    content: 'MODELHiTCH  /  HARNESS',
    fg: ACCENT,
    height: 1,
  });
  const sub = new TextRenderable(renderer, {
    content: `${runtime.provider}/${runtime.model}  ·  ${ctx.playbook}  ·  ${runtime.configPath}`,
    fg: MUTED,
    height: 1,
  });
  const task = new TextRenderable(renderer, {
    content: prompt.slice(0, 500),
    fg: TEXT,
    height: 2,
  });
  const scroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    borderStyle: 'rounded',
    borderColor: '#30363d',
    title: ' run ',
    titleColor: ACCENT,
    backgroundColor: PANEL,
    stickyScroll: true,
    stickyStart: 'bottom',
    scrollY: true,
  });
  const status = new TextRenderable(renderer, { content: 'Running…', fg: MUTED, height: 1 });
  const footer = new TextRenderable(renderer, {
    content: 'Up/Down scroll   Esc quit',
    fg: MUTED,
    height: 1,
  });
  for (const child of [heading, sub, task, scroll, status, footer]) root.add(child);
  renderer.root.add(root);

  let settled = false;
  let finish = (_code: number): void => undefined;
  const exitPromise = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const quit = (code: number): void => {
    if (settled) return;
    settled = true;
    try {
      syntax.destroy();
    } catch {
      /* renderer teardown owns the rest */
    }
    renderer.destroy();
    finish(code);
  };

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (key.name === 'escape' || key.name === 'q') {
      key.preventDefault();
      quit(0);
      return;
    }
    if (key.name === 'up') {
      key.preventDefault();
      scroll.scrollBy({ x: 0, y: -3 });
      return;
    }
    if (key.name === 'down') {
      key.preventDefault();
      scroll.scrollBy({ x: 0, y: 3 });
    }
  });

  const newMarkdownBlock = (): MarkdownRenderable => {
    const md = new MarkdownRenderable(renderer, {
      content: '',
      syntaxStyle: syntax,
      fg: TEXT,
      streaming: true,
    });
    scroll.add(md);
    return md;
  };

  let md = newMarkdownBlock();
  let turns = 0;
  let totalTokens = 0;

  try {
    for await (const ev of streamHarness(prompt, options)) {
      if (settled) break;
      if (ev.type === 'chunk' && ev.chunk.type === 'text-delta') {
        md.content += ev.chunk.text;
      } else if (ev.type === 'turn') {
        turns = ev.turn;
        totalTokens += ev.result.usage?.totalTokens ?? 0;
        md.streaming = false;
        md = newMarkdownBlock();
        status.content = `Turn ${turns} · ${totalTokens} tokens`;
        status.fg = MUTED;
      } else if (ev.type === 'tool') {
        md.streaming = false;
        const block = new TextRenderable(renderer, {
          content: `$ ${ev.call.name}\n${ev.output.slice(0, 1500)}`,
          fg: MUTED,
        });
        scroll.add(block);
        md = newMarkdownBlock();
        status.content = `Turn ${turns} · tool ${ev.call.name} · ${totalTokens} tokens`;
        status.fg = MUTED;
      } else if (ev.type === 'done') {
        turns = ev.turns;
        md.streaming = false;
        const usage = ev.usage.totalTokens ?? totalTokens;
        status.content = `Done · ${turns} turns · ${usage} tokens · Esc to exit`;
        status.fg = OK;
      }
    }
  } catch (err) {
    status.content = `Error: ${err instanceof Error ? err.message : String(err)} · Esc to exit`;
    status.fg = ERROR;
  }

  const code = await exitPromise;
  if (code !== 0) process.exitCode = code;
}
