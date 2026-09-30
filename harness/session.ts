import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from '../src/index.js';

/**
 * Saved runs, so an interrupted terminal is not a lost task.
 *
 * A session is one JSON file holding the full message history plus enough
 * context to say what it was: model, playbook, turn count, timestamp. It is
 * written once when the run finishes, not per turn, and it uses the ModelHitch
 * settings directory rather than inventing a second config location.
 */

/** Root for harness state. `HARNESS_STATE_DIR` overrides it (tests, CI). */
export function harnessStateDir(): string {
  const override = process.env['HARNESS_STATE_DIR'];
  if (override && override.trim() !== '') return override.trim();
  return join(homedir(), '.modelhitch', 'harness');
}

export function sessionsDir(dir?: string): string {
  return dir ?? join(harnessStateDir(), 'sessions');
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  /** `provider/model` the session ran on. */
  model: string;
  playbook: string;
  turns: number;
  messages: ModelMessage[];
}

/** Sortable, readable, and unique enough: `20260601-143012-4f2a`. */
export function newSessionId(now: Date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${suffix}`;
}

export function sessionPath(id: string, dir?: string): string {
  return join(sessionsDir(dir), `${id}.json`);
}

export function saveSession(record: SessionRecord, dir?: string): string {
  const target = sessionsDir(dir);
  mkdirSync(target, { recursive: true });
  const path = sessionPath(record.id, dir);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}

function isModelMessage(value: unknown): value is ModelMessage {
  if (value === null || typeof value !== 'object') return false;
  const role = (value as { role?: unknown }).role;
  return role === 'system' || role === 'user' || role === 'assistant' || role === 'tool';
}

/**
 * Read a session back.
 *
 * Every failure mode is one readable line rather than a stack trace, because
 * this runs from the CLI where a stack trace tells the user nothing. The
 * `system` check matters most: a resumed session is fed straight back into the
 * loop, and a history without its system prompt would silently pick up a fresh
 * one on top of the restored turns.
 */
export function loadSession(id: string, dir?: string): SessionRecord {
  const path = sessionPath(id, dir);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    let known: string[] = [];
    try {
      known = readdirSync(sessionsDir(dir))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length));
    } catch {
      /* no sessions directory yet */
    }
    throw new Error(
      known.length === 0
        ? `No session "${id}" (nothing saved under ${sessionsDir(dir)}).`
        : `No session "${id}" under ${sessionsDir(dir)}. Saved sessions: ${known.join(', ')}.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Session ${id} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`Session ${id} is not a session object.`);
  }

  const record = raw as Partial<SessionRecord>;
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    throw new Error(`Session ${id} has no messages.`);
  }
  const first = record.messages[0];
  if (!isModelMessage(first) || first.role !== 'system') {
    throw new Error(
      `Session ${id} is unusable: its first message is ` +
        `${isModelMessage(first) ? `"${first.role}"` : 'not a message'}, expected "system". ` +
        'Refusing to resume, because a second system prompt would be prepended to the restored history.',
    );
  }
  if (!record.messages.every(isModelMessage)) {
    throw new Error(`Session ${id} contains a message with an unknown role.`);
  }

  return {
    id: typeof record.id === 'string' && record.id !== '' ? record.id : id,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    model: typeof record.model === 'string' ? record.model : '',
    playbook: typeof record.playbook === 'string' ? record.playbook : 'unknown',
    turns: typeof record.turns === 'number' && Number.isFinite(record.turns) ? record.turns : 0,
    messages: record.messages,
  };
}

/** List saved sessions, newest id first (the id sorts by time). */
export function listSessions(dir?: string): string[] {
  try {
    return readdirSync(sessionsDir(dir))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => existsSync(sessionPath(id, dir)))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Delete one saved session.
 *
 * Deliberately narrow: it removes the session file and nothing else. A run's
 * snapshot directory is a separate artefact holding the bytes needed to undo
 * that run's writes, and it lives outside the sessions directory precisely so
 * that forgetting a transcript cannot destroy the ability to roll back the
 * change the transcript described. `--undo <run-id>` still works after
 * `sessions rm <id>`.
 *
 * Returns false when there was no such session, so the caller can say that
 * rather than reporting a successful delete of nothing.
 */
export function removeSession(id: string, dir?: string): boolean {
  const path = sessionPath(id, dir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
