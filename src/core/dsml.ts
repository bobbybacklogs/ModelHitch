/**
 * Recovery for DeepSeek-family models that emit tool calls as DSML markup in
 * message text instead of populating `tool_calls`.
 *
 * DeepSeek V4 models sometimes write their internal tool-call syntax into the
 * assistant content channel when the request and the model's expectation about
 * available tools disagree (for example a system prompt that advertises a tool
 * the request never declared). The raw markup looks like:
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="bash">
 *   <｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * Variants seen in the wild differ only in the pipe glyphs around the marker
 * (`<||DSML||`, `<｜DSML｜`, `<|DSML|`), because the markers are model-internal
 * special tokens that survive decoding in mangled form. Callers that ignore this
 * ship raw markup to the user; callers that parse it recover a usable tool call.
 */

/** Matches any observed DSML marker spelling, including its leading `<`. */
export const DSML_MARKER_PATTERN = String.raw`<[|｜]{0,2}DSML[|｜]{0,2}`;

/** The marker body only, e.g. `｜DSML｜`, without the surrounding tag brackets. */
const MARKER_BODY = String.raw`[|｜]{0,2}DSML[|｜]{0,2}`;

/** Any DSML marker, anywhere: `hasDsmlMarkup` keys on this. */
const DSML_ANY = new RegExp(DSML_MARKER_PATTERN);

/**
 * The marker is optional in every tag below.
 *
 * DeepSeek emits two spellings of the same markup: the canonical DSML form, and
 * a bare form with the special tokens missing entirely. The bare form is what a
 * client sees when the model's tool-call intent lands in the text channel with
 * no marker tokens surviving decode:
 *
 *   <tool_calls>
 *   <invoke name="exec">
 *   <parameter name="command" string="true">ls -la</parameter>
 *   </invoke>
 *   </tool_calls>
 *
 * Attribute conventions (`string="true"`, named or positional parameters) are
 * identical, so one parser handles both spellings.
 */

/** `<｜DSML｜invoke name="...">` or `<invoke name="...">`. */
const INVOKE_OPEN = new RegExp(
  `<(?:${MARKER_BODY})?invoke\\s+name\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))\\s*>`,
  'g',
);

/** `<｜DSML｜parameter ...attrs...>` or `<parameter ...attrs...>`. */
const PARAMETER_OPEN = new RegExp(`<(?:${MARKER_BODY})?parameter\\s*([^>]*)>`, 'g');

/** Close tags for the two block kinds, with or without the marker. */
const INVOKE_CLOSE = new RegExp(`</(?:${MARKER_BODY})?invoke\\s*>`, 'g');
const PARAMETER_CLOSE = new RegExp(`</(?:${MARKER_BODY})?parameter\\s*>`, 'g');

/**
 * Leftover wrapper tags and unparsed debris. Restricted to the markup's own
 * vocabulary so ordinary prose containing angle brackets survives untouched.
 */
const STRAY_MARKER = new RegExp(
  `</?(?:${MARKER_BODY})?(?:tool_calls|function_calls|invoke|parameter)\\b[^>]*>`,
  'g',
);

/**
 * A markup tag truncated at the end of the response, with no closing `>`:
 * `</tool_calls`, `<parameter name="x"`. Anchored to the end of the string so an
 * unclosed angle bracket inside ordinary prose is never removed.
 */
const UNCLOSED_TAIL_TAG = new RegExp(
  `</?(?:${MARKER_BODY})?(?:tool_calls|function_calls|invoke|parameter)\\b[^>]*$`,
);

/** Attribute parser for a parameter tag. */
const ATTRIBUTE = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export interface RecoveredToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface DsmlRecovery {
  /** Tool calls recovered from markup. */
  toolCalls: RecoveredToolCall[];
  /** Message text with the recovered markup removed. */
  content: string;
  /** True when markup was found, even if no call could be parsed out of it. */
  detected: boolean;
}

/** Tool schema lookup so unnamed positional arguments can be attributed. */
export type ToolSchemaMap = Record<
  string,
  { properties?: Record<string, unknown>; required?: string[] }
>;

/** True when text carries any DSML marker. */
export function hasDsmlMarkup(text: unknown): boolean {
  return typeof text === 'string' && DSML_ANY.test(text);
}

