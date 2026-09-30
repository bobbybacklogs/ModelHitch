import { relative, resolve } from 'node:path';

/**
 * Workspace path containment.
 *
 * The executor refuses to touch anything outside the workspace, and the approval
 * preview wants the same answer without duplicating the rule. One definition,
 * two callers, and the approval gate is then never looking at a file the write
 * would have been refused for.
 */
export function resolveWorkspacePath(workspaceDir: string, p: string): string {
  const abs = resolve(workspaceDir, p);
  const rel = relative(workspaceDir, abs);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return abs;
}

/** True when `p` resolves inside `workspaceDir`; never throws. */
export function isInsideWorkspace(workspaceDir: string, p: string): boolean {
  try {
    resolveWorkspacePath(workspaceDir, p);
    return true;
  } catch {
    return false;
  }
}
