import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelMessage } from '../src/index.js';
import {
  harnessStateDir,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
  sessionPath,
} from '../harness/session.js';

/**
 * A resumed run is fed straight back into the loop, so the checks that matter
 * are the boundary ones: a corrupt file, an unknown id, and a history that lost
 * its system prompt. Each has to fail as one readable line rather than as a
 * stack trace, and a history without a system prompt must be refused instead of
 * quietly picking up a second one.
 */

const DIR = join(__dirname, '.tmp-sessions');

const MESSAGES: ModelMessage[] = [
  { role: 'system', content: 'You are an expert engineer.' },
  { role: 'user', content: 'add a widget' },
  { role: 'assistant', content: 'done' },
];

beforeAll(() => {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe('session ids and state directory', () => {
  it('builds a sortable timestamped id', () => {
    const id = newSessionId(new Date(2026, 5, 1, 14, 30, 12));
    expect(id.startsWith('20260601-143012-')).toBe(true);
  });

  it('produces distinct ids', () => {
    expect(newSessionId()).not.toBe(newSessionId());
  });

  it('honours the state directory override', () => {
    const previous = process.env['HARNESS_STATE_DIR'];
    process.env['HARNESS_STATE_DIR'] = join('C:', 'tmp', 'harness-state');
    try {
      expect(harnessStateDir()).toBe(join('C:', 'tmp', 'harness-state'));
    } finally {
      if (previous === undefined) delete process.env['HARNESS_STATE_DIR'];
      else process.env['HARNESS_STATE_DIR'] = previous;
    }
  });
});

describe('save and load', () => {
  it('round-trips a run', () => {
    const record = {
      id: 'session-1',
      createdAt: '2026-06-01T14:30:12.000Z',
      model: 'vercel-ai-gateway/openai/gpt-5.4',
      playbook: 'feature',
      turns: 3,
      messages: MESSAGES,
    };
    const path = saveSession(record, DIR);
    expect(path).toBe(sessionPath('session-1', DIR));

    const loaded = loadSession('session-1', DIR);
    expect(loaded.model).toBe(record.model);
    expect(loaded.turns).toBe(3);
    expect(loaded.playbook).toBe('feature');
    expect(loaded.messages).toEqual(MESSAGES);
  });

  it('lists what it saved', () => {
    expect(listSessions(DIR)).toContain('session-1');
  });

  it('reports an unknown id as one line, naming what does exist', () => {
    expect(() => loadSession('missing', DIR)).toThrow(/No session "missing"/);
    expect(() => loadSession('missing', DIR)).toThrow(/session-1/);
  });

  it('reports corrupt JSON as one line rather than a stack trace', () => {
    writeFileSync(join(DIR, 'broken.json'), '{ this is not json');
    let message = '';
    try {
      loadSession('broken', DIR);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('not valid JSON');
    expect(message.split('\n').length).toBe(1);
  });

  it('refuses a history that does not start with a system message', () => {
    saveSession(
      {
        id: 'no-system',
        createdAt: '2026-06-01T14:30:12.000Z',
        model: 'm',
        playbook: 'p',
        turns: 1,
        messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }],
      },
      DIR,
    );
    expect(() => loadSession('no-system', DIR)).toThrow(/expected "system"/);
  });

  it('refuses a session with no messages', () => {
    saveSession(
      { id: 'empty', createdAt: '', model: '', playbook: '', turns: 0, messages: [] },
      DIR,
    );
    expect(() => loadSession('empty', DIR)).toThrow(/has no messages/);
  });

  it('refuses a message with an unknown role', () => {
    saveSession(
      {
        id: 'bad-role',
        createdAt: '',
        model: '',
        playbook: '',
        turns: 0,
        messages: [
          { role: 'system', content: 's' },
          { role: 'wizard', content: 'x' } as unknown as ModelMessage,
        ],
      },
      DIR,
    );
    expect(() => loadSession('bad-role', DIR)).toThrow(/unknown role/);
  });
});
