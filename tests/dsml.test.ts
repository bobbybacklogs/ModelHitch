import { describe, expect, it } from 'vitest';
import {
  DsmlStreamGuard,
  hasDsmlMarkup,
  hasToolCallMarkup,
  recoverDsmlToolCalls,
  recoverMessageToolCalls,
  toolSchemaFromDefinitions,
  type RecoveredToolCall,
} from '../src/core/dsml.js';

const TOKEN = '\uFF5C'; // ｜ fullwidth vertical line, as DeepSeek emits it
const OPEN = (kind: string) => `<${TOKEN}DSML${TOKEN}${kind}>`;
const CLOSE = (kind: string) => `</${TOKEN}DSML${TOKEN}${kind}>`;

/** Build markup the way DeepSeek's own encoder does. */
function markup(invokes: string): string {
  return `${OPEN('function_calls')}\n${invokes}\n${CLOSE('function_calls')}`;
}

function invoke(name: string, params: string): string {
  return `${OPEN(`invoke name="${name}"`)}\n${params}\n${CLOSE('invoke')}`;
}

function param(name: string, value: string, isString = true): string {
  return `${OPEN(`parameter name="${name}" string="${isString}"`)}${value}${CLOSE('parameter')}`;
}

/** Read the single recovered call, failing loudly if recovery produced none. */
function only(calls: RecoveredToolCall[]): RecoveredToolCall {
  const [first] = calls;
  if (!first) throw new Error(`expected one recovered call, got ${calls.length}`);
  return first;
}

describe('hasDsmlMarkup', () => {
  it('detects every observed marker spelling', () => {
    for (const marker of [
      `<${TOKEN}DSML${TOKEN}function_calls>`,
      '<|DSML|function_calls>',
      '<||DSML||function_calls>',
      '<|DSML|tool_calls>',
      `<${TOKEN}DSML${TOKEN}tool_calls>`,
    ]) {
      expect(hasDsmlMarkup(marker)).toBe(true);
    }
  });

  it('ignores ordinary text and non-strings', () => {
    expect(hasDsmlMarkup('just a normal answer about <div> tags')).toBe(false);
    expect(hasDsmlMarkup(undefined)).toBe(false);
    expect(hasDsmlMarkup(null)).toBe(false);
  });
});