/**
 * A complete bare invoke block: an `<invoke name="...">` opening with its
 * matching `</invoke>` close.
 *
 * Requiring the closing tag is what keeps this from firing on prose that merely
 * mentions the tag names. A model that means to act emits the whole block.
 */
const BARE_INVOKE_BLOCK = new RegExp(
  `<invoke\\s+name\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)\\s*>[\\s\\S]*?</invoke\\s*>`,
);

/**
 * True when text carries tool-call markup in either spelling: the canonical DSML
 * form, or the bare `<invoke>` form DeepSeek emits when the marker special
 * tokens do not survive decoding.
 */
export function hasToolCallMarkup(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return DSML_ANY.test(text) || BARE_INVOKE_BLOCK.test(text);
}

/**
 * Apply markup recovery to a normalized assistant message.
 *
 * Only runs when the provider returned no tool calls: if the model already
 * produced real `tool_calls`, any markup-looking text is genuine message content
 * (for example a user pasting an example) and must be left alone.
 */
export function recoverMessageToolCalls(
  message: { content?: unknown; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> },
  toolSchema?: ToolSchemaMap,
): { content: unknown; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; recovered: boolean } {
  if (message.toolCalls && message.toolCalls.length > 0) {
    return { content: message.content, toolCalls: message.toolCalls, recovered: false };
  }
  const recovery = recoverDsmlToolCalls(message.content, toolSchema);
  if (!recovery.detected) {
    return { content: message.content, toolCalls: message.toolCalls, recovered: false };
  }
  return {
    content: recovery.content,
    toolCalls: recovery.toolCalls.length > 0 ? recovery.toolCalls : undefined,
    recovered: recovery.toolCalls.length > 0,
  };
}

function readAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(tag)) !== null) {
    attrs[(match[1] ?? '').toLowerCase()] = match[2] ?? match[3] ?? '';
  }
  return attrs;
}

function tryJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Coerce a parameter's textual value using DeepSeek's documented convention:
 * the `string` attribute is `"true"` for string parameters (values are written
 * as-is, with no escaping or quotes) and `"false"` for every other type
 * (numbers, booleans, arrays, objects), which are written as JSON.
 *
 * The attribute is sometimes absent or malformed, so fall back to inference.
 */
function coerceParameterValue(raw: string, stringAttr: string | undefined): unknown {
  const value = raw.trim();

  if (stringAttr === 'true') return value;
  if (stringAttr === 'false') {
    const parsed = tryJson(value);
    return parsed !== undefined ? parsed : value;
  }
  // Absent/odd attribute: infer.
  const parsed = tryJson(value);
  return parsed !== undefined ? parsed : value;
}

/** Find the first close tag of `kind` at or after `from`. */
function findClose(text: string, from: number, kind: 'invoke' | 'parameter'): { start: number; end: number } | null {
  const re = kind === 'invoke' ? INVOKE_CLOSE : PARAMETER_CLOSE;
  re.lastIndex = from;
  const match = re.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

/**
 * Conventional primary-argument names, used only when a positional argument
 * cannot be attributed through a declared tool schema (the request advertised a
 * tool it never declared). Without this the recovered call would silently lose
 * its payload.
 */
const PRIMARY_ARGUMENT_HINTS: Array<[RegExp, string]> = [
  [/^(?:bash|sh|shell|zsh|exec|run|run_command|execute|terminal|command)/i, 'command'],
  [/^(?:read|read_file|view|cat|open_file|open)/i, 'file_path'],
  [/^(?:write|write_file|edit|edit_file|create|apply_patch)/i, 'file_path'],
  [/^(?:glob|find|list|ls|search_files|list_dir)/i, 'pattern'],
  [/^(?:grep|search|rg)/i, 'query'],
  [/^(?:fetch|http|request|get_url|web_fetch|curl)/i, 'url'],
];

function primaryArgumentName(toolName: string): string {
  for (const [pattern, argName] of PRIMARY_ARGUMENT_HINTS) {
    if (pattern.test(toolName)) return argName;
  }
  return 'input';
}

/** Parse one `invoke` body into a name/arguments pair. */
function parseInvokeBody(body: string, name: string, toolSchema?: ToolSchemaMap): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  /** Unnamed values, in document order, as the model's positional indexes. */
  const positionals: string[] = [];
  let sawNamed = false;

  PARAMETER_OPEN.lastIndex = 0;
  let param: RegExpExecArray | null;
  while ((param = PARAMETER_OPEN.exec(body)) !== null) {
    const attrs = readAttributes(param[1] ?? '');
    const valueStart = param.index + param[0].length;
    const close = findClose(body, valueStart, 'parameter');
    const rawValue = body.slice(valueStart, close === null ? body.length : close.start);
    // Unnamed parameters use a positional index, e.g. `string="0"`.
    if (attrs.name) {
      sawNamed = true;
      params[attrs.name] = coerceParameterValue(rawValue, attrs.string);
    } else {
      positionals.push(rawValue);
    }
    PARAMETER_OPEN.lastIndex = close === null ? body.length : close.end;
  }

  if (positionals.length > 0) {
    const schema = toolSchema?.[name];
    // Prefer the schema's required list, then its remaining properties.
    const ordered = [
      ...(schema?.required ?? []),
      ...Object.keys(schema?.properties ?? {}).filter((k) => !(schema?.required ?? []).includes(k)),
    ];
    if (ordered.length === 0 && !sawNamed) {
      // No schema to attribute against: keep the payload under the tool's
      // conventional primary argument so the call is still actionable.
      params[primaryArgumentName(name)] = coerceParameterValue(positionals[0] ?? '', undefined);
    } else {
      positionals.forEach((raw, index) => {
        const key = ordered[index];
        if (key && !(key in params)) params[key] = coerceParameterValue(raw, undefined);
      });
    }
  }

  return params;
}

