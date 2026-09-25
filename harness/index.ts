import { runToolLoop, type ToolLoopEvent } from '../src/index.js';
import type { ModelMessage } from '../src/index.js';
import { HARNESS_TOOLS, executeHarnessTool } from './tools.js';
import { buildSystemPrompt } from './prompt.js';
import { loadHarnessRuntime } from './runtime.js';

export interface HarnessOptions {
  /** Per-run override in `<provider>/<model>` form (mirrors `modelhitch chat --model`). */
  model?: string;
  /** Config file (default `~/.modelhitch/config.json`, or `MODELHITCH_CONFIG`). */
  configPath?: string;
  maxTurns?: number;
  extraSystem?: string;
  noZstack?: boolean;
  workspaceDir?: string;
}

export interface HarnessResult {
  events: ToolLoopEvent[];
  messages: ModelMessage[];
  turns: number;
  playbook: string;
  model: string;
  configPath: string;
}

export async function* streamHarness(
  prompt: string,
  options: HarnessOptions = {},
): AsyncGenerator<ToolLoopEvent> {
  const workspaceDir = options.workspaceDir ?? process.cwd();
  const runtime = await loadHarnessRuntime({
    configPath: options.configPath,
    modelOverride: options.model,
  });
  const ctx = await buildSystemPrompt(prompt, {
    extraSystem: options.extraSystem,
    noZstack: options.noZstack,
  });

  const messages: ModelMessage[] = [
    { role: 'system', content: ctx.systemPrompt },
    { role: 'user', content: prompt },
  ];

  const execute = async (name: string, args: Record<string, unknown>): Promise<string> =>
    executeHarnessTool(name, args, { workspaceDir });

  yield* runToolLoop(
    runtime.client,
    { provider: runtime.provider, model: runtime.model, messages, tools: HARNESS_TOOLS },
    execute,
    { maxTurns: options.maxTurns ?? 8 },
  );
}

export async function runHarness(prompt: string, options: HarnessOptions = {}): Promise<HarnessResult> {
  const ctx = await buildSystemPrompt(prompt, {
    extraSystem: options.extraSystem,
    noZstack: options.noZstack,
  }).catch(() => ({ playbook: 'unknown' as string, systemPrompt: '' }));
  const events: ToolLoopEvent[] = [];
  let messages: ModelMessage[] = [];
  let turns = 0;
  let configPath = options.configPath ?? '';
  let model = options.model ?? '';
  for await (const ev of streamHarness(prompt, options)) {
    events.push(ev);
    if (ev.type === 'done') {
      messages = ev.messages;
      turns = ev.turns;
    }
  }
  try {
    const runtime = await loadHarnessRuntime({
      configPath: options.configPath,
      modelOverride: options.model,
    });
    configPath = runtime.configPath;
    model = `${runtime.provider}/${runtime.model}`;
  } catch {
    /* keep fallbacks above; streamHarness already surfaced the real error */
  }
  return {
    events,
    messages,
    turns,
    playbook: 'playbook' in ctx ? (ctx as { playbook: string }).playbook : 'unknown',
    model,
    configPath,
  };
}