describe('recoverDsmlToolCalls', () => {
  it('recovers a named string parameter', () => {
    const text = `Let me check.\n\n${markup(invoke('bash', param('command', 'ls -la')))}`;
    const result = recoverDsmlToolCalls(text);

    expect(result.detected).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(only(result.toolCalls).name).toBe('bash');
    expect(only(result.toolCalls).arguments).toEqual({ command: 'ls -la' });
    expect(result.content).toBe('Let me check.');
  });

  it('recovers multiple invokes as separate calls', () => {
    const text = markup(
      invoke('bash', param('command', 'find . -maxdepth 2')) +
        '\n' +
        invoke('bash', param('command', 'pwd && ls -la')),
    );
    const result = recoverDsmlToolCalls(text);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((c) => c.arguments)).toEqual([
      { command: 'find . -maxdepth 2' },
      { command: 'pwd && ls -la' },
    ]);
    expect(only(result.toolCalls).id).not.toBe(result.toolCalls[1]?.id);
    expect(result.content).toBe('');
  });

  it('leaves no markup behind in the content', () => {
    const result = recoverDsmlToolCalls(markup(invoke('bash', param('command', 'ls'))));
    expect(result.content).not.toMatch(/DSML/);
    expect(result.content).toBe('');
  });

  it('honours string="false" by JSON-decoding the value', () => {
    const text = markup(
      invoke(
        'search',
        [param('limit', '25', false), param('recursive', 'true', false), param('tags', '["a","b"]', false)].join('\n'),
      ),
    );
    const result = recoverDsmlToolCalls(text);

    expect(only(result.toolCalls).arguments).toEqual({ limit: 25, recursive: true, tags: ['a', 'b'] });
  });

  it('keeps string="true" values verbatim, including JSON-looking text', () => {
    const text = markup(invoke('write', param('content', '{"not":"parsed"}', true)));
    const result = recoverDsmlToolCalls(text);

    expect(only(result.toolCalls).arguments).toEqual({ content: '{"not":"parsed"}' });
  });

  it('preserves multi-line string values and trims surrounding newlines', () => {
    const body = 'line one\nline two\n  indented';
    const text = markup(invoke('write', param('content', `\n${body}\n`)));
    const result = recoverDsmlToolCalls(text);

    expect(only(result.toolCalls).arguments.content).toBe(body);
  });

  it('maps a lone unnamed positional parameter onto the schema', () => {
    // Observed in the wild: the model emits string="0" with no name attribute.
    const text = markup(
      `${OPEN('invoke name="bash"')}\n${OPEN('parameter string="0"')}\nls -la\n${CLOSE('parameter')}\n${CLOSE('invoke')}`,
    );
    const schema = { bash: { properties: { command: { type: 'string' } }, required: ['command'] } };
    const result = recoverDsmlToolCalls(text, schema);

    expect(only(result.toolCalls).arguments).toEqual({ command: 'ls -la' });
  });

  it('maps multiple positional parameters onto the schema in order', () => {
    const text = markup(
      `${OPEN('invoke name="edit"')}\n` +
        `${OPEN('parameter string="0"')}\nfile.txt\n${CLOSE('parameter')}\n` +
        `${OPEN('parameter string="1"')}\nnew body\n${CLOSE('parameter')}\n` +
        `${CLOSE('invoke')}`,
    );
    const schema = { edit: { properties: { file_path: {}, content: {} }, required: ['file_path', 'content'] } };

    expect(only(recoverDsmlToolCalls(text, schema).toolCalls).arguments).toEqual({
      file_path: 'file.txt',
      content: 'new body',
    });
  });

  it('keeps the payload when no schema was declared', () => {
    // A system prompt that promises a tool the request never declares makes the
    // model emit positional markup; dropping it would lose the command.
    const text = markup(
      `${OPEN('invoke name="Bash"')}\n${OPEN('parameter string="0"')}\nls -la\n${CLOSE('parameter')}\n${CLOSE('invoke')}`,
    );

    expect(only(recoverDsmlToolCalls(text).toolCalls).arguments).toEqual({ command: 'ls -la' });
    expect(only(recoverDsmlToolCalls(text, {}).toolCalls).arguments).toEqual({ command: 'ls -la' });
  });

  it('prefers named parameters over the schema fallback', () => {
    const text = markup(invoke('bash', param('command', 'ls -la')));
    const schema = { bash: { properties: { command: {} }, required: ['command'] } };

    expect(only(recoverDsmlToolCalls(text, schema).toolCalls).arguments).toEqual({ command: 'ls -la' });
  });

  it('handles the tool_calls wrapper spelling', () => {
    const text = `${OPEN('tool_calls')}\n${invoke('bash', param('command', 'pwd'))}\n${CLOSE('tool_calls')}`;
    const result = recoverDsmlToolCalls(text);

    expect(result.toolCalls).toHaveLength(1);
    expect(only(result.toolCalls).arguments).toEqual({ command: 'pwd' });
    expect(result.content).toBe('');
  });

  it('handles ASCII pipe markers', () => {
    const text =
      '<|DSML|function_calls>\n<|DSML|invoke name="bash">\n<|DSML|parameter name="command" string="true">pwd</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|function_calls>';
    const result = recoverDsmlToolCalls(text);

    expect(result.toolCalls).toHaveLength(1);
    expect(only(result.toolCalls).arguments).toEqual({ command: 'pwd' });
  });

  it('reports detection but no calls when markup is unparseable', () => {
    const result = recoverDsmlToolCalls(`${OPEN('function_calls')}\nno invokes here\n${CLOSE('function_calls')}`);

    expect(result.detected).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toBe('no invokes here');
  });

  it('is a no-op on plain text', () => {
    const result = recoverDsmlToolCalls('nothing to see');
    expect(result.detected).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toBe('nothing to see');
  });
});

describe('recoverMessageToolCalls', () => {
  const schema = toolSchemaFromDefinitions([
    { name: 'bash', parameters: { properties: { command: { type: 'string' } }, required: ['command'] } },
  ]);

  it('recovers when the provider returned no tool calls', () => {
    const result = recoverMessageToolCalls({ content: markup(invoke('bash', param('command', 'ls'))) }, schema);

    expect(result.recovered).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.content).toBe('');
  });

  it('never touches real tool calls', () => {
    const real = [{ id: 'call_1', name: 'bash', arguments: { command: 'ls' } }];
    const result = recoverMessageToolCalls(
      { content: `example markup: ${markup(invoke('bash', param('command', 'ls')))}`, toolCalls: real },
      schema,
    );

    expect(result.recovered).toBe(false);
    expect(result.toolCalls).toBe(real);
    expect(result.content).toContain('example markup');
  });

  it('leaves content intact when there is no markup', () => {
    const result = recoverMessageToolCalls({ content: 'all done' }, schema);
    expect(result.recovered).toBe(false);
    expect(result.content).toBe('all done');
  });
});

