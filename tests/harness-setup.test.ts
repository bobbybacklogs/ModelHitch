import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redact, runSetup, writeConfigAtomic } from '../harness/setup.js';
import { CONFIG_VERSION, type ModelHitchConfig } from '../src/config.js';

/**
 * The setup wizard's job is to leave a working config behind, and its failure
 * mode is worse than doing nothing: a wizard that writes before it verifies
 * replaces a working config with a broken one. So most of these cases are about
 * what is *not* on disk after a failure.
 *
 * A fake `input` with `isTTY: true` is what gets past the interactive guard, and
 * the prompt functions are injected — no test ever touches a real terminal or a
 * real provider.
 */

const SANDBOX = resolve(__dirname, '.tmp-setup-sandbox');

beforeAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  mkdirSync(SANDBOX, { recursive: true });
});

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

function collector(): { stream: NodeJS.WriteStream; text: () => string } {
  let out = '';
  return {
    stream: {
      isTTY: false,
      columns: 100,
      write(chunk: string) {
        out += chunk;
        return true;
      },
    } as unknown as NodeJS.WriteStream,
    text: () => out,
  };
}

const fakeStdin = { isTTY: true } as unknown as NodeJS.ReadStream;

/** A wizard run with scripted answers. */
function scripted(answers: {
  text?: string[];
  secret?: string;
  yes?: boolean[];
}): {
  prompt: (question: string, fallback?: string) => Promise<string>;
  secretPrompt: (question: string) => Promise<string>;
  confirmOverwrite: (question: string) => Promise<boolean>;
  asked: string[];
} {
  const asked: string[] = [];
  const texts = [...(answers.text ?? [])];
  const yes = [...(answers.yes ?? [])];
  return {
    asked,
    prompt: async (question: string, fallback?: string) => {
      asked.push(question);
      const next = texts.shift();
      return next === undefined ? (fallback ?? '') : next;
    },
    secretPrompt: async (question: string) => {
      asked.push(question);
      return answers.secret ?? '';
    },
    confirmOverwrite: async (question: string) => {
      asked.push(question);
      return yes.shift() ?? false;
    },
  };
}

describe('redact', () => {
  it('removes a secret wherever it appears', () => {
    expect(redact('failed with key sk-abc123 in header', 'sk-abc123')).toBe(
      'failed with key *** in header',
    );
  });

  it('leaves short strings alone rather than mangling ordinary text', () => {
    // A one-character "secret" would redact every occurrence of that character.
    expect(redact('a normal message', 'a')).toBe('a normal message');
  });
});

describe('writeConfigAtomic', () => {
  it('writes the document and leaves no temp file behind', () => {
    const path = join(SANDBOX, 'atomic', 'config.json');
    writeConfigAtomic(path, { version: CONFIG_VERSION, defaultProviderId: 'deepseek', defaultModel: 'deepseek-v4-flash' });
    expect(JSON.parse(readFileSync(path, 'utf8')).defaultModel).toBe('deepseek-v4-flash');
    expect(readdirSync(join(SANDBOX, 'atomic'))).toEqual(['config.json']);
  });

  it('replaces an existing file rather than appending to it', () => {
    const path = join(SANDBOX, 'atomic', 'config.json');
    writeConfigAtomic(path, { version: CONFIG_VERSION, defaultModel: 'second' });
    expect(JSON.parse(readFileSync(path, 'utf8')).defaultModel).toBe('second');
  });
});

