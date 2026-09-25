import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ToolDefinition } from '../src/index.js';
import { GREP_TOOL_NAME, createGrepTool } from './grep.js';
import {
  TIER_TOOLS,
  loadAgentLibrary,
  resolveAgentsDir,
  searchAgents,
  type AgentLibrary,
  type LibraryAgent,
  type SubagentToolTier,
} from './agent-library.js';

export type { SubagentToolTier } from './agent-library.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Subagent delegation for the harness, backed by bihan (the subagent
 * orchestrator that is itself built on ModelHitch).
 *
 * bihan is *not* a declared dependency of this package on purpose: a `file:`
 * link to a sibling checkout would break `npm ci` on a clean CI checkout, and
 * the published 0.1.0 predates the tool-shape and lane-routing fixes this
 * harness relies on. Instead we resolve it at runtime the same way
 * `prompt.ts` locates zstack — explicit env var first, then the sibling
 * checkout — and simply offer no subagent tool when it isn't there.
 *
 * The roster itself comes from one of three places, in priority order:
 *   1. an explicit `agents` list (tests, one-off runs),
 *   2. a folder of `agent.md` definitions (the agency agent library),
 *   3. the three generic built-ins below.
 */

/** The slice of bihan's surface this adapter uses. */
interface BihanTool {
  name: string;
  description?: string;
  toModelHitch(): {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
    function?: unknown;
  };
  run(rawArgs: unknown, context: unknown): Promise<unknown>;
}

interface BihanAgent {
  asTool(options?: { toolName?: string; description?: string }): BihanTool;
}

interface BihanInstance {
  registerAgent(config: Record<string, unknown>): BihanAgent;
  registerTool(tool: unknown): unknown;
  getAgent(name: string): BihanAgent | undefined;
  getAgents(): BihanAgent[];
  setLanePreset(preset: string, target: string): unknown;
  maxSubagentDepth: number;
}

interface BihanModule {
  Bihan: new (options: Record<string, unknown>) => BihanInstance;
  tools: {
    createFileSystemToolkit(options?: { baseDir?: string }): unknown[];
    createShellToolkit(options?: { baseDir?: string }): unknown[];
    createMemoryToolkit(): unknown[];
  };
}

/** Where to load bihan from: env override, then the installed package, then the sibling checkout. */
export function bihanCandidates(): string[] {
  const candidates: string[] = [];
  const envDir = process.env['HARNESS_BIHAN_DIR'] ?? process.env['BIHAN_DIR'];
  if (envDir) candidates.push(join(resolve(envDir), 'dist/index.js'));
  for (const rel of ['../bihan_harness', '../../bihan_harness']) {
    candidates.push(resolve(__dirname, rel, 'dist/index.js'));
  }
  return candidates;
}

/**
 * True when a specifier is a filesystem path rather than a package name.
 *
 * Must not test for "/" — Windows paths use backslashes, and misclassifying
 * them as package names makes `import()` fail under Node's real loader (a
 * bundler or test-runner resolver may still paper over it, which is why this is
 * asserted directly in the tests).
 */
export function isFileTarget(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec);
}

/** The specifier to hand to `import()`: a bare package name, or a file:// URL. */
export function toImportSpecifier(spec: string): string {
  return isFileTarget(spec) ? pathToFileURL(spec).href : spec;
}

/**
 * Load bihan, or return null when it isn't installed. Null means "no subagent
 * tool" — the harness stays fully usable without it.
 */
