import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const FALLBACK_SYSTEM = `You are an expert engineer executing a coding task.
Write short, direct code with no fluff. Verify against real artifacts (files, command output, tests), never mocks.
Cite concrete files and commands in your final summary.`;

export interface ZstackContext {
  systemPrompt: string;
  playbook: string;
  principles: string[];
  modelHint?: string;
}

function zstackRoot(): string | null {
  const candidates = [
    process.env.ZSTACK_DIR,
    resolve(__dirname, '../../zstack'),
    resolve(__dirname, '../zstack'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(join(c, 'playbooks')) && existsSync(join(c, 'principles'))) return c;
  }
  return null;
}

export async function buildSystemPrompt(
  taskPrompt: string,
  opts: { extraSystem?: string; noZstack?: boolean } = {},
): Promise<ZstackContext> {
  if (opts.noZstack || process.env.HARNESS_NO_ZSTACK === '1') {
    const systemPrompt = [FALLBACK_SYSTEM, opts.extraSystem].filter(Boolean).join('\n\n');
    return { systemPrompt, playbook: 'none', principles: [] };
  }
  const root = zstackRoot();
  if (!root) {
    const systemPrompt = [FALLBACK_SYSTEM, opts.extraSystem].filter(Boolean).join('\n\n');
    return { systemPrompt, playbook: 'none', principles: [] };
  }
  try {
    const mod = (await import(pathToFileURL(join(root, 'src/sdk.mjs')).href)) as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;
    const ZStack = mod['ZStack'];
    const zs = new ZStack({ rootDir: root, workspaceDir: process.cwd() });
    const detailed = zs.classifyPromptDetailed(taskPrompt);
    const playbookType: string = detailed.type ?? 'feature';
    const principleNames: string[] = detailed.principles ?? [];
    let playbookContent = '';
    try {
      playbookContent = zs.getPlaybook(playbookType) as string;
    } catch {
      playbookContent = `# Task: ${playbookType}`;
    }
    const principleTexts: string[] = [];
    for (const p of principleNames.slice(0, 4)) {
      try {
        principleTexts.push(`### Principle: ${p}\n${zs.getPrinciple(p) as string}`.slice(0, 4000));
      } catch {
        principleTexts.push(`### Principle: ${p}`);
      }
    }
    const systemPrompt = [
      zs.defaultSystemPrompt ?? FALLBACK_SYSTEM,
      opts.extraSystem ?? '',
      `## Applicable Task Playbook (${playbookType}):\n${playbookContent.slice(0, 8000)}`,
      principleTexts.length > 0 ? `## Applicable Principles:\n${principleTexts.join('\n\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { systemPrompt, playbook: playbookType, principles: principleNames };
  } catch {
    const systemPrompt = [FALLBACK_SYSTEM, opts.extraSystem].filter(Boolean).join('\n\n');
    return { systemPrompt, playbook: 'fallback', principles: [] };
  }
}