/**
 * Recover tool calls from tool-call markup in assistant text, in either the
 * DSML-tagged or bare `<invoke>` spelling.
 *
 * `toolSchema` maps tool name to its JSON schema so unnamed positional arguments
 * can be attributed to the schema's first required property.
 */
export function recoverDsmlToolCalls(text: unknown, toolSchema?: ToolSchemaMap): DsmlRecovery {
  const original = typeof text === 'string' ? text : '';
  if (!hasToolCallMarkup(original)) {
    return { toolCalls: [], content: original, detected: false };
  }

  const toolCalls: RecoveredToolCall[] = [];
  let out = '';
  let cursor = 0;

  INVOKE_OPEN.lastIndex = 0;
  let invoke: RegExpExecArray | null;
  while ((invoke = INVOKE_OPEN.exec(original)) !== null) {
    const name = invoke[1] ?? invoke[2] ?? invoke[3] ?? '';
    const bodyStart = invoke.index + invoke[0].length;
    const close = findClose(original, bodyStart, 'invoke');
    const bodyEnd = close ? close.start : original.length;
    const end = close ? close.end : original.length;

    out += original.slice(cursor, invoke.index);
    if (name) {
      toolCalls.push({
        id: `dsml_call_${toolCalls.length}`,
        name,
        arguments: parseInvokeBody(original.slice(bodyStart, bodyEnd), name, toolSchema),
      });
    }
    cursor = end;
    INVOKE_OPEN.lastIndex = end;
  }
  out += original.slice(cursor);

  // Drop wrapper markers and any unparsed invoke/parameter debris.
  out = out.replace(STRAY_MARKER, '');
  // A truncated response can end mid-tag, as in a trailing `</tool_calls` with
  // no closing `>`. `STRAY_MARKER` requires the `>`, so that fragment survives
  // it and would ship as debris. Only a tag at the very end is treated this
  // way, so an unclosed tag inside real prose is left alone.
  out = out.replace(UNCLOSED_TAIL_TAG, '');

  return {
    toolCalls,
    content: out.replace(/\n{3,}/g, '\n\n').trim(),
    detected: true,
  };
}

/** Build a schema lookup from normalized tool definitions. */
export function toolSchemaFromDefinitions(
  tools: Array<{ name: string; parameters?: Record<string, unknown> }> | undefined,
): ToolSchemaMap | undefined {
  if (!tools || tools.length === 0) return undefined;
  const map: ToolSchemaMap = {};
  for (const tool of tools) {
    const params = tool.parameters;
    if (!params || typeof params !== 'object') {
      map[tool.name] = {};
      continue;
    }
    const properties = params.properties;
    const required = params.required;
    map[tool.name] = {
      properties: properties && typeof properties === 'object' ? (properties as Record<string, unknown>) : undefined,
      required: Array.isArray(required) ? required.filter((r): r is string => typeof r === 'string') : undefined,
    };
  }
  return map;
}

