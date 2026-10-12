import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Durable conversation -> cloud-agent session map.
 *
 * The in-memory map is lost on every bridge restart, and a lost map is not
 * cosmetic: the vendor still holds the agent, but the bridge no longer knows
 * which agent belongs to which conversation, so the next turn forks a new agent
 * and the earlier work is orphaned. Verified by `tests/cloud-agent-readopt.test.ts`
 * — `list()` alone cannot bridge that gap, because the vendor has no idea what
 * the bridge called the conversation.
 *
 * Layout: one file per record under `<directory>/<backendId>/<conversationId>.json`,
 * mirroring `WorkspaceStore`'s conventions (atomic temp+rename writes, ENOENT
 * reads tolerated). Conversation ids are hashed for the filename because they can
 * be derived from arbitrary message content and may contain path separators.
 *
 * Backend-neutral on purpose: a local backend needs the same file, so the store
 * is per-backend rather than Cursor-shaped.
 */
export interface CloudAgentSessionRecord {
  /** Bridge conversation identity (the provider's session id). */
  conversationId: string;
  /** Backend id, e.g. `cursor-cloud`. */
  backendId: string;
  /** Vendor session/agent id. */
  sessionId: string;
  /** Last known vendor status, for the workspace rail without a network call. */
  status?: string;
  /** ISO timestamp of the last write. */
  updatedAt: string;
}

export class CloudAgentSessionStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private backendDir(backendId: string): string {
    return join(this.directory, sanitizeSegment(backendId));
  }

  /**
   * Stable filename for a conversation id.
   *
   * Uses a hash rather than the raw id: a conversation id can be derived from
   * message content (`deriveSessionId`) and is not guaranteed to be a safe path
   * segment. The original id is stored inside the record, so the mapping stays
   * recoverable.
   */
  private recordPath(backendId: string, conversationId: string): string {
    return join(this.backendDir(backendId), `${hashId(conversationId)}.json`);
  }

  get(backendId: string, conversationId: string): string | undefined {
    return this.read(backendId, conversationId)?.sessionId;
  }

  read(backendId: string, conversationId: string): CloudAgentSessionRecord | undefined {
    let text: string;
    try {
      text = readFileSync(this.recordPath(backendId, conversationId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return JSON.parse(text) as CloudAgentSessionRecord;
  }

  set(backendId: string, conversationId: string, sessionId: string, status?: string): void {
    this.write({
      conversationId,
      backendId,
      sessionId,
      ...(status !== undefined ? { status } : {}),
      updatedAt: new Date().toISOString(),
    });
  }

  /** Remove a conversation's mapping (e.g. after a failed run). */
  delete(backendId: string, conversationId: string): void {
    try {
      unlinkSync(this.recordPath(backendId, conversationId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
  }

  /** Every record for a backend, newest first. */
  list(backendId: string): CloudAgentSessionRecord[] {
    const dir = this.backendDir(backendId);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const records: CloudAgentSessionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      try {
        records.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as CloudAgentSessionRecord);
      } catch {
        // A corrupt record must not take down the whole list; adopt what is readable.
        continue;
      }
    }
    records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return records;
  }

  private write(record: CloudAgentSessionRecord): void {
    const dir = this.backendDir(record.backendId);
    mkdirSync(dir, { recursive: true });
    const targetPath = this.recordPath(record.backendId, record.conversationId);
    const tempPath = join(dir, `.${randomUUID()}.tmp`);
    writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    renameSync(tempPath, targetPath);
  }
}

/** Keep a backend id usable as a path segment. */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Short stable hash so filenames stay bounded and path-safe. */
function hashId(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