export async function loadBihan(): Promise<{ module: BihanModule; from: string } | null> {
  // A bare specifier fails cleanly when the package isn't installed; the
  // sibling paths cover the local-dev layout.
  for (const spec of ['@genoventures-labs/bihan', ...bihanCandidates()]) {
    if (isFileTarget(spec) && !existsSync(spec)) continue;
    try {
      const mod = (await import(toImportSpecifier(spec))) as Partial<BihanModule>;
      if (typeof mod.Bihan === 'function' && mod.tools) {
        return { module: mod as BihanModule, from: spec };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Normalise a bihan tool into ModelHitch's flat `ToolDefinition`.
 *
 * ModelHitch wraps tools itself (`{ type: 'function', function: t }`), so a
 * pre-wrapped tool arrives on the wire as `function.function` with no top-level
 * `name`. bihan 0.1.1+ returns the flat shape; this unwraps anyway so the
 * adapter is correct against either version.
 */
export function toFlatDefinition(tool: BihanTool): ToolDefinition {
  const raw = tool.toModelHitch() as Record<string, unknown>;
  const nested = raw['function'];
  const inner =
    nested !== null && typeof nested === 'object' ? (nested as Record<string, unknown>) : raw;
  const name = typeof inner['name'] === 'string' ? inner['name'] : tool.name;
  const description = typeof inner['description'] === 'string' ? inner['description'] : tool.description;
  const parameters =
    inner['parameters'] !== null && typeof inner['parameters'] === 'object'
      ? (inner['parameters'] as Record<string, unknown>)
      : { type: 'object', properties: {} };
  return { name, description, parameters };
}

/**
 * One-line availability summary for the CLI banner, so it is obvious whether
 * subagent delegation is live, and from where.
 */
export async function describeSubagents(options: { agentsDir?: string | null } = {}): Promise<string> {
  const loaded = await loadBihan();
  if (!loaded) {
    return 'subagents=off (bihan not found; install @genoventures-labs/bihan or set HARNESS_BIHAN_DIR)';
  }
  const dir = resolveAgentsDir(options.agentsDir);
  if (!dir) return `subagents=on (bihan from ${loaded.from}; built-in agents only)`;

  const library = loadAgentLibrary({ dir });
  return `subagents=on (bihan from ${loaded.from}; ${library.agents.length} agents from ${dir})`;
}

export interface SubagentRoster {
  /** Tools to add to the orchestrator's tool list. */
  tools: ToolDefinition[];
  /** The delegation tool itself; always `tools[0]`. */
  tool: ToolDefinition;
  /** True when `name` is one of this roster's tools. */
  ownsTool(name: string): boolean;
  /** Dispatch a call to one of `tools`. Never throws. */
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  /** Registered subagent names. */
  names: string[];
  /** Tool names a registered subagent actually holds, to verify tier wiring. */
  toolNamesFor(agentName: string): string[];
  /** Where bihan was loaded from. */
  from: string;
  /** Where the roster came from. */
  source: { kind: 'library'; dir: string } | { kind: 'explicit' } | { kind: 'builtin' };
  /** One descriptor per registered agent. */
  entries: Array<{
    name: string;
    description: string;
    tier: SubagentToolTier;
    sandboxed: boolean;
    unsupportedTools: string[];
    sourcePath?: string;
  }>;
  /** Non-fatal problems found while loading, e.g. a malformed definition. */
  warnings: string[];
  /** The loaded library, when the roster came from a folder. */
  library?: AgentLibrary;
}

export interface AgentSpec {
  name: string;
  role: string;
  instructions: string;
  tools: SubagentToolTier;
}

export interface SubagentOptions {
  /** Model target subagents inherit, as `provider/model`. */
  model: string;
  workspaceDir: string;
  /** Explicit agents; overrides both the library and the built-ins. */
  agents?: AgentSpec[];
  /** Folder of agent definitions. `undefined` auto-discovers; `null` disables. */
  agentsDir?: string | null;
  maxDepth?: number;
  /** Names to leave out of a loaded library. */
  exclude?: string[];
}

/** Generic sub-contractors, used when no agent library is available. */
export const DEFAULT_SUBAGENTS: AgentSpec[] = [
  {
    name: 'Scout',
    role: 'Read-only Reconnaissance',
    instructions:
      'Explore the workspace and report findings. You cannot modify anything. ' +
      'Cite concrete file paths and line numbers in your answer.',
    tools: 'readonly',
  },
  {
    name: 'Builder',
    role: 'Implementation',
    instructions:
      'Implement the requested change in the workspace. Make the smallest correct edit, ' +
      'then report exactly which files you changed and why.',
    tools: 'full',
  },
  {
    name: 'Verifier',
    role: 'Verification',
    instructions:
      'Independently verify claimed work: run the relevant build and tests and inspect the diff. ' +
      'Report what you actually observed, including failures. Do not take claims on trust. ' +
      'You have no file-editing tool, and you must not modify the workspace — your shell can ' +
      'technically write files, but report problems instead of fixing them.',
    tools: 'shell',
  },
];

/** Descriptions are truncated in the catalogue so 50+ agents stay affordable. */
const CATALOG_DESCRIPTION_CHARS = 120;

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function buildCatalog(entries: Array<{ name: string; description: string; tier: SubagentToolTier }>): string {
  return entries
    .map((entry) => `- ${entry.name} (${entry.tier}): ${truncate(entry.description || '(no description)', CATALOG_DESCRIPTION_CHARS)}`)
    .join('\n');
}

/**
 * Build the subagent roster. Returns null when bihan is unavailable, so the
 * harness degrades to its own tools instead of failing to start.
 */
export async function createSubagentRoster(
  client: unknown,
  options: SubagentOptions,
): Promise<SubagentRoster | null> {
  const loaded = await loadBihan();
  if (!loaded) return null;
  const { Bihan, tools } = loaded.module;

  const bihan = new Bihan({
    // Share the harness's ModelHitch client so subagents inherit its policy,
    // failover, cooldown, and usage accounting rather than opening a second
    // unmanaged path to providers.
    client,
    defaultModel: options.model,
    maxSubagentDepth: options.maxDepth ?? 2,
  });

  // Resolve the concrete tool objects once, then grant per agent by name.
  const toolsByName = new Map<string, unknown>();
  const register = (name: string, tool: unknown): void => {
    toolsByName.set(name, tool);
  };
  for (const tool of tools.createFileSystemToolkit({ baseDir: options.workspaceDir })) {
    register((tool as { name: string }).name, tool);
  }
  for (const tool of tools.createShellToolkit({ baseDir: options.workspaceDir })) {
    register((tool as { name: string }).name, tool);
  }
  register(GREP_TOOL_NAME, createGrepTool(options.workspaceDir));

  const warnings: string[] = [];
  const entries: SubagentRoster['entries'] = [];
  let library: AgentLibrary | undefined;
  let source: SubagentRoster['source'];

  /** Register one agent with the toolset its tier implies. */
  const addAgent = (spec: {
    name: string;
    role: string;
    instructions: string;
    tier: SubagentToolTier;
    description?: string;
    sandboxed?: boolean;
    unsupportedTools?: string[];
    sourcePath?: string;
  }): void => {
    const granted = TIER_TOOLS[spec.tier];
    const toolset: unknown[] = [];
    for (const name of granted) {
      const tool = toolsByName.get(name);
      if (tool === undefined) {
        // A missing tool means the grant and the toolkit disagree; say so rather
        // than handing the agent a capability that silently does not exist.
        warnings.push(`${spec.name}: tool "${name}" is not available and was not granted`);
        continue;
      }
      toolset.push(tool);
    }

    bihan.registerAgent({
      name: spec.name,
      role: spec.role,
      instructions: spec.instructions,
      tools: toolset,
    });

    entries.push({
      name: spec.name,
      description: spec.description ?? spec.role,
      tier: spec.tier,
      sandboxed: spec.sandboxed === true,
      unsupportedTools: spec.unsupportedTools ?? [],
      sourcePath: spec.sourcePath,
    });
  };

  if (options.agents) {
    source = { kind: 'explicit' };
    for (const spec of options.agents) {
      addAgent({ name: spec.name, role: spec.role, instructions: spec.instructions, tier: spec.tools });
    }
  } else {
    const dir = resolveAgentsDir(options.agentsDir);
    if (dir) {
      library = loadAgentLibrary({ dir, ...(options.exclude ? { exclude: options.exclude } : {}) });
      source = { kind: 'library', dir: library.dir };
      warnings.push(...library.warnings);
      for (const agent of library.agents) {
        addAgent({
          name: agent.name,
          // The system prompt bihan builds is "You are X, acting as: <role>",
          // so the description is the most useful thing to put in the role slot.
          role: truncate(agent.description || agent.name, 200),
          instructions: agent.body,
          tier: agent.tier,
          description: agent.description,
          sandboxed: agent.sandboxed,
          unsupportedTools: agent.unsupportedTools,
          sourcePath: agent.sourcePath,
        });
      }
    } else {
      source = { kind: 'builtin' };
      for (const spec of DEFAULT_SUBAGENTS) {
        addAgent({ name: spec.name, role: spec.role, instructions: spec.instructions, tier: spec.tools });
      }
    }
  }

  const names = entries.map((entry) => entry.name);
  const catalogue = buildCatalog(entries);
  const fromLibrary = source.kind === 'library';

  const delegationTool: ToolDefinition = {
    name: 'subagent',
    description:
      `Delegate a focused task to a specialized subagent (sub-contractor). It runs its own separate ` +
      `tool loop in this workspace and returns only its final answer, keeping this context clean. ` +
      `Use it for work that would otherwise flood this conversation with file contents or command output.\n\n` +
      `Available subagents (${names.length}):\n${catalogue}` +
      (fromLibrary ? `\n\nUse find_subagent(query) if you are unsure which agent fits.` : ''),
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Which subagent to dispatch, by exact name.' },
        task: {
          type: 'string',
          description:
            'Clear, self-contained instructions and any context the subagent needs. ' +
            'Subagent runs are stateless and cannot see this conversation.',
        },
      },
      required: ['agent', 'task'],
    },
  };

  const toolsOut: ToolDefinition[] = [delegationTool];

  /** Find-subagent is only worth its context when there is a real catalogue. */
  let findTool: ToolDefinition | undefined;
  if (fromLibrary && library) {
    findTool = {
      name: 'find_subagent',
      description:
        `Search the ${library.agents.length} available subagents by intent when you are unsure which one to use. ` +
        `Returns the best-matching agent names with their descriptions.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you need done, in a few words.' },
          limit: { type: 'integer', description: 'Maximum matches to return. Defaults to 8.' },
        },
        required: ['query'],
      },
    };
    toolsOut.push(findTool);
  }

  const nameList = (): string => names.join(', ');

  async function findMatches(args: Record<string, unknown>): Promise<string> {
    const query = typeof args['query'] === 'string' ? (args['query'] as string) : '';
    if (query.trim() === '') return 'Error: find_subagent needs a non-empty query.';
    const limit = typeof args['limit'] === 'number' ? Math.max(1, Math.min(25, args['limit'] as number)) : 8;
    if (!library) return `Error: no agent library is loaded; available: ${nameList()}.`;
    const matches = searchAgents(library.agents, query, limit);
    if (matches.length === 0) {
      return `No subagent matched "${query}". Available: ${nameList()}.`;
    }
    return matches
      .map((m) => `${m.name} (${m.tier}): ${m.description || '(no description)'}`)
      .join('\n');
  }

  async function delegate(args: Record<string, unknown>): Promise<string> {
    const agent = typeof args['agent'] === 'string' ? (args['agent'] as string) : '';
    const task = typeof args['task'] === 'string' ? (args['task'] as string) : '';
    if (!agent || !task) {
      return `Error: subagent needs both "agent" and "task". Available: ${nameList()}.`;
    }
    const target = bihan.getAgent(agent);
    if (!target) {
      return (
        `Error: unknown subagent "${agent}". ` +
        (findTool ? `Use find_subagent to pick one. ` : '') +
        `Available: ${nameList()}.`
      );
    }
    try {
      // asTool() gives the subagent entry point: it runs the subagent's own loop
      // and returns only its synthesized answer.
      const out = await target.asTool().run({ task }, { agentName: 'Harness' });
      return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
    } catch (err) {
      return `Error: subagent "${agent}" failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    tools: toolsOut,
    tool: delegationTool,
    names,
    from: loaded.from,
    source,
    entries,
    warnings,
    ...(library ? { library } : {}),
    ownsTool(name: string) {
      return toolsOut.some((t) => t.name === name);
    },
    async execute(name: string, args: Record<string, unknown>) {
      if (name === delegationTool.name) return delegate(args);
      if (findTool && name === findTool.name) return findMatches(args);
      return `Error: unknown subagent tool "${name}".`;
    },
    toolNamesFor(agentName: string) {
      const agent = bihan.getAgent(agentName) as unknown as
        | { getTools(): Array<{ name: string }> }
        | undefined;
      return agent ? agent.getTools().map((t) => t.name) : [];
    },
  };
}
