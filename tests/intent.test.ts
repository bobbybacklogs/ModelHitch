import { describe, expect, it } from 'vitest';
import {
  BULK_MAX_CHARS,
  BULK_MAX_TOKENS,
  DEFAULT_INTENT,
  INTENT_NAMES,
  REASONING_MIN_CHARS,
  inferenceEnabled,
  inferIntent,
  inputCharacters,
  intentPolicy,
  intentVocabulary,
  isIntentName,
  validateIntents,
  type IntentShape,
} from '../src/core/intent.js';
import { createRegistrySource, type Policy, type Provider } from '../src/index.js';
import { validateConfig, validateConfigWithSource } from '../src/config.js';
import type { ModelMessage } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const user = (content: string): ModelMessage => ({ role: 'user', content });
const imageUser = (): ModelMessage => ({
  role: 'user',
  content: [
    { type: 'text', text: 'what is this' },
    { type: 'image', imageUrl: 'https://example.test/shot.png' },
  ],
});
const imageDataUser = (): ModelMessage => ({
  role: 'user',
  content: [{ type: 'image-data', data: 'AAAA', mimeType: 'image/png' }],
});
const assistantToolCall = (): ModelMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }],
});
const toolResult = (): ModelMessage => ({ role: 'tool', content: 'file contents', toolCallId: 'c1' });
const assistantThinking = (): ModelMessage => ({
  role: 'assistant',
  content: 'done',
  reasoningContent: 'weighing options',
});
const assistantPlain = (): ModelMessage => ({ role: 'assistant', content: 'sure' });

const someTools = (count = 1) => Array.from({ length: count }, (_, i) => ({ name: `tool_${i}` }));

/** A request shape with only the fields inference looks at. */
const shape = (overrides: Partial<IntentShape> = {}): IntentShape => ({
  messages: [user('hello')],
  ...overrides,
});

const longText = (chars: number): string => 'x'.repeat(chars);

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('intent vocabulary', () => {
  it('is fixed and excludes the implicit default', () => {
    expect(INTENT_NAMES).toEqual(['coding', 'reasoning', 'vision', 'bulk']);
    expect(INTENT_NAMES).not.toContain(DEFAULT_INTENT);
  });

  it('recognizes exactly the vocabulary', () => {
    for (const name of INTENT_NAMES) expect(isIntentName(name)).toBe(true);
    expect(isIntentName(DEFAULT_INTENT)).toBe(false);
    expect(isIntentName('refactor')).toBe(false);
    expect(isIntentName('')).toBe(false);
    expect(isIntentName(undefined)).toBe(false);
    expect(isIntentName(42)).toBe(false);
  });

  it('renders the vocabulary for messages and pickers', () => {
    expect(intentVocabulary()).toBe('coding, reasoning, vision, bulk');
  });
});

// ---------------------------------------------------------------------------
// inputCharacters
// ---------------------------------------------------------------------------

