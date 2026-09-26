#!/usr/bin/env node
// agent-runtime/bin/info.mjs — discover / validate / manifest emit for an agent dir.
//
// Usage:
//   node agent-runtime/bin/info.mjs <agentDir> [--out <file>]
//
// Prints the JSON manifest to stdout; with `--out <file>` also writes it
// (atomically) to that path. Exits 0 when validation passes, 1 when it fails
// or the directory cannot be discovered, 2 on usage errors.
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { discoverAgent } = await import(join(here, '..', 'lib', 'runtime-info.mjs'));

const INSTRUCTIONS = 'usage: node agent-runtime/bin/info.mjs <agentDir> [--out <manifest.json>]\n';

function parseArgs(argv) {
  const args = { dir: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      args.out = argv[++i];
      if (!args.out) throw new Error('--out requires a path');
    } else if (arg === '--json') {
      // accepted for convenience; manifest is always JSON on stdout
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      args.dir = arg;
    }
  }
  return args;
}

async function writeOut(path, text) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, path);
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`runtime-info: ${err.message}\n`);
  process.stderr.write(INSTRUCTIONS);
  process.exit(2);
}

if (!args.dir) {
  process.stderr.write(INSTRUCTIONS);
  process.exit(2);
}

let manifest;
try {
  manifest = await discoverAgent(args.dir);
} catch (err) {
  process.stderr.write(`runtime-info: failed to inspect ${args.dir}: ${err.message}\n`);
  process.exit(1);
}

const text = `${JSON.stringify(manifest, null, 2)}\n`;
process.stdout.write(text);
if (args.out) {
  await writeOut(args.out, text);
  process.stderr.write(`runtime-info: manifest written to ${args.out}\n`);
}

for (const problem of manifest.validation.problems) {
  process.stderr.write(`runtime-info: validation: ${problem}\n`);
}
if (manifest.validation.status === 'failed') process.exitCode = 1;