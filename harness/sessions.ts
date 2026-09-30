/**
 * `mhh sessions` — inspect and prune saved runs.
 *
 * A saved session is an id nobody remembers, so without this the only way to
 * find one is to read the state directory by hand. Three verbs, the smallest
 * set that makes the feature usable: list, show, remove.
 *
 * Output goes through the same `TerminalRenderer` idiom as a run, so a session
 * listing looks like the rest of the tool rather than like a stray `console.log`.
 * `list` also has a `--json` form, because the ids are what a script wants and
 * parsing a table is not a plan.
 */

import { PALETTE, Painter, colorCapability } from './theme.js';
import { clip, clipEnd, formatCount } from './format.js';
import { listSessions, loadSession, removeSession, sessionsDir, type SessionRecord } from './session.js';
import { confirm } from './readline.js';

export type SessionsVerb = 'list' | 'show' | 'rm';

export interface SessionsOptions {
  verb: SessionsVerb;
  /** Required by `show` and `rm`. */
  id?: string;
  json?: boolean;
  /** `--yes`: remove without asking. */
  assumeYes?: boolean;
  /** Test seam. */
  output?: NodeJS.WriteStream;
  error?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  /** Test seam: skip the confirmation prompt. */
  confirmRemove?: (question: string) => Promise<boolean>;
}

