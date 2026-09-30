/**
 * Mid-run context compaction.
 *
 * A long task accumulates messages until the provider refuses the next call.
 * `summarize.ts` already handles the single largest contributor — one oversized
 * tool result — but a run that reads forty modest files never trips that
 * threshold and still runs out of context.
 *
 * So this replaces *completed turns* with a digest, keeping the most recent ones
 * verbatim. Three rules are structural rather than stylistic, and each exists
 * because breaking it produces a request the provider rejects rather than a
 * request that is merely worse:
 *
 *   1. **The system message is never touched.** It is the run's instructions,
 *      and a digest of instructions is not instructions.
 *   2. **An assistant message that carries tool calls is never separated from
 *      its tool results.** A `tool` message refers to its call by id; dropping
 *      the assistant half orphans it, and dropping the tool half leaves a call
 *      with no answer. Both are malformed. They move as one unit or not at all.
 *   3. **The digest replaces, it does not append.** A compaction that left the
 *      old turns in place would grow the history it was called to shrink.
 */

import type { ModelMessage } from '../src/index.js';

/**
 * Total message content, in characters, above which a run compacts.
 *
 * Characters rather than tokens on purpose: the harness cannot count tokens
 * without the provider's tokenizer, and every provider counts differently. A
 * character budget is the same approximation `summarize.ts` already uses, and
 * it errs the same way — early rather than late.
 */
export const DEFAULT_COMPACT_THRESHOLD = 48_000;

/**
 * Completed units kept verbatim.
 *
 * Two, because the most recent turn is what the model is actively working on
 * and the one before it usually carries the tool results it just reasoned
 * about. Compacting either produces a model that has forgotten what it was
 * doing, which reads as a sudden loss of competence rather than as a policy.
 */
export const KEEP_RECENT_UNITS = 2;

/**
 * Fraction of the history a compaction must remove to be worth doing.
 *
 * A digest is a model call and a rewrite of the run's own history, so a
 * compaction that saves almost nothing costs both and buys neither. Observed in
 * a live run: one round reported `24492 chars -> 24480`, because the turns kept
 * verbatim dominated and the digest was nearly as large as what it replaced.
 * Below this fraction the compaction is discarded and the history is left alone.
 */
export const MIN_COMPACTION_GAIN = 0.1;

export interface MessageUnit {
  /** Index of the first message in the run's array. */
  start: number;
  /** Exclusive end. */
  end: number;
  messages: ModelMessage[];
  /** Characters of content in this unit, for the budget. */
  size: number;
  /**
   * False for the system message and for the most recent turns: units that may
   * never be dropped.
   */
  droppable: boolean;
}

/** Characters of content in one message. Cheap, and stable across providers. */
export function messageSize(message: ModelMessage): number {
  let size = 0;
  if (typeof message.content === 'string') {
    size += message.content.length;
  } else {
    for (const part of message.content) {
      // Only text is counted. An inline image is large in a way that has nothing
      // to do with the context this budget is about, and counting its base64
      // would make one screenshot trigger compaction on its own.
      if (part.type === 'text') size += part.text.length;
    }
  }
  // Counted outside the branch above: a tool call carries its arguments in the
  // message even when its text content is empty, and arguments are often the
  // largest thing a turn adds.
  if (message.role === 'assistant' && message.toolCalls) {
    for (const call of message.toolCalls) size += JSON.stringify(call.arguments ?? {}).length + call.name.length;
  }
  return size;
}

/** Total content size of a history. */
export function historySize(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) total += messageSize(message);
  return total;
}

/**
 * Split a history into units that may be dropped independently.
 *
 * The grouping rule is the one that matters: an assistant message carrying tool
 * calls absorbs the `tool` messages that answer it, matched by `toolCallId`. A
 * `tool` message that matches no preceding call is kept as its own unit rather
 * than attached to whatever came before, because guessing the owner is how a
 * mismatched pairing gets produced in the first place.
 *
 * Two units are never droppable: the system message, which is the run's
 * instructions, and the first user message, which is the task. A digest of the
 * task is a paraphrase of the thing everything else is measured against, and a
 * run that has lost the original wording of its instructions is a run that
 * quietly starts solving a slightly different problem.
 */
