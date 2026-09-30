/**
 * `mhh setup` — from "the command failed" to "a run starts", without hand-editing JSON.
 *
 * The order of operations here is the whole design:
 *
 *   1. collect answers, 2. build the candidate document in memory, 3. validate
 *   it, 4. prove it works with one cheap call, 5. only then write.
 *
 * Writing first and verifying after is the tempting order and the wrong one: a
 * bad credential would already have replaced a working config, and the user
 * would be left with a run that fails where it used to work. Everything in this
 * module exists to keep step 5 last.
 *
 * Two rules about the credential, both absolute: it is never echoed (see
 * `askSecret`), and it is redacted out of anything printed — a provider that
 * quotes the request back in an error message must not turn into a key leak.
 */

import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defaultConfigPath, defaultConfigTemplate, readConfigFile } from '../src/config-file.js';
import { validateConfig, type ModelHitchConfig } from '../src/config.js';
import { defaultProviders } from '../src/index.js';
import { buildRuntime } from './runtime.js';
import { ask, askSecret, confirm, NO_INPUT } from './readline.js';
import { PALETTE, Painter, colorCapability } from './theme.js';
import { clip } from './format.js';

export interface SetupOptions {
  configPath?: string;
  /** Injected for tests: the prompt surface. */
  prompt?: (question: string, fallback?: string) => Promise<string>;
  /** Injected for tests: the secret prompt. */
  secretPrompt?: (question: string) => Promise<string>;
  /** Injected for tests: the confirmation. */
  confirmOverwrite?: (question: string) => Promise<boolean>;
  /** Injected for tests: the verification call. */
  verify?: (runtime: Awaited<ReturnType<typeof buildRuntime>>) => Promise<void>;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

/** How long the one verification call may take before setup gives up on it. */
export const SETUP_VERIFY_TIMEOUT_MS = 30_000;

/**
 * Environment variable that usually holds each provider's key, so the prompt can
 * suggest where the value normally lives. Unknown providers get a generic line
 * rather than a guess.
 */
const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  zai: 'ZAI_API_KEY',
  together: 'TOGETHER_API_KEY',
  huggingface: 'HF_TOKEN',
  ollama: '(no key needed — the local daemon)',
};

/** Replace a secret with a marker wherever it might have leaked into text. */
export function redact(text: string, secret: string): string {
  if (secret.length < 4) return text;
  return text.split(secret).join('***');
}

/**
 * Write the config so a reader never sees a half-written file.
 *
 * A temp file in the same directory, then a rename: the rename is atomic on
 * both POSIX and Windows, so a crash mid-write leaves the old document intact
 * rather than a truncated one. 0600 because the file holds plaintext keys and
 * is user-owned — the same reason `.npmrc` is.
 */
export function writeConfigAtomic(path: string, config: ModelHitchConfig): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${process.pid}-${Date.now()}.config.json.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, path);
  } catch (err) {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* the temp file never landed, or the directory is unwritable anyway */
    }
    throw err;
  }
}

/** A model id offered when the user has no preference and we know one. */
function defaultModelFor(providerId: string): string {
  const provider = defaultProviders.find((entry) => entry.id === providerId);
  return provider?.defaultModel ?? '';
}

interface PromptSurface {
  text: (question: string, fallback?: string) => Promise<string>;
  secret: (question: string) => Promise<string>;
  yes: (question: string) => Promise<boolean>;
}

function surface(options: SetupOptions): PromptSurface {
  const io = {
    ...(options.input ? { input: options.input } : {}),
    ...(options.output ? { output: options.output } : {}),
  };
  return {
    text:
      options.prompt ??
      (async (question, fallback) => {
        const answer = (await ask(question, io)).trim();
        return answer === '' ? (fallback ?? '') : answer;
      }),
    secret: options.secretPrompt ?? (async (question) => (await askSecret(question, io)).trim()),
    yes:
      options.confirmOverwrite ??
      (async (question) => await confirm(question, { ...io, defaultAnswer: false })),
  };
}

export interface SetupResult {
  exitCode: number;
  /** Where the config was written, when it was. */
  path?: string;
  /** Set when setup declined or failed, for the caller to print if it wants. */
  reason?: string;
}