describe('runSetup', () => {
  it('refuses a non-TTY stdin with exit 1 and writes nothing', async () => {
    const path = join(SANDBOX, 'non-tty', 'config.json');
    const out = collector();
    const result = await runSetup({
      configPath: path,
      input: { isTTY: false } as unknown as NodeJS.ReadStream,
      output: out.stream,
    });
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain('TTY');
    expect(existsSync(path)).toBe(false);
    expect(out.text()).toContain('interactive terminal');
  });

  it('writes a verified config and reports the path', async () => {
    const path = join(SANDBOX, 'happy', 'config.json');
    const out = collector();
    let verified = 0;
    const script = scripted({ text: ['deepseek', 'deepseek-v4-flash'], secret: 'sk-secret-value' });
    const result = await runSetup({
      configPath: path,
      input: fakeStdin,
      output: out.stream,
      ...script,
      verify: async () => {
        verified++;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.path).toBe(path);
    // Exactly one verification call: setup is not a run.
    expect(verified).toBe(1);

    const written = JSON.parse(readFileSync(path, 'utf8')) as ModelHitchConfig;
    expect(written.defaultProviderId).toBe('deepseek');
    expect(written.defaultModel).toBe('deepseek-v4-flash');
    expect(written.keys?.['deepseek']).toBe('sk-secret-value');
  });

  it('writes the config 0600 on POSIX, because it holds plaintext keys', () => {
    if (process.platform === 'win32') return; // Windows ignores POSIX modes
    const path = join(SANDBOX, 'perms', 'config.json');
    writeConfigAtomic(path, { version: CONFIG_VERSION, defaultModel: 'x' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('never echoes the credential to the terminal', async () => {
    const path = join(SANDBOX, 'secret-echo', 'config.json');
    const out = collector();
    const script = scripted({ text: ['deepseek', 'deepseek-v4-flash'], secret: 'sk-do-not-print-me' });
    await runSetup({ configPath: path, input: fakeStdin, output: out.stream, ...script, verify: async () => undefined });
    expect(out.text()).not.toContain('sk-do-not-print-me');
  });

  it('redacts the credential out of a provider error', async () => {
    const path = join(SANDBOX, 'secret-error', 'config.json');
    const out = collector();
    const script = scripted({ text: ['deepseek', 'deepseek-v4-flash'], secret: 'sk-leaky-key-1234' });
    const result = await runSetup({
      configPath: path,
      input: fakeStdin,
      output: out.stream,
      ...script,
      verify: async () => {
        throw new Error('401 from provider: bad header {"authorization":"Bearer sk-leaky-key-1234"}');
      },
    });
    expect(result.exitCode).toBe(1);
    expect(out.text()).not.toContain('sk-leaky-key-1234');
    expect(out.text()).toContain('***');
  });

  it('writes nothing when verification fails, and leaves an existing file byte-identical', async () => {
    const dir = join(SANDBOX, 'verify-fail');
    const path = join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    const before = '{\n  "defaultProviderId": "openai",\n  "defaultModel": "gpt-5.4"\n}\n';
    writeFileSync(path, before);

    const out = collector();
    const script = scripted({ text: ['deepseek', 'deepseek-v4-flash'], secret: 'sk-nope', yes: [true] });
    const result = await runSetup({
      configPath: path,
      input: fakeStdin,
      output: out.stream,
      ...script,
      verify: async () => {
        throw new Error('invalid api key');
      },
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(out.text()).toContain('nothing was written');
    // No backup either: nothing was replaced, so there is nothing to back up.
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  it('asks before overwriting an existing config, and keeps it when refused', async () => {
    const dir = join(SANDBOX, 'keep');
    const path = join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    const before = '{\n  "defaultProviderId": "openai",\n  "defaultModel": "gpt-5.4"\n}\n';
    writeFileSync(path, before);

    const out = collector();
    const script = scripted({ yes: [false] });
    const result = await runSetup({ configPath: path, input: fakeStdin, output: out.stream, ...script });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(script.asked.some((question) => question.includes('Overwrite'))).toBe(true);
  });

  it('backs up the previous config before replacing it', async () => {
    const dir = join(SANDBOX, 'backup');
    const path = join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    const before = '{\n  "defaultProviderId": "openai",\n  "defaultModel": "gpt-5.4"\n}\n';
    writeFileSync(path, before);

    const out = collector();
    const script = scripted({ text: ['deepseek', 'deepseek-v4-flash'], secret: 'sk-new', yes: [true] });
    const result = await runSetup({
      configPath: path,
      input: fakeStdin,
      output: out.stream,
      ...script,
      verify: async () => undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(path, 'utf8')).defaultProviderId).toBe('deepseek');
  });

  it('reports a malformed existing config as one line, not a stack trace', async () => {
    const dir = join(SANDBOX, 'malformed');
    const path = join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '{ not json at all');

    const out = collector();
    const script = scripted({ yes: [false] });
    const result = await runSetup({ configPath: path, input: fakeStdin, output: out.stream, ...script });

    expect(result.exitCode).toBe(1);
    const text = out.text();
    expect(text).toContain('not valid JSON');
    expect(text).not.toContain('at Object'); // no stack trace
    expect(readFileSync(path, 'utf8')).toBe('{ not json at all');
  });

  it('accepts the provider/model spelling other flags use', async () => {
    const path = join(SANDBOX, 'slash', 'config.json');
    const out = collector();
    // The model answer carries the provider, so it must win over the earlier one.
    const script = scripted({ text: ['openai', 'deepseek/deepseek-v4-flash'], secret: 'sk-x' });
    const result = await runSetup({
      configPath: path,
      input: fakeStdin,
      output: out.stream,
      ...script,
      verify: async () => undefined,
    });
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(path, 'utf8')) as ModelHitchConfig;
    expect(written.defaultProviderId).toBe('deepseek');
    expect(written.defaultModel).toBe('deepseek-v4-flash');
  });

  it('refuses when the answers are empty rather than writing a blank config', async () => {
    const path = join(SANDBOX, 'empty', 'config.json');
    const out = collector();
    const script = scripted({ text: ['', ''], secret: '' });
    const result = await runSetup({
      configPath: path,
      input: fakeStdin,
      output: out.stream,
      ...script,
      verify: async () => undefined,
    });
    // The provider falls back to the default; an empty model id is the failure.
    expect(result.exitCode).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it('leaves an empty key out of the document instead of writing a blank one', async () => {
    const path = join(SANDBOX, 'no-key', 'config.json');
    const out = collector();
    const script = scripted({ text: ['ollama', 'llama3.2'], secret: '' });
    const result = await runSetup({
      configPath: path,
      input: fakeStdin,
      output: out.stream,
      ...script,
      verify: async () => undefined,
    });
    expect(result.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(path, 'utf8')) as ModelHitchConfig;
    expect(written.keys?.['ollama']).toBeUndefined();
  });
});
