#!/usr/bin/env node
/**
 * ModelHitch CLI.
 *
 *   modelhitch            print the logo, version, and command help
 *   modelhitch bridge     start the local OpenAI-compatible bridge server
 *   modelhitch bridge --background  start it as a background process (pid in ~/.modelhitch)
 *   modelhitch status     is a background bridge running?
 *   modelhitch front      stop the background one and run the bridge in this terminal
 *   modelhitch stop       stop the background bridge
 *   modelhitch settings   edit local settings in an OpenTUI terminal interface
 *   modelhitch settings --web  open the bridge settings UI in a browser
 *   modelhitch setup codex  install the ModelHitch skill for Codex
 *   modelhitch --version  print the version
 *   modelhitch --help     print help
 *
 * Environment:
 *   MODELHITCH_PORT       bridge port (default 3939)
 *   MODELHITCH_HOST       bridge host (default 127.0.0.1)
 *   MODELHITCH_MAX_BODY_BYTES  max request body for the bridge (default 64 MiB)
 *   MODELHITCH_HOME       directory for the background pid/log (default ~/.modelhitch)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentModuleUrl } from './core/import-meta.js';
import { printAsciiLogo } from './ascii.js';
import { createModelHitchServer } from './server/server.js';
import { OPENCODE_GO_MODELS, OPENCODE_ZEN_MODELS } from './providers/opencode.js';
import { installSkills, SETUP_TARGETS, type SetupTarget } from './skill-installer.js';
import {
  clearPid,
  daemonStatus,
  isRunning,
  probeBridge,
  readPid,
  spawnBackground,
  stopBackground,
  waitForReady,
} from './daemon.js';
import {
  createCatalogSource,
  type CatalogSource,
} from './catalog/source.js';
import {
  buildCatalogOptions,
  buildCooldownFromConfig,
  isMaskedSecret,
  policyFromConfig,
  serializeConfig,
  validateConfigWithSource,
} from './config.js';
import {
  defaultConfigPath,
  defaultConfigTemplate,
  initConfigFile,
  modelhitchHome,
  readConfigFile,
  writeConfigFile,
} from './config-file.js';
import type { ModelHitchConfig } from './config.js';
import { MemoryKeyStore } from './storage/memory.js';
import { CircuitBreaker } from './core/circuit-breaker.js';
import type { LaneCooldown } from './core/failover.js';
import type { Provider } from './providers/types.js';
import { defaultProviders } from './registry.js';

/** Provider id → env vars checked (first hit wins) when seeding config.keys. */
const PROVIDER_KEY_ENV: Record<string, string[]> = {
  'opencode-zen': ['OPENCODE_ZEN_API_KEY', 'OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  huggingface: ['HF_TOKEN'],
  gemini: ['GEMINI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  zai: ['ZAI_API_KEY'],
};

/**
 * Load KEY=VALUE pairs from a dotenv-style file into process.env without
 * overwriting anything already set. Best-effort — missing files are ignored.
 */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** Pull known provider keys from the process env into a config.keys map. */
function keysFromEnv(existing: Record<string, string> = {}): Record<string, string> {
  const keys = { ...existing };
  for (const [providerId, envNames] of Object.entries(PROVIDER_KEY_ENV)) {
    if (keys[providerId]) continue;
    for (const name of envNames) {
      const value = process.env[name];
      if (value) {
        keys[providerId] = value;
        break;
      }
    }
  }
  return keys;
}

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', currentModuleUrl()), 'utf8'),
).version as string;

/** Read the value of `--flag` from the process args, or undefined. */
function flagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

/** Read the value of `--flag` from a local args array, or undefined. */
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function argsHasFlag(flags: string[]): boolean {
  return flags.some((flag) => process.argv.includes(flag));
}

function usage(): void {
  console.log(`ModelHitch v${VERSION} — plug-and-play BYOK integration layer.
  hitched at https://github.com/genoventures-labs/ModelHitch

Usage:
  modelhitch                                     print the logo, version, and this help
  modelhitch bridge                              start the local OpenAI-compatible bridge server
  modelhitch bridge --background                  start it in the background (terminal stays free)
  modelhitch bridge --image-lane                  enable the dedicated image generation lane
  modelhitch bridge --no-image-lane               disable the image generation lane
  modelhitch bridge --image-provider openai       set the image lane provider (openai|gemini)
  modelhitch bridge --image-model gpt-image-2     set the default image model
  modelhitch status                              is a background bridge running?
  modelhitch front                               stop the background one, run the bridge in this terminal
  modelhitch stop                                stop the background bridge
  modelhitch settings                            edit local config in an OpenTUI interface
  modelhitch settings --web                      open the bridge settings UI in a browser
  modelhitch settings --config <path>            edit a specific config file
  modelhitch setup <agent>                       install skills for codex, claude, cursor, vscode, or all
  modelhitch --version                           print the version
  modelhitch --help                              print this help

Background process:
  tracked in ~/.modelhitch (bridge.pid + bridge.log, override with MODELHITCH_HOME)

Skill setup:
  modelhitch setup codex            install to the agent's user skill directory
  modelhitch setup all --project    install project skills for all four agents
  --project                         install in the current project instead
  --dry-run                         show destinations without writing
  --force                           update files in existing skill directories

Bridge environment:
  MODELHITCH_PORT           port (default 3939)
  MODELHITCH_HOST           host (default 127.0.0.1)
  MODELHITCH_MAX_BODY_BYTES max request body (default 64 MiB)
  Image generation is disabled by default; enable it via CLI flags or /settings.
`);
}

async function runBridge(): Promise<void> {
  // Background daemons often start without a shell env. Load local dotenv files
  // (cwd + ~/.modelhitch) so OPENCODE_*/OPENAI_* keys still resolve.
  loadEnvFile(join(process.cwd(), '.env'));
  loadEnvFile(join(modelhitchHome(), '.env'));
  loadEnvFile(join(homedir(), '.modelhitch', '.env'));

  const port = Number(process.env.MODELHITCH_PORT ?? 3939);
  const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';
  const maxBodyBytes = Number(process.env.MODELHITCH_MAX_BODY_BYTES ?? 64 * 1024 * 1024);
  const configPath = flagValue('--config') ?? defaultConfigPath();
  const imageFlag = argsHasFlag(['--image-lane', '--image-generation']) ? true : argsHasFlag(['--no-image-lane', '--no-image-generation']) ? false : undefined;
  const imageProvider = flagValue('--image-provider') ?? undefined;
  const imageModel = flagValue('--image-model') ?? undefined;
  const imageQuality = flagValue('--image-quality') ?? undefined;
  const imageSize = flagValue('--image-size') ?? undefined;

  const loaded = readConfigFile(configPath); // null when none exists yet
  if (loaded) {
    const { errors } = validateConfigWithSource(loaded);
    if (errors.length) {
      console.error(`Config ${configPath} is invalid:\n  - ${errors.join('\n  - ')}`);
      process.exitCode = 1;
      return;
    }
  }
  const config: ModelHitchConfig = loaded ?? defaultConfigTemplate();
  if (imageFlag !== undefined || imageProvider !== undefined || imageModel !== undefined || imageQuality !== undefined || imageSize !== undefined) {
    const configuredProvider = imageProvider && ['openai', 'gemini'].includes(imageProvider)
      ? (imageProvider as 'openai' | 'gemini')
      : config.imageGeneration?.providerId ?? 'openai';
    const providerChanged = configuredProvider !== config.imageGeneration?.providerId;
    config.imageGeneration = {
      enabled: imageFlag ?? config.imageGeneration?.enabled ?? false,
      providerId: configuredProvider,
      model: imageModel ?? (providerChanged ? undefined : config.imageGeneration?.model) ?? (configuredProvider === 'gemini' ? 'gemini-3.1-flash-image' : 'gpt-image-2'),
      quality: imageQuality && ['low', 'medium', 'high'].includes(imageQuality) ? (imageQuality as 'low' | 'medium' | 'high') : config.imageGeneration?.quality ?? 'medium',
      size: imageSize ?? config.imageGeneration?.size ?? '1024x1024',
    };
  }
  // Merge env-sourced keys so a bridge without a written keys block still works
  // (and the settings UI can show which providers already have credentials).
  config.keys = keysFromEnv(config.keys ?? {});
  if (!loaded) {
    try {
      writeConfigFile(configPath, config);
    } catch {
      /* settings still work in-memory; file write is best-effort */
    }
  }

  // Catalog mode: warm the models.dev source, build the executable provider set.
  let catalogSource: CatalogSource | undefined;
  let providers: Provider[] = defaultProviders;
  let keystore = new MemoryKeyStore();
  const cooldown: LaneCooldown | undefined = buildCooldownFromConfig(config);
  const configCatalog = buildCatalogOptions(config);
  if (configCatalog || config.catalog !== undefined) {
    const src = createCatalogSource({ ...configCatalog, registry: defaultProviders });
    try {
      await src.warm();
      catalogSource = src;
      providers = src.providers();
    } catch (err) {
      console.error(`Failed to load the models.dev catalog: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  const server = createModelHitchServer({
    providers,
    defaultProviderId: config.defaultProviderId ?? 'opencode-zen',
    defaultModel: config.defaultModel,
    imageGeneration: config.imageGeneration,
    staticModels: {
      'opencode-zen': [...OPENCODE_ZEN_MODELS],
      'opencode-go': [...OPENCODE_GO_MODELS],
    },
    maxBodyBytes,
    policy: policyFromConfig(config),
    cooldown,
    catalogSource,
    keystore,
    // Keys from the config file / env are available from the very first request —
    // no Apply needed for keys already stored locally.
    apiKeys: config.keys,
    usagePersistence: true,
    logger: (line) => console.log(line),
    onFailover: (event) =>
      console.log(
        `[failover] ${event.from.providerId}/${event.from.model} -> ${event.to.providerId}/${event.to.model} (${event.error.code}${event.error.status ? ` HTTP ${event.error.status}` : ''})`,
      ),
    // Settings surface: read the (masked) document, validate + persist + apply.
    configBridge: {
      getConfig: () => serializeConfig(config, { maskSecrets: true }),
      updateConfig: async (next: unknown) => {
        const asConfig = next as ModelHitchConfig;
        const { errors } = validateConfigWithSource(asConfig, catalogSource);
        if (errors.length) return { ok: false, errors };
        // Never persist a masked placeholder back as a real key (a client that
        // echoes the masked value we handed out would otherwise silently
        // overwrite the user's real key). Plaintext is accepted; masked blobs
        // fall back to the previously-stored value.
        const keys = asConfig.keys ?? {};
        for (const [providerId, value] of Object.entries(keys)) {
          if (isMaskedSecret(value)) {
            delete keys[providerId];
            const prev = (config.keys ?? {})[providerId];
            if (prev && !isMaskedSecret(prev)) keys[providerId] = prev;
          }
        }
        // Persist the full document (keys included) to the config file.
        try {
          writeConfigFile(configPath, asConfig);
        } catch (err) {
          return { ok: false, errors: [`Failed to write ${configPath}: ${(err as Error).message}`] };
        }
        // Apply immediately — hot reload. Optional fields absent from the
        // incoming document must be cleared first: Object.assign alone would
        // keep stale values (e.g. a catalog block the UI just unchecked).
        for (const k of ['catalog', 'defaultProviderId', 'defaultModel', 'cooldown', 'imageGeneration'] as const) {
          delete (config as unknown as Record<string, unknown>)[k];
        }
        Object.assign(config, asConfig);
        try {
          const nextCatalog = buildCatalogOptions(config);
          const wantsCatalog = config.catalog !== undefined;
          if (wantsCatalog && !catalogSource) {
            const src = createCatalogSource({ ...nextCatalog, registry: defaultProviders });
            await src.warm();
            catalogSource = src;
            server.reconfigure({
              providers: src.providers(),
              policy: policyFromConfig(config),
              cooldown: buildCooldownFromConfig(config) ?? (catalogSource ? new CircuitBreaker() : undefined),
              catalogSource: src,
              apiKeys: config.keys,
              defaultProviderId: config.defaultProviderId,
              defaultModel: config.defaultModel,
              imageGeneration: config.imageGeneration,
            });
          } else if (!wantsCatalog && catalogSource) {
            // Catalog mode switched off — fall back to the built-in registry.
            catalogSource = undefined;
            server.reconfigure({
              providers,
              policy: policyFromConfig(config),
              cooldown: buildCooldownFromConfig(config),
              catalogSource: undefined,
              apiKeys: config.keys,
              defaultProviderId: config.defaultProviderId,
              defaultModel: config.defaultModel,
              imageGeneration: config.imageGeneration,
            });
          } else {
            server.reconfigure({
              providers: catalogSource ? catalogSource.providers() : providers,
              policy: policyFromConfig(config),
              cooldown: buildCooldownFromConfig(config) ?? (catalogSource ? new CircuitBreaker() : undefined),
              apiKeys: config.keys,
              baseUrls: config.catalog?.baseUrls,
              defaultProviderId: config.defaultProviderId,
              defaultModel: config.defaultModel,
              imageGeneration: config.imageGeneration,
            });
          }
        } catch (err) {
          return { ok: false, errors: [`Failed to apply config: ${(err as Error).message}`] };
        }
        return { ok: true };
      },
    },
  });

  const { url } = await server.listen(port, host);
  console.log(`\nModelHitch bridge v${VERSION} listening on ${url}

Point any OpenAI-compatible client (Android Studio Agent Mode, JetBrains AI,
Cursor, Codex CLI, Claude Code, Gemini CLI, ...) at:

  Base URL:   ${url}/v1
  API key:    any value (keys are resolved locally, never sent out)

Settings (local — no env digging):
  ${configPath}
  open ${url}/settings in a browser

Usage telemetry (persisted to ./modelhitch-usage.db):
  JSON:       curl ${url}/v1/usage
  Dashboard:  open ${url}/usage in a browser

Press Ctrl+C to stop.`);
}

async function runBackgroundBridge(): Promise<void> {
  const port = Number(process.env.MODELHITCH_PORT ?? 3939);
  const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';
  const tracked = daemonStatus();

  if (!tracked.running) {
    const existing = await probeBridge(port, host);
    if (existing.responding) {
      console.log(`A bridge is already responding on ${existing.url}, but it is not tracked by this CLI.`);
      console.log('  Leave it running, or stop that process before starting a managed background bridge.');
      return;
    }
  }

  const spawned = spawnBackground(['bridge']);

  if (spawned.alreadyRunning) {
    console.log(`A background bridge is already running (pid ${spawned.pid}).`);
    console.log(`  status:  modelhitch status`);
    console.log(`  front:   modelhitch front  (stop it and run it here)`);
    console.log(`  stop:    modelhitch stop`);
    return;
  }

  console.log(`Launched the bridge in the background (pid ${spawned.pid}).`);
  const ready = await waitForReady(port, host, 8000, spawned.pid);
  if (!ready && !isRunning(spawned.pid)) clearPid();
  console.log(
    ready
      ? `  responding on http://${host}:${port} — your terminal is free.`
      : !isRunning(spawned.pid)
        ? `  process exited before becoming ready — check the log:`
        : `  not responding yet — check the log:`,
  );
  console.log(`  log:     ${spawned.logPath}`);
  console.log(`  status:  modelhitch status`);
  console.log(`  stop:    modelhitch stop`);
  console.log(`  front:   modelhitch front  (stop it and run it here)`);
}

async function runStatus(): Promise<void> {
  const status = daemonStatus();
  const port = Number(process.env.MODELHITCH_PORT ?? 3939);
  const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';

  if (!status.running || status.pid === null) {
    const existing = await probeBridge(port, host);
    if (readPid() !== null) {
      clearPid();
      console.log('modelhitch status: tracked process stopped (stale pid file cleaned up)');
    }
    if (existing.responding) {
      console.log('modelhitch status: responding (untracked process)');
      console.log(`  healthz:  yes — responding on ${existing.url}`);
      console.log('  stop:     stop the owning process; this CLI will not kill an untracked PID');
      return;
    }
    console.log('modelhitch status: not running');
    console.log('  start it with:  modelhitch bridge --background');
    return;
  }

  let health = 'no';
  try {
    const res = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1200) });
    health = res.ok ? `yes — responding on http://${host}:${port}` : 'no';
  } catch {
    /* not responding */
  }
  console.log('modelhitch status: running');
  console.log(`  pid:      ${status.pid}`);
  console.log(`  healthz:  ${health}`);
  console.log(`  log:      ${status.logPath}`);
}

