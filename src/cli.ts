#!/usr/bin/env node
/**
 * ModelHitch CLI — see `usage()` for the authoritative command and flag list.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentModuleUrl } from './core/import-meta.js';
import { printAsciiLogo } from './ascii.js';
import { createModelHitchServer } from './server/server.js';
import { installSkills, SETUP_TARGETS, type SetupTarget } from './skill-installer.js';
import { readVercelCliAuthToken } from './core/vercel-auth.js';
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
import { bridgeProviders } from './bridge-providers.js';
import { defaultProviders } from './registry.js';
import { validateCursorCloudApiKey, CURSOR_CLOUD_PROVIDER_ID } from './providers/cursor-cloud.js';
import { CursorCloudSessionStore } from './providers/cursor-cloud-session.js';

/** Provider id → env vars checked (first hit wins) when seeding config.keys. */
const PROVIDER_KEY_ENV: Record<string, string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  groq: ['GROQ_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'VERCEL_TOKEN'],
  together: ['TOGETHER_API_KEY'],
  huggingface: ['HF_TOKEN'],
  gemini: ['GEMINI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  moonshot: ['MOONSHOT_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'cursor-cloud': ['CURSOR_API_KEY'],
};

const cloudSessionStore = new CursorCloudSessionStore();

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
  if (!keys['vercel-ai-gateway']) {
    const cliToken = readVercelCliAuthToken();
    if (cliToken) keys['vercel-ai-gateway'] = cliToken;
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
  modelhitch                                     print logo, version, and this help
  modelhitch --help | -h                         same as above
  modelhitch --version | -v                      print version

  modelhitch bridge                              start the local OpenAI-compatible bridge (foreground)
  modelhitch bridge --background | -b            start bridge in the background (terminal stays free)
  modelhitch status                              show background bridge pid, health, and log path
  modelhitch front                               stop background bridge and run it in this terminal
  modelhitch stop                                stop the background bridge

  modelhitch config                              print masked local config (default ~/.modelhitch/config.json)
  modelhitch config init                         create the default config file if missing
  modelhitch config --path <file>                use a specific config file

  modelhitch settings                            edit config in OpenTUI (requires Bun; needs a TTY)
  modelhitch settings --web                      open the running bridge /settings page in a browser
  modelhitch settings --config <file>            config file to edit (alias: --path)
  modelhitch workspace                           open the running bridge /workspace page in a browser

  modelhitch setup <agent>                       install agent skills (codex, claude, cursor, vscode, or all)

  modelhitch chat                                send a prompt through a bridge chat session
  modelhitch work                                run a one-shot work order on the bridge
  modelhitch cloud list                          list Cursor Cloud agents via the bridge
  modelhitch cloud get <id>                      show one cloud agent id and status
  modelhitch cloud cancel <id>                   cancel a cloud agent (exit 0 when cancelled)

Chat and work flags:
  --rotation                                     use the bridge default provider/model (rotation target)
  --model <provider>/<model>                     pin a provider and model (split on the first slash)
  --prompt <text>                                user prompt text
  --base-url <url>                               bridge base URL (default http://127.0.0.1:3939, or MODELHITCH_PORT)

Bridge flags (with \`bridge\` and \`bridge --background\`):
  --config <file>                config file (default ~/.modelhitch/config.json)
  --image-lane                   enable image generation lane (alias: --image-generation)
  --no-image-lane                disable image lane (alias: --no-image-generation)
  --image-provider openai|gemini image provider (default openai)
  --image-model <id>             image model (openai default gpt-image-2; gemini default gemini-3.1-flash-image)
  --image-quality low|medium|high  image quality (default medium)
  --image-size <WxH>             image size (default 1024x1024)
  --cloud-agent-lane             enable Cursor Cloud Agent lane (alias: --cloud-agent)
  --no-cloud-agent-lane          disable cloud agent lane (alias: --no-cloud-agent)
  --cloud-agent-repo <url>       cloudAgent.repos[0].url
  --cloud-agent-ref <ref>        cloudAgent.repos[0].startingRef
  --cloud-agent-model <id>       cloudAgent.defaultModel (default composer-2.5)

Setup options (with \`setup <agent>\`):
  modelhitch setup codex                         install to the agent user skill directory
  modelhitch setup all --project                 install project skills for all four agents
  --project                                      install in the current project instead of user home
  --dry-run                                      show destinations without writing
  --force                                        overwrite files in existing skill directories

Files and environment:
  ~/.modelhitch/bridge.pid, bridge.log, config.json  (override directory with MODELHITCH_HOME)
  MODELHITCH_PORT           bridge port (default 3939)
  MODELHITCH_HOST           bind host (default 127.0.0.1)
  MODELHITCH_MAX_BODY_BYTES max request body (default 64 MiB)
  MODELHITCH_DEBUG=1        log forwarded request bodies (may expose secrets)
  Provider keys resolve from config keys.* and env vars (e.g. OPENAI_API_KEY, CURSOR_API_KEY).
  Image lane is off by default; enable via bridge flags or /settings.
  Cloud Agent lane is off by default; route explicitly as cursor-cloud/<model> after enabling.
  CURSOR_API_KEY (or keys.cursor-cloud) enables the cloud lane; service-account keys via env only.
`);
}

async function validateCloudAgentKey(config: ModelHitchConfig): Promise<void> {
  if (!config.cloudAgent?.enabled) return;
  const key = config.keys?.[CURSOR_CLOUD_PROVIDER_ID] ?? process.env.CURSOR_API_KEY;
  if (!key) return;
  try {
    await validateCursorCloudApiKey(key);
    console.log('Cursor Cloud Agent API key validated (GET /v1/me).');
  } catch (err) {
    console.warn(`Cursor Cloud Agent API key validation failed: ${(err as Error).message}`);
  }
}

async function runBridge(): Promise<void> {
  // Background daemons often start without a shell env. Load local dotenv files
  // (cwd + ~/.modelhitch) so AI_GATEWAY_*/OPENAI_* keys still resolve.
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
  const cloudFlag = argsHasFlag(['--cloud-agent-lane', '--cloud-agent']) ? true : argsHasFlag(['--no-cloud-agent-lane', '--no-cloud-agent']) ? false : undefined;
  const cloudRepo = flagValue('--cloud-agent-repo') ?? undefined;
  const cloudRef = flagValue('--cloud-agent-ref') ?? undefined;
  const cloudModel = flagValue('--cloud-agent-model') ?? undefined;

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
  if (cloudFlag !== undefined || cloudRepo !== undefined || cloudRef !== undefined || cloudModel !== undefined) {
    const existingRepos = config.cloudAgent?.repos ?? [];
    const repoUrl = cloudRepo ?? existingRepos[0]?.url;
    const startingRef = cloudRef ?? existingRepos[0]?.startingRef;
    const repos = repoUrl ? [{ url: repoUrl, ...(startingRef ? { startingRef } : {}) }] : existingRepos;
    config.cloudAgent = {
      enabled: cloudFlag ?? config.cloudAgent?.enabled ?? false,
      defaultModel: cloudModel ?? config.cloudAgent?.defaultModel ?? 'composer-2.5',
      repos,
      mode: config.cloudAgent?.mode ?? 'agent',
      autoCreatePR: false,
      workOnCurrentBranch: config.cloudAgent?.workOnCurrentBranch ?? false,
      sessionReuse: config.cloudAgent?.sessionReuse ?? 'per-bridge-session',
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
  let baseProviders: Provider[] = defaultProviders;
  let keystore = new MemoryKeyStore();
  const cooldown: LaneCooldown | undefined = buildCooldownFromConfig(config);
  const configCatalog = buildCatalogOptions(config);
  if (configCatalog || config.catalog !== undefined) {
    const src = createCatalogSource({ ...configCatalog, registry: defaultProviders });
    try {
      await src.warm();
      catalogSource = src;
      baseProviders = src.providers();
    } catch (err) {
      console.error(`Failed to load the models.dev catalog: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }
  const providers = bridgeProviders(baseProviders, config, cloudSessionStore);
  await validateCloudAgentKey(config);

  const server = createModelHitchServer({
    providers,
    defaultProviderId: config.defaultProviderId ?? 'vercel-ai-gateway',
    defaultModel: config.defaultModel,
    imageGeneration: config.imageGeneration,
    cloudAgent: config.cloudAgent,
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
        for (const k of ['catalog', 'defaultProviderId', 'defaultModel', 'defaultWorkspaceTarget', 'cooldown', 'imageGeneration', 'cloudAgent'] as const) {
          delete (config as unknown as Record<string, unknown>)[k];
        }
        Object.assign(config, asConfig);
        config.keys = keysFromEnv(config.keys ?? {});
        try {
          const nextCatalog = buildCatalogOptions(config);
          const wantsCatalog = config.catalog !== undefined;
          const applyProviders = (base: Provider[]) => bridgeProviders(base, config, cloudSessionStore);
          if (wantsCatalog && !catalogSource) {
            const src = createCatalogSource({ ...nextCatalog, registry: defaultProviders });
            await src.warm();
            catalogSource = src;
            baseProviders = src.providers();
            server.reconfigure({
              providers: applyProviders(baseProviders),
              policy: policyFromConfig(config),
              cooldown: buildCooldownFromConfig(config) ?? (catalogSource ? new CircuitBreaker() : undefined),
              catalogSource: src,
              apiKeys: config.keys,
              defaultProviderId: config.defaultProviderId,
              defaultModel: config.defaultModel,
              imageGeneration: config.imageGeneration,
              cloudAgent: config.cloudAgent,
            });
          } else if (!wantsCatalog && catalogSource) {
            // Catalog mode switched off — fall back to the built-in registry.
            catalogSource = undefined;
            baseProviders = defaultProviders;
            server.reconfigure({
              providers: applyProviders(baseProviders),
              policy: policyFromConfig(config),
              cooldown: buildCooldownFromConfig(config),
              catalogSource: undefined,
              apiKeys: config.keys,
              defaultProviderId: config.defaultProviderId,
              defaultModel: config.defaultModel,
              imageGeneration: config.imageGeneration,
              cloudAgent: config.cloudAgent,
            });
          } else {
            const base = catalogSource ? catalogSource.providers() : baseProviders;
            server.reconfigure({
              providers: applyProviders(base),
              policy: policyFromConfig(config),
              cooldown: buildCooldownFromConfig(config) ?? (catalogSource ? new CircuitBreaker() : undefined),
              apiKeys: config.keys,
              baseUrls: config.catalog?.baseUrls,
              defaultProviderId: config.defaultProviderId,
              defaultModel: config.defaultModel,
              imageGeneration: config.imageGeneration,
              cloudAgent: config.cloudAgent,
            });
          }
          await validateCloudAgentKey(config);
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

async function runBackgroundBridge(bridgeArgs: string[]): Promise<void> {
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

  const spawned = spawnBackground(['bridge', ...bridgeArgs]);

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

function defaultBridgeBaseUrl(): string {
  const port = process.env.MODELHITCH_PORT ?? '3939';
  return `http://127.0.0.1:${port}`;
}

function parseChatWorkTarget(args: string[]): { target: { kind: 'rotation' } | { kind: 'model'; providerId: string; modelId: string } } {
  const rotation = args.includes('--rotation');
  const modelFlag = argValue(args, '--model');
  if (rotation && modelFlag) {
    throw new Error('Use either --rotation or --model, not both.');
  }
  if (modelFlag) {
    const slash = modelFlag.indexOf('/');
    if (slash <= 0 || slash === modelFlag.length - 1) {
      throw new Error('--model must be <provider>/<model> (split on the first slash).');
    }
    return {
      target: {
        kind: 'model',
        providerId: modelFlag.slice(0, slash),
        modelId: modelFlag.slice(slash + 1),
      },
    };
  }
  return { target: { kind: 'rotation' } };
}

async function runChatCommand(args: string[]): Promise<void> {
  const prompt = argValue(args, '--prompt');
  if (!prompt?.trim()) throw new Error('--prompt is required.');
  const baseUrl = (argValue(args, '--base-url') ?? defaultBridgeBaseUrl()).replace(/\/+$/, '');
  const { target } = parseChatWorkTarget(args);

  const sessionRes = await fetch(`${baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  });
  if (!sessionRes.ok) {
    throw new Error(`Failed to create session: HTTP ${sessionRes.status} ${await sessionRes.text()}`);
  }
  const session = (await sessionRes.json()) as { id: string };

  const messageRes = await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(session.id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  if (!messageRes.ok) {
    throw new Error(`Failed to send message: HTTP ${messageRes.status} ${await messageRes.text()}`);
  }
  const updated = (await messageRes.json()) as {
    messages: Array<{ role: string; content?: string }>;
  };
  const assistant = [...updated.messages].reverse().find((m) => m.role === 'assistant');
  const text = typeof assistant?.content === 'string' ? assistant.content : '';
  console.log(text);
}

async function cloudBridgeFetch(baseUrl: string, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`, init);
  return res;
}

async function parseCloudBridgeError(res: Response, id?: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  const message = body.error?.message ?? `HTTP ${res.status}`;
  if (id && res.status === 404) {
    console.error(`Cloud agent not found: ${id}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  throw new Error(message);
}

async function runCloudList(args: string[]): Promise<void> {
  const baseUrl = (argValue(args, '--base-url') ?? defaultBridgeBaseUrl()).replace(/\/+$/, '');
  const res = await cloudBridgeFetch(baseUrl, '/v1/cloud-agents');
  if (!res.ok) await parseCloudBridgeError(res);
  const body = (await res.json()) as { agents?: Array<{ id: string }> };
  for (const agent of body.agents ?? []) console.log(agent.id);
}

async function runCloudGet(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) throw new Error('Usage: modelhitch cloud get <id>');
  const baseUrl = (argValue(args, '--base-url') ?? defaultBridgeBaseUrl()).replace(/\/+$/, '');
  const res = await cloudBridgeFetch(baseUrl, `/v1/cloud-agents/${encodeURIComponent(id)}`);
  if (!res.ok) await parseCloudBridgeError(res, id);
  const agent = (await res.json()) as { id: string; status?: string };
  console.log(`${agent.id}\t${agent.status ?? ''}`);
}

async function runCloudCancel(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: modelhitch cloud cancel <id>');
    process.exitCode = 1;
    return;
  }
  const baseUrl = (argValue(args, '--base-url') ?? defaultBridgeBaseUrl()).replace(/\/+$/, '');
  const cancelRes = await cloudBridgeFetch(baseUrl, `/v1/cloud-agents/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!cancelRes.ok) await parseCloudBridgeError(cancelRes, id);
  const getRes = await cloudBridgeFetch(baseUrl, `/v1/cloud-agents/${encodeURIComponent(id)}`);
  if (!getRes.ok) await parseCloudBridgeError(getRes, id);
  const agent = (await getRes.json()) as { status?: string };
  if ((agent.status ?? '').toLowerCase() !== 'cancelled') {
    process.exitCode = 1;
  }
}

async function runCloudCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const subArgs = args.slice(1);
  switch (sub) {
    case 'list':
      await runCloudList(subArgs);
      break;
    case 'get':
      await runCloudGet(subArgs);
      break;
    case 'cancel':
      await runCloudCancel(subArgs);
      break;
    default:
      throw new Error('Usage: modelhitch cloud list | get <id> | cancel <id>');
  }
}

async function runWorkCommand(args: string[]): Promise<void> {
  const prompt = argValue(args, '--prompt');
  if (!prompt?.trim()) throw new Error('--prompt is required.');
  const baseUrl = (argValue(args, '--base-url') ?? defaultBridgeBaseUrl()).replace(/\/+$/, '');
  const { target } = parseChatWorkTarget(args);

  const res = await fetch(`${baseUrl}/v1/work-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, target }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create work order: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string; status: string };
  console.log(`${body.id}\t${body.status}`);
}

async function openBridgePage(path: string, label: string): Promise<void> {
  const port = Number(process.env.MODELHITCH_PORT ?? 3939);
  const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';
  const url = `http://${host}:${port}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(1500) });
  } catch {
    throw new Error(`No ModelHitch bridge is responding at ${url}. Start it with \`modelhitch bridge --background\`.`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('text/html')) {
    throw new Error(
      `The bridge at ${url} does not provide the ${label} UI (HTTP ${response.status}, ${contentType || 'unknown content type'}). ` +
      'Stop it and restart it with this ModelHitch version.',
    );
  }
  openBrowser(url);
  console.log(`Opened ${url}`);
}

async function runWebSettings(): Promise<void> {
  await openBridgePage('/settings', 'settings');
}

async function runWebWorkspace(): Promise<void> {
  await openBridgePage('/workspace', 'workspace');
}

/** Logo is for interactive help; keep background/status/stop output script-friendly. */
function shouldPrintLogo(args: string[]): boolean {
  const [cmd] = args;
  if (cmd === 'settings' || cmd === 'status' || cmd === 'stop') return false;
  if (cmd === '-v' || cmd === '--version') return false;
  if (cmd === 'bridge' && (args.includes('--background') || args.includes('-b'))) return false;
  return true;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [cmd] = args;
  if (shouldPrintLogo(args)) printAsciiLogo();
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
    case 'bridge': {
      const bridgeArgs = args.slice(1);
      if (bridgeArgs.includes('--background') || bridgeArgs.includes('-b')) {
        const forwarded = bridgeArgs.filter((arg) => arg !== '--background' && arg !== '-b');
        await runBackgroundBridge(forwarded);
      } else {
        await runBridge();
      }
      break;
    }
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
    case 'chat':
      await runChatCommand(args.slice(1));
      break;
    case 'work':
      await runWorkCommand(args.slice(1));
      break;
    case 'cloud':
      await runCloudCommand(args.slice(1));
      break;
    case 'workspace':
      await runWebWorkspace();
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