describe('toolSchemaFromDefinitions', () => {
  it('returns undefined for no tools', () => {
    expect(toolSchemaFromDefinitions(undefined)).toBeUndefined();
    expect(toolSchemaFromDefinitions([])).toBeUndefined();
  });

  it('maps names to properties and required lists', () => {
    const map = toolSchemaFromDefinitions([
      { name: 'a', parameters: { properties: { x: {} }, required: ['x'] } },
      { name: 'b' },
    ]);
    const entry = map?.a;
    if (!entry) throw new Error('expected a schema entry for tool "a"');

    expect(entry.required).toEqual(['x']);
    expect(entry.properties).toEqual({ x: {} });
    expect(map?.b).toEqual({ properties: undefined, required: undefined });
  });
});

describe('DsmlStreamGuard', () => {
  it('passes plain text through incrementally', () => {
    const guard = new DsmlStreamGuard();
    expect(guard.push('Hello ')).toBe('Hello ');
    expect(guard.push('world')).toBe('world');
    expect(guard.isDsml).toBe(false);

    const end = guard.finish();
    expect(end.text).toBe('');
    expect(end.detected).toBe(false);
  });

  it('holds back a partial marker split across deltas and still recovers', () => {
    const guard = new DsmlStreamGuard();
    const full = `Sure.\n${markup(invoke('bash', param('command', 'ls -la')))}`;

    // Feed one character at a time: the worst case for a streaming parser.
    let emitted = '';
    for (const ch of full) emitted += guard.push(ch);

    const end = guard.finish();
    emitted += end.text;

    expect(guard.isDsml).toBe(true);
    expect(end.detected).toBe(true);
    expect(end.toolCalls).toHaveLength(1);
    expect(only(end.toolCalls).arguments).toEqual({ command: 'ls -la' });
    // The prose before the marker survives; no markup ever reaches the client.
    expect((emitted + end.text).includes('DSML')).toBe(false);
    expect((emitted + end.text).trim()).toBe('Sure.');
  });

  it('flushes the held tail when the stream ends without markup', () => {
    const guard = new DsmlStreamGuard();
    expect(guard.push('comparison: a <')).toBe('comparison: a ');

    const end = guard.finish();
    expect(end.text).toBe('<');
    expect(end.detected).toBe(false);
  });
});

/**
 * The bare spelling: identical structure, no DSML special tokens. Captured
 * verbatim from DeepSeek V4 Pro through the bridge, where the marker tokens did
 * not survive decoding and the markup landed in `content` with
 * `finish_reason: stop`.
 */
