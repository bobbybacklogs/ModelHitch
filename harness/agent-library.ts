import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GREP_TOOL_NAME } from './grep.js';

/**
 * Loads a folder of agency agent definitions — `<folder>/<agent-name>/agent.md`.
 *
 * The format is YAML frontmatter plus a markdown body that *is* the agent's
 * system prompt:
 *
 *   ---
 *   name: ui-qa
 *   description: Perform the final product-quality pass ...
 *   tools:
 *     - view_file
 *     - grep_search
 *   ---
 *   # UI QA
 *   You are the final UI quality gate ...
 *
 * Two things make this worth its own module:
 *
 * 1. Size. A real library runs to ~57 agents and ~440 KB of prose. Loading every
 *    body into a prompt is impossible, so only names and descriptions are
 *    exposed; a body is read into a prompt only when that agent is delegated to.
 *
 * 2. Tool names. These files declare VS Code Copilot tools (`view_file`,
 *    `grep_search`, `replace_file_content`, `run_command`, `manage_task`), none
 *    of which exist here. They are mapped to real capabilities, and each agent's
 *    privilege tier is derived from what it declared rather than granted
 *    uniformly.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Subagent privilege tiers. Only `readonly` is an enforceable restriction. */
export type SubagentToolTier = 'readonly' | 'shell' | 'write' | 'full';

/**
 * VS Code Copilot tool name -> the tool actually granted here.
 *
 * `null` means there is no equivalent; the declaration is reported rather than
 * silently dropped, so the gap is visible instead of the agent quietly losing a
 * capability it asked for.
 */
export const DECLARED_TOOL_MAP: Record<string, string | null> = {
  view_file: 'read_file',
  grep_search: GREP_TOOL_NAME,
  replace_file_content: 'write_file',
  run_command: 'run_command',
  manage_task: null,
};

/**
 * Tools granted per tier.
 *
 * Tiers are capability classes, not sandboxes: `shell` can write files through
 * the shell even though it holds no `write_file`, so only `readonly` (which has
 * neither) is genuinely unable to modify the workspace.
 */
export const TIER_TOOLS: Record<SubagentToolTier, string[]> = {
  readonly: ['read_file', 'list_files', GREP_TOOL_NAME],
  write: ['read_file', 'list_files', GREP_TOOL_NAME, 'write_file'],
  shell: ['read_file', 'list_files', GREP_TOOL_NAME, 'run_command'],
  full: ['read_file', 'list_files', GREP_TOOL_NAME, 'write_file', 'run_command'],
};

export interface LibraryAgent {
  name: string;
  description: string;
  /** The markdown body: this agent's system prompt. */
  body: string;
  declaredTools: string[];
  /** Tools actually granted, after mapping and sandbox handling. */
  grantedTools: string[];
  /** Declared tools with no equivalent here. */
  unsupportedTools: string[];
  tier: SubagentToolTier;
  /** True when the definition asked for a sandbox; shell is withheld. */
  sandboxed: boolean;
  /** False when the definition sets `subagent: false`. */
  delegatable: boolean;
  sourcePath: string;
  warnings: string[];
}

export interface AgentLibrary {
  dir: string;
  agents: LibraryAgent[];
  /** Agents present in the folder but excluded from the roster. */
  excluded: Array<{ name: string; reason: string }>;
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * Frontmatter parsing
 * ------------------------------------------------------------------ */

export interface Frontmatter {
  data: Record<string, string | string[]>;
  body: string;
  warnings: string[];
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1);
    return inner.replace(/\\(["\\/nrt])/g, (_m, ch: string) => {
      switch (ch) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        default:
          return ch;
      }
    });
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    // YAML single quotes: the only escape is '' for a literal quote.
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Parse the YAML subset these files actually use.
 *
 * Deliberately not a general YAML parser — this package has two dependencies and
 * neither is a YAML library, and adding one to parse frontmatter would not be a
 * good trade. The supported subset is: plain scalars, double- and single-quoted
 * scalars, `>`/`|` block scalars, `[a, b]` inline lists, and `- item` block
 * lists. Anything outside it is reported as a warning rather than guessed at.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const warnings: string[] = [];
  const data: Record<string, string | string[]> = {};

  // Tolerate a UTF-8 BOM and CRLF line endings.
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');

