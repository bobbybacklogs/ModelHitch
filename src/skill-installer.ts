import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sharedSkill from '../plugins/modelhitch/skills/modelhitch/SKILL.md';
import sharedReference from '../plugins/modelhitch/skills/modelhitch/references/api-and-operations.md';
import claudeIntegrateSkill from '../.claude/skills/modelhitch-integrate/SKILL.md';
import claudeIntegrateReference from '../.claude/skills/modelhitch-integrate/references/api-reference.md';
import claudeBridgeSkill from '../.claude/skills/modelhitch-bridge/SKILL.md';
import claudeBridgeReference from '../.claude/skills/modelhitch-bridge/references/operations-reference.md';
import { zstackSkillFiles, setupZstackSkillFiles } from './zstack-template.js';

export const SETUP_TARGETS = ['codex', 'claude', 'cursor', 'vscode', 'all'] as const;
export const SETUP_PACKAGES = ['modelhitch', 'zstack'] as const;

export type SetupTarget = (typeof SETUP_TARGETS)[number];
export type SetupPackage = (typeof SETUP_PACKAGES)[number];
export type SetupScope = 'user' | 'project';

export interface InstallSkillsOptions {
  target: SetupTarget;
  package?: SetupPackage;
  scope?: SetupScope;
  force?: boolean;
  dryRun?: boolean;
  homeDir?: string;
  projectDir?: string;
}

export interface InstalledSkill {
  agent: Exclude<SetupTarget, 'all'>;
  path: string;
  files: string[];
}

interface SkillTemplate {
  name: string;
  files: Record<string, string>;
}

const shared: SkillTemplate = {
  name: 'modelhitch',
  files: {
    'SKILL.md': sharedSkill,
    'references/api-and-operations.md': sharedReference,
  },
};

const claudeSkills: SkillTemplate[] = [
  {
    name: 'modelhitch-integrate',
    files: {
      'SKILL.md': claudeIntegrateSkill,
      'references/api-reference.md': claudeIntegrateReference,
    },
  },
  {
    name: 'modelhitch-bridge',
    files: {
      'SKILL.md': claudeBridgeSkill,
      'references/operations-reference.md': claudeBridgeReference,
    },
  },
];

const zstackTemplates: SkillTemplate[] = [
  {
    name: 'zstack',
    files: zstackSkillFiles,
  },
  {
    name: 'setup-zstack',
    files: setupZstackSkillFiles,
  },
];

const userRoots = {
  codex: ['.codex', 'skills'],
  claude: ['.claude', 'skills'],
  cursor: ['.cursor', 'skills'],
  vscode: ['.copilot', 'skills'],
} as const;

const projectRoots = {
  codex: ['.agents', 'skills'],
  claude: ['.claude', 'skills'],
  cursor: ['.cursor', 'skills'],
  vscode: ['.github', 'skills'],
} as const;

function agentsFor(target: SetupTarget): Array<Exclude<SetupTarget, 'all'>> {
  return target === 'all' ? ['codex', 'claude', 'cursor', 'vscode'] : [target];
}

export function installSkills(options: InstallSkillsOptions): InstalledSkill[] {
  const scope = options.scope ?? 'user';
  const pkg = options.package ?? 'modelhitch';
  const base = scope === 'user' ? (options.homeDir ?? homedir()) : (options.projectDir ?? process.cwd());
  const roots = scope === 'user' ? userRoots : projectRoots;
  const planned = agentsFor(options.target).flatMap((agent) => {
    let templates: SkillTemplate[];
    if (pkg === 'zstack') {
      templates = zstackTemplates;
    } else {
      templates = agent === 'claude' ? claudeSkills : [shared];
    }
    return templates.map((template) => {
      const path = join(base, ...roots[agent], template.name);
      return { agent, path, template };
    });
  });

  if (!options.force && !options.dryRun) {
    const collisions = planned.filter(({ path }) => existsSync(path));
    if (collisions.length > 0) {
      const paths = collisions.map(({ path }) => `  ${path}`).join('\n');
      throw new Error(`Skill destination already exists:\n${paths}\nRun again with --force to update managed files.`);
    }
  }

  return planned.map(({ agent, path, template }) => {
    const files = Object.keys(template.files).map((relativePath) => join(path, relativePath));
    if (!options.dryRun) {
      for (const [relativePath, content] of Object.entries(template.files)) {
        const destination = join(path, relativePath);
        mkdirSync(join(destination, '..'), { recursive: true });
        writeFileSync(destination, content, 'utf8');
      }
    }
    return { agent, path, files };
  });
}
