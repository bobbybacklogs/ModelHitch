import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUDED_AGENTS,
  TIER_TOOLS,
  agentsDirCandidates,
  defaultAgentsDir,
  loadAgentLibrary,
  mapDeclaredTools,
  parseFrontmatter,
  resolveAgentsDir,
  searchAgents,
} from '../harness/agent-library.js';

const FIXTURES = resolve(__dirname, 'fixtures', 'agents');

/** The user's real agency library, if this machine has one. */
const REAL_DIR = defaultAgentsDir();
const hasRealLibrary = existsSync(REAL_DIR);

describe('parseFrontmatter', () => {
  it('parses a plain scalar and the body', () => {
    const { data, body } = parseFrontmatter('---\nname: alpha\ndescription: Plain text here.\n---\n\n# Alpha\n\nBody text.\n');
    expect(data['name']).toBe('alpha');
    expect(data['description']).toBe('Plain text here.');
    expect(body).toBe('# Alpha\n\nBody text.');
  });

  it('parses a block list into an array', () => {
    const { data } = parseFrontmatter('---\ntools:\n  - view_file\n  - grep_search\n---\nbody\n');
    expect(data['tools']).toEqual(['view_file', 'grep_search']);
  });

  it('splits only on the first colon', () => {
    const { data } = parseFrontmatter('---\ndescription: Ready when: you are done.\n---\nx\n');
    expect(data['description']).toBe('Ready when: you are done.');
  });

  it('unquotes a double-quoted scalar and keeps inner colons and apostrophes', () => {
    const { data } = parseFrontmatter(
      '---\ndescription: "Quoted: it\'s got \'apostrophes\' and a colon."\n---\nx\n',
    );
    expect(data['description']).toBe("Quoted: it's got 'apostrophes' and a colon.");
  });

  it('handles a quoted empty string', () => {
    const { data } = parseFrontmatter('---\nname: x\ndescription: ""\n---\nx\n');
    expect(data['description']).toBe('');
  });

  it('folds a > block scalar onto one line', () => {
    const { data } = parseFrontmatter('---\ndescription: >\n  line one\n  line two\n  line three\ntools:\n  - view_file\n---\nx\n');
    expect(data['description']).toBe('line one line two line three');
    // The block must not swallow the next key.
    expect(data['tools']).toEqual(['view_file']);
  });

  it('keeps newlines for a | literal block scalar', () => {
    const { data } = parseFrontmatter('---\ndescription: |\n  line one\n  line two\n---\nx\n');
    expect(data['description']).toBe('line one\nline two');
  });

  it('parses an inline list', () => {
    const { data } = parseFrontmatter('---\ntools: [view_file, grep_search]\n---\nx\n');
    expect(data['tools']).toEqual(['view_file', 'grep_search']);
  });

  it('treats a bare key with no value as an empty scalar, not an empty list', () => {
    const { data } = parseFrontmatter('---\ndescription:\nname: x\n---\nbody\n');
    expect(data['description']).toBe('');
    expect(data['name']).toBe('x');
  });

  it('warns and returns the whole text when there is no frontmatter', () => {
    const { data, body, warnings } = parseFrontmatter('Just a body, no frontmatter.');
    expect(data).toEqual({});
    expect(body).toBe('Just a body, no frontmatter.');
    expect(warnings.join(' ')).toContain('no YAML frontmatter');
  });

  it('warns on unterminated frontmatter instead of hanging', () => {
    const { warnings } = parseFrontmatter('---\nname: x\nbody never closes\n');
    expect(warnings.join(' ')).toContain('unterminated');
  });

  it('warns on an unparseable line but keeps parsing the rest', () => {
    const { data, warnings } = parseFrontmatter('---\nname: x\nnot a valid line at all\ntools:\n  - view_file\n---\nb\n');
    expect(data['name']).toBe('x');
    expect(data['tools']).toEqual(['view_file']);
    expect(warnings.join(' ')).toContain('unparseable');
  });

  it('tolerates CRLF and a BOM', () => {
    const { data, body } = parseFrontmatter('\uFEFF---\r\nname: crlf\r\n---\r\nbody\r\n');
    expect(data['name']).toBe('crlf');
    expect(body).toBe('body');
  });
});