export function splitUnits(messages: readonly ModelMessage[]): MessageUnit[] {
  const units: MessageUnit[] = [];
  let index = 0;
  let seenUserTask = false;
  while (index < messages.length) {
    const message = messages[index] as ModelMessage;
    const start = index;
    const group: ModelMessage[] = [message];
    index++;

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      const pending = new Set(message.toolCalls.map((call) => call.id));
      while (index < messages.length) {
        const next = messages[index] as ModelMessage;
        if (next.role !== 'tool' || !pending.has(next.toolCallId)) break;
        pending.delete(next.toolCallId);
        group.push(next);
        index++;
      }
    }

    let size = 0;
    for (const part of group) size += messageSize(part);
    const isTask = message.role === 'user' && !seenUserTask;
    if (isTask) seenUserTask = true;
    units.push({
      start,
      end: index,
      messages: group,
      size,
      // Identifying these by role rather than by index keeps this correct for a
      // restored history, where the first user message is the resumed task.
      droppable: message.role !== 'system' && !isTask,
    });
  }
  return units;
}

export interface CompactionPlan {
  /** Units to replace with a digest, in order. */
  drop: MessageUnit[];
  /** Units kept verbatim. */
  keep: MessageUnit[];
  /** Characters the whole history holds now. */
  size: number;
  /** Characters the dropped units account for. */
  droppedSize: number;
}

export interface PlanOptions {
  threshold?: number;
  keepRecent?: number;
}

/**
 * Decide whether to compact, and what to drop.
 *
 * Returns null when there is nothing to do, which includes the case the spec
 * calls out: a threshold below a single turn's size with only one droppable
 * unit. Dropping the only unit a run has would leave the model with a digest
 * and no recent context, so the planner refuses rather than making the run
 * worse in the name of staying under a number.
 */
export function planCompaction(
  messages: readonly ModelMessage[],
  options: PlanOptions = {},
): CompactionPlan | null {
  const threshold = options.threshold ?? DEFAULT_COMPACT_THRESHOLD;
  const keepRecent = Math.max(0, options.keepRecent ?? KEEP_RECENT_UNITS);
  const size = historySize(messages);
  if (threshold <= 0 || size <= threshold) return null;

  const units = splitUnits(messages);
  const droppable = units.filter((unit) => unit.droppable);
  // Keep at least one completed unit: a digest with no recent context is a run
  // that has forgotten what it was doing.
  if (droppable.length <= 1) return null;

  const keepCount = Math.min(keepRecent, droppable.length - 1);
  const keep = droppable.slice(droppable.length - keepCount);
  const drop = droppable.slice(0, droppable.length - keepCount);
  if (drop.length === 0) return null;

  let droppedSize = 0;
  for (const unit of drop) droppedSize += unit.size;
  return { drop, keep, size, droppedSize };
}

export interface CompactRequest {
  messages: readonly ModelMessage[];
  threshold?: number;
  keepRecent?: number;
  /** Digest the dropped turns. Injected, so this module stays provider-neutral. */
  digest: (request: string) => Promise<string>;
  /** Called once per compaction, so a reader knows history was rewritten. */
  log?: (message: string) => void;
  /** Format the digest into a message. Overridable for tests. */
  makeDigestMessage?: (digest: string, droppedUnits: number) => ModelMessage;
}

export interface CompactOutcome {
  messages: ModelMessage[];
  compacted: boolean;
  droppedUnits: number;
  keptUnits: number;
  before: number;
  after: number;
}

