import { runToolLoop, type ToolLoopEvent, type BatchToolExecutor } from '../src/index.js';
import type { ModelMessage, ToolCall } from '../src/index.js';
import { compactMessages } from './compact.js';
import { HARNESS_TOOLS, executeHarnessTool } from './tools.js';
import { buildSystemPrompt } from './prompt.js';
import { loadHarnessRuntime, type HarnessRuntime } from './runtime.js';
import { createSubagentRoster } from './subagents.js';
import {
  DECLINE_MESSAGE,
  buildApprovalPreview,
  isMutatingToolCall,
  type ApprovalHandler,
} from './approval.js';
import { declined, resultFromText, timeout, type ToolResult } from './result.js';
import { DEFAULT_TOOL_CONCURRENCY, runToolBatch } from './batch.js';
import { mayAutoApprove, type RiskClassifier } from './risk.js';
import { buildReviewerRegistration } from './reviewer.js';
import { DEFAULT_TOOL_TIMEOUT_MS, createToolCanceller, type ToolCanceller } from './cancel.js';
import { createSnapshotter, type Snapshotter } from './snapshot.js';
import { createReadCache } from './read-cache.js';
import { isInsideWorkspace, resolveWorkspacePath } from './workspace.js';
import { newSessionId, saveSession } from './session.js';
import {
  DEFAULT_SUMMARIZE_THRESHOLD,
  summarizeToolOutput,
  type SummarizeDeps,
} from './summarize.js';
import type { EmbedFn } from './agent-library.js';

export interface HarnessOptions {
  /** Per-run override in `<provider>/<model>` form (mirrors `modelhitch chat --model`). */
  model?: string;
  /** Config file (default `~/.modelhitch/config.json`, or `MODELHITCH_CONFIG`). */
  configPath?: string;
  maxTurns?: number;
  extraSystem?: string;
  noZstack?: boolean;
  workspaceDir?: string;
  /** Folder of `<name>/agent.md` subagent definitions. `null` disables it. */
  agentsDir?: string | null;
  /**
   * History to seed the loop with instead of a fresh system prompt, for
   * `--resume`. The restored messages already carry their system prompt, so
   * supplying these replaces `buildSystemPrompt` rather than stacking on it.
   */
  initialMessages?: ModelMessage[];
  /** Write the finished run to the harness state directory. */
  saveSession?: boolean;
  /** Session id to save under, and to name this run's snapshot directory. */
  sessionId?: string;
  /** Confirmation gate for mutating tool calls. Absent means no gate at all. */
  onApproval?: ApprovalHandler;
  /** Budget per tool call, in ms. `0` disables the timeout. */
  toolTimeoutMs?: number;
  /** Injected so the CLI can wire Ctrl-C to the running tool. */
  canceller?: ToolCanceller;
  /** Copy pre-change bytes aside so the run can be undone. */
  snapshots?: boolean;
  /** Override for the snapshot directory (tests). */
  snapshotRoot?: string;
  /** Replace long tool results with a head/digest/tail form. */
  summarizeTools?: boolean;
  /** Character count above which a tool result is summarized. */
  summarizeThreshold?: number;
  /** Embedder for semantic subagent search. Absent keeps the lexical search. */
  embedder?: EmbedFn;
  /**
   * Characters of each likely-relevant file's head appended to the system
   * prompt. `undefined` or `0` (the default) appends none. The picker itself
   * always runs; this only changes how much of each pick is included.
   */
  contextBytes?: number;
  /**
   * Read-only tool calls allowed in flight at once (default 4). `1` restores
   * strictly serial execution, which is what a debugging run wants.
   */
  toolConcurrency?: number;
  /**
   * Labels the risk of a mutating call before the gate asks. Absent means the
   * approval request is exactly what it was before this existed.
   */
  risk?: RiskClassifier;
  /**
   * `--auto-approve-safe`: skip the prompt for a call classified `safe`.
   *
   * Only the transport installs this. The harness passes it to the gate it
   * builds for a subagent delegation, which is the one prompt the CLI cannot
   * see.
   */
  autoApproveSafe?: boolean;
  /**
   * `--review`: register the bundled read-only reviewer alongside whatever
   * roster resolves, so the model can delegate to it during the run.
   * `--no-agents` (`agentsDir: null`) still disables it with everything else.
   */
  review?: boolean;
  /**
   * `--compact`: total message characters above which the oldest completed turns
   * are replaced by a digest. `0` or absent leaves the history untouched.
   */
  compactThreshold?: number;
}