describe('mapDeclaredTools', () => {
  it('maps read-only declarations to the readonly tier', () => {
    const mapped = mapDeclaredTools(['view_file', 'grep_search']);
    expect(mapped.tier).toBe('readonly');
    expect(mapped.granted).toEqual(TIER_TOOLS.readonly);
    expect(mapped.unsupported).toEqual([]);
  });

  it('maps write and shell to the full tier', () => {
    expect(mapDeclaredTools(['view_file', 'replace_file_content', 'run_command']).tier).toBe('full');
  });

  it('maps shell without write to the shell tier', () => {
    expect(mapDeclaredTools(['view_file', 'run_command']).tier).toBe('shell');
  });

  it('maps write without shell to the write tier', () => {
    expect(mapDeclaredTools(['view_file', 'replace_file_content']).tier).toBe('write');
  });

  it('defaults an empty declaration to readonly, never full', () => {
    const mapped = mapDeclaredTools([]);
    expect(mapped.tier).toBe('readonly');
    expect(mapped.granted).not.toContain('write_file');
    expect(mapped.granted).not.toContain('run_command');
  });

  it('reports manage_task as unsupported instead of dropping it silently', () => {
    const mapped = mapDeclaredTools(['manage_task']);
    expect(mapped.unsupported).toEqual(['manage_task']);
    expect(mapped.tier).toBe('readonly');
  });

  it('reports an entirely unknown tool name as unsupported', () => {
    expect(mapDeclaredTools(['teleport']).unsupported).toEqual(['teleport']);
  });

  it('withholds the shell for a sandboxed agent and downgrades it to readonly', () => {
    const mapped = mapDeclaredTools(['view_file', 'grep_search', 'run_command'], { sandboxed: true });
    expect(mapped.tier).toBe('readonly');
    expect(mapped.granted).not.toContain('run_command');
    expect(mapped.warnings.join(' ')).toContain('sandbox');
  });

  it('keeps shell for a non-sandboxed agent that declares it', () => {
    expect(mapDeclaredTools(['run_command']).granted).toContain('run_command');
  });

  it('never grants a capability the agent did not declare', () => {
    // A readonly agent must not end up with write or shell through its tier.
    const readonly = mapDeclaredTools(['view_file']);
    expect(readonly.granted).not.toContain('write_file');
    expect(readonly.granted).not.toContain('run_command');
  });
});

