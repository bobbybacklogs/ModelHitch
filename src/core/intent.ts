import { validatePolicy, type Policy, type PolicyValidation, type ProviderSource } from './policy.js';
import type { ChatParams, ModelMessage } from './types.js';

/**
 * Intent-aware rotation (phase 0 — pure).
 *
 * Rotation today answers "which lanes did the user configure, and which of them
 * can take over when one fails". It answers the same question for every request.
 * An *intent* is the missing noun: a named plan. `coding` is a lane list,
 * `bulk` is a different lane list, and the request picks between them before the
 * failover walk starts.
 *
 * This module is deliberately just data and pure functions — no `node:*`, no
 * config loading, no HTTP. It is the same shape as `core/capabilities.ts`,
 * which already answers "which lanes can serve this request" from the request
 * shape alone. Nothing here routes; `resolvePolicyLanes` still builds every
 * lane list, and the walk that consumes those lanes is untouched.
 *
 * Two inference rules are deliberately conservative, because a wrong guess
 * silently spends a different provider's quota than the user configured:
 *
 * - **Tools present is a capability signal, not coding intent.** A weather
 *   lookup, a document search, and a refactor all ship a `tools` array, so
 *   offering tools resolves to the default plan instead of guessing `coding`.
 *   Only a tool loop *already in flight* — a `tool` message or an assistant
 *   `toolCalls` block — establishes agentic work in fact.
 * - **Short is not bulk.** "yes", "continue", and "what's the status?" are
 *   short. `bulk` requires no history, a short input, *and* an explicitly
 *   declared small output cap, which is the one signal that says the caller
 *   expects cheap work.
 *
 * When the evidence is ambiguous the answer is `default`. Inference can never
 * fail a request: an unmatched, unknown, or unconfigured intent falls through
 * to the default plan.
 */

/** The intent vocabulary. Fixed, so inference and pickers agree on the names. */
export const INTENT_NAMES = ['coding', 'reasoning', 'vision', 'bulk'] as const;

export type IntentName = (typeof INTENT_NAMES)[number];

/**
 * The implicit intent. It is never written under `intents.profiles` — it *is*
 * the base `Policy`, which is what keeps a config without an `intents` block
 * behaving exactly as it does today.
 */
export const DEFAULT_INTENT = 'default' as const;

export type IntentKey = IntentName | typeof DEFAULT_INTENT;

/** Input characters at or above which a request reads as long-context work (≈ 6k tokens). */
export const REASONING_MIN_CHARS = 24_000;

/** Input characters at or below which a request *may* read as bulk work. */
export const BULK_MAX_CHARS = 800;

/**
 * An explicitly declared output cap this small is bulk evidence. The cap has to
 * be *set* — an absent `maxTokens` means the caller said nothing about the size
 * of the work, which is not evidence of cheap work, it is an absence of
 * evidence.
 */
export const BULK_MAX_TOKENS = 256;

/** One policy per intent. A missing key means "no plan of its own". */
export type IntentProfiles = Partial<Record<IntentName, Policy>>;

/** The `intents` block of the config document. Plain data; JSON-safe. */
export interface IntentsConfig {
  /**
   * Infer the intent from the request shape when the caller named none.
   * Default: `true`. `false` restores the pre-intent behavior exactly.
   */
  infer?: boolean;
  /** Per-intent plans. Absent or partial is fine — missing names use `default`. */
  profiles?: IntentProfiles;
}

/** The part of a request that inference is allowed to look at. */
export type IntentShape = Pick<ChatParams, 'messages' | 'tools' | 'maxTokens'>;

/** True when `value` is one of the fixed intent names. */
export function isIntentName(value: unknown): value is IntentName {
  return typeof value === 'string' && (INTENT_NAMES as readonly string[]).includes(value);
}

/** The vocabulary as a display string, for validation messages and pickers. */
export function intentVocabulary(): string {
  return INTENT_NAMES.join(', ');
}

/**
 * Total characters of *textual* input: `text` parts, string contents, and
 * `role:'tool'` contents.
 *
 * Image payloads are excluded on purpose. A single base64 screenshot is
 * millions of characters, so counting it would classify every vision request as
 * long-context and make the `reasoning` threshold meaningless. Characters, not
 * tokens — no tokenizer dependency, matching the `estimateAnthropicInputTokens`
 * convention (chars/4).
 */
export function inputCharacters(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') {
      total += message.content.length;
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') total += part.text.length;
    }
  }
  return total;
}

/** True when any message carries an image part. */
function hasImageContent(messages: readonly ModelMessage[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === 'image' || part.type === 'image-data'),
  );
}

/**
 * True when a tool loop is already in flight. This is the only signal that
 * establishes coding work: the conversation is agentic in fact, not merely
 * capable of being agentic.
 */
function hasToolLoopEvidence(messages: readonly ModelMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'tool' || (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0),
  );
}

/** True when a previous turn was a reasoning turn. */
function hasReasoningHistory(messages: readonly ModelMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      typeof message.reasoningContent === 'string' &&
      message.reasoningContent.length > 0,
  );
}

