#!/usr/bin/env node
import { streamHarness } from './index.js';
import { buildSystemPrompt } from './prompt.js';
import { loadHarnessRuntime } from './runtime.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  const v = process.argv[i + 1];
  if (i === -1 || !v || v.startsWith('--')) return undefined;
  return v;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let out = '';
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

async function ask(question: string): Promise<string> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const flagsWithValues = new Set(['--model', '--config', '--max-turns']);
  const promptTokens: string[] = [];
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as string;
    if (t === 'run' && i === 0) continue;
    if (t.startsWith('--')) {
      if (flagsWithValues.has(t)) i++;
      continue;
    }
    promptTokens.push(t);
  }
  if (has('--help') || has('-h')) {
    console.log(
      'Usage: modelhitch-harness [run] "<task>" [--model <provider>/<model>] [--config <path>] [--max-turns <n>] [--no-zstack] [--tui] [--plain]',
    );
    console.log('  TUI shows automatically when interactive under bun; --plain forces plaintext, --tui forces the TUI.');
    console.log('  No task? Pipe it in (`echo "fix the bug" | modelhitch-harness`) or type it when asked.');
    return;
  }

  let prompt = promptTokens.join(' ').trim();
  if (!prompt && process.stdin.isTTY !== true) {
    prompt = (await readStdin()).trim();
  }
  if (!prompt && process.stdin.isTTY === true && process.stdout.isTTY === true) {
    prompt = (await ask('Task: ')).trim();
  }
  if (!prompt) {
    console.log(
      'Usage: modelhitch-harness [run] "<task>" [--model <provider>/<model>] [--config <path>] [--max-turns <n>] [--no-zstack] [--tui] [--plain]',
    );
    process.exitCode = 1;
    return;
  }

  const modelOverride = arg('--model');
  const configPath = arg('--config');
  const maxTurns = Number(arg('--max-turns') ?? '8');
  const noZstack = has('--no-zstack');
  const harnessOpts = {
    model: modelOverride,
    configPath,
    maxTurns: Number.isFinite(maxTurns) ? maxTurns : 8,
    noZstack,
  };

  const forceTui = has('--tui');
  const forcePlain = has('--plain') || has('--no-tui');
  const runtimeIsBun = (globalThis as { Bun?: unknown }).Bun !== undefined;
  let useTui = forceTui || (!forcePlain && process.stdout.isTTY === true);

  if (useTui && !runtimeIsBun) {
    if (forceTui) {
      throw new Error('--tui needs the bun runtime: `bun harness/cli.ts ...` or `npm run harness:tui -- ...`');
    }
    console.log('[harness] plaintext mode (TUI needs bun; run under bun for the full view)');
    useTui = false;
  }

  if (useTui) {
    try {
      // Lazy: @opentui/core's renderer needs bun's FFI — keep it out of plaintext runs.
      const { runHarnessTui } = await import('./tui.js');
      await runHarnessTui(prompt, harnessOpts);
      return;
    } catch (err) {
      if (forceTui) throw err;
      console.log(
        `[harness] TUI unavailable (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); falling back to plaintext`,
      );
    }
  }

  const runtime = await loadHarnessRuntime({ configPath, modelOverride });
  const ctx = await buildSystemPrompt(prompt, { noZstack });
  console.log(
    `[harness] config=${runtime.configPath} playbook=${ctx.playbook} model=${runtime.provider}/${runtime.model}`,
  );
  // Cheap: loadBihan() is a path check plus a cached import.
  const { describeSubagents } = await import('./subagents.js');
  console.log(`[harness] ${await describeSubagents()}`);

  let turns = 0;
  for await (const ev of streamHarness(prompt, harnessOpts)) {
    if (ev.type === 'chunk' && ev.chunk.type === 'text-delta') process.stdout.write(ev.chunk.text);
    else if (ev.type === 'tool') {
      process.stdout.write(`\n[tool ${ev.call.name}]\n${ev.output.slice(0, 2000)}\n`);
    } else if (ev.type === 'turn') {
      turns = ev.turn;
    } else if (ev.type === 'done') {
      turns = ev.turns;
      const final = ev.final.message;
      const text = typeof final.content === 'string' ? final.content : '[non-text]';
      console.log(
        `\n[harness done] turns=${ev.turns} tokens=${ev.usage.totalTokens ?? '?'} final=${text.slice(0, 500)}`,
      );
    }
  }
  void turns;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
