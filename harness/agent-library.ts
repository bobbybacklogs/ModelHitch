import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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

    // A plain scalar can continue on the next line, indented. This is ordinary
    // YAML and it shows up constantly in practice: a description long enough to
    // wrap gets written that way, and treating the continuation as junk both
    // warned and silently truncated the text to its first line. Fold it the way
    // YAML does, with a single space per break.
    const continuation: string[] = [];
    while (i < end) {
      const next = lines[i] as string;
      if (next.trim() === '') break;
      if (!/^\s/.test(next)) break;
      if (next.trimStart().startsWith('#')) {
        i++;
        continue;
      }
      continuation.push(next.trim());
      i++;
    }

    const unquoted = unquote(rawValue);
    const scalar = unquoted === '' || unquoted === '~' || unquoted === 'null' ? '' : unquoted;
    data[key] = continuation.length === 0 ? scalar : [scalar, ...continuation].join(' ');
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

/* ------------------------------------------------------------------ *
 * Semantic search
 * ------------------------------------------------------------------ */

/**
 * An embedder: one vector per input text, in the order given.
 *
 * Provider-neutral on purpose. This harness must not import a vendor SDK or
 * hard-code a model id, so the caller injects whatever embedder it already
 * holds, and a caller holding none keeps the lexical path unchanged.
 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface SemanticSearchDeps {
  /**
   * Injected embedder. Provider-neutral on purpose: this harness must not import
   * a vendor SDK or hard-code a model id.
   */
  embed?: EmbedFn;
  /** Identity of the embedder, part of the cache key. Defaults to 'default'. */
  embedderId?: string;
  /** Where vectors are cached. Defaults to `<harness state dir>/embeddings`. */
  cacheDir?: string;
  /** Called once with a warning when semantic search is unavailable or fails. */
  log?: (message: string) => void;
  /** Character budget for the body text before embedding. Defaults to 4000. */
  bodyChars?: number;
  /** Weight of the semantic score in the blend (0..1). Defaults to 0.8. */
  semanticWeight?: number;
}

/**
 * Body characters fed to the embedder per agent.
 *
 * A real library is 50+ agents and ~440 KB of prose, and embedding every body
 * whole would cost far more than a routing decision is worth. These definitions
 * state what the agent owns in their opening section, so the first 4000
 * characters carry the intent that matters and the rest is procedure.
 */
const EMBED_BODY_CHARS = 4000;

/**
 * Semantic share of the blended score.
 *
 * Weighted toward semantics, because the whole point is matching an intent that
 * shares no vocabulary with the query, but not all the way: an exact name hit
 * should still be able to win, and the lexical share separates agents the
 * embedder finds equally close.
 */
const EMBED_SEMANTIC_WEIGHT = 0.8;

/**
 * Where vectors live when the caller does not say: `<state>/embeddings`.
 *
 * The state directory is resolved here rather than imported from the session
 * module, because agent-library is a leaf the session layer imports and reaching
 * back into it would be a cycle.
 */
export function defaultEmbeddingCacheDir(): string {
  const configured = process.env['HARNESS_STATE_DIR'];
  const stateDir =
    configured !== undefined && configured.trim() !== ''
      ? resolve(configured)
      : join(homedir(), '.modelhitch', 'harness');
  return join(stateDir, 'embeddings');
}

/**
 * Cache file name for one embedder.
 *
 * Ids arrive from configuration, so anything that could not be a path segment is
 * folded to "_" instead of being allowed to escape the cache directory.
 */
function cacheFileName(embedderId: string): string {
  return embedderId.replace(/[^A-Za-z0-9._-]+/g, '_') || 'default';
}

/**
 * Key for one cached vector: sha256 over the embedder id and the exact text.
 *
 * The id is inside the hash because a cache directory outlives whichever
 * embedder filled it, and a vector from another model is not comparable, so the
 * two must never collide. The NUL separator keeps "a"+"bc" distinct from
 * "ab"+"c".
 */
function embeddingKey(embedderId: string, text: string): string {
  return createHash('sha256').update(`${embedderId}\u0000${text}`, 'utf8').digest('hex');
}