/** First user message of a saved run, for the listing. */
export function firstTask(record: SessionRecord): string {
  const message = record.messages.find((candidate) => candidate.role === 'user');
  if (message === undefined) return '(no task recorded)';
  const content = message.content;
  if (typeof content === 'string') return content.replace(/\s+/g, ' ').trim();
  // A multimodal first message carries parts; the text ones are the task.
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter((text) => text !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface SessionSummary {
  id: string;
  model: string;
  turns: number;
  createdAt: string;
  task: string;
  messages: number;
  /** Set when the record exists but could not be read back. */
  error?: string;
}

/**
 * Read every saved session's headline facts.
 *
 * A session that cannot be parsed is reported as a row with an `error` rather
 * than dropped: a corrupt file the listing silently hides is a corrupt file
 * nobody ever cleans up.
 */
export function summarizeSessions(ids: string[] = listSessions()): SessionSummary[] {
  return ids.map((id) => {
    try {
      const record = loadSession(id);
      return {
        id,
        model: record.model === '' ? 'unknown' : record.model,
        turns: record.turns,
        createdAt: record.createdAt,
        task: firstTask(record),
        messages: record.messages.length,
      };
    } catch (err) {
      return {
        id,
        model: 'unknown',
        turns: 0,
        createdAt: '',
        task: '',
        messages: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

/**
 * One line per session, with the columns a reader actually scans for.
 *
 * The model column is clipped from the *left*: `vercel-ai-gateway/anthropic/
 * claude-sonnet-4` is mostly provider plumbing, and the model name is the half
 * that distinguishes one row from another. The task gets whatever is left,
 * because it is the reason to look at the list at all.
 */
export function formatSessionList(summaries: SessionSummary[], columns = 100): string {
  const painter = new Painter(colorCapability());
  if (summaries.length === 0) {
    return `  ${painter.color('muted', 'no saved sessions')}\n` +
      `  ${painter.color('faint', `runs are saved with --save-session; state lives in ${sessionsDir()}`)}\n`;
  }
  const idWidth = Math.max(...summaries.map((entry) => entry.id.length));
  const modelWidth = Math.min(28, Math.max(...summaries.map((entry) => entry.model.length)));
  const lines: string[] = [];
  for (const entry of summaries) {
    if (entry.error !== undefined) {
      lines.push(
        `  ${painter.color('error', entry.id.padEnd(idWidth))}  ` +
          painter.color('error', clip(entry.error, Math.max(20, columns - idWidth - 4))),
      );
      continue;
    }
    const taskRoom = Math.max(24, columns - idWidth - modelWidth - 20);
    lines.push(
      `  ${painter.color('text', entry.id.padEnd(idWidth))}  ` +
        `${painter.color('info', clipEnd(entry.model, modelWidth).padEnd(modelWidth))}  ` +
        `${painter.color('faint', `${entry.turns}t`.padStart(4))}  ` +
        painter.color('muted', clip(entry.task, taskRoom)),
    );
  }
  lines.push('');
  lines.push(
    `  ${painter.color('faint', `${summaries.length} session${summaries.length === 1 ? '' : 's'} · mhh sessions show <id> · mhh sessions rm <id>`)}`,
  );
  return `${lines.join('\n')}\n`;
}

/** The whole saved record, for `show`. */
export function formatSessionDetail(record: SessionRecord, columns = 100): string {
  const painter = new Painter(colorCapability());
  const rows: Array<[string, string]> = [
    ['id', record.id],
    ['model', record.model === '' ? 'unknown' : record.model],
    ['playbook', record.playbook],
    ['turns', String(record.turns)],
    ['created', record.createdAt === '' ? 'unknown' : record.createdAt],
    ['messages', formatCount(record.messages.length)],
    ['resume', `mhh --resume ${record.id}`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  const lines: string[] = ['', `  ${painter.bold(painter.color('accent', 'SESSION'))}`, ''];
  for (const [label, value] of rows) {
    lines.push(
      `  ${painter.color('faint', label.padEnd(width))}  ` +
        painter.color('text', clip(value, Math.max(8, columns - width - 4))),
    );
  }

  lines.push('', `  ${painter.color('faint', 'task')}`, '');
  for (const line of wrap(firstTask(record), Math.max(20, columns - 6))) {
    lines.push(`    ${painter.color('text', line)}`);
  }

  // The tool calls, in order: the shape of what the run did, without the bodies.
  const toolNames: string[] = [];
  for (const message of record.messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) toolNames.push(call.name);
    }
  }
  if (toolNames.length > 0) {
    const counts = new Map<string, number>();
    for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
    const rendered = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name}×${count}`)
      .join('  ');
    lines.push('', `  ${painter.color('faint', 'tool calls')}`, '');
    lines.push(`    ${painter.color('muted', clip(rendered, Math.max(20, columns - 6)))}`);
  }
  lines.push('');
  return lines.join('\n');
}

function wrap(text: string, columns: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (word === '') continue;
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= columns) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== '') out.push(line);
  return out.length > 0 ? out : [''];
}

/**
 * The subcommand. Prints and returns an exit code; it does not set
 * `process.exitCode` itself, so the caller decides.
 */
export async function runSessions(options: SessionsOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const err = options.error ?? process.stderr;
  const painter = new Painter(colorCapability({ stream: out }));
  const say = (text = ''): void => void out.write(`${text}\n`);

  switch (options.verb) {
    case 'list': {
      const summaries = summarizeSessions();
      if (options.json === true) {
        out.write(`${JSON.stringify({ sessions: summaries }, null, 2)}\n`);
        // An empty list is a fact, not a failure: a script checking for saved
        // runs should not have to treat exit 1 as "none yet".
        return 0;
      }
      say();
      say(`  ${painter.bold(painter.color('accent', 'MODELHITCH'))}${painter.color('faint', ' · saved sessions')}`);
      say();
      out.write(formatSessionList(summaries, (out.columns ?? 100)));
      return 0;
    }

    case 'show': {
      if (options.id === undefined || options.id === '') {
        err.write(`${painter.color('error', 'sessions show needs an id')}\n`);
        return 1;
      }
      try {
        const record = loadSession(options.id);
        if (options.json === true) {
          out.write(`${JSON.stringify(record, null, 2)}\n`);
          return 0;
        }
        out.write(formatSessionDetail(record, out.columns ?? 100));
        return 0;
      } catch (failed) {
        // `loadSession` already lists the known ids in its message, which is the
        // same courtesy the `--resume` failure path gives.
        err.write(`${painter.color('error', failed instanceof Error ? failed.message : String(failed))}\n`);
        return 1;
      }
    }

    case 'rm': {
      if (options.id === undefined || options.id === '') {
        err.write(`${painter.color('error', 'sessions rm needs an id')}\n`);
        return 1;
      }
      // Read it first: `removeSession` reports only whether a file went away,
      // and "no such session" deserves the known-ids message, not a bare false.
      let record: SessionRecord;
      try {
        record = loadSession(options.id);
      } catch (failed) {
        err.write(`${painter.color('error', failed instanceof Error ? failed.message : String(failed))}\n`);
        return 1;
      }

      if (options.assumeYes !== true) {
        const ask =
          options.confirmRemove ??
          (async (question: string): Promise<boolean> =>
            await confirm(question, {
              ...(options.input ? { input: options.input } : {}),
              ...(options.output ? { output: out } : {}),
            }));
        const agreed = await ask(
          `  ${painter.color('warn', `Delete session ${record.id} (${record.turns} turns)? [y/N] `)}`,
        );
        if (!agreed) {
          say(`  ${painter.color('faint', 'left in place.')}`);
          return 1;
        }
      }

      const removed = removeSession(options.id);
      if (!removed) {
        err.write(`${painter.color('error', `No session "${options.id}".`)}\n`);
        return 1;
      }
      say(
        `  ${painter.color('ok', '✔ deleted')} ${painter.color('muted', record.id)}` +
          painter.color('faint', `   (its snapshot, if any, is untouched: mhh --undo ${record.id})`),
      );
      return 0;
    }
  }
}
