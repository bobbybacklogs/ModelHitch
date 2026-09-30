#!/usr/bin/env node
/**
 * Check the markup parser against real captured DeepSeek output.
 *
 * Every sample below was captured verbatim from a live bridge, not invented.
 * Several are malformed, which is the point: the model's markup is not
 * guaranteed well-formed, and a parser that only handles the tidy case leaks.
 *
 * Usage: node verification/markup-samples-probe.mjs
 */
import { recoverDsmlToolCalls, hasDsmlMarkup, hasToolCallMarkup } from '../dist/index.js';

const samples = [
  {
    name: 'doubled wrapper tag',
    text: '<tool_calls>\n<tool_calls>\n<invoke name="shell">\n<parameter name="command">ls -la</parameter>\n</invoke>\n</tool_calls>',
    expect: [{ name: 'shell', arguments: { command: 'ls -la' } }]
  },
  {
    name: 'extra timeout parameter',
    text: '<tool_calls>\n<invoke name="exec">\n<parameter name="command" string="true">pwd && ls -la</parameter>\n<parameter name="timeout" string="true">10000</parameter>\n</invoke>\n</tool_calls',
    // `string="true"` means verbatim text, so the value stays a string. The
    // trailing `</tool_calls` is truncated with no `>`, which is the point.
    expect: [{ name: 'exec', arguments: { command: 'pwd && ls -la', timeout: '10000' } }]
  },
  {
    name: 'parameter with an unclosed quote',
    text: '<tool_calls>\n<invoke name="exec">\n<parameter name="cmd" string="pwd && ls -la</parameter>\n</invoke>\n</tool_calls>',
    // Malformed on purpose: the value must still come through as usable text.
    expectName: 'exec'
  },
  {
    name: 'multi-line command with a pipe',
    text: '<tool_calls>\n<invoke name="exec">\n<parameter name="command" string="true">pwd && ls -la && find . -maxdepth 2 -type f | sed \'s#^./##\' | sort | head -200</parameter>\n</invoke>\n</tool_calls>',
    expectName: 'exec',
    expectCommand: "pwd && ls -la && find . -maxdepth 2 -type f | sed 's#^./##' | sort | head -200"
  },
  {
    name: 'prose before markup survives',
    text: "I'll inspect the repository first, then make the changes.\n\n<tool_calls>\n<invoke name=\"exec\">\n<parameter name=\"command\">ls</parameter>\n</invoke>\n</tool_calls>",
    expectName: 'exec',
    expectContent: "I'll inspect the repository first, then make the changes."
  },
  {
    name: 'canonical DSML with full-width pipes still parses',
    text: '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">ls -la</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
    expect: [{ name: 'bash', arguments: { command: 'ls -la' } }]
  }
];

let failures = 0;

for (const sample of samples) {
  const result = recoverDsmlToolCalls(sample.text);
  const problems = [];

  if (!result.detected) problems.push('markup not detected');
  if (sample.expect) {
    const actual = result.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }));
    if (JSON.stringify(actual) !== JSON.stringify(sample.expect)) {
      problems.push(`expected ${JSON.stringify(sample.expect)}, got ${JSON.stringify(actual)}`);
    }
  }
  if (sample.expectName && result.toolCalls[0]?.name !== sample.expectName) {
    problems.push(`expected tool name ${sample.expectName}, got ${result.toolCalls[0]?.name}`);
  }
  if (sample.expectCommand && result.toolCalls[0]?.arguments?.command !== sample.expectCommand) {
    problems.push(`command mismatch: ${JSON.stringify(result.toolCalls[0]?.arguments?.command)}`);
  }
  if (sample.expectContent !== undefined) {
    if (!result.content.includes(sample.expectContent)) {
      problems.push(`prose lost: ${JSON.stringify(result.content)}`);
    }
  }
  // Whatever happens, no tag debris may survive into the content.
  if (/<\/?(?:tool_calls|function_calls|invoke|parameter)\b/i.test(result.content)) {
    problems.push(`tag debris left in content: ${JSON.stringify(result.content.slice(0, 120))}`);
  }
  if (/DSML/.test(result.content)) {
    problems.push('DSML marker left in content');
  }

  const status = problems.length === 0 ? 'PASS' : 'FAIL';
  console.log(`${status}  ${sample.name}`);
  for (const problem of problems) console.log(`        ${problem}`);
  if (problems.length > 0) failures++;
}

// The negative case: prose that merely mentions the tags must not be rewritten.
const prose = 'Wrap the call in <invoke name="bash"> only when you need a shell.';
const proseResult = recoverDsmlToolCalls(prose);
console.log(`${proseResult.toolCalls.length === 0 && proseResult.content === prose ? 'PASS' : 'FAIL'}  prose mentioning tags is left alone`);
if (proseResult.toolCalls.length !== 0 || proseResult.content !== prose) failures++;

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}  (hasToolCallMarkup agrees with hasDsmlMarkup on canonical DSML: ${hasToolCallMarkup('<｜DSML｜invoke name="a"></｜DSML｜invoke>') === hasDsmlMarkup('<｜DSML｜invoke name="a"></｜DSML｜invoke>')})`);
process.exitCode = failures === 0 ? 0 : 1;