export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const painter = new Painter(colorCapability({ stream: output }));
  const say = (line = ''): void => void output.write(`${line}\n`);
  const configPath = options.configPath ?? process.env['MODELHITCH_CONFIG'] ?? defaultConfigPath();
  const io = surface(options);

  // A prompt nobody can answer is a hang, not a setup.
  if (input.isTTY !== true) {
    say(
      painter.color(
        'error',
        '✖ setup needs an interactive terminal: it asks questions, and a piped stdin cannot answer them.',
      ),
    );
    say(painter.color('faint', `  create the file by hand instead: ${configPath}`));
    return { exitCode: 1, reason: 'stdin is not a TTY' };
  }

  say();
  say(`  ${painter.bold(painter.color('accent', 'MODELHITCH'))}${painter.color('faint', ' · harness setup')}`);
  say(`  ${painter.color('faint', configPath)}`);
  say();

  /* ---- what is already there ------------------------------------- */
  let existing: ModelHitchConfig | null = null;
  try {
    existing = readConfigFile(configPath);
  } catch (err) {
    // A malformed file is reported as the parser's one-line reason, never a
    // stack trace; the user needs to know which file and what is wrong with it.
    const reason = err instanceof Error ? err.message : String(err);
    say(painter.color('error', `✖ ${reason}`));
    const replace = await io.yes(painter.color('warn', '  Replace it with a new one? [y/N] '));
    if (!replace) {
      say(painter.color('faint', '  left untouched.'));
      return { exitCode: 1, reason };
    }
  }

  if (existing !== null) {
    const { errors } = validateConfig(existing);
    const summary =
      errors.length > 0
        ? `invalid: ${errors.join('; ')}`
        : `${existing.defaultProviderId ?? '?'}/${existing.defaultModel ?? '?'}`;
    say(painter.color('warn', `! a config already exists (${summary})`));
    const overwrite = await io.yes(painter.color('warn', '  Overwrite it? [y/N] '));
    if (!overwrite) {
      say(painter.color('faint', '  left untouched.'));
      return { exitCode: 1, reason: 'existing config kept' };
    }
  }

  /* ---- answers ---------------------------------------------------- */
  const providerDefault = existing?.defaultProviderId ?? 'vercel-ai-gateway';
  const providerAnswer = await io.text(
    `  ${painter.color('text', 'provider')} ${painter.color('faint', `[${providerDefault}]`)}: `,
    providerDefault,
  );
  let provider = providerAnswer;

  const modelDefault = existing?.defaultModel ?? defaultModelFor(provider);
  const modelAnswer = await io.text(
    `  ${painter.color('text', 'model')} ${painter.color('faint', modelDefault ? `[${modelDefault}]` : '')}: `,
    modelDefault,
  );
  let model = modelAnswer;
  // The runtime addresses a model as `<provider>/<model>`; accept that spelling
  // here and split it, because it is the form every other flag and message uses.
  const slash = modelAnswer.indexOf('/');
  if (slash > 0 && slash < modelAnswer.length - 1) {
    provider = modelAnswer.slice(0, slash);
    model = modelAnswer.slice(slash + 1);
  }

  if (provider === '' || model === '') {
    say(painter.color('error', '✖ a provider and a model are both required.'));
    return { exitCode: 1, reason: 'provider or model missing' };
  }

  const envHint = PROVIDER_KEY_ENV[provider];
  const secret = await io.secret(
    `  ${painter.color('text', 'api key')}` +
      `${envHint ? painter.color('faint', ` (commonly ${envHint})`) : ''}: `,
  );
  say();

  /* ---- candidate document ----------------------------------------- */
  const candidate: ModelHitchConfig = { ...(existing ?? defaultConfigTemplate()) };
  candidate.defaultProviderId = provider;
  candidate.defaultModel = model;
  candidate.keys = { ...(candidate.keys ?? {}) };
  if (secret !== NO_INPUT && secret !== '') candidate.keys[provider] = secret;

  const { errors } = validateConfig(candidate);
  if (errors.length > 0) {
    say(painter.color('error', `✖ the config would be invalid: ${errors.join('; ')}`));
    say(painter.color('faint', `  nothing was written to ${configPath}.`));
    return { exitCode: 1, reason: errors.join('; ') };
  }

  /* ---- prove it works, before writing anything -------------------- */
  say(painter.color('faint', `  checking ${provider}/${model} …`));
  try {
    const runtime = await buildRuntime({ config: candidate, configPath });
    if (options.verify) {
      await options.verify(runtime);
    } else {
      await verifyCredential(runtime.client, provider, model);
    }
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err), secret);
    say(painter.color('error', `✖ ${clip(reason, 200)}`));
    say(painter.color('faint', `  nothing was written to ${configPath}; any existing file is untouched.`));
    return { exitCode: 1, reason };
  }

  /* ---- write ------------------------------------------------------ */
  try {
    if (existing !== null) {
      const backup = `${configPath}.bak`;
      copyFileSync(configPath, backup);
      say(painter.color('faint', `  previous config copied to ${backup}`));
    }
    writeConfigAtomic(configPath, candidate);
  } catch (err) {
    const reason = redact(err instanceof Error ? err.message : String(err), secret);
    say(painter.color('error', `✖ could not write ${configPath}: ${clip(reason, 200)}`));
    return { exitCode: 1, reason };
  }

  say(painter.color('ok', `✔ wrote ${configPath} (mode 0600)`));
  say(painter.color('faint', `  next: ${painter.color('muted', 'mhh "list the files here"')}`));
  say();
  return { exitCode: 0, path: configPath };
}

/**
 * Exactly one cheap round trip: a one-token reply proves the key is accepted and
 * the model id resolves, and costs almost nothing. Anything longer is a run, and
 * a run is not this command's job.
 */
async function verifyCredential(
  client: Awaited<ReturnType<typeof buildRuntime>>['client'],
  provider: string,
  model: string,
): Promise<void> {
  await client.chat({
    provider,
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    maxTokens: 1,
    signal: AbortSignal.timeout(SETUP_VERIFY_TIMEOUT_MS),
  });
}