describe('inputCharacters', () => {
  it('counts string contents', () => {
    expect(inputCharacters([user('abcde'), assistantPlain()])).toBe(9);
  });

  it('counts text parts and tool results', () => {
    expect(inputCharacters([imageUser(), toolResult()])).toBe('what is this'.length + 'file contents'.length);
  });

  it('excludes image payloads so a screenshot cannot read as long-context', () => {
    const withImage = inputCharacters([imageDataUser()]);
    expect(withImage).toBe(0);

    const huge = 'A'.repeat(5_000_000);
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'image-data', data: huge, mimeType: 'image/png' }] },
    ];
    expect(inputCharacters(messages)).toBe(0);
    expect(inferIntent({ messages })).toBe('vision');
  });

  it('is zero for an empty conversation', () => {
    expect(inputCharacters([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// inferIntent — vision
// ---------------------------------------------------------------------------

describe('inferIntent — vision', () => {
  it('detects an image part', () => {
    expect(inferIntent(shape({ messages: [imageUser()] }))).toBe('vision');
  });

  it('detects base64 image data', () => {
    expect(inferIntent(shape({ messages: [imageDataUser()] }))).toBe('vision');
  });

  it('outranks tools, a tool loop, and long context', () => {
    expect(inferIntent(shape({ messages: [imageUser()], tools: someTools() }))).toBe('vision');
    expect(inferIntent(shape({ messages: [assistantToolCall(), toolResult(), imageUser()] }))).toBe('vision');
    expect(inferIntent(shape({ messages: [user(longText(REASONING_MIN_CHARS + 1)), imageUser()] }))).toBe('vision');
  });
});

// ---------------------------------------------------------------------------
// inferIntent — coding
// ---------------------------------------------------------------------------

describe('inferIntent — coding', () => {
  it('detects a tool loop already in flight', () => {
    expect(inferIntent(shape({ messages: [user('fix the test'), assistantToolCall(), toolResult()] }))).toBe('coding');
  });

  it('detects an assistant tool call even without a result yet', () => {
    expect(inferIntent(shape({ messages: [user('fix it'), assistantToolCall()] }))).toBe('coding');
  });

  it('outranks long context once a loop exists', () => {
    const messages = [user(longText(REASONING_MIN_CHARS + 1)), assistantToolCall(), toolResult()];
    expect(inferIntent(shape({ messages }))).toBe('coding');
  });
});

// ---------------------------------------------------------------------------
// inferIntent — tools are a capability signal, not coding intent
// ---------------------------------------------------------------------------

describe('inferIntent — tools alone stay on the default plan', () => {
  it('does not infer coding from an offered tools array', () => {
    expect(inferIntent(shape({ messages: [user('weather in Lisbon?')], tools: someTools() }))).toBe(DEFAULT_INTENT);
  });

  it('does not fall through to reasoning for a long request with tools', () => {
    const messages = [user(longText(REASONING_MIN_CHARS + 5_000))];
    expect(inferIntent(shape({ messages, tools: someTools() }))).toBe(DEFAULT_INTENT);
  });

  it('does not fall through to bulk for a short capped request with tools', () => {
    const messages = [user('hi')];
    expect(inferIntent(shape({ messages, tools: someTools(), maxTokens: 128 }))).toBe(DEFAULT_INTENT);
  });

  it('treats an empty tools array as no tools', () => {
    const messages = [user(longText(REASONING_MIN_CHARS))];
    expect(inferIntent(shape({ messages, tools: [] }))).toBe('reasoning');
  });
});

// ---------------------------------------------------------------------------
// inferIntent — reasoning
// ---------------------------------------------------------------------------

describe('inferIntent — reasoning', () => {
  it('detects long input at the threshold', () => {
    const messages = [user(longText(REASONING_MIN_CHARS))];
    expect(inputCharacters(messages)).toBe(REASONING_MIN_CHARS);
    expect(inferIntent(shape({ messages }))).toBe('reasoning');
  });

  it('rejects input just below the threshold with no other signal', () => {
    const messages = [user(longText(REASONING_MIN_CHARS - 1))];
    expect(inferIntent(shape({ messages }))).toBe(DEFAULT_INTENT);
  });

  it('detects a reasoning turn in history', () => {
    expect(inferIntent(shape({ messages: [user('keep going'), assistantThinking()] }))).toBe('reasoning');
  });
});

// ---------------------------------------------------------------------------
// inferIntent — bulk needs declared low-complexity work
// ---------------------------------------------------------------------------

describe('inferIntent — bulk requires all three signals', () => {
  const bulkShape = (overrides: Partial<IntentShape> = {}): IntentShape =>
    shape({ messages: [user('translate: hello')], maxTokens: 128, ...overrides });

  it('infers bulk from a one-shot, short, explicitly capped request', () => {
    expect(inferIntent(bulkShape())).toBe('bulk');
    expect(inferIntent(bulkShape({ maxTokens: 1 }))).toBe('bulk');
    expect(inferIntent(bulkShape({ maxTokens: BULK_MAX_TOKENS }))).toBe('bulk');
  });

  it('does not infer bulk from brevity alone', () => {
    expect(inferIntent(shape({ messages: [user('yes')] }))).toBe(DEFAULT_INTENT);
    expect(inferIntent(shape({ messages: [user('continue')] }))).toBe(DEFAULT_INTENT);
  });

  it('does not infer bulk without an explicit output cap', () => {
    expect(inferIntent(shape({ messages: [user('hi')] }))).toBe(DEFAULT_INTENT);
  });

  it('does not infer bulk from a cap that is not small', () => {
    expect(inferIntent(bulkShape({ maxTokens: BULK_MAX_TOKENS + 1 }))).toBe(DEFAULT_INTENT);
    expect(inferIntent(bulkShape({ maxTokens: 4_096 }))).toBe(DEFAULT_INTENT);
  });

  it('ignores a non-positive cap', () => {
    expect(inferIntent(bulkShape({ maxTokens: 0 }))).toBe(DEFAULT_INTENT);
    expect(inferIntent(bulkShape({ maxTokens: -1 }))).toBe(DEFAULT_INTENT);
  });

  it('does not infer bulk once there is conversation history', () => {
    const messages = [assistantPlain(), user('ok')];
    expect(inferIntent(shape({ messages, maxTokens: 64 }))).toBe(DEFAULT_INTENT);
  });

  it('rejects input above the character ceiling', () => {
    const messages = [user(longText(BULK_MAX_CHARS + 1))];
    expect(inferIntent(shape({ messages, maxTokens: 64 }))).toBe(DEFAULT_INTENT);
    expect(inferIntent(shape({ messages: [user(longText(BULK_MAX_CHARS))], maxTokens: 64 }))).toBe('bulk');
  });
});

// ---------------------------------------------------------------------------
// inferIntent — fallback
// ---------------------------------------------------------------------------

describe('inferIntent — default plan', () => {
  it('is the answer for a plain request', () => {
    expect(inferIntent(shape())).toBe(DEFAULT_INTENT);
  });

  it('is the answer for an empty conversation', () => {
    expect(inferIntent({ messages: [] })).toBe(DEFAULT_INTENT);
  });

  it('never throws on an unclassifiable request', () => {
    const weird = shape({ messages: [{ role: 'tool', content: '', toolCallId: '' }] });
    expect(() => inferIntent(weird)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// inferenceEnabled
// ---------------------------------------------------------------------------

describe('inferenceEnabled', () => {
  it('defaults to on', () => {
    expect(inferenceEnabled(undefined)).toBe(true);
    expect(inferenceEnabled({})).toBe(true);
    expect(inferenceEnabled({ infer: true })).toBe(true);
  });

  it('is off only when explicitly disabled', () => {
    expect(inferenceEnabled({ infer: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// intentPolicy
// ---------------------------------------------------------------------------

describe('intentPolicy', () => {
  const coding: Policy = { trusted: [{ providerId: 'alpha' }], fallback: [] };
  const config = { infer: true, profiles: { coding } };

  it('returns the configured plan for a named intent', () => {
    expect(intentPolicy(config, 'coding')).toBe(coding);
  });

  it('returns undefined for the default intent — the caller keeps the base policy', () => {
    expect(intentPolicy(config, DEFAULT_INTENT)).toBeUndefined();
  });

  it('returns undefined for an unconfigured intent, so it degrades to the base policy', () => {
    expect(intentPolicy(config, 'vision')).toBeUndefined();
    expect(intentPolicy(config, 'reasoning')).toBeUndefined();
    expect(intentPolicy(config, 'bulk')).toBeUndefined();
  });

  it('returns undefined when there is no intents block at all', () => {
    expect(intentPolicy(undefined, 'coding')).toBeUndefined();
    expect(intentPolicy({}, 'coding')).toBeUndefined();
    expect(intentPolicy({ profiles: {} }, 'coding')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateIntents
// ---------------------------------------------------------------------------

function fakeProvider(id: string, defaultModel: string): Provider {
  return {
    id,
    name: id,
    defaultModel,
    capabilities: { streaming: true, toolCalling: true, vision: true, embeddings: false },
    chat: async () => ({ message: { role: 'assistant', content: `ok-${id}` }, finishReason: 'stop' }),
    stream: async function* () {
      yield { type: 'finish', finishReason: 'stop' };
    },
  };
}

const source = createRegistrySource([
  fakeProvider('alpha', 'a-model'),
  fakeProvider('beta', 'b-model'),
]);

describe('validateIntents', () => {
  it('accepts an absent block', () => {
    expect(validateIntents(undefined, source)).toEqual({ errors: [], warnings: [] });
  });

  it('accepts an empty block', () => {
    expect(validateIntents({}, source)).toEqual({ errors: [], warnings: [] });
  });

  it('accepts a configured profile', () => {
    const config = { infer: true, profiles: { coding: { trusted: [{ providerId: 'alpha' }], fallback: [] } } };
    expect(validateIntents(config, source).errors).toEqual([]);
  });

  it('accepts an entirely missing profile — a partial vocabulary is fine', () => {
    const config = { profiles: { coding: { trusted: [{ providerId: 'beta', models: ['b-model'] }], fallback: [] } } };
    const { errors } = validateIntents(config, source);
    expect(errors).toEqual([]);
  });

  it('rejects a non-object block or profiles', () => {
    expect(validateIntents([] as never, source).errors[0]).toContain('intents must be an object');
    expect(validateIntents({ profiles: [] as never }, source).errors[0]).toContain(
      'intents.profiles must be an object',
    );
  });

  it('rejects a non-boolean infer flag', () => {
    const { errors } = validateIntents({ infer: 'yes' as never }, source);
    expect(errors).toEqual(['intents.infer must be a boolean when set.']);
  });

  it('rejects an unknown intent name and names the vocabulary', () => {
    const config = { profiles: { refactor: { trusted: [{ providerId: 'alpha' }], fallback: [] } } };
    const { errors } = validateIntents(config as never, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('intents.profiles.refactor');
    expect(errors[0]).toContain('unknown intent');
    expect(errors[0]).toContain(intentVocabulary());
  });

  it('does not accept "default" as a profile name — it is the base policy', () => {
    const config = { profiles: { default: { trusted: [{ providerId: 'alpha' }], fallback: [] } } };
    const { errors } = validateIntents(config as never, source);
    expect(errors[0]).toContain('unknown intent');
  });

  it('prefixes nested policy errors with the intent path', () => {
    const config = {
      profiles: { coding: { trusted: [{ providerId: 'nope' }], fallback: [] } },
    };
    const { errors } = validateIntents(config as never, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('intents.profiles.coding.trusted[0]');
    expect(errors[0]).toContain('unknown provider "nope"');
    expect(errors[0]).toContain('alpha, beta');
  });

  it('validates each profile like the base plan — an empty plan is still an error', () => {
    const config = { profiles: { bulk: { trusted: [], fallback: [] } } };
    const { errors } = validateIntents(config as never, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('intents.profiles.bulk');
    expect(errors[0]).toContain('at least one entry');
  });

  it('reports every bad profile, not just the first', () => {
    const config = {
      profiles: {
        refactor: { trusted: [], fallback: [] },
        coding: { trusted: [{ providerId: 'nope' }], fallback: [] },
        vision: { trusted: [{ providerId: 'alpha' }], fallback: [] },
      },
    };
    const { errors } = validateIntents(config as never, source);
    expect(errors).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The config document — the loader path (docs/intent-rotation.md §5)
// ---------------------------------------------------------------------------

const codingPlan = { trusted: [{ providerId: 'alpha' }], fallback: [] };

describe('intents in the config document', () => {
  it('accepts a well-formed block', () => {
    const config = { version: 1, intents: { infer: true, profiles: { coding: codingPlan } } };
    expect(validateConfig(config).errors).toEqual([]);
  });

  it('accepts a document with no intents block at all', () => {
    expect(validateConfig({ version: 1 }).errors).toEqual([]);
  });

  it('reports an unknown profile name without needing a provider source', () => {
    // This is the startup path: the loader validates before any catalog exists,
    // so shape and names have to be caught here or not at all.
    const config = { version: 1, intents: { profiles: { refactor: codingPlan } } };
    const { errors } = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('intents.profiles.refactor');
    expect(errors[0]).toContain('unknown intent');
  });

  it('reports a malformed profile without needing a provider source', () => {
    const missing = validateConfig({ version: 1, intents: { profiles: { bulk: {} } } });
    expect(missing.errors[0]).toContain('intents.profiles.bulk must have trusted[] and fallback[] arrays.');

    const empty = validateConfig({ version: 1, intents: { profiles: { bulk: { trusted: [], fallback: [] } } } });
    expect(empty.errors[0]).toContain('must have at least one entry in trusted or fallback.');
  });

  it('reports a non-boolean infer flag', () => {
    const { errors } = validateConfig({ version: 1, intents: { infer: 'yes' } });
    expect(errors).toContain('intents.infer must be a boolean when set.');
  });

  it('reports an unknown provider in a profile once a source is available', () => {
    const config = {
      version: 1,
      intents: { profiles: { coding: { trusted: [{ providerId: 'nope' }], fallback: [] } } },
    };
    const { errors } = validateConfigWithSource(config as never, source);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('intents.profiles.coding.trusted[0]');
    expect(errors[0]).toContain('unknown provider "nope"');
  });

  it('does not report a name twice when both passes run', () => {
    const config = {
      version: 1,
      intents: { profiles: { refactor: { trusted: [{ providerId: 'nope' }], fallback: [] } } },
    };
    const { errors } = validateConfigWithSource(config as never, source);
    // The typo is the only problem worth naming; the profile inside it is never
    // validated, so it cannot add a second complaint about the same line.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('intents.profiles.refactor');
  });

  it('leaves the base plan alone', () => {
    const config = {
      version: 1,
      policy: { trusted: [{ providerId: 'alpha' }], fallback: [] },
      intents: { profiles: { coding: codingPlan } },
    };
    const { errors } = validateConfigWithSource(config as never, source);
    expect(errors).toEqual([]);
  });
});