export interface HarnessResult {
  events: ToolLoopEvent[];
  messages: ModelMessage[];
  turns: number;
  playbook: string;
  model: string;
  configPath: string;
  /** Where the run was saved, when `saveSession` was set. */
  sessionPath?: string;
  /** Where the run's snapshot landed, when anything was captured. */
  snapshotPath?: string;
}

/**
 * A short digest of the middle of an oversized tool result, using the same
 * client the run already uses. Kept here rather than in `summarize.ts` so that
 * module stays provider-neutral and testable without a network.
 */
function digestFrom(runtime: HarnessRuntime): (request: string) => Promise<string> {
  return async (request: string): Promise<string> => {
    const result = await runtime.client.chat({
      provider: runtime.provider,
      model: runtime.model,
      messages: [{ role: 'user', content: request }],
    });
    const content = result.message.content;
    if (typeof content === 'string') return content;
    return content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .filter((text) => text !== '')
      .join('\n');
  };
}

/**
 * The per-turn batch executor.
 *
 * `runToolLoop` hands over the batch; `runToolBatch` decides the schedule. The
 * hook yields one result per call in the model's order regardless of completion
 * order, which is what keeps a parallel turn's transcript identical to a serial
 * one — that reproducibility is the point, not a side effect.
 *
 * The turn is threaded into `execute` because this is the only place that knows
 * it: the batch runs a whole turn's calls, and the read cache names that turn
 * when it answers a repeat read instead of the body.
 */