/** True for a non-empty vector of finite numbers, the only shape usable here. */
function isVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read the cache, or an empty one.
 *
 * Every failure mode here (absent file, unreadable file, truncated JSON, a
 * hand-edited shape) resolves to "no cache", because a cache is a cost
 * optimisation and never a reason for a search to fail. Individual junk entries
 * are dropped rather than poisoning the whole file.
 */
function readEmbeddingCache(path: string): Record<string, number[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const cache: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isVector(value)) cache[key] = value;
  }
  return cache;
}

/**
 * Persist the cache, best effort.
 *
 * A read-only directory or a full disk costs one extra embed next run, which is
 * far cheaper than failing a search, so nothing here is allowed to throw.
 */
function writeEmbeddingCache(path: string, cache: Record<string, number[]>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), 'utf8');
  } catch {
    /* best effort by design */
  }
}

/**
 * Loggers already warned.
 *
 * The warning is once per logger per process rather than once per process: a
 * long-lived harness builds several rosters, and a warning swallowed for the
 * second caller would hide exactly the degradation this exists to surface.
 * Keying on the logger keeps a loop from flooding without doing that.
 */
const warnedLoggers = new WeakSet<object>();

function warnOnce(deps: SemanticSearchDeps, text: string): void {
  const log = deps.log;
  if (!log || warnedLoggers.has(log)) return;
  warnedLoggers.add(log);
  try {
    log(text);
  } catch {
    // A logger that throws must not take the search down with it.
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return EMBED_SEMANTIC_WEIGHT;
  return Math.min(1, Math.max(0, value));
}

function cosineSimilarity(a: number[], b: number[]): number {
  // Equal widths are arranged by the caller; a mismatch here would mean the
  // embedder is not honouring its own contract, and scoring that as 0 similarity
  // is safer than reading past the end of either vector.
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Reject an embedder response that cannot be trusted, before it reaches scoring.
 *
 * A short or non-numeric batch is a bug in the embedder, not a ranking signal,
 * so it takes the same fallback path as a rejection rather than silently
 * scoring every agent as 0.
 */
function assertVectors(value: unknown, expected: number): asserts value is number[][] {
  const list: unknown[] | null = Array.isArray(value) ? value : null;
  if (!list || list.length !== expected || !list.every(isVector)) {
    throw new Error(`embedder returned ${list ? list.length : 'no'} usable vectors for ${expected} texts`);
  }
}

/**
 * Rank agents by intent, with the lexical score as a tiebreak.
 *
 * `searchAgents` matches literal words, so a query that describes the task in
 * different vocabulary than the definition ("change how the records are shaped"
 * against "database migrations") finds nothing. Embeddings close that gap. The
 * lexical path is kept alongside it rather than replaced, because it is free,
 * it never fails, and an exact name hit is still the strongest signal available.
 *
 * Returns exactly what `searchAgents` returns, so callers such as the subagent
 * roster need no change and can switch between the two freely.
 */
export async function searchAgentsSemantic(
  agents: LibraryAgent[],
  query: string,
  limit = 8,
  deps: SemanticSearchDeps = {},
): Promise<AgentMatch[]> {
  // An empty library or an empty query is not a semantic problem, so it is
  // answered before the embedder or the cache is touched at all.
  if (agents.length === 0 || query.trim() === '') return [];

  /** The lexical path, and the promise that it never throws. */
  const lexical = (): AgentMatch[] => {
    try {
      return searchAgents(agents, query, limit);
    } catch (err) {
      warnOnce(deps, `semantic search is off and keyword search failed: ${errorText(err)}`);
      return [];
    }
  };

  const embed = deps.embed;
  if (!embed) {
    warnOnce(deps, 'semantic search is off (no embedder injected); using keyword search');
    return lexical();
  }

  const embedderId = deps.embedderId ?? 'default';
  const semanticWeight = clamp01(deps.semanticWeight ?? EMBED_SEMANTIC_WEIGHT);
  const bodyChars = Math.max(0, deps.bodyChars ?? EMBED_BODY_CHARS);
  const cachePath = join(deps.cacheDir ?? defaultEmbeddingCacheDir(), `${cacheFileName(embedderId)}.json`);

  // Name, description and body together are what identifies the agent's task;
  // the body is cut to a character budget first so one 40 KB definition cannot
  // dominate the cost of the batch. The query is embedded as-is, with no
  // stemming or rewriting, so the vector describes what the caller actually
  // asked for. Embeddings go through the injected function only.
  const texts = agents.map((agent) => `${agent.name}\n${agent.description}\n${agent.body.slice(0, bodyChars)}`);
  const keys = texts.map((text) => embeddingKey(embedderId, text));
  const queryKey = embeddingKey(embedderId, query);

  const cache = readEmbeddingCache(cachePath);
  const vectors: Array<number[] | undefined> = keys.map((key) => cache[key]);
  let queryVector: number[] | undefined = cache[queryKey];
  let dirty = false;

  try {
    // One batched call covers every agent still missing a vector plus the query.
    // The query is cached like any other text, which is what makes a repeated
    // search free rather than merely cheap.
    const missing: number[] = [];
    for (let i = 0; i < vectors.length; i++) {
      if (!isVector(vectors[i])) missing.push(i);
    }

    if (missing.length > 0 || !isVector(queryVector)) {
      const batch = [...missing.map((i) => texts[i] ?? ''), ...(isVector(queryVector) ? [] : [query])];
      const out = await embed(batch);
      assertVectors(out, batch.length);
      missing.forEach((index, position) => {
        const vector = out[position] as number[];
        vectors[index] = vector;
        const key = keys[index];
        if (key !== undefined) {
          cache[key] = vector;
          dirty = true;
        }
      });
      if (!isVector(queryVector)) {
        const fresh = out[out.length - 1] as number[];
        queryVector = fresh;
        cache[queryKey] = fresh;
        dirty = true;
      }
    }

    if (!isVector(queryVector)) throw new Error('no query vector');

    // A cached vector left by an embedder of another width cannot be compared
    // with the query. That invalidates the entry, not the search, so only the
    // offending entries are re-embedded.
    const stale: number[] = [];
    for (let i = 0; i < vectors.length; i++) {
      const vector = vectors[i];
      if (isVector(vector) && vector.length !== queryVector.length) stale.push(i);
    }
    if (stale.length > 0) {
      const out = await embed(stale.map((i) => texts[i] ?? ''));
      assertVectors(out, stale.length);
      stale.forEach((index, position) => {
        const vector = out[position] as number[];
        vectors[index] = vector;
        const key = keys[index];
        if (key !== undefined) {
          cache[key] = vector;
          dirty = true;
        }
      });
    }

    if (dirty) writeEmbeddingCache(cachePath, cache);
  } catch (err) {
    warnOnce(deps, `semantic search failed (${errorText(err)}); using keyword search`);
    return lexical();
  }

  const queryVec = queryVector;
  if (!queryVec) return lexical(); // unreachable: the block above either sets it or falls back

  // Raw lexical scores, taken one agent at a time through the same function the
  // caller would otherwise use. Scoring agents individually keeps a duplicate
  // name from being credited with another agent's score.
  const lexicalScores = agents.map((agent) => searchAgents([agent], query, 1)[0]?.score ?? 0);
  let maxLexical = 0;
  for (const score of lexicalScores) {
    if (score > maxLexical) maxLexical = score;
  }

  const matches: AgentMatch[] = agents.map((agent, index) => {
    const vector = vectors[index];
    const semantic = isVector(vector) ? cosineSimilarity(vector, queryVec) : 0;
    // Normalised against the best lexical score in the library so the two halves
    // of the blend are on the same 0..1 scale regardless of query length.
    const lexicalShare = maxLexical > 0 ? (lexicalScores[index] ?? 0) / maxLexical : 0;
    return {
      name: agent.name,
      description: agent.description,
      tier: agent.tier,
      score: semantic * semanticWeight + lexicalShare * (1 - semanticWeight),
    };
  });

  return matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}