  if ((lines[0] ?? '').trim() !== '---') {
    return { data, body: normalised.trim(), warnings: ['no YAML frontmatter found'] };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] as string).trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { data, body: normalised.trim(), warnings: ['unterminated YAML frontmatter'] };
  }

  const body = lines.slice(end + 1).join('\n').trim();

  let i = 1;
  while (i < end) {
    const line = lines[i] as string;
    i++;

    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // Only column-zero keys start a new field; indented lines belong to the
    // previous one and are handled in the branches below.
    if (/^\s/.test(line)) {
      warnings.push(`ignoring unexpected indented line: ${line.trim().slice(0, 60)}`);
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/.exec(line);
    if (!match) {
      warnings.push(`ignoring unparseable frontmatter line: ${line.trim().slice(0, 60)}`);
      continue;
    }
    const key = match[1] as string;
    const rawValue = (match[2] as string).trim();

    // Block scalar: `>` folds newlines to spaces, `|` keeps them.
    const blockMatch = /^([>|])([-+]?)$/.exec(rawValue);
    if (blockMatch) {
      const fold = blockMatch[1] === '>';
      const collected: string[] = [];
      while (i < end) {
        const next = lines[i] as string;
        if (next.trim() !== '' && !/^\s/.test(next)) break;
        collected.push(next);
        i++;
      }
      // Drop leading/trailing blank lines, then de-indent.
      while (collected.length > 0 && (collected[0] as string).trim() === '') collected.shift();
      while (collected.length > 0 && (collected[collected.length - 1] as string).trim() === '') collected.pop();
      const indent = Math.min(
        ...collected.filter((l) => l.trim() !== '').map((l) => (l.match(/^\s*/) as RegExpMatchArray)[0].length),
      );
      const deIndented = collected.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      data[key] = fold ? deIndented.join(' ').replace(/\s+/g, ' ').trim() : deIndented.join('\n').trim();
      continue;
    }

    // Block list: `- item` lines.
    if (rawValue === '') {
      const items: string[] = [];
      while (i < end) {
        const next = lines[i] as string;
        const itemMatch = /^\s+-\s*(.*)$/.exec(next);
        if (!itemMatch) {
          if (next.trim() === '') {
            i++;
            continue;
          }
          break;
        }
        items.push(unquote((itemMatch[1] as string).trim()));
        i++;
      }
      // A key with no value and no items is an empty scalar, not an empty list.
      data[key] = items.length === 0 ? '' : items;
      continue;
    }

    // Inline list.
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1).trim();
      data[key] =
        inner === ''
          ? []
          : inner
              .split(',')
              .map((part) => unquote(part.trim()))
              .filter((part) => part !== '');
      continue;
    }

    const unquoted = unquote(rawValue);
    data[key] = unquoted === '' || unquoted === '~' || unquoted === 'null' ? '' : unquoted;
  }

  return { data, body, warnings };
}

/* ------------------------------------------------------------------ *
 * Tool mapping and tier derivation
 * ------------------------------------------------------------------ */

export interface MappedTools {
  granted: string[];
  unsupported: string[];
  tier: SubagentToolTier;
  sandboxed: boolean;
  warnings: string[];
}

/**
 * Map declared tools onto real ones and derive the agent's tier.
 *
 * An agent that declares nothing gets `readonly` rather than full access: a
 * missing `tools:` key is not a statement about privilege, so the safe reading
 * is taken and the gap stays visible instead of silently granting writes.
 */