export function createBatchExecutor(options: {
  concurrency: number;
  execute: (name: string, args: Record<string, unknown>, turn?: number) => Promise<string>;
  log: (message: string) => void;
}): BatchToolExecutor {
  return async function* batch(calls, context) {
    const items = calls.map((call) => ({ name: call.name, args: call.arguments }));
    const outputs = await runToolBatch(
      items,
      (item) => options.execute(item.name, item.args, context.turn),
      {
        concurrency: options.concurrency,
        // `approval.ts` is the one authority on what needs a gate; a second list
        // here is how the two drift apart.
        isMutating: isMutatingToolCall,
        onGroup: (group, size) => {
          if (size > 1) {
            options.log(
              group === 'read-only'
                ? `[harness] ${size} read-only calls, up to ${options.concurrency} at once`
                : `[harness] ${size} mutating calls, one at a time`,
            );
          }
        },
      },
    );
    for (let index = 0; index < calls.length; index++) {
      yield { call: calls[index] as ToolCall, output: outputs[index] ?? '' };
    }
  };
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

  const restored = options.initialMessages && options.initialMessages.length > 0
    ? options.initialMessages
    : undefined;
  const ctx = restored
    ? undefined
    : await buildSystemPrompt(prompt, {
        extraSystem: options.extraSystem,
        noZstack: options.noZstack,
        // The prompt section and the header must describe the same directory,
        // and a caller may point the run at one that is not the cwd.
        workspaceDir,
        // The same embedder the subagent roster gets, so the likely-files
        // ranking is semantic when the caller supplied one. There is no second
        // injection point: a run that can embed can embed for both.
        ...(options.embedder !== undefined ? { embedder: options.embedder } : {}),
        ...(options.contextBytes !== undefined ? { contextBytes: options.contextBytes } : {}),
      });

  const messages: ModelMessage[] = restored
    ? [...restored, { role: 'user', content: prompt }]
    : [
        { role: 'system', content: ctx?.systemPrompt ?? '' },
        { role: 'user', content: prompt },
      ];

  // Subagent delegation, when bihan is resolvable. It shares this runtime's
  // ModelHitch client, so delegated work stays inside the same policy,
  // failover, and cooldown rather than opening an unmanaged provider path.
  // The roster is a folder of agent definitions when one is available.
  const reviewer =
    options.review === true && options.agentsDir !== null ? buildReviewerRegistration() : undefined;
  if (reviewer !== undefined) {
    for (const warning of reviewer.warnings) process.stderr.write(`[review] ${warning}\n`);
    if (reviewer.spec === undefined) {
      process.stderr.write(`[review] reviewer not registered: ${reviewer.refused ?? 'unknown reason'}\n`);
    }
  }
  const subagents = await createSubagentRoster(runtime.client, {
    model: `${runtime.provider}/${runtime.model}`,
    workspaceDir,
    ...(options.agentsDir !== undefined ? { agentsDir: options.agentsDir } : {}),
    ...(options.embedder !== undefined ? { embedder: options.embedder } : {}),
    ...(reviewer?.spec !== undefined ? { extraAgents: [reviewer.spec] } : {}),
  });
  const tools = subagents ? [...HARNESS_TOOLS, ...subagents.tools] : HARNESS_TOOLS;

  const sessionId = options.sessionId ?? newSessionId();
  const canceller =
    options.canceller ??
    createToolCanceller(options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
  const snapshotter: Snapshotter | undefined =
    options.snapshots === true
      ? createSnapshotter({ workspaceDir, runId: sessionId, ...(options.snapshotRoot ? { root: options.snapshotRoot } : {}) })
      : undefined;
  // One read cache per run, in memory only. It is never handed to `saveSession`
  // or the snapshot directory: it describes what this run already paid for, and
  // a resumed run has to read the files again to know what it holds.
  const readCache = createReadCache();

  const summarizeEnabled = options.summarizeTools === true;
  const threshold = options.summarizeThreshold ?? DEFAULT_SUMMARIZE_THRESHOLD;
  const compactThreshold = options.compactThreshold ?? 0;
  /** Whether this run rewrote its own history, for the session-save note. */
  let compacted = false;
  const deps: SummarizeDeps = {
    digest: digestFrom(runtime),
    log: (message: string): void => console.error(message),
  };

  const execute = async (
    name: string,
    args: Record<string, unknown>,
    turn?: number,
  ): Promise<string> => {
    const routed = subagents !== null && subagents.ownsTool(name);
    const result: ToolResult = await canceller.run(
      name,
      async (signal): Promise<ToolResult> => {
        if (routed && subagents) {
          // A delegation never reaches `executeHarnessTool`, so the read cache
          // has to be dropped here or a subagent's writes would leave the parent
          // serving bodies from before it ran. Dropped before the gate, for the
          // same reason it is dropped there: a decline is not worth reasoning
          // about when an unconditional drop costs a read at most.
          if (isMutatingToolCall(name, args)) readCache.invalidate();
          // The delegation is gated as one unit: bihan runs the subagent's own
          // loop, so the harness cannot see, let alone confirm, the calls inside
          // it. Saying so is better than implying a gate that is not there.
          if (options.onApproval && isMutatingToolCall(name, args)) {
            const preview = await buildApprovalPreview(name, args, { workspaceDir });
            const risk = await options.risk?.classify(name, args, preview);
            // The delegation gate is the one prompt the CLI cannot wrap, so the
            // auto-approve decision for it is made here, from the same predicate.
            if (options.autoApproveSafe === true && mayAutoApprove(risk)) {
              process.stderr.write(
                `[harness] ${name}: auto-approved (risk: safe — ${risk?.reason ?? ''})\n`,
              );
            } else {
              const approved = await options.onApproval({
                tool: name,
                args,
                preview,
                ...(risk ? { risk } : {}),
              });
              if (!approved) return declined(DECLINE_MESSAGE, 'the human declined this delegation');
            }
          }
          snapshotter?.note(
            'subagent delegation runs its own loop in this workspace; its writes are not captured',
          );
          // bihan returns a bare string, so this is the documented fallback path
          // for a result that never had an envelope.
          return resultFromText(await subagents.execute(name, args, signal));
        }
        return await executeHarnessTool(name, args, {
          workspaceDir,
          signal,
          readCache,
          ...(turn === undefined ? {} : { turn }),
          ...(options.onApproval ? { onApproval: options.onApproval } : {}),
          ...(snapshotter ? { snapshot: snapshotter } : {}),
          ...(options.risk ? { risk: options.risk } : {}),
        });
      },
      // Both a budget expiry and a Ctrl-C land here. From the model's side the
      // distinction that matters is "this did not finish", so both are reported
      // as a timeout — the message still says which one happened.
      (message) => timeout(message),
    );
    // Summarize here, at the one place a result becomes a message, so every
    // path (harness tool or subagent) is covered exactly once. The outcome is
    // passed down so a failure is protected by its classification rather than
    // by re-reading its prefix.
    const served = await summarizeToolOutput(result.text, {
      tool: name,
      threshold,
      enabled: summarizeEnabled,
      deps,
      outcome: result.outcome,
    });
    // The read cache stores what the model was served, and this is the only
    // place that text exists. Equal texts need no recording — the read already
    // stored exactly these bytes — so only a summarized body is handed back, and
    // a repeat read then cannot quietly upgrade a digest into the whole file.
    const pathArg = args['path'];
    if (served !== result.text && name === 'read' && typeof pathArg === 'string') {
      if (isInsideWorkspace(workspaceDir, pathArg)) {
        readCache.recordServed(resolveWorkspacePath(workspaceDir, pathArg), served);
      }
    }
    return served;
  };

  const loop = runToolLoop(
    runtime.client,
    { provider: runtime.provider, model: runtime.model, messages, tools },
    execute,
    {
      maxTurns: options.maxTurns ?? 8,
      // A batch of read-only calls is a batch of independent reads; running them
      // one after another was never a correctness requirement, only a default.
      executeMany: createBatchExecutor({
        concurrency: options.toolConcurrency ?? DEFAULT_TOOL_CONCURRENCY,
        execute,
        log: (message) => process.stderr.write(`${message}\n`),
      }),
      // Compaction runs between turns, so it can never overlap an in-flight tool
      // call or a subagent delegation: the loop awaits the executor before it
      // reaches here.
      ...(compactThreshold > 0
        ? {
            beforeTurn: async (history: ModelMessage[]): Promise<ModelMessage[]> => {
              const outcome = await compactMessages({
                messages: history,
                threshold: compactThreshold,
                // The same provider-neutral client and the same shape as the
                // tool-result digest, so `summarize.ts` stays out of it.
                digest: digestFrom(runtime),
                log: (message) => process.stderr.write(`${message}\n`),
              });
              if (outcome.compacted) compacted = true;
              return outcome.messages;
            },
          }
        : {}),
    },
  );

  for await (const ev of loop) {
    if (ev.type === 'done') {
      if (options.saveSession === true) {
        try {
          const path = saveSession({
            id: sessionId,
            createdAt: new Date().toISOString(),
            model: `${runtime.provider}/${runtime.model}`,
            playbook: ctx?.playbook ?? 'resumed',
            turns: ev.turns,
            messages: ev.messages,
          });
          console.error(`[harness] session saved: ${path}`);
          if (compacted) {
            // A resumed run that compacted persists the compacted history, not
            // the transcript it was resumed from. Saying so is the difference
            // between a rewrite the user consented to and one they discover.
            console.error(
              '[harness] note: this run compacted its history, so the saved session holds the digest, ' +
                'not the original transcript',
            );
          }
        } catch (err) {
          // Losing the transcript must not invalidate the run that produced it.
          console.error(
            `[harness] could not save session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      snapshotter?.finish();
      yield ev;
      return;
    }
    yield ev;
  }
}

export async function runHarness(prompt: string, options: HarnessOptions = {}): Promise<HarnessResult> {
  const ctx = await buildSystemPrompt(prompt, {
    extraSystem: options.extraSystem,
    noZstack: options.noZstack,
    workspaceDir: options.workspaceDir,
    // Forwarded here too so this call cannot report "no embedder" for a run that
    // has one: the picker warns once per logger, and a false first warning would
    // silence the real one from `streamHarness` below.
    ...(options.embedder !== undefined ? { embedder: options.embedder } : {}),
    ...(options.contextBytes !== undefined ? { contextBytes: options.contextBytes } : {}),
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
    playbook: options.initialMessages ? 'resumed' : 'playbook' in ctx ? (ctx as { playbook: string }).playbook : 'unknown',
    model,
    configPath,
  };
}