describe('loadAgentLibrary against fixtures', () => {
  const library = loadAgentLibrary({ dir: FIXTURES });
  const byName = new Map(library.agents.map((a) => [a.name, a]));

  it('loads every directory that has an agent.md', () => {
    // 12 fixture directories contain an agent.md; orchestrator (policy) and
    // kappa (subagent: false) are excluded, so 10 are loaded.
    expect(library.agents.length).toBe(10);
  });

  it('ignores stray files and directories without agent.md', () => {
    expect(byName.has('stray')).toBe(false);
    expect(byName.has('empty-dir')).toBe(false);
  });

  it('excludes the orchestrator by default', () => {
    expect(DEFAULT_EXCLUDED_AGENTS).toContain('orchestrator');
    expect(byName.has('orchestrator')).toBe(false);
    expect(library.excluded.some((e) => e.name === 'orchestrator')).toBe(true);
  });

  it('excludes an agent whose definition sets subagent: false', () => {
    expect(byName.has('kappa')).toBe(false);
    expect(library.excluded.some((e) => e.name === 'kappa' && /subagent: false/.test(e.reason))).toBe(true);
  });

  it('can include the orchestrator when exclusion is overridden', () => {
    const all = loadAgentLibrary({ dir: FIXTURES, exclude: [] });
    expect(all.agents.map((a) => a.name)).toContain('orchestrator');
    // Overriding the policy list does not resurrect kappa, which excludes
    // itself from delegation via `subagent: false`.
    expect(all.agents.map((a) => a.name)).not.toContain('kappa');
    expect(all.agents.length).toBe(11);
  });

  it('keeps the markdown body as the instructions', () => {
    expect(byName.get('alpha')!.body).toContain('Never modify anything.');
    expect(byName.get('alpha')!.body.startsWith('# Alpha')).toBe(true);
  });

  it('derives the readonly tier for a read-only agent', () => {
    const alpha = byName.get('alpha')!;
    expect(alpha.tier).toBe('readonly');
    expect(alpha.grantedTools).not.toContain('run_command');
  });

  it('derives the full tier for an agent declaring edits and shell', () => {
    expect(byName.get('beta')!.tier).toBe('full');
  });

  it('defaults an agent with no tools key to readonly', () => {
    const gamma = byName.get('gamma')!;
    expect(gamma.declaredTools).toEqual([]);
    expect(gamma.tier).toBe('readonly');
  });

  it('downgrades a sandboxed agent and records why', () => {
    const delta = byName.get('delta')!;
    expect(delta.sandboxed).toBe(true);
    expect(delta.tier).toBe('readonly');
    expect(delta.grantedTools).not.toContain('run_command');
  });

  it('records unsupported tools on the agent', () => {
    expect(byName.get('epsilon')!.unsupportedTools).toEqual(['manage_task']);
  });

  it('parses quoted descriptions containing colons and apostrophes', () => {
    const zeta = byName.get('zeta')!;
    expect(zeta.description).toContain("it contains a colon, 'apostrophes'");
    expect(zeta.description.endsWith('.')).toBe(true);
  });

  it('parses folded descriptions', () => {
    const eta = byName.get('eta')!;
    expect(eta.description).toBe(
      'Folded block scalar description that spans several lines and should be joined into a single line with no newlines left in it.',
    );
    expect(eta.description).not.toContain('\n');
  });

  it('falls back to the directory name when there is no name key', () => {
    const theta = byName.get('theta')!;
    expect(theta.name).toBe('theta');
    expect(theta.warnings.join(' ')).toContain('directory name');
  });

  it('handles a file with no frontmatter at all', () => {
    const iota = byName.get('iota')!;
    expect(iota.name).toBe('iota');
    expect(iota.body).toContain('No frontmatter here');
    expect(iota.tier).toBe('readonly');
  });

  it('warns about a malformed line but still loads the agent', () => {
    const lambda = byName.get('lambda')!;
    expect(lambda.name).toBe('lambda');
    expect(lambda.declaredTools).toEqual(['view_file']);
    expect(library.warnings.join(' ')).toContain('lambda');
  });

  it('reports a missing directory instead of throwing', () => {
    const missing = loadAgentLibrary({ dir: join(FIXTURES, 'does-not-exist') });
    expect(missing.agents).toEqual([]);
    expect(missing.warnings.join(' ')).toContain('cannot read');
  });
});

describe('agent directory resolution', () => {
  it('offers the standard library location', () => {
    expect(defaultAgentsDir().endsWith(join('.agents', 'agents'))).toBe(true);
    expect(agentsDirCandidates().some((c) => c.includes('.agents'))).toBe(true);
  });

  it('treats null as explicitly disabled', () => {
    expect(resolveAgentsDir(null)).toBeNull();
  });

  it('returns null for an explicit path that does not exist', () => {
    expect(resolveAgentsDir(join(FIXTURES, 'nope'))).toBeNull();
  });

  it('returns the resolved path for one that does', () => {
    expect(resolveAgentsDir(FIXTURES)).toBe(FIXTURES);
  });
});

describe('searchAgents', () => {
  const library = loadAgentLibrary({ dir: FIXTURES });

  it('ranks an exact name first', () => {
    expect(searchAgents(library.agents, 'alpha')[0]!.name).toBe('alpha');
  });

  it('matches on description words', () => {
    const hits = searchAgents(library.agents, 'sandbox shell');
    expect(hits.map((h) => h.name)).toContain('delta');
  });

  it('returns an empty list for an empty or unmatchable query', () => {
    expect(searchAgents(library.agents, '')).toEqual([]);
    expect(searchAgents(library.agents, 'zzzzqqqq')).toEqual([]);
  });

  it('respects the limit', () => {
    expect(searchAgents(library.agents, 'the', 2).length).toBeLessThanOrEqual(2);
  });
});