describe('bare tool-call markup', () => {
  const CAPTURED_EXEC =
    '<tool_calls>\n' +
    '<invoke name="exec">\n' +
    '<parameter name="command" string="true">pwd && ls -la && find . -maxdepth 2 -type f | sed \'s#^./##\' | sort | head -200</parameter>\n' +
    '<parameter name="justification" string="true">Inspect repository root and file inventory before making changes.</parameter>\n' +
    '</invoke>\n' +
    '</tool_calls>';

  const CAPTURED_SHELL_NO_TYPE =
    '<tool_calls>\n' +
    '<invoke name="shell">\n' +
    '<parameter name="command">pwd && ls -la</parameter>\n' +
    '</invoke>\n' +
    '</tool_calls>';

  it('detects bare markup but not prose that merely names the tags', () => {
    expect(hasToolCallMarkup(CAPTURED_EXEC)).toBe(true);
    expect(hasToolCallMarkup(CAPTURED_SHELL_NO_TYPE)).toBe(true);
    // No DSML token, so the narrow predicate stays false.
    expect(hasDsmlMarkup(CAPTURED_EXEC)).toBe(false);
    // An opening tag with no close is prose, not a call.
    expect(hasToolCallMarkup('wrap the call in <invoke name="bash"> to run it')).toBe(false);
  });

  it('recovers the captured exec block with both parameters', () => {
    const result = recoverDsmlToolCalls(CAPTURED_EXEC);

    expect(result.detected).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(only(result.toolCalls).name).toBe('exec');
    expect(only(result.toolCalls).arguments).toEqual({
      command: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200",
      justification: 'Inspect repository root and file inventory before making changes.',
    });
    expect(result.content).toBe('');
  });

  it('recovers a bare parameter with no string attribute', () => {
    const result = recoverDsmlToolCalls(CAPTURED_SHELL_NO_TYPE);

    expect(only(result.toolCalls).name).toBe('shell');
    expect(only(result.toolCalls).arguments).toEqual({ command: 'pwd && ls -la' });
  });

  it('keeps the prose that preceded the markup', () => {
    const result = recoverDsmlToolCalls(`I'll inspect the project first.\n\n${CAPTURED_EXEC}`);

    expect(result.content).toBe("I'll inspect the project first.");
    expect(result.toolCalls).toHaveLength(1);
  });

  it('recovers two bare invokes as separate calls', () => {
    const two =
      '<tool_calls>\n' +
      '<invoke name="read">\n<parameter name="file_path">a.ts</parameter>\n</invoke>\n' +
      '<invoke name="read">\n<parameter name="file_path">b.ts</parameter>\n</invoke>\n' +
      '</tool_calls>';
    const result = recoverDsmlToolCalls(two);

    expect(result.toolCalls.map((c) => c.arguments)).toEqual([{ file_path: 'a.ts' }, { file_path: 'b.ts' }]);
    expect(result.content).toBe('');
  });

  it('never fires when the provider returned real tool calls', () => {
    const real = [{ id: 'call_1', name: 'exec', arguments: { command: 'ls' } }];
    const result = recoverMessageToolCalls({ content: CAPTURED_EXEC, toolCalls: real });

    expect(result.recovered).toBe(false);
    expect(result.content).toBe(CAPTURED_EXEC);
  });

  it('recovers bare markup through recoverMessageToolCalls', () => {
    const result = recoverMessageToolCalls({ content: CAPTURED_EXEC });

    expect(result.recovered).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.content).toBe('');
  });

  it('survives the stream guard one character at a time', () => {
    const guard = new DsmlStreamGuard();
    let emitted = '';
    for (const ch of `Working.\n${CAPTURED_EXEC}`) emitted += guard.push(ch);

    const end = guard.finish();
    emitted += end.text;

    expect(end.detected).toBe(true);
    expect(end.toolCalls).toHaveLength(1);
    expect(only(end.toolCalls).name).toBe('exec');
    // No tag fragment ever reaches the client.
    expect(emitted).not.toMatch(/<tool_calls|<invoke|<parameter/);
    expect(emitted.trim()).toBe('Working.');
  });

  it('leaves ordinary HTML in streaming prose intact', () => {
    const guard = new DsmlStreamGuard();
    const full = 'The layout uses <div class="row"> and <span>text</span> here.';
    let emitted = '';
    for (const ch of full) emitted += guard.push(ch);
    emitted += guard.finish().text;

    expect(emitted).toBe(full);
  });

  it('recovers a doubled wrapper tag', () => {
    // Captured live: the model emitted the wrapper twice.
    const result = recoverDsmlToolCalls(
      '<tool_calls>\n<tool_calls>\n<invoke name="shell">\n<parameter name="command">ls -la</parameter>\n</invoke>\n</tool_calls>',
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(only(result.toolCalls).name).toBe('shell');
    expect(only(result.toolCalls).arguments).toEqual({ command: 'ls -la' });
    expect(result.content).toBe('');
  });

  it('strips a tag truncated with no closing bracket at the end', () => {
    // Captured live: the response ended `</tool_calls` with no `>`.
    const result = recoverDsmlToolCalls(
      '<tool_calls>\n<invoke name="exec">\n<parameter name="command" string="true">pwd && ls -la</parameter>\n</invoke>\n</tool_calls',
    );

    expect(only(result.toolCalls).name).toBe('exec');
    // `string="true"` means verbatim, so the value stays a string.
    expect(only(result.toolCalls).arguments).toEqual({ command: 'pwd && ls -la' });
    expect(result.content).toBe('');
    expect(result.content).not.toMatch(/tool_calls/);
  });

  it('recovers a parameter whose quote was never closed', () => {
    // Captured live and malformed on purpose: the value must still be usable.
    const result = recoverDsmlToolCalls(
      '<tool_calls>\n<invoke name="exec">\n<parameter name="cmd" string="true">pwd && ls -la</parameter>\n</invoke>\n</tool_calls>',
    );

    expect(only(result.toolCalls).name).toBe('exec');
    expect(Object.values(only(result.toolCalls).arguments)).toContain('pwd && ls -la');
  });

  it('keeps a multi-line command with shell metacharacters verbatim', () => {
    const command = "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200";
    const result = recoverDsmlToolCalls(
      `<tool_calls>\n<invoke name="exec">\n<parameter name="command" string="true">${command}</parameter>\n</invoke>\n</tool_calls>`,
    );

    expect(only(result.toolCalls).arguments).toEqual({ command });
  });
});