async function runFront(): Promise<void> {
  const status = daemonStatus();
  if (status.running && status.pid !== null) {
    await stopBackground();
    console.log(`Stopped the background bridge (pid ${status.pid}) — running it here instead.\n`);
  } else if (readPid() !== null) {
    clearPid();
  }
  await runBridge();
}

async function runStop(): Promise<void> {
  const status = daemonStatus();
  if (status.running && status.pid !== null) {
    await stopBackground();
    console.log(`Stopped the background bridge (pid ${status.pid}).`);
  } else if (readPid() !== null) {
    clearPid();
    console.log('No background bridge was running (stale pid file cleaned up).');
  } else {
    console.log('No background bridge is running.');
  }
}

function runSetup(args: string[]): void {
  const target = args[0];
  if (!target || !SETUP_TARGETS.includes(target as SetupTarget)) {
    throw new Error('Choose an agent: codex, claude, cursor, vscode, or all.');
  }
  const known = new Set(['--project', '--dry-run', '--force']);
  const unknown = args.slice(1).filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown setup option: ${unknown[0]}`);

  const dryRun = args.includes('--dry-run');
  const installed = installSkills({
    target: target as SetupTarget,
    scope: args.includes('--project') ? 'project' : 'user',
    force: args.includes('--force'),
    dryRun,
  });
  console.log(dryRun ? 'ModelHitch would install:' : 'ModelHitch skills installed:');
  for (const skill of installed) console.log(`  ${skill.agent.padEnd(7)} ${skill.path}`);
  if (!dryRun) console.log('\nRestart the agent or open a new session so it discovers the skill.');
}

async function runConfig(args: string[]): Promise<void> {
  const path = argValue(args, '--path') ?? defaultConfigPath();
  if (args.includes('init')) {
    const { created } = initConfigFile(path);
    console.log(created ? `Created ${path}` : `Already exists: ${path}`);
    return;
  }
  // Default: print the masked config path + contents.
  console.log(`config: ${path}`);
  const existing = readConfigFile(path);
  if (!existing) {
    console.log('  (none yet — run `modelhitch config init` or open the settings page)');
    return;
  }
  console.log(JSON.stringify(serializeConfig(existing, { maskSecrets: true }), null, 2));
}

function runSettings(args: string[]): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('The settings TUI requires an interactive terminal.');
  }
  const configPath = argValue(args, '--config') ?? argValue(args, '--path') ?? defaultConfigPath();
  const moduleUrl = currentModuleUrl();
  const extension = moduleUrl.endsWith('.ts') ? 'ts' : 'js';
  const tuiPath = fileURLToPath(new URL(`./settings-tui.${extension}`, moduleUrl));
  const result = spawnSync('bun', [tuiPath, '--config', configPath], { stdio: 'inherit' });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error('OpenTUI requires Bun for this Node version. Install Bun from https://bun.sh, then run `modelhitch settings` again.');
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

function openBrowser(url: string): void {
  const os = platform();
  const command = os === 'win32' ? 'cmd.exe' : os === 'darwin' ? 'open' : 'xdg-open';
  const args = os === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function runWebSettings(): Promise<void> {
  const port = Number(process.env.MODELHITCH_PORT ?? 3939);
  const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';
  const url = `http://${host}:${port}/settings`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  } catch {
    throw new Error(`No ModelHitch bridge is responding at ${url}. Start it with \`modelhitch bridge --background\`.`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('text/html')) {
    throw new Error(
      `The bridge at ${url} does not provide the settings UI (HTTP ${response.status}, ${contentType || 'unknown content type'}). ` +
      'Stop it and restart it with this ModelHitch version.',
    );
  }
  openBrowser(url);
  console.log(`Opened ${url}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [cmd] = args;
  if (cmd !== 'settings') printAsciiLogo();
  switch (cmd) {
    case undefined:
    case '-h':
    case '--help':
      usage();
      break;
    case '-v':
    case '--version':
      console.log(VERSION);
      break;
    case 'bridge':
      if (args.includes('--background') || args.includes('-b')) {
        await runBackgroundBridge();
      } else {
        await runBridge();
      }
      break;
    case 'status':
      await runStatus();
      break;
    case 'front':
      await runFront();
      break;
    case 'stop':
      await runStop();
      break;
    case 'setup':
      runSetup(args.slice(1));
      break;
    case 'config':
      await runConfig(args.slice(1));
      break;
    case 'settings':
      if (args.includes('--web')) await runWebSettings();
      else runSettings(args.slice(1));
      break;
    default:
      console.log(`Unknown command: ${cmd}\n`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
