// runtime-info: discover, validate, and manifest an agent fixture directory.
//
// Filesystem-first agent runtime — Phase 1. Given an agent directory, discover
// the agent files, validate the required shape, and emit an inspectable JSON
// manifest. This module does not execute agents; it only reads and reports.
import { promises as fs } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';

/**
 * Files that count as an agent entry point, listed in priority order. The
 * first one present wins.
 */
export const AGENT_ENTRY_CANDIDATES = ['agent.ts', 'agent.tsx', 'agent.js', 'agent.mjs'];

/** Markdown instructions files, in priority order. */
export const INSTRUCTIONS_CANDIDATES = ['instructions.md', 'INSTRUCTIONS.md'];

const MD_EXT = '.md';

/** Minimum structure an agent directory must satisfy to make validation pass. */
export const REQUIRED_SHAPE = {
  instructions: 'a Markdown instructions file (instructions.md) describing the agent',
  entry: 'a typed agent entry point (agent.ts, agent.tsx, agent.js, or agent.mjs)',
};

/**
 * Walk a directory, collecting relative file and directory paths.
 *
 * Hidden entries (dot-prefixed) are skipped, symlinks are followed, and
 * traversal is bounded by `maxEntries` so a pathological fixture cannot
 * balloon the process.
 */
export async function discover(agentDir, { maxEntries = 2000 } = {}) {
  const root = resolve(agentDir);
  const files = [];
  const dirs = [];
  let seen = 0;

  async function walk(current, depth) {
    if (seen >= maxEntries) {
      throw new Error(`discover: aborted after ${maxEntries} entries under ${root}`);
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const dirent of entries) {
      if (seen >= maxEntries) {
        throw new Error(`discover: aborted after ${maxEntries} entries under ${root}`);
      }
      if (dirent.name.startsWith('.')) continue;
      const abs = join(current, dirent.name);
      let isDir = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        isDir = (await fs.stat(abs)).isDirectory();
      }
      if (isDir) {
        seen += 1;
        dirs.push(toRelative(root, abs));
        if (depth < 8) await walk(abs, depth + 1);
      } else if (dirent.isFile()) {
        seen += 1;
        files.push(toRelative(root, abs));
      }
    }
  }

  await walk(root, 0);
  files.sort();
  dirs.sort();
  return { root, files, dirs };
}

function toRelative(root, abs) {
  return abs.slice(root.length + 1).split(sep).join('/');
}

/** Resolve the instructions file among the discovered relative paths; null when absent. */
export function resolveInstructions(files) {
  const set = new Set(files);
  for (const name of INSTRUCTIONS_CANDIDATES) {
    if (set.has(name)) return name;
  }
  const markdown = files.filter((f) => extname(f).toLowerCase() === MD_EXT);
  return markdown.length > 0 ? markdown[0] : null;
}

/** Resolve the agent entry point among the discovered relative paths; null when absent. */
export function resolveEntry(files) {
  const set = new Set(files);
  for (const name of AGENT_ENTRY_CANDIDATES) {
    if (set.has(name)) return name;
  }
  return null;
}

/**
 * Validate an agent directory against the required shape.
 *
 * Returns `{ valid, errors, resolved }`. `valid` is true only when all
 * required files are present with no blocking problems.
 */
export function validate(agentDir, files, { entryOptional = false } = {}) {
  const errors = [];
  const set = new Set(files);

  const instructions = resolveInstructions(files);
  if (!instructions) {
    errors.push(`missing ${REQUIRED_SHAPE.instructions}`);
  }

  const entry = resolveEntry(files);
  if (!entry && !entryOptional) {
    errors.push(`missing ${REQUIRED_SHAPE.entry}`);
  }

  if (entry) {
    const stem = basename(entry, extname(entry));
    if (stem.includes('converted')) {
      errors.push(
        `entry point must not be named */converted.* (reserved by the payload sentinel); rename ${entry}`,
      );
    }
  }

  return { valid: errors.length === 0, errors, resolved: { instructions, entry } };
}

async function readFileShape(abs) {
  try {
    const info = await fs.stat(abs);
    if (info.isDirectory()) return { bytes: 0, text: null, error: 'file is a directory' };
    return { bytes: info.size, text: await fs.readFile(abs, 'utf8'), error: null };
  } catch (err) {
    return { bytes: 0, text: null, error: err.message };
  }
}

/**
 * Discover, validate, and build the inspectable manifest for one agent dir.
 *
 * Only reads the filesystem and never executes agent code; the entry point
 * is listed in the manifest, not loaded.
 */
export async function discoverAgent(agentDir) {
  const { root, files, dirs } = await discover(agentDir);
  const resolution = validate(root, files);
  const instructionsAbs = resolution.resolved.instructions
    ? join(root, resolution.resolved.instructions)
    : null;
  const entryAbs = resolution.resolved.entry ? join(root, resolution.resolved.entry) : null;

  const statShape = {};
  for (const rel of files) {
    try {
      const st = await fs.stat(join(root, rel));
      statShape[rel] = [st.size, Math.floor(st.mtimeMs)];
    } catch (err) {
      statShape[rel] = [0, 0, err.message];
    }
  }

  const instructions = instructionsAbs ? await readFileShape(instructionsAbs) : null;

  return {
    dir: root,
    agentName: basename(root),
    format: 'agent-runtime.manifest.v1',
    discoveredAt: new Date().toISOString(),
    discoveredFiles: files,
    discoveredDirs: dirs,
    required: {
      instructionsFile: resolution.resolved.instructions,
      entryPoint: resolution.resolved.entry,
    },
    validation: {
      status: resolution.valid ? 'ok' : 'failed',
      problems: resolution.errors,
    },
    statShape: { files: statShape, note: 'relativePath: [sizeBytes, mtimeEpochMs]' },
    instructions: instructions
      ? { path: resolution.resolved.instructions, bytes: instructions.bytes, error: instructions.error }
      : { path: null, bytes: 0 },
    entry: entryAbs
      ? { path: resolution.resolved.entry, exists: true, hints: { vocabulary: extname(entryAbs).slice(1) } }
      : { path: null, exists: false },
  };
}