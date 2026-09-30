import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { currentModuleUrl } from './core/import-meta.js';
import type { OpenCodeLocalProvider, OpenCodeLocalState } from './opencode-byok.js';

/**
 * Read the local OpenCode install.
 *
 * Console BYOK connections are opaque (`conn_…` ids minted by the Console), so
 * ModelHitch cannot enumerate them offline. What it *can* read offline is which
 * providers and models the user actually runs in OpenCode — that is the list
 * the BYOK rotation should follow, so the bridge does not invent a model
 * lineup the user never picked.
 *
 * Three sources, all best-effort:
 *   - `<data>/auth.json`            connected providers + credential type
 *   - `<data>/opencode.db`          `credential` rows and recent message
 *                                   `providerID`/`modelID` usage (node:sqlite)
 *   - `<config>/opencode.json[c]`   the selected `model` and per-provider
 *                                   `models` maps
 *
 * Never throws: an OpenCode install that is missing, mid-upgrade, locked, or
 * on a Node too old for `node:sqlite` degrades to whatever was readable, with
 * the reason recorded in `warnings`.
 */

const MAX_MODELS_PER_PROVIDER = 12;
const MAX_MESSAGE_ROWS = 800;

type SqliteModule = { DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase };

interface SqliteDatabase {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

export interface OpenCodeStateOptions {
  /** Override the user home (tests). */
  home?: string;
  /** Override the OpenCode data directory (tests). */
  dataDir?: string;
  /** Override the OpenCode config directory (tests). */
  configDir?: string;
}

/** Candidate OpenCode data directories, first existing one wins. */
export function openCodeDataDirs(home = homedir()): string[] {
  const dirs: string[] = [];
  if (process.env.OPENCODE_DATA_HOME) dirs.push(process.env.OPENCODE_DATA_HOME);
  if (process.env.XDG_DATA_HOME) dirs.push(join(process.env.XDG_DATA_HOME, 'opencode'));
  dirs.push(join(home, '.local', 'share', 'opencode'));
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, 'opencode'));
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'opencode'));
  return [...new Set(dirs)];
}

/** Candidate OpenCode config directories, first existing one wins. */
export function openCodeConfigDirs(home = homedir()): string[] {
  const dirs: string[] = [];
  if (process.env.OPENCODE_CONFIG_HOME) dirs.push(process.env.OPENCODE_CONFIG_HOME);
  if (process.env.XDG_CONFIG_HOME) dirs.push(join(process.env.XDG_CONFIG_HOME, 'opencode'));
  dirs.push(join(home, '.config', 'opencode'));
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'opencode'));
  return [...new Set(dirs)];
}

function firstExisting(dirs: readonly string[]): string | undefined {
  return dirs.find((dir) => existsSync(dir));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Strip `//` and `/* *\/` comments so a `.jsonc` document can be parsed. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += char;
  }
  return JSON.parse(out);
}

interface MutableProvider {
  providerId: string;
  models: string[];
  credentialType?: string;
  lastUsedAt?: number;
}

function providerEntry(map: Map<string, MutableProvider>, providerId: string): MutableProvider | undefined {
  const id = providerId?.trim();
  if (!id) return undefined;
  let entry = map.get(id);
  if (!entry) {
    entry = { providerId: id, models: [] };
    map.set(id, entry);
  }
  return entry;
}

function pushModel(entry: MutableProvider, model: string | undefined): void {
  const value = typeof model === 'string' ? model.trim() : '';
  if (!value) return;
  if (entry.models.includes(value)) return;
  if (entry.models.length >= MAX_MODELS_PER_PROVIDER) return;
  entry.models.push(value);
}

/** Read `<data>/auth.json` — provider ids and how each one authenticates. */
function readAuthFile(path: string, map: Map<string, MutableProvider>, state: OpenCodeLocalState): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    state.warnings.push(`Could not read ${path}: ${(err as Error).message}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  state.sources.push(path);
  for (const [providerId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = providerEntry(map, providerId);
    if (!entry) continue;
    const type = (value as { type?: unknown } | null)?.type;
    if (typeof type === 'string') entry.credentialType = type;
  }
}

/** Read `<config>/opencode.json[c]` — the selected model + provider model maps. */
function readConfigFile(path: string, map: Map<string, MutableProvider>, state: OpenCodeLocalState): void {
  let parsed: unknown;
  try {
    parsed = parseJsonc(readFileSync(path, 'utf8'));
  } catch (err) {
    state.warnings.push(`Could not read ${path}: ${(err as Error).message}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  state.sources.push(path);
  const config = parsed as Record<string, unknown>;

  const selected = typeof config.model === 'string' ? config.model : undefined;
  const slash = selected?.indexOf('/') ?? -1;
  if (selected && slash > 0) {
    const providerId = selected.slice(0, slash);
    const modelId = selected.slice(slash + 1);
    const entry = providerEntry(map, providerId);
    if (entry) pushModel(entry, modelId);
    // An explicit `model` in the OpenCode config outranks usage history.
    state.selected = { providerId, modelId };
  }

  const providers = config.provider;
  if (!providers || typeof providers !== 'object') return;
  for (const [providerId, value] of Object.entries(providers as Record<string, unknown>)) {
    const entry = providerEntry(map, providerId);
    if (!entry) continue;
    const models = (value as { models?: unknown } | null)?.models;
    if (Array.isArray(models)) {
      for (const model of models) pushModel(entry, typeof model === 'string' ? model : undefined);
    } else if (models && typeof models === 'object') {
      for (const modelId of Object.keys(models as Record<string, unknown>)) pushModel(entry, modelId);
    }
  }
}

function loadSqlite(): SqliteModule | undefined {
  try {
    return createRequire(currentModuleUrl())('node:sqlite') as SqliteModule;
  } catch {
    return undefined;
  }
}

/**
 * Read `opencode.db`: connected credentials plus the provider/model of recent
 * assistant messages — the strongest available signal for "the models this
 * user actually chose".
 */
function readDatabase(
  path: string,
  sqlite: SqliteModule | undefined,
  map: Map<string, MutableProvider>,
  state: OpenCodeLocalState,
): void {
  if (!sqlite) {
    state.warnings.push('node:sqlite is unavailable (needs Node >= 22.5) — OpenCode model history skipped.');
    return;
  }
  let db: SqliteDatabase;
  try {
    db = new sqlite.DatabaseSync(path, { readOnly: true });
  } catch (err) {
    state.warnings.push(`Could not open ${path}: ${(err as Error).message}`);
    return;
  }
  try {
    state.sources.push(path);
    try {
      const rows = db.prepare('select integration_id, method_id from credential').all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const entry = providerEntry(map, String(row.integration_id ?? ''));
        if (entry && typeof row.method_id === 'string' && row.method_id) entry.credentialType ??= row.method_id;
      }
    } catch (err) {
      state.warnings.push(`OpenCode credential table unreadable: ${(err as Error).message}`);
    }

    // Recency order: the newest message per provider is the model in use now.
    const rows = db
      .prepare('select data, time_created from message order by time_created desc limit ?')
      .all(MAX_MESSAGE_ROWS) as Array<Record<string, unknown>>;
    for (const row of rows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(row.data ?? '{}')) as Record<string, unknown>;
      } catch {
        continue;
      }
      const providerId = typeof data.providerID === 'string' ? data.providerID : '';
      const modelId = typeof data.modelID === 'string' ? data.modelID : '';
      if (!providerId) continue;
      const entry = providerEntry(map, providerId);
      if (!entry) continue;
      const at = Number(row.time_created);
      if (Number.isFinite(at)) entry.lastUsedAt = Math.max(entry.lastUsedAt ?? 0, at);
      pushModel(entry, modelId);
      state.selected ??= { providerId, modelId };
    }
  } catch (err) {
    state.warnings.push(`Could not read OpenCode message history: ${(err as Error).message}`);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Snapshot the local OpenCode install. `found` is false only when nothing
 * OpenCode-shaped exists on this machine.
 */
export function readOpenCodeLocalState(options: OpenCodeStateOptions = {}): OpenCodeLocalState {
  const home = options.home ?? homedir();
  const state: OpenCodeLocalState = { found: false, sources: [], providers: [], warnings: [] };
  const map = new Map<string, MutableProvider>();

  const dataDir = options.dataDir ?? firstExisting(openCodeDataDirs(home));
  const configDir = options.configDir ?? firstExisting(openCodeConfigDirs(home));

  if (dataDir) {
    if (isDirectory(dataDir)) state.found = true;
    const authPath = join(dataDir, 'auth.json');
    if (existsSync(authPath)) readAuthFile(authPath, map, state);
    const dbPath = join(dataDir, 'opencode.db');
    if (existsSync(dbPath)) readDatabase(dbPath, loadSqlite(), map, state);
  }

  if (configDir && isDirectory(configDir)) {
    state.found = true;
    const paths = new Set(
      ['opencode.json', 'opencode.jsonc'].map((name) => join(configDir, name)).filter((path) => existsSync(path)),
    );
    // Directory listing catches future filenames and profile-suffixed configs.
    try {
      for (const name of readdirSync(configDir)) {
        if (/^opencode(\.[\w-]+)?\.jsonc?$/.test(name)) paths.add(join(configDir, name));
      }
    } catch {
      /* unreadable config dir is not fatal */
    }
    for (const path of paths) readConfigFile(path, map, state);
  }

  const providers: OpenCodeLocalProvider[] = [...map.values()]
    .filter((entry) => entry.models.length > 0 || entry.credentialType !== undefined)
    .sort((a, b) => {
      const used = (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
      if (used !== 0) return used;
      return b.models.length - a.models.length || a.providerId.localeCompare(b.providerId);
    });

  state.providers = providers;
  return state;
}
