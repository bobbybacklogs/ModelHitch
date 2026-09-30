import {
  ModelHitch,
  buildCatalogOptions,
  buildCooldownFromConfig,
  defaultConfigTemplate,
  policyFromConfig,
  readConfigFile,
  validateConfig,
  MemoryKeyStore,
  defaultProviders,
} from '../src/index.js';
import { defaultConfigPath } from '../src/config-file.js';
import type { ModelHitchConfig } from '../src/index.js';

export interface HarnessRuntime {
  client: ModelHitch;
  config: ModelHitchConfig;
  configPath: string;
  provider: string;
  model: string;
}

/** Split a `<provider>/<model>` override on the first slash (mirrors `modelhitch chat --model`). */
export function splitModelOverride(flag: string): { providerId: string; modelId: string } {
  const slash = flag.indexOf('/');
  if (slash <= 0 || slash === flag.length - 1) {
    throw new Error('--model must be <provider>/<model> (split on the first slash).');
  }
  return { providerId: flag.slice(0, slash), modelId: flag.slice(slash + 1) };
}

function configPathFrom(opts: { configPath?: string }): string {
  return opts.configPath ?? process.env.MODELHITCH_CONFIG ?? defaultConfigPath();
}

/**
 * Build the harness client from ModelHitch's own settings document —
 * `~/.modelhitch/config.json` (or `--config` / `MODELHITCH_CONFIG`).
 * Same defaults, policy, cooldown, catalog, and keys the bridge uses.
 * No parallel env knobs: only an explicit `--model provider/model`
 * overrides the configured default for a single run.
 */
export async function loadHarnessRuntime(opts: {
  configPath?: string;
  modelOverride?: string;
  /**
   * Suppress the "no config yet" hint. The doctor reports the same fact in its
   * own report, so printing it here as well would say it twice.
   */
  hintOnMissing?: boolean;
} = {}): Promise<HarnessRuntime> {
  const configPath = configPathFrom(opts);
  const loaded = readConfigFile(configPath);
  if (loaded === null && opts.hintOnMissing !== false) {
    // A first run with no config fails deep inside provider resolution, with an
    // error that says nothing about the missing file. One line here turns that
    // into an instruction.
    process.stderr.write(
      `[harness] no config at ${configPath} — run \`mhh setup\` to create one, or \`mhh doctor\` to check the setup\n`,
    );
  }
  const config: ModelHitchConfig = loaded ?? defaultConfigTemplate();
  return await buildRuntime({ config, configPath, ...(opts.modelOverride !== undefined ? { modelOverride: opts.modelOverride } : {}) });
}

/**
 * Build a runtime from a config document that is not on disk yet.
 *
 * `setup` needs this: it must prove a candidate credential works *before*
 * writing anything, so it cannot go through `loadHarnessRuntime`, which by
 * definition reads a file. Keeping the wiring in one place means the wizard
 * verifies against exactly the client a run would build.
 */
export async function buildRuntime(opts: {
  config: ModelHitchConfig;
  configPath: string;
  /** Per-run override in `<provider>/<model>` form. */
  modelOverride?: string;
}): Promise<HarnessRuntime> {
  const config = opts.config;
  const { errors } = validateConfig(config);
  if (errors.length) {
    throw new Error(`Invalid ModelHitch config at ${opts.configPath}:\n  - ${errors.join('\n  - ')}`);
  }

  const keystore = new MemoryKeyStore();
  for (const [providerId, key] of Object.entries(config.keys ?? {})) {
    if (key) await keystore.set(providerId, key);
  }

  let provider = config.defaultProviderId ?? 'vercel-ai-gateway';
  let model = config.defaultModel ?? defaultProviders[0]?.defaultModel ?? 'openai/gpt-5.4';
  if (opts.modelOverride) {
    const { providerId, modelId } = splitModelOverride(opts.modelOverride);
    provider = providerId;
    model = modelId;
  }

  const client = await ModelHitch.create({
    defaultProviderId: provider,
    defaultModel: model,
    keystore,
    policy: policyFromConfig(config),
    cooldown: buildCooldownFromConfig(config),
    ...(buildCatalogOptions(config) ? { catalog: buildCatalogOptions(config) } : {}),
  });

  return { client, config, configPath: opts.configPath, provider, model };
}