/** True when the request continues a conversation rather than opening one. */
function hasConversationHistory(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => message.role === 'assistant' || message.role === 'tool');
}

/** Every signal bulk requires. Anything less specific stays on the default plan. */
function isBulkShaped(params: IntentShape, messages: readonly ModelMessage[]): boolean {
  if (hasConversationHistory(messages)) return false;
  if (inputCharacters(messages) > BULK_MAX_CHARS) return false;
  const maxTokens = params.maxTokens;
  return typeof maxTokens === 'number' && maxTokens > 0 && maxTokens <= BULK_MAX_TOKENS;
}

/**
 * Infer the intent of a request from its shape alone. First match wins, and
 * `DEFAULT_INTENT` is the answer whenever the evidence is ambiguous — this
 * never throws and never fails a request.
 */
export function inferIntent(params: IntentShape): IntentKey {
  const messages = params.messages;

  // Vision outranks everything: lane capability is what is being selected here,
  // and only a vision lane can serve a request that carries an image.
  if (hasImageContent(messages)) return 'vision';

  // A tool loop already in flight is evidence of agentic work.
  if (hasToolLoopEvidence(messages)) return 'coding';

  // Tools *offered* is a capability signal, not proof of coding intent. Rather
  // than guess `coding` here, or fall through and guess `reasoning`/`bulk` for a
  // request we already know we cannot classify, hold on the default plan.
  if ((params.tools?.length ?? 0) > 0) return DEFAULT_INTENT;

  if (inputCharacters(messages) >= REASONING_MIN_CHARS || hasReasoningHistory(messages)) {
    return 'reasoning';
  }

  if (isBulkShaped(params, messages)) return 'bulk';

  return DEFAULT_INTENT;
}

/**
 * Whether inference applies at all. The caller composes:
 * `inferenceEnabled(cfg) ? inferIntent(params) : DEFAULT_INTENT`.
 */
export function inferenceEnabled(config: IntentsConfig | undefined): boolean {
  return config?.infer !== false;
}

/**
 * The plan an intent should route through, or `undefined` meaning "no plan of
 * its own — use the base policy". The caller falls back with `?? this.policy`,
 * so a missing profile and an unknown name both degrade to today's behavior
 * instead of erroring.
 */
export function intentPolicy(
  config: IntentsConfig | undefined,
  intent: IntentKey,
): Policy | undefined {
  if (intent === DEFAULT_INTENT) return undefined;
  return config?.profiles?.[intent];
}

/**
 * Shape and name errors for the `intents` block.
 *
 * Needs no provider source, so the config loader can run it before a catalog is
 * warmed. Kept separate from the provider-aware pass so the two can be composed
 * without either one reporting the same typo twice.
 */
export function validateIntentsShape(config: IntentsConfig | undefined): string[] {
  if (config === undefined) return [];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return ['intents must be an object with "infer" and "profiles".'];
  }

  const errors: string[] = [];
  if (config.infer !== undefined && typeof config.infer !== 'boolean') {
    errors.push('intents.infer must be a boolean when set.');
  }

  const profiles = config.profiles;
  if (profiles === undefined) return errors;
  if (typeof profiles !== 'object' || profiles === null || Array.isArray(profiles)) {
    errors.push('intents.profiles must be an object keyed by intent name.');
    return errors;
  }

  for (const name of Object.keys(profiles)) {
    if (!isIntentName(name)) {
      errors.push(`intents.profiles.${name}: unknown intent. Known intents: ${intentVocabulary()}.`);
    }
  }
  return errors;
}

/**
 * Provider-aware checks: every profile's lanes are validated exactly like the
 * base plan's, with the intent path prefixed onto each message
 * (`intents.profiles.coding.trusted[0]: ...`).
 *
 * Unknown profile names are skipped rather than reported — `validateIntentsShape`
 * owns names, so a typo surfaces once. A missing profile is not a problem and is
 * not reported at all.
 */
export function validateIntentProfiles(
  config: IntentsConfig | undefined,
  source: ProviderSource,
): PolicyValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config || typeof config !== 'object') return { errors, warnings };
  const profiles = config.profiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) return { errors, warnings };

  for (const [name, policy] of Object.entries(profiles)) {
    if (!isIntentName(name) || !policy) continue;
    const nested = validatePolicy(policy, source);
    for (const error of nested.errors) errors.push(`intents.profiles.${name}.${error}`);
    for (const warning of nested.warnings) warnings.push(`intents.profiles.${name}.${warning}`);
  }

  return { errors, warnings };
}

/**
 * Validate a whole `intents` block: shape and names, then each profile's lanes
 * against `source`.
 *
 * Unknown profile names are errors — the vocabulary is fixed, so an unknown key
 * is a typo, and silently ignoring it would leave the user with a plan that
 * never routes.
 */
export function validateIntents(
  config: IntentsConfig | undefined,
  source: ProviderSource,
): PolicyValidation {
  const profiles = validateIntentProfiles(config, source);
  return {
    errors: [...validateIntentsShape(config), ...profiles.errors],
    warnings: profiles.warnings,
  };
}
