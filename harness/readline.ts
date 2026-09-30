/**
 * The one interactive prompt helper.
 *
 * `cli.ts` grew its own `ask()` to collect a task when the CLI is run with no
 * arguments. The approval gate and the session prompts want the same thing, so
 * this module owns it instead of a second copy drifting alongside the first.
 */

export interface AskOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** Ask a question and resolve with the raw line the user typed. */
export async function ask(question: string, options: AskOptions = {}): Promise<string> {
  const readline = await import('node:readline');
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = readline.createInterface({ input, output });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/**
 * Yes/no prompt.
 *
 * A non-TTY stdin answers `defaultAnswer` immediately rather than waiting for a
 * line that will never arrive. That is the whole point: a piped run must not
 * hang on a prompt nobody can see. Callers that need "assume yes" for
 * non-interactive use check their own flag before asking.
 */
export async function confirm(
  question: string,
  options: AskOptions & { defaultAnswer?: boolean } = {},
): Promise<boolean> {
  const input = options.input ?? process.stdin;
  const fallback = options.defaultAnswer ?? false;
  if (input.isTTY !== true) return fallback;
  const answer = (await ask(question, options)).trim().toLowerCase();
  if (answer === '') return fallback;
  return answer === 'y' || answer === 'yes';
}

/** A line the caller asked for but did not get, e.g. a non-TTY stdin. */
export const NO_INPUT = '';

/**
 * A prompt whose answer is not echoed.
 *
 * Node's readline writes every keystroke back through its `output` stream, so
 * the only way to keep a credential off the screen is to give readline a sink
 * that discards, and write the prompt ourselves. Nothing else here is clever:
 * the answer is still returned as a plain string, and it is the caller's job
 * never to log it.
 */
export async function askSecret(question: string, options: AskOptions = {}): Promise<string> {
  const readline = await import('node:readline');
  const { Writable } = await import('node:stream');
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (input.isTTY !== true) return NO_INPUT;

  const sink = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
  const rl = readline.createInterface({ input, output: sink, terminal: true });
  output.write(question);
  try {
    const answer = await new Promise<string>((resolve) => rl.question('', resolve));
    output.write('\n');
    return answer;
  } finally {
    rl.close();
  }
}