/**
 * The real thing: the user's own 57-agent library. Skipped where it is absent
 * (CI), so this pins the parser against the actual corpus without making the
 * suite depend on a home directory.
 */
describe.skipIf(!hasRealLibrary)('the real agency library', () => {
  const library = loadAgentLibrary({ dir: REAL_DIR });
  const byName = new Map(library.agents.map((a) => [a.name, a]));

  it('loads dozens of agents', () => {
    expect(library.agents.length).toBeGreaterThan(40);
  });

  it('gives every agent a name and a non-empty body', () => {
    for (const agent of library.agents) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.body.length).toBeGreaterThan(0);
    }
  });

  it('gives every agent a tier and at least one granted tool', () => {
    for (const agent of library.agents) {
      expect(['readonly', 'shell', 'write', 'full']).toContain(agent.tier);
      expect(agent.grantedTools.length).toBeGreaterThan(0);
    }
  });

  it('parses the folded description that spans multiple lines', () => {
    const bounty = byName.get('web-bounty-hunter');
    expect(bounty).toBeDefined();
    expect(bounty!.description).toContain('Read-only offensive-minded');
    expect(bounty!.description).not.toContain('\n');
  });

  it('honours the sandbox on the security agent', () => {
    const bounty = byName.get('web-bounty-hunter')!;
    expect(bounty.sandboxed).toBe(true);
    expect(bounty.grantedTools).not.toContain('run_command');
    // Its own description says "Does not modify source code", so readonly is right.
    expect(bounty.tier).toBe('readonly');
    expect(bounty.description).toContain('Does not modify source code');
  });

  it('parses every quoted description containing apostrophes', () => {
    const tesseract = byName.get('tesseract');
    expect(tesseract).toBeDefined();
    expect(tesseract!.description.startsWith('"')).toBe(false);
    expect(tesseract!.description.length).toBeGreaterThan(100);
  });

  it('excludes the orchestrator from the roster', () => {
    expect(byName.has('orchestrator')).toBe(false);
    expect(library.excluded.some((e) => e.name === 'orchestrator')).toBe(true);
  });

  it('maps the tools that dominate the corpus', () => {
    const declaring = (tool: string): number =>
      library.agents.filter((a) => a.declaredTools.includes(tool)).length;
    // These counts come from the corpus itself; they pin the parser against it.
    expect(declaring('grep_search')).toBeGreaterThanOrEqual(40);
    expect(declaring('view_file')).toBeGreaterThanOrEqual(40);
    expect(declaring('run_command')).toBeGreaterThanOrEqual(30);
    expect(declaring('replace_file_content')).toBeGreaterThanOrEqual(25);
    expect(declaring('manage_task')).toBeGreaterThanOrEqual(8);
  });

  it('never grants a shell to an agent that did not declare run_command', () => {
    for (const agent of library.agents) {
      if (agent.declaredTools.includes('run_command')) continue;
      expect(agent.grantedTools).not.toContain('run_command');
    }
  });

  it('never grants writes to an agent that declared neither edits nor shell', () => {
    for (const agent of library.agents) {
      const declaredMutation =
        agent.declaredTools.includes('replace_file_content') || agent.declaredTools.includes('run_command');
      if (declaredMutation) continue;
      expect(agent.grantedTools).not.toContain('write_file');
      expect(agent.tier).toBe('readonly');
    }
  });

  it('keeps the total catalogue small enough to fit in a prompt', () => {
    // Only descriptions are ever injected wholesale; bodies load per delegation.
    const catalogue = library.agents.map((a) => a.description).join(' ').length;
    expect(catalogue).toBeLessThan(20_000);
  });
});