export function mapDeclaredTools(declared: string[], options: { sandboxed?: boolean } = {}): MappedTools {
  const warnings: string[] = [];
  const grantedNames = new Set<string>();
  const unsupported: string[] = [];

  for (const tool of declared) {
    const mapped = Object.prototype.hasOwnProperty.call(DECLARED_TOOL_MAP, tool)
      ? DECLARED_TOOL_MAP[tool]
      : null;
    if (mapped === null || mapped === undefined) {
      unsupported.push(tool);
      continue;
    }
    grantedNames.add(mapped);
  }

  const sandboxed = options.sandboxed === true;
  if (sandboxed && grantedNames.delete('run_command')) {
    warnings.push('commandExecutionPolicy: sandbox — shell withheld from this agent');
  }

  const canWrite = grantedNames.has('write_file');
  const canShell = grantedNames.has('run_command');
  const tier: SubagentToolTier = canWrite && canShell ? 'full' : canShell ? 'shell' : canWrite ? 'write' : 'readonly';

  // Grant the tier's capability class. A readonly agent gets the inspection
  // tools even if it declared only one of them; they cannot mutate anything.
  const granted = TIER_TOOLS[tier].slice();

  return { granted, unsupported, tier, sandboxed, warnings };
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

/** Default location of the agency agent library. */
export function defaultAgentsDir(): string {
  return join(homedir(), '.agents', 'agents');
}

/** Candidate locations, in priority order. */
export function agentsDirCandidates(): string[] {
  const candidates: string[] = [];
  const envDir = process.env['HARNESS_AGENTS_DIR'] ?? process.env['AGENTS_DIR'];
  if (envDir) candidates.push(resolve(envDir));
  candidates.push(defaultAgentsDir());
  for (const rel of ['../.agents/agents', '../../.agents/agents']) {
    candidates.push(resolve(__dirname, rel));
  }
  return candidates;
}

/** The first candidate that exists and is a directory, or null. */
export function resolveAgentsDir(explicit?: string | null): string | null {
  if (explicit === null) return null; // explicitly disabled
  if (explicit !== undefined) return existsSync(explicit) ? resolve(explicit) : null;
  for (const candidate of agentsDirCandidates()) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

/**
 * Agents excluded from the roster by default.
 *
 * `orchestrator` excludes itself: its own definition states "Do not invoke
 * Orchestrator as one of your own workers", and delegating to a second
 * orchestrator from inside a delegated run is exactly nested orchestration.
 */
export const DEFAULT_EXCLUDED_AGENTS = ['orchestrator'];

export interface LoadOptions {
  dir: string;
  /** Agent names to leave out. Defaults to DEFAULT_EXCLUDED_AGENTS. */
  exclude?: string[];
}

/** Read one `agent.md` into a LibraryAgent, or explain why it cannot be used. */
export function parseAgentFile(filePath: string, fallbackName: string): { agent?: LibraryAgent; error?: string } {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { error: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }

  const { data, body, warnings } = parseFrontmatter(text);
  const name = typeof data['name'] === 'string' && data['name'].length > 0 ? data['name'] : fallbackName;
  if (typeof data['name'] !== 'string' || data['name'].length === 0) {
    warnings.push(`no usable name: using directory name "${fallbackName}"`);
  }

  const description = typeof data['description'] === 'string' ? data['description'] : '';
  if (description === '') warnings.push('no description');

  const declaredTools = Array.isArray(data['tools']) ? data['tools'] : [];
  const sandboxed = typeof data['commandExecutionPolicy'] === 'string' && data['commandExecutionPolicy'] === 'sandbox';
  const mapped = mapDeclaredTools(declaredTools, { sandboxed });
  // `subagent: false` marks a definition as not delegatable.
  const delegatable = data['subagent'] !== 'false';

  return {
    agent: {
      name,
      description,
      body,
      declaredTools,
      grantedTools: mapped.granted,
      unsupportedTools: mapped.unsupported,
      tier: mapped.tier,
      sandboxed: mapped.sandboxed,
      delegatable,
      sourcePath: filePath,
      warnings: [...warnings, ...mapped.warnings],
    },
  };
}

/**
 * Load every `<name>/agent.md` under a folder.
 *
 * A malformed file is reported and skipped rather than crashing the harness: a
 * typo in one of sixty definitions should not make the whole library unusable.
 */
export function loadAgentLibrary(options: LoadOptions): AgentLibrary {
  const dir = resolve(options.dir);
  const exclude = new Set(options.exclude ?? DEFAULT_EXCLUDED_AGENTS);
  const agents: LibraryAgent[] = [];
  const excluded: Array<{ name: string; reason: string }> = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return {
      dir,
      agents: [],
      excluded: [],
      warnings: [`cannot read agent directory: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;

    const subdir = join(dir, entry.name);
    const filePath = join(subdir, 'agent.md');
    if (!existsSync(filePath)) continue;

    const { agent, error } = parseAgentFile(filePath, entry.name);
    if (!agent) {
      warnings.push(`${entry.name}: ${error}`);
      continue;
    }

    if (exclude.has(agent.name)) {
      excluded.push({ name: agent.name, reason: 'excluded by policy' });
      continue;
    }
    // Honour a definition that marks itself as not delegatable.
    if (!agent.delegatable) {
      excluded.push({ name: agent.name, reason: 'definition sets subagent: false' });
      continue;
    }
    if (seen.has(agent.name)) {
      warnings.push(`${entry.name}: duplicate agent name "${agent.name}" - keeping the first`);
      continue;
    }

    seen.add(agent.name);
    agents.push(agent);
    for (const warning of agent.warnings) warnings.push(`${agent.name}: ${warning}`);
  }

  return { dir, agents, excluded, warnings };
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export interface AgentMatch {
  name: string;
  description: string;
  tier: SubagentToolTier;
  score: number;
}

/**
 * Rank agents against a free-text query.
 *
 * Exists because a 57-agent catalogue is too big to reason over reliably: the
 * orchestrator can search by intent instead of guessing a name.
 */
export function searchAgents(agents: LibraryAgent[], query: string, limit = 8): AgentMatch[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const scored: AgentMatch[] = [];
  for (const agent of agents) {
    const name = agent.name.toLowerCase();
    const description = agent.description.toLowerCase();
    const body = agent.body.toLowerCase();
    let score = 0;

    for (const term of terms) {
      if (name === term) score += 100;
      else if (name.startsWith(term)) score += 60;
      else if (name.includes(term)) score += 40;
      if (description.includes(term)) score += 25;
      // Body hits are a weak signal: nearly every body mentions common words.
      else if (body.includes(term)) score += 5;
    }

    if (score > 0) scored.push({ name: agent.name, description: agent.description, tier: agent.tier, score });
  }

  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}