/** Block names that begin tool-call markup, in either marker spelling. */
const MARKUP_WORDS = ['tool_calls', 'function_calls', 'invoke', 'parameter'] as const;

/** A complete marker body at the start of a tag's name, e.g. `｜DSML｜`. */
const LEADING_MARKER_BODY = new RegExp(`^${MARKER_BODY}`);

/** Every character that can appear while a marker body is still forming. */
const MARKER_CHARS = /^[|｜DSML]*$/;

type OpeningProbe = 'none' | 'partial' | 'open';

/**
 * Classify a tail that starts at a `<`, to decide whether it could begin
 * tool-call markup.
 *
 * `partial` means the tail is still too short to rule markup in or out, so it
 * must be held back. `open` means an actual markup block has started, so
 * everything from here on must be withheld from the text channel.
 */
function probeMarkupOpening(tail: string): OpeningProbe {
  if (!tail.startsWith('<')) return 'none';
  let rest = tail.slice(1);
  // Closing tags and self-closing fragments never start markup we hold for.
  if (rest.startsWith('/')) return 'none';
  rest = rest.replace(LEADING_MARKER_BODY, '');

  if (rest.length === 0) return 'partial';
  if (MARKER_CHARS.test(rest)) return 'partial';

  for (const word of MARKUP_WORDS) {
    if (rest.startsWith(word)) return 'open';
    if (word.startsWith(rest)) return 'partial';
  }
  return 'none';
}

/**
 * Streaming guard that keeps incremental text output while recovering tool-call
 * markup.
 *
 * Text is emitted as it arrives, except that a tail which could still grow into
 * a markup block is held back. Once a block actually opens, nothing more is
 * emitted; `finish()` then recovers tool calls and returns whatever prose
 * surrounded them. If the stream ends with markup opened but no complete block,
 * `finish()` releases the held text rather than swallowing it.
 */
export class DsmlStreamGuard {
  private buffer = '';
  private readonly toolSchema: ToolSchemaMap | undefined;
  private detected = false;
  private holding = false;

  constructor(toolSchema?: ToolSchemaMap) {
    this.toolSchema = toolSchema;
  }

  /** True once tool-call markup has been seen in the stream. */
  get isDsml(): boolean {
    return this.detected;
  }

  /** Index from which the buffer must not be emitted yet. */
  private holdIndex(buffer: string): number {
    if (this.holding) return 0;
    // Walk candidate '<' positions back to front. The loop is explicit rather
    // than a `for` update because `lastIndexOf('<', -1)` clamps to 0 and would
    // return the same index forever whenever the buffer starts with a '<' that
    // is not markup, such as `<div`.
    let i = buffer.lastIndexOf('<');
    while (i !== -1) {
      const probe = probeMarkupOpening(buffer.slice(i));
      if (probe === 'open') {
        this.holding = true;
        return i;
      }
      if (probe === 'partial') return i;
      if (i === 0) break;
      i = buffer.lastIndexOf('<', i - 1);
    }
    return buffer.length;
  }

  /** Feed a text delta; returns the text safe to emit immediately. */
  push(delta: string): string {
    if (!delta) return '';
    this.buffer += delta;
    if (this.detected || this.holding) {
      // Markup may now be complete; detection is what finish() acts on.
      if (!this.detected && hasToolCallMarkup(this.buffer)) this.detected = true;
      return '';
    }
    if (hasToolCallMarkup(this.buffer)) {
      this.detected = true;
      return '';
    }

    const cut = this.holdIndex(this.buffer);
    const emit = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return emit;
  }

  /**
   * Flush at end of stream. Returns any remaining prose plus recovered tool
   * calls when markup was present.
   *
   * When markup opened but never completed, the held text is released rather
   * than dropped: a partial fragment is prose the caller still needs to see.
   */
  finish(): { text: string; toolCalls: RecoveredToolCall[]; detected: boolean } {
    if (!this.detected) {
      const text = this.buffer;
      this.buffer = '';
      this.holding = false;
      return { text, toolCalls: [], detected: false };
    }

    const recovery = recoverDsmlToolCalls(this.buffer, this.toolSchema);
    this.buffer = '';
    this.holding = false;
    return { text: recovery.content, toolCalls: recovery.toolCalls, detected: true };
  }
}
