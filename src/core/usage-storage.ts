import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { currentModuleUrl } from './import-meta.js';
import type { FailoverEvent } from './failover.js';
import type { UsageEvent } from './usage.js';

/**
 * SQLite-backed usage persistence.
 *
 * `UsageTracker` keeps its hot state in memory for fast snapshots; an optional
 * `UsageStorage` mirrors every event into durable storage so history survives
 * bridge restarts. This module ships one implementation built on Node's
 * built-in `node:sqlite` (`DatabaseSync`) — zero native dependencies.
 *
 * Requires Node >= 22.5 (when `node:sqlite` shipped unflagged). On older
 * Node, enabling persistence throws a clear error; the rest of ModelHitch
 * keeps working because the module is only loaded lazily.
 */

/** Durable sink for usage events and failover events. */
export interface UsageStorage {
  /** Load all history, oldest first. */
  load(): { events: UsageEvent[]; failovers: FailoverEvent[] };
  append(event: UsageEvent): void;
  appendFailover(event: FailoverEvent): void;
  clear(): void;
  close(): void;
}

type SqliteModule = { DatabaseSync: new (file: string) => SqliteDatabase };

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

const DEFAULT_FILE = 'modelhitch-usage.db';

function loadSqlite(): SqliteModule {
  // `node:sqlite` must be required lazily — a top-level import would crash the
  // whole package on Node < 22.5. `createRequire(currentModuleUrl())` resolves
  // the current module's file URL in both the ESM and CJS builds (esbuild
  // leaves `import.meta` as an empty `{}` shim in CJS output, so `import.meta.url`
  // is `undefined` there; `currentModuleUrl()` falls back to `__filename`).
  // Unlike a bare `require` reference, it is never intercepted by esbuild's
  // `__require` Proxy shim, which throws "Dynamic require of ... is not
  // supported" in ESM output.
  try {
    return createRequire(currentModuleUrl())('node:sqlite') as SqliteModule;
  } catch {
    throw new Error(
      `SQLite usage persistence requires Node >= 22.5 (found ${process.version}). ` +
        `Disable \`usagePersistence\` or pass your own \`UsageTracker\`.`,
    );
  }
}

interface UsageRow {
  at: string;
  providerId: string;
  model: string;
  wire: string;
  streamed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number;
}

interface FailoverRow {
  at: string;
  fromProviderId: string;
  fromModel: string;
  toProviderId: string;
  toModel: string;
  code: string;
  message: string;
  status: number | null;
  attempt: number;
}

/**
 * SQLite-backed `UsageStorage`. One database file holds two tables:
 * `usage_events` and `failover_events`.
 *
 * @param file Database file path. Defaults to `modelhitch-usage.db` in the
 *   working directory; parent directories are created automatically. Use
 *   `':memory:'` for a throwaway in-memory database (tests).
 */
export class SqliteUsageStorage implements UsageStorage {
  private db: SqliteDatabase;
  private insertEvent: ReturnType<SqliteDatabase['prepare']>;
  private insertFailover: ReturnType<SqliteDatabase['prepare']>;
  private closed = false;

  constructor(file = DEFAULT_FILE) {
    const { DatabaseSync } = loadSqlite();
    if (file !== ':memory:') {
      mkdirSync(dirname(resolve(file)), { recursive: true });
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      providerId TEXT NOT NULL,
      model TEXT NOT NULL,
      wire TEXT NOT NULL,
      streamed INTEGER NOT NULL DEFAULT 0,
      inputTokens INTEGER NOT NULL DEFAULT 0,
      outputTokens INTEGER NOT NULL DEFAULT 0,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      costUsd REAL NOT NULL DEFAULT 0,
      latencyMs REAL NOT NULL DEFAULT 0
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS failover_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      fromProviderId TEXT NOT NULL,
      fromModel TEXT NOT NULL,
      toProviderId TEXT NOT NULL,
      toModel TEXT NOT NULL,
      code TEXT NOT NULL,
      message TEXT NOT NULL,
      status INTEGER,
      attempt INTEGER NOT NULL DEFAULT 1
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_events(at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_failover_at ON failover_events(at)');
    this.insertEvent = this.db.prepare(
      `INSERT INTO usage_events (at, providerId, model, wire, streamed, inputTokens, outputTokens, totalTokens, costUsd, latencyMs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertFailover = this.db.prepare(
      `INSERT INTO failover_events (at, fromProviderId, fromModel, toProviderId, toModel, code, message, status, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  load(): { events: UsageEvent[]; failovers: FailoverEvent[] } {
    const rows = this.db.prepare('SELECT * FROM usage_events ORDER BY at ASC, id ASC').all() as unknown as UsageRow[];
    const events: UsageEvent[] = rows.map((r) => ({
      providerId: r.providerId,
      model: r.model,
      wire: r.wire,
      streamed: r.streamed === 1,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      totalTokens: r.totalTokens,
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      at: r.at,
    }));
    const frows = this.db
      .prepare('SELECT * FROM failover_events ORDER BY at ASC, id ASC')
      .all() as unknown as FailoverRow[];
    const failovers: FailoverEvent[] = frows.map((r) => ({
      at: r.at,
      from: { providerId: r.fromProviderId, model: r.fromModel },
      to: { providerId: r.toProviderId, model: r.toModel },
      error: {
        code: r.code as FailoverEvent['error']['code'],
        message: r.message,
        ...(r.status != null ? { status: r.status } : {}),
      },
      attempt: r.attempt,
    }));
    return { events, failovers };
  }

  append(event: UsageEvent): void {
    if (this.closed) return;
    this.insertEvent.run(
      event.at,
      event.providerId,
      event.model,
      event.wire,
      event.streamed ? 1 : 0,
      event.inputTokens ?? 0,
      event.outputTokens ?? 0,
      event.totalTokens ?? 0,
      event.costUsd ?? 0,
      event.latencyMs ?? 0,
    );
  }

  appendFailover(event: FailoverEvent): void {
    if (this.closed) return;
    this.insertFailover.run(
      event.at,
      event.from.providerId,
      event.from.model,
      event.to.providerId,
      event.to.model,
      event.error.code,
      event.error.message,
      event.error.status ?? null,
      event.attempt,
    );
  }

  clear(): void {
    if (this.closed) return;
    this.db.exec('DELETE FROM usage_events');
    this.db.exec('DELETE FROM failover_events');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // Already closed — nothing to do.
    }
  }
}