/** The prompt the digest is asked for. Kept here so the wording is one place. */
export function buildCompactionRequest(units: readonly MessageUnit[]): string {
  const lines: string[] = [
    'Summarise the earlier part of a coding session for another engineer who will',
    'continue the work. Keep file paths, identifiers, commands, decisions, and any',
    'unresolved problem exactly as they are. Drop pleasantries and repetition.',
    'Answer in at most 20 short lines, no preamble.',
    '',
  ];
  for (const unit of units) {
    for (const message of unit.messages) {
      if (message.role === 'tool') {
        lines.push(`tool result: ${typeof message.content === 'string' ? message.content.slice(0, 1_200) : ''}`);
        continue;
      }
      const text = typeof message.content === 'string' ? message.content : '';
      if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
        lines.push(`assistant called: ${message.toolCalls.map((call) => call.name).join(', ')}`);
      }
      if (text.trim() !== '') lines.push(`${message.role}: ${text.slice(0, 1_200)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Replace the oldest completed turns with one digest message.
 *
 * Never throws on a digest failure: a run that cannot summarise its history is a
 * run that continues with a full history, which is the state it was already in.
 * Compaction is an optimisation and must not be able to end a run.
 */
export async function compactMessages(request: CompactRequest): Promise<CompactOutcome> {
  const messages = [...request.messages];
  const before = historySize(messages);
  const plan = planCompaction(messages, {
    ...(request.threshold !== undefined ? { threshold: request.threshold } : {}),
    ...(request.keepRecent !== undefined ? { keepRecent: request.keepRecent } : {}),
  });
  if (plan === null) {
    return { messages, compacted: false, droppedUnits: 0, keptUnits: 0, before, after: before };
  }

  let digest: string;
  try {
    digest = (await request.digest(buildCompactionRequest(plan.drop))).trim();
  } catch (err) {
    request.log?.(
      `[harness] compaction skipped: the digest failed (${err instanceof Error ? err.message : String(err)})`,
    );
    return { messages, compacted: false, droppedUnits: 0, keptUnits: 0, before, after: before };
  }
  if (digest === '') {
    request.log?.('[harness] compaction skipped: the digest came back empty');
    return { messages, compacted: false, droppedUnits: 0, keptUnits: 0, before, after: before };
  }

  const digestMessage =
    request.makeDigestMessage?.(digest, plan.drop.length) ??
    ({
      role: 'user',
      content:
        `[compacted: ${plan.drop.length} earlier turn${plan.drop.length === 1 ? '' : 's'} replaced by this summary]\n\n` +
        digest,
    } satisfies ModelMessage);

  // Rebuild by walking the original array: the digest lands at the position of
  // the first dropped unit, and everything else keeps its order. Rebuilding
  // rather than splicing keeps this correct for a history with a system message
  // in the middle, which a caller can hand in even though the loop does not.
  const droppedStarts = new Set(plan.drop.map((unit) => unit.start));
  const dropIndex = new Set<number>();
  for (const unit of plan.drop) {
    for (let index = unit.start; index < unit.end; index++) dropIndex.add(index);
  }

  const next: ModelMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (droppedStarts.has(index)) {
      next.push(digestMessage);
      continue;
    }
    if (dropIndex.has(index)) continue;
    next.push(messages[index] as ModelMessage);
  }

  const after = historySize(next);
  // A compaction that barely shrank anything is a paid model call in exchange
  // for a rewritten history, which is the opposite of the trade it was called to
  // make. Keep the original in that case.
  const saved = plan.size > 0 ? (plan.size - after) / plan.size : 0;
  if (saved < MIN_COMPACTION_GAIN) {
    request.log?.(
      `[harness] compaction skipped: it would have saved ${Math.max(0, Math.round(saved * 100))}% ` +
        `(${plan.size} -> ${after} chars), below the ${Math.round(MIN_COMPACTION_GAIN * 100)}% worth doing`,
    );
    return { messages, compacted: false, droppedUnits: 0, keptUnits: 0, before, after: before };
  }

  request.log?.(
    `[harness] compacted ${plan.drop.length} turn${plan.drop.length === 1 ? '' : 's'} into 1 ` +
      `(${plan.size} chars -> ${after}, ${plan.keep.length} kept verbatim)`,
  );
  return {
    messages: next,
    compacted: true,
    droppedUnits: plan.drop.length,
    keptUnits: plan.keep.length,
    before,
    after,
  };
}

/**
 * Structural validity of a history, as the next provider call would see it.
 *
 * Exported because compaction's failure mode is a malformed request, and a
 * malformed request surfaces as an opaque provider error several turns later.
 * Checking the invariant directly is what turns that into a named failure.
 */
export interface PairingProblem {
  index: number;
  reason: string;
}

export function validatePairing(messages: readonly ModelMessage[]): PairingProblem[] {
  const problems: PairingProblem[] = [];
  const answered = new Set<string>();
  const asked = new Map<string, number>();

  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) asked.set(call.id, index);
    } else if (message.role === 'tool') {
      if (!asked.has(message.toolCallId)) {
        problems.push({ index, reason: `tool result for "${message.toolCallId}" has no preceding call` });
      } else if (answered.has(message.toolCallId)) {
        problems.push({ index, reason: `duplicate tool result for "${message.toolCallId}"` });
      }
      answered.add(message.toolCallId);
    }
  });

  for (const [id, index] of asked) {
    if (!answered.has(id)) {
      problems.push({ index, reason: `tool call "${id}" was never answered` });
    }
  }
  return problems;
}
