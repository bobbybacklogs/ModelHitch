import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ToolDefinition } from '../src/index.js';

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
 */

/** The slice of bihan's surface this adapter uses. */
interface BihanTool {
  name: string;
  description: string;
  toModelHitch(): { name?: string; description?: string; parameters?: Record<string, unknown>; function?: unknown };
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
 * subagent delegation is live or silently absent.
 */
export async function describeSubagents(): Promise<string> {
  const loaded = await loadBihan();
  if (!loaded) {
    return 'subagents=off (bihan not found; install @genoventures-labs/bihan or set HARNESS_BIHAN_DIR)';
  }
  return `subagents=on (bihan from ${loaded.from})`;
}

export interface SubagentRoster {
  /** The single `subagent` tool the orchestrator calls. */
  tool: ToolDefinition;
  /** Registered sub-contractor names, for diagnostics and tests. */
  names: string[];
  /** Run one delegation; never throws — tool errors come back as JSON text. */
  execute(args: Record<string, unknown>): Promise<string>;
  /** Tool names a registered subagent actually holds, to verify tier wiring. */
  toolNamesFor(agentName: string): string[];
  /** Where bihan was loaded from. */
  from: string;
}

export interface SubagentOptions {
  /** Model target subagents inherit, as `provider/model`. */
  model: string;
  workspaceDir: string;
  /** Registry of agent names -> instructions/roles; defaults to the built-ins. */
  agents?: Array<{ name: string; role: string; instructions: string; tools: SubagentToolTier }>;
  maxDepth?: number;
}

/**
 * Tool tiers for subagents.
 *
 * Only `readonly` is a real, enforceable restriction: it holds neither a
 * `write_file` tool nor a shell, so it genuinely cannot modify the workspace.
 *
 * `shell`, `write`, and `full` can all modify the workspace — and note that
 * shell access IS write access. A subagent with `run_command` can write files
 * with the shell (`echo x> f.txt`) even though it holds no `write_file` tool.
 * Verified empirically: a `shell`-tier Verifier created a file exactly that
 * way. Tiers therefore describe *intent and least privilege*, not a sandbox;
 * do not treat them as a security boundary.
 *
 * `readonly` — inspect files only. Genuinely cannot write.
 * `shell`    — inspect files and run commands; no edit tool, but the shell can
 *              still write. Use for verification, where it must run the build
 *              and tests but should not be fixing what it checks.
 * `write`    — edit files, no shell.
 * `full`     — edit files and run commands.
 */
export type SubagentToolTier = 'readonly' | 'shell' | 'write' | 'full';

/** Built-in sub-contractors. */
export const DEFAULT_SUBAGENTS: Array<{
  name: string;
  role: string;
  instructions: string;
  tools: SubagentToolTier;
}> = [
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

  const fsTools = tools.createFileSystemToolkit({ baseDir: options.workspaceDir });
  const shellTools = tools.createShellToolkit({ baseDir: options.workspaceDir });
  const readable = fsTools.filter((t) => (t as { name?: string }).name !== 'write_file');

  const toolsetFor = (tier: SubagentToolTier): unknown[] => {
    switch (tier) {
      case 'readonly':
        return readable;
      case 'shell':
        return [...readable, ...shellTools];
      case 'write':
        return fsTools;
      case 'full':
        return [...fsTools, ...shellTools];
    }
  };

  for (const spec of options.agents ?? DEFAULT_SUBAGENTS) {
    bihan.registerAgent({
      name: spec.name,
      role: spec.role,
      instructions: spec.instructions,
      tools: toolsetFor(spec.tools),
    });
  }

  const names = bihan.getAgents().map((a) => (a as unknown as { name: string }).name);
  const roster = names.map((n) => `"${n}"`).join(', ');

  const tool: ToolDefinition = {
    name: 'subagent',
    description:
      `Delegate a focused task to a specialized subagent (sub-contractor). It runs its own separate ` +
      `tool loop in this workspace and returns only its final answer, keeping this context clean. ` +
      `Available subagents: ${roster}. Use it for work that would otherwise flood this conversation ` +
      `with file contents or command output.`,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: `Which subagent to dispatch: ${roster}` },
        task: {
          type: 'string',
          description: 'Clear, self-contained instructions and any context the subagent needs.',
        },
      },
      required: ['agent', 'task'],
    },
  };

  return {
    tool,
    names,
    from: loaded.from,
    toolNamesFor(agentName: string) {
      const agent = bihan.getAgent(agentName) as unknown as
        | { getTools(): Array<{ name: string }> }
        | undefined;
      return agent ? agent.getTools().map((t) => t.name) : [];
    },
    async execute(args) {
      const agent = typeof args['agent'] === 'string' ? (args['agent'] as string) : '';
      const task = typeof args['task'] === 'string' ? (args['task'] as string) : '';
      if (!agent || !task) {
        return `Error: subagent needs both "agent" and "task". Available: ${roster}.`;
      }
      const target = bihan.getAgent(agent);
      if (!target) {
        return `Error: unknown subagent "${agent}". Available: ${roster || '(none registered)'}.`;
      }
      try {
        // asTool() gives the debounced subagent entry point: it runs the
        // subagent's own loop and returns only its synthesized answer.
        const out = await target.asTool().run({ task }, { agentName: 'Harness' });
        return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      } catch (err) {
        return `Error: subagent "${agent}" failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}
