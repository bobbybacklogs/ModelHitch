import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CONFIG_VERSION, type ModelHitchConfig } from './config.js';

/**
 * Node-only config file I/O for the local settings surface.
 *
 * Default location: `~/.modelhitch/config.json` (override the directory with
 * `MODELHITCH_HOME`, matching the daemon's pid/log home). The settings UI and
 * the CLI both round-trip this exact document — masked on read, plain on disk
 * (the file is user-owned and local, like `.npmrc`).
 */

export function modelhitchHome(): string {
  return process.env.MODELHITCH_HOME || join(homedir(), '.modelhitch');
}

export function defaultConfigPath(): string {
  return join(modelhitchHome(), 'config.json');
}

/** Read the config document. Returns null when no file exists yet. */
export function readConfigFile(path: string): ModelHitchConfig | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read config at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Config at ${path} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Config at ${path} must be a JSON object.`);
  }
  return parsed as ModelHitchConfig;
}

/** Write the config document (creates parent directories). */
export function writeConfigFile(path: string, config: ModelHitchConfig): void {
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create config directory ${dir}: ${(err as Error).message}`);
  }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * Default template written by `modelhitch config init` and used when the bridge
 * starts with no config file. Mirrors `DEFAULT_FAILOVER_LANES`: Vercel AI
 * Gateway primary with alternate gateway models as the safety net.
 */
export function defaultConfigTemplate(): ModelHitchConfig {
  return {
    version: CONFIG_VERSION,
    defaultProviderId: 'vercel-ai-gateway',
    defaultModel: 'openai/gpt-5.4',
    policy: {
      trusted: [{ providerId: 'vercel-ai-gateway', models: ['openai/gpt-5.4'] }],
      fallback: [
        {
          providerId: 'vercel-ai-gateway',
          models: ['anthropic/claude-sonnet-4.6', 'google/gemini-3-flash'],
        },
        { providerId: 'openai', models: ['gpt-5.4'] },
      ],
    },
    cooldown: { type: 'circuit-breaker', failureThreshold: 3, baseTripMs: 15_000, maxTripMs: 120_000 },
    imageGeneration: { enabled: false, providerId: 'openai', model: 'gpt-image-2', quality: 'medium', size: '1024x1024' },
  };
}

/** Scaffold a config at `path` (refuses to overwrite an existing file). */
export function initConfigFile(path: string): { created: boolean; path: string } {
  const existing = readConfigFile(path);
  if (existing) return { created: false, path };
  writeConfigFile(path, defaultConfigTemplate());
  return { created: true, path };
}
