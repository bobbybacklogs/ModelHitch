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
import type { CustomLaneConfig, ModelHitchConfig, OpenCodeByokConnection } from './config.js';
import { OPENCODE_BYOK_SCHEMAS } from './config.js';
import type { CustomLaneSchema } from './providers/custom-lane.js';
import { CUSTOM_LANE_SCHEMAS } from './providers/custom-lane.js';
import type { OpenCodeByokSchema } from './providers/opencode-byok.js';
import { MemoryKeyStore } from './storage/memory.js';
import { CircuitBreaker } from './core/circuit-breaker.js';
import type { LaneCooldown } from './core/failover.js';
import type { Provider } from './providers/types.js';
import { bridgeProviders } from './bridge-providers.js';
import { defaultProviders } from './registry.js';
import { applyOpenCodeByokPlan, describeOpenCodeByokPlan, openCodeByokApiKeys } from './opencode-byok.js';
import type { OpenCodeLocalState } from './opencode-byok.js';
import { applyCustomLanesPlan, customLaneApiKeys, describeCustomLanesPlan } from './custom-lanes.js';
import {
  applyChatGptPlanPlan,
  CHATGPT_PLAN_PROVIDER_ID,
  CHATGPT_PLAN_USAGE_SETTINGS_URL,
  chatGptPlanConfig,
  describeChatGptPlan,
  resolveChatGptPlan,
} from './chatgpt-plan.js';
import type { ChatGptPlanConfig } from './config.js';
import {
  ChatGptPlanAuth,
  describeChatGptPlanAccount,
  defaultChatGptPlanCredentialsPath,
} from './chatgpt-plan-auth.js';
import { listChatGptPlanAccountModels } from './chatgpt-plan-lane.js';
import { createChatGptPlanProvider } from './providers/chatgpt-plan.js';
import { readOpenCodeLocalState } from './opencode-state.js';
import { validateCursorCloudApiKey, CURSOR_CLOUD_PROVIDER_ID } from './providers/cursor-cloud.js';
import { CursorCloudSessionStore } from './providers/cursor-cloud-session.js';
import { CloudAgentSessionStore } from './providers/cloud-agent-session-store.js';

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
 * Durable conversation -> cloud-agent map, so a restarted bridge continues the
 * remote agent instead of forking a new one. Lives beside the config file, like
 * the workspace store.
 */
const cloudAgentSessionStore = new CloudAgentSessionStore(join(modelhitchHome(), 'cloud-agents'));

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

/**
 * Split `--flag=value` into its parts. Returns the bare flag name plus the
 * inline value (undefined for the space-separated form).
 */
function splitFlag(arg: string): { name: string; inline?: string } {
  if (!arg.startsWith('--')) return { name: arg };
  const eq = arg.indexOf('=');
  if (eq <= 2) return { name: arg };
  return { name: arg.slice(0, eq), inline: arg.slice(eq + 1) };
}

/**
 * Parse the repeatable Console BYOK connection flags in argv order, so
 * `--opencode-byok-connection <id> --opencode-byok-models a,b` scopes the
 * models to the connection that immediately precedes them.
 */
function openCodeByokConnectionsFromArgs(argv: string[] = process.argv): OpenCodeByokConnection[] {
  const connections: OpenCodeByokConnection[] = [];
  const last = () => connections[connections.length - 1];
  for (let i = 0; i < argv.length; i++) {
    const { name, inline } = splitFlag(argv[i] ?? '');
    if (!name.startsWith('--opencode-byok')) continue;
    const next = argv[i + 1];
    const spaced = inline === undefined && next !== undefined && !next.startsWith('--') ? next : undefined;
    const value = inline ?? spaced;
    const consumed = spaced !== undefined;
    switch (name) {
      case '--opencode-byok-connection':
        if (value) connections.push({ id: value, enabled: true });
        if (consumed) i++;
        break;
      case '--opencode-byok-label':
        if (value && last()) last()!.label = value;
        if (consumed) i++;
        break;
      case '--opencode-byok-models':
        if (value && last()) last()!.models = value.split(',').map((m) => m.trim()).filter(Boolean);
        if (consumed) i++;
        break;
      case '--opencode-byok-schema':
        if (value && last() && OPENCODE_BYOK_SCHEMAS.includes(value as OpenCodeByokSchema)) {
          last()!.schema = value as OpenCodeByokSchema;
        }
        if (consumed) i++;
        break;
      case '--opencode-byok-connection-url':
        if (value && last()) last()!.baseUrl = value;
        if (consumed) i++;
        break;
      default:
        break;
    }
  }
  return connections;
}

/** Replace same-id connections in place, append the rest. */
function mergeOpenCodeByokConnections(
  existing: readonly OpenCodeByokConnection[],
  incoming: readonly OpenCodeByokConnection[],
): OpenCodeByokConnection[] {
  const out = existing.map((connection) => ({ ...connection }));
  for (const connection of incoming) {
    const index = out.findIndex((candidate) => candidate.id === connection.id);
    if (index === -1) out.push({ ...connection });
    else out[index] = { ...out[index], ...connection };
  }
  return out;
}

/**
 * Parse the repeatable custom-lane flags in argv order, so
 * `--custom-lane <id> --custom-lane-url <url> --custom-lane-models a,b` scopes
 * the URL and models to the lane that immediately precedes them.
 */
function customLanesFromArgs(argv: string[] = process.argv): CustomLaneConfig[] {
  const lanes: CustomLaneConfig[] = [];
  const last = () => lanes[lanes.length - 1];
  for (let i = 0; i < argv.length; i++) {
    const { name, inline } = splitFlag(argv[i] ?? '');
    if (!name.startsWith('--custom-lane')) continue;
    const next = argv[i + 1];
    const spaced = inline === undefined && next !== undefined && !next.startsWith('--') ? next : undefined;
    const value = inline ?? spaced;
    const consumed = spaced !== undefined;
    switch (name) {
      case '--custom-lane':
        // A lane is not usable without an endpoint and models, so it is created
        // here and completed by the flags that follow.
        if (value) lanes.push({ id: value, baseUrl: '', models: [], enabled: true });
        if (consumed) i++;
        break;
      case '--custom-lane-label':
        if (value && last()) last()!.label = value;
        if (consumed) i++;
        break;
      case '--custom-lane-url':
        if (value && last()) last()!.baseUrl = value;
        if (consumed) i++;
        break;
      case '--custom-lane-models':
        if (value && last()) last()!.models = value.split(',').map((m) => m.trim()).filter(Boolean);
        if (consumed) i++;
        break;
      case '--custom-lane-schema':
        if (value && last() && CUSTOM_LANE_SCHEMAS.includes(value as CustomLaneSchema)) {
          last()!.schema = value as CustomLaneSchema;
        }
        if (consumed) i++;
        break;
      case '--custom-lane-on-limit':
        if (value && last() && (value === 'rotate' || value === 'stop')) last()!.onLimit = value;
        if (consumed) i++;
        break;
      default:
        break;
    }
  }
  return lanes;
}

/** Replace same-id custom lanes in place, append the rest. */
function mergeCustomLanes(
  existing: readonly CustomLaneConfig[],
  incoming: readonly CustomLaneConfig[],
): CustomLaneConfig[] {
  const out = existing.map((lane) => ({ ...lane }));
  for (const lane of incoming) {
    const index = out.findIndex((candidate) => candidate.id === lane.id);
    if (index === -1) out.push({ ...lane });
    else {
      // The flags that were actually passed win; an unset flag never erases a
      // stored endpoint or model list.
      const merged: CustomLaneConfig = { ...out[index], ...lane };
      if (!lane.baseUrl && out[index]?.baseUrl) merged.baseUrl = out[index]!.baseUrl;
      if (!lane.models?.length && out[index]?.models?.length) merged.models = out[index]!.models;
      out[index] = merged;
    }
  }
  return out;
}

/**
 * Turn the local OpenCode snapshot into BYOK connection candidates: one per
 * provider the user actually runs, carrying the models they actually chose.
 * The id is the OpenCode provider name, which the user replaces with the
 * Console connection id — Console mints opaque `conn_…` ids that no local file
 * records, so the name is the best join key available offline.
 */
function openCodeImportConnections(state: OpenCodeLocalState | undefined): OpenCodeByokConnection[] {
  if (!state?.found) return [];
  return state.providers
    .filter((provider) => provider.models.length > 0)
    .map((provider) => ({
      id: provider.providerId,
      label: `${provider.providerId} (from OpenCode)`,
      schema: 'auto' as OpenCodeByokSchema,
      models: provider.models,
      enabled: true,
    }));
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
  modelhitch setup zstack [agent]                install zstack workflow skills (default: all agents)

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
  --provider <id>                pin the bridge to one provider until it is restarted
                                 (the lane the pin displaces stays as fallback, so a
                                 depleted or erroring pin still rotates on)
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

OpenCode Console BYOK flags (https://opencode.ai/v2/docs/console/byok/):
  --opencode-byok                enable BYOK connections (alias: --no-opencode-byok)
  --opencode-byok-connection <id>  add a connection: the Console API URL or bare conn_… id (repeatable)
  --opencode-byok-models <a,b>   models enabled on the preceding connection (the rotation pool)
  --opencode-byok-label <text>   label for the preceding connection
  --opencode-byok-schema <s>     auto | chat-completions | responses | anthropic | google
  --opencode-byok-mode <m>       rotation (default) or pinned
  --opencode-byok-pin <id>       connection to pin when mode is pinned
  --opencode-byok-model <id>     model to pin when mode is pinned
  --opencode-byok-sync           seed empty model lists from the local OpenCode install
                                 (alias: --no-opencode-byok-sync)
  --opencode-byok-import         read the local OpenCode install and print/seed connections
  Console BYOK authenticates with the Console service-account key: keys.opencode
  (or OPENCODE_API_KEY) is reused, with keys.opencode-byok / keys.opencode-byok-<slug>
  as per-connection overrides.

Custom BYOK lane flags (a provider we do not ship, used as an ordinary lane):
  --custom-lanes                 enable custom lanes (alias: --no-custom-lanes)
  --custom-lane <id>             add a lane by id (repeatable; becomes provider custom-<id>)
  --custom-lane-url <url>        endpoint for the preceding lane, e.g. https://api.example.com/v1
  --custom-lane-models <a,b>     model slots for the preceding lane — typed by hand, never polled
  --custom-lane-label <text>     label for the preceding lane
  --custom-lane-schema <s>       auto (default) | chat-completions | responses | anthropic | google
  --custom-lane-on-limit <b>     rotate (default) or stop
  --custom-lanes-placement <p>   lead (default) or fallback
  Keys resolve from keys.custom-<id>, then the lane's apiKeyEnvVar, then
  MODELHITCH_CUSTOM_<ID>_API_KEY. ModelHitch never calls GET /models on a custom
  lane: the slots you type are exactly what the lane serves.
  on-limit=stop makes the lane terminal: a rate limit or empty account surfaces
  instead of spending another provider, and stays that way while it is parked.

Sign in with ChatGPT flags (spend the user's ChatGPT plan as a lane):
  --chatgpt-plan                 enable the chatgpt-plan lane (alias: --no-chatgpt-plan)
  --chatgpt-plan-models <a,b>    model slugs for the lane; omit to read the signed-in account
  --chatgpt-plan-mode <m>        rotation (default) or pinned
  --chatgpt-plan-pin <slug>      model to lead when mode is pinned
  --chatgpt-plan-placement <p>   lead (default) or fallback
  --chatgpt-plan-on-limit <b>    rotate (default) or stop
  --chatgpt-plan-account <key>   saved account to serve this lane (default: the active one)
  modelhitch chatgpt-plan sign-in [--account <key>] [--register] [--force-consent] [--no-open]
  modelhitch chatgpt-plan status [--json] | models | accounts | use --account <key> | sign-out
  The lane is provider id chatgpt-plan: route explicitly as chatgpt-plan/<slug>, or
  rotate/pin it with the flags above. Tokens live in
  ~/.modelhitch/chatgpt-plan.json (mode 0600), never in config.json, and never in
  an API key. Sign-in happens in your system browser through a loopback callback;
  no client secret is involved. Requests set store:false and stream:true, which
  this route requires, so temperature and maxTokens are not sent.

Setup options (with \`setup <agent>\` or \`setup zstack [agent]\`):
  modelhitch setup codex                         install to the agent user skill directory
  modelhitch setup all --project                 install project skills for all four agents
  modelhitch setup zstack                        install zstack workflow to all four agents
  modelhitch setup zstack cursor --project       install zstack in current project for Cursor
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
  // --provider: runtime-only pin, never written back to the config file.
  const pinnedProviderId = flagValue('--provider');
  const byokFlag = argsHasFlag(['--opencode-byok', '--opencode-byok-lane']) ? true : argsHasFlag(['--no-opencode-byok', '--no-opencode-byok-lane']) ? false : undefined;
  const byokModeFlag = flagValue('--opencode-byok-mode');
  const byokPin = flagValue('--opencode-byok-pin');
  const byokPinModel = flagValue('--opencode-byok-model');
  const byokSync = argsHasFlag(['--opencode-byok-sync']) ? true : argsHasFlag(['--no-opencode-byok-sync']) ? false : undefined;
  const byokConnections = openCodeByokConnectionsFromArgs();
  const byokImport = argsHasFlag(['--opencode-byok-import']);
  const customFlag = argsHasFlag(['--custom-lanes']) ? true : argsHasFlag(['--no-custom-lanes']) ? false : undefined;
  const customPlacementFlag = flagValue('--custom-lanes-placement');
  const customLaneArgs = customLanesFromArgs();
  const chatgptPlanFlag = argsHasFlag(['--chatgpt-plan']) ? true : argsHasFlag(['--no-chatgpt-plan']) ? false : undefined;
  const chatgptPlanMode = flagValue('--chatgpt-plan-mode');
  const chatgptPlanPin = flagValue('--chatgpt-plan-pin');
  const chatgptPlanPlacement = flagValue('--chatgpt-plan-placement');
  const chatgptPlanOnLimit = flagValue('--chatgpt-plan-on-limit');
  const chatgptPlanAccount = flagValue('--chatgpt-plan-account');
  const chatgptPlanModelsFlag = flagValue('--chatgpt-plan-models');
  // Reading the local OpenCode install costs a DB scan, so it stays lazy: the
  // import flag reads it now, `syncFromOpenCode` reads it when providers are
  // built, and the settings UI reads it through /v1/opencode-state on demand.
  let openCodeStateCache: OpenCodeLocalState | undefined;
  const openCodeStateLazy = (): OpenCodeLocalState => (openCodeStateCache ??= readOpenCodeLocalState());
  const openCodeState = byokImport ? openCodeStateLazy() : undefined;

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
  if (byokImport) {
    const discovered = openCodeImportConnections(openCodeStateLazy());
    if (!discovered.length) {
      console.warn('OpenCode import: no providers with models were found in the local OpenCode install.');
    } else {
      console.log(`OpenCode import: ${discovered.length} connection${discovered.length === 1 ? '' : 's'} discovered from the local install.`);
      for (const connection of discovered) {
        console.log(`  ${connection.id.padEnd(20)} ${(connection.models ?? []).join(', ') || '(no models)'}`);
      }
      console.log('  Console connection ids are not stored locally: replace each id with its real');
      console.log('  connection id (or paste the Console API URL) from https://opencode.ai/console.');
    }
    byokConnections.push(...discovered);
  }
  if (
    byokFlag !== undefined ||
    byokConnections.length > 0 ||
    byokModeFlag !== undefined ||
    byokPin !== undefined ||
    byokPinModel !== undefined ||
    byokSync !== undefined ||
    byokImport
  ) {
    const existing = config.opencodeByok;
    const connections = mergeOpenCodeByokConnections(existing?.connections ?? [], byokConnections);
    const pinnedConnectionId = byokPin ?? existing?.pinnedConnectionId;
    const pinnedModel = byokPinModel ?? existing?.pinnedModel;
    // Naming a connection is a request to use it: only an explicit
    // --no-opencode-byok (or a document that already disabled the block) keeps
    // the lane off.
    const enabled = byokFlag ?? (byokConnections.length > 0 ? true : existing?.enabled ?? connections.length > 0);
    config.opencodeByok = {
      enabled,
      mode: byokModeFlag === 'pinned' || byokModeFlag === 'rotation' ? byokModeFlag : existing?.mode ?? 'rotation',
      ...(pinnedConnectionId ? { pinnedConnectionId } : {}),
      ...(pinnedModel ? { pinnedModel } : {}),
      connections,
      syncFromOpenCode: byokSync ?? existing?.syncFromOpenCode ?? false,
    };
    if (byokModeFlag !== undefined && byokModeFlag !== 'pinned' && byokModeFlag !== 'rotation') {
      console.error(`--opencode-byok-mode must be "rotation" or "pinned" (got "${byokModeFlag}").`);
      process.exitCode = 1;
      return;
    }
  }
  if (customPlacementFlag !== undefined && customPlacementFlag !== 'lead' && customPlacementFlag !== 'fallback') {
    console.error(`--custom-lanes-placement must be "lead" or "fallback" (got "${customPlacementFlag}").`);
    process.exitCode = 1;
    return;
  }
  if (customFlag !== undefined || customPlacementFlag !== undefined || customLaneArgs.length > 0) {
    const existing = config.customLanes;
    const lanes = mergeCustomLanes(existing?.lanes ?? [], customLaneArgs);
    // Naming a lane is a request to use it: only an explicit --no-custom-lanes
    // (or a document that already disabled the block) keeps the block off.
    const enabled = customFlag ?? (customLaneArgs.length > 0 ? true : existing?.enabled ?? lanes.length > 0);
    config.customLanes = {
      enabled,
      placement: customPlacementFlag === 'lead' || customPlacementFlag === 'fallback'
        ? customPlacementFlag
        : existing?.placement ?? 'lead',
      lanes,
    };
  }
  if (
    chatgptPlanFlag !== undefined ||
    chatgptPlanMode !== undefined ||
    chatgptPlanPin !== undefined ||
    chatgptPlanPlacement !== undefined ||
    chatgptPlanOnLimit !== undefined ||
    chatgptPlanAccount !== undefined ||
    chatgptPlanModelsFlag !== undefined
  ) {
    const existing = chatGptPlanConfig(config);
    if (chatgptPlanMode !== undefined && chatgptPlanMode !== 'rotation' && chatgptPlanMode !== 'pinned') {
      console.error(`--chatgpt-plan-mode must be "rotation" or "pinned" (got "${chatgptPlanMode}").`);
      process.exitCode = 1;
      return;
    }
    if (chatgptPlanPlacement !== undefined && chatgptPlanPlacement !== 'lead' && chatgptPlanPlacement !== 'fallback') {
      console.error(`--chatgpt-plan-placement must be "lead" or "fallback" (got "${chatgptPlanPlacement}").`);
      process.exitCode = 1;
      return;
    }
    if (chatgptPlanOnLimit !== undefined && chatgptPlanOnLimit !== 'rotate' && chatgptPlanOnLimit !== 'stop') {
      console.error(`--chatgpt-plan-on-limit must be "rotate" or "stop" (got "${chatgptPlanOnLimit}").`);
      process.exitCode = 1;
      return;
    }
    // Naming a model slot is a request to use the lane, matching the
    // custom-lane rule: only an explicit --no-chatgpt-plan turns it back off.
    const enabled = chatgptPlanFlag ?? (chatgptPlanModelsFlag !== undefined ? true : existing?.enabled ?? false);
    const models = chatgptPlanModelsFlag !== undefined
      ? [...new Set(chatgptPlanModelsFlag.split(',').map((m) => m.trim()).filter(Boolean))]
      : existing?.models ?? [];
    const block: ChatGptPlanConfig = {
      enabled,
      mode: chatgptPlanMode === 'rotation' || chatgptPlanMode === 'pinned' ? chatgptPlanMode : existing?.mode ?? 'rotation',
      placement:
        chatgptPlanPlacement === 'lead' || chatgptPlanPlacement === 'fallback'
          ? chatgptPlanPlacement
          : existing?.placement ?? 'lead',
      onLimit:
        chatgptPlanOnLimit === 'rotate' || chatgptPlanOnLimit === 'stop'
          ? chatgptPlanOnLimit
          : existing?.onLimit ?? 'rotate',
      models,
    };
    if (chatgptPlanPin !== undefined) block.pinnedModel = chatgptPlanPin;
    else if (existing?.pinnedModel) block.pinnedModel = existing.pinnedModel;
    if (chatgptPlanAccount !== undefined) block.accountKey = chatgptPlanAccount;
    else if (existing?.accountKey) block.accountKey = existing.accountKey;
    config.chatgptPlan = block;
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
  if (byokImport) {
    // The import is a one-shot: persist the seeded connections so the settings
    // page can take over, then exit instead of starting a bridge.
    try {
      writeConfigFile(configPath, config);
      console.log(`Wrote ${configPath} with opencodeByok enabled.`);
      console.log('Set each connection\'s real Console id in /settings, then start the bridge.');
    } catch (err) {
      console.error(`Could not write ${configPath}: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
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
  const byokState = config.opencodeByok?.syncFromOpenCode ? openCodeStateLazy() : openCodeState;
  // Sign in with ChatGPT: the credential store is created before the provider
  // set so the lane can be built with it. It owns the token file and the
  // sign-in flow, and the server's account routes read it through a small
  // adapter below.
  const chatgptPlanAuth = new ChatGptPlanAuth({ path: defaultChatGptPlanCredentialsPath() });
  /**
   * Model slugs the lane serves.
   *
   * The config wins when it names slots. Otherwise the signed-in account is
   * asked once at startup, because ChatGPT plan catalogs are account-specific
   * and a guessed slug would be a lane that 404s.
   */
  let chatgptPlanAccountModels: string[] = [];
  const refreshChatGptPlanAccountModels = async (): Promise<string[]> => {
    if (chatGptPlanConfig(config)?.models?.length) {
      chatgptPlanAccountModels = [];
      return chatgptPlanAccountModels;
    }
    chatgptPlanAccountModels = await listChatGptPlanAccountModels({ tokens: chatgptPlanAuth });
    return chatgptPlanAccountModels;
  };
  if (config.chatgptPlan?.enabled) await refreshChatGptPlanAccountModels();

  const chatgptPlanContext = () => ({
    chatgptPlanTokens: chatgptPlanAuth,
    chatgptPlanAccountModels,
  });
  // Every bridgeProviders call gets the durable cloud-agent store, so the
  // restart-safe mapping is never missing at one call site and present at
  // another (which would make reuse depend on which route built the providers).
  const cloudAgentContext = () => ({ cloudAgentSessionStore });
  const providers = bridgeProviders(baseProviders, config, cloudSessionStore, {
    openCodeState: byokState,
    ...chatgptPlanContext(),
    ...cloudAgentContext(),
  });
  await validateCloudAgentKey(config);

  /**
   * Compose the routing plan from the current config and runtime state.
   *
   * Three blocks layer in a fixed order, each one merging on top of the last:
   *
   *   OpenCode BYOK   rotation puts every connection × model at the front and
   *                   pinned keeps one connection primary; either way the
   *                   configured policy sits directly behind as the fallback.
   *   custom lanes    `lead` puts them in front of everything (adding a lane is
   *                   a request to route to it), `fallback` appends them behind
   *                   the buffet as a last resort.
   *   ChatGPT plan    same two choices, merged last so `lead` makes the plan
   *                   the primary route with the whole stack behind it.
   *
   * One function because three call sites need the identical result: startup,
   * a settings Apply, and a ChatGPT sign-in or account switch.
   */
  const composePlan = (state: OpenCodeLocalState | undefined) => {
    const byokPlan = applyOpenCodeByokPlan({
      config,
      policy: policyFromConfig(config),
      defaultProviderId: config.defaultProviderId,
      defaultModel: config.defaultModel,
      state,
    });
    const customPlan = applyCustomLanesPlan({
      config,
      policy: byokPlan.policy,
      defaultProviderId: byokPlan.defaultProviderId,
      defaultModel: byokPlan.defaultModel,
    });
    const chatgptPlan = applyChatGptPlanPlan({
      config,
      policy: customPlan.policy,
      defaultProviderId: customPlan.defaultProviderId,
      defaultModel: customPlan.defaultModel,
      accountModels: chatgptPlanAccountModels,
    });
    return { byokPlan, customPlan, chatgptPlan };
  };

  const { byokPlan, customPlan, chatgptPlan } = composePlan(byokState);
  // `--provider <id>` pins routing for the life of this process only.
  if (pinnedProviderId && !providers.some((p) => p.id === pinnedProviderId)) {
    console.error(
      `Unknown --provider "${pinnedProviderId}". Available: ${providers.map((p) => p.id).sort().join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const server = createModelHitchServer({
    providers,
    defaultProviderId: pinnedProviderId ?? chatgptPlan.defaultProviderId ?? config.defaultProviderId ?? 'vercel-ai-gateway',
    defaultModel: pinnedProviderId ? config.defaultModel : chatgptPlan.defaultModel ?? config.defaultModel,
    pinnedProviderId,
    openCodeState: () => openCodeStateLazy(),
    // The account panel and sign-in flow for the ChatGPT plan lane. Sign-in
    // finishes on its own loopback listener, so the page polls status rather
    // than waiting on a request here.
    chatGptPlan: {
      status: () => chatgptPlanAuth.status(),
      beginSignIn: (options) => chatgptPlanAuth.beginSignIn(options),
      signInAttempt: (attemptId) => chatgptPlanAuth.signInAttempt(attemptId),
      cancelSignIn: (attemptId) => chatgptPlanAuth.cancelSignIn(attemptId),
      signOut: (options) => chatgptPlanAuth.signOut(options),
      activate: (accountKey) => chatgptPlanAuth.activate(accountKey),
      // Deliberately independent of `enabled`: the settings page loads the
      // account's catalog before the user turns the lane on.
      listModels: async () => {
        const probe = createChatGptPlanProvider({ tokens: chatgptPlanAuth });
        return probe.listModels ? probe.listModels({}) : [];
      },
    },
    imageGeneration: config.imageGeneration,
    cloudAgent: config.cloudAgent,
    localAgent: config.localAgent,
    cloudAgentSessionStore,
    maxBodyBytes,
    policy: chatgptPlan.policy,
    cooldown,
    catalogSource,
    keystore,
    // Keys from the config file / env are available from the very first request —
    // no Apply needed for keys already stored locally.
    apiKeys: { ...config.keys, ...openCodeByokApiKeys(config, { state: byokState }), ...customLaneApiKeys(config) },
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
        for (const k of ['catalog', 'defaultProviderId', 'defaultModel', 'defaultWorkspaceTarget', 'cooldown', 'imageGeneration', 'cloudAgent', 'opencodeByok', 'customLanes', 'chatgptPlan'] as const) {
          delete (config as unknown as Record<string, unknown>)[k];
        }
        Object.assign(config, asConfig);
        config.keys = keysFromEnv(config.keys ?? {});
        try {
          const nextCatalog = buildCatalogOptions(config);
          const wantsCatalog = config.catalog !== undefined;
          // A settings Apply is the moment a BYOK connection or its models can
          // change, so re-read the OpenCode install when the block asks for it.
          const state = config.opencodeByok?.syncFromOpenCode ? readOpenCodeLocalState() : undefined;
          openCodeStateCache = state;
          // The ChatGPT plan block may have just been scoped to new model
          // slots, or turned on for an account that is already signed in.
          await refreshChatGptPlanAccountModels();
          const applyProviders = (base: Provider[]) =>
            bridgeProviders(base, config, cloudSessionStore, {
              openCodeState: state,
              ...chatgptPlanContext(),
              ...cloudAgentContext(),
            });
          const plan = composePlan(state);
          const routeDefaults = {
            defaultProviderId: pinnedProviderId ?? plan.chatgptPlan.defaultProviderId ?? config.defaultProviderId,
            defaultModel: pinnedProviderId ? config.defaultModel : plan.chatgptPlan.defaultModel ?? config.defaultModel,
            pinnedProviderId,
            openCodeState: () => openCodeStateLazy(),
            policy: plan.chatgptPlan.policy,
            apiKeys: { ...config.keys, ...openCodeByokApiKeys(config, { state }), ...customLaneApiKeys(config) },
          };
          if (wantsCatalog && !catalogSource) {
            const src = createCatalogSource({ ...nextCatalog, registry: defaultProviders });
            await src.warm();
            catalogSource = src;
            baseProviders = src.providers();
            server.reconfigure({
              providers: applyProviders(baseProviders),
              cooldown: buildCooldownFromConfig(config) ?? (catalogSource ? new CircuitBreaker() : undefined),
              catalogSource: src,
              imageGeneration: config.imageGeneration,
              cloudAgent: config.cloudAgent,
              localAgent: config.localAgent,
              cloudAgentSessionStore,
              ...routeDefaults,
            });
          } else if (!wantsCatalog && catalogSource) {
            // Catalog mode switched off — fall back to the built-in registry.
            catalogSource = undefined;
            baseProviders = defaultProviders;
            server.reconfigure({
              providers: applyProviders(baseProviders),
              cooldown: buildCooldownFromConfig(config),
              catalogSource: undefined,
              imageGeneration: config.imageGeneration,
              cloudAgent: config.cloudAgent,
              localAgent: config.localAgent,
              cloudAgentSessionStore,
              ...routeDefaults,
            });
          } else {
            const base = catalogSource ? catalogSource.providers() : baseProviders;
            server.reconfigure({
              providers: applyProviders(base),
              cooldown: buildCooldownFromConfig(config) ?? (catalogSource ? new CircuitBreaker() : undefined),
              baseUrls: config.catalog?.baseUrls,
              imageGeneration: config.imageGeneration,
              cloudAgent: config.cloudAgent,
              localAgent: config.localAgent,
              cloudAgentSessionStore,
              ...routeDefaults,
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

  /**
   * Re-plan and push to the running server.
   *
   * Signing in, signing out, or switching accounts changes which model slugs
   * the lane serves, so the provider set and the routing plan both have to be
   * rebuilt. Without this the lane would only appear after a restart, and the
   * settings page would show a signed-in account that serves nothing.
   */
  const applyChatGptPlanChange = async (): Promise<void> => {
    await refreshChatGptPlanAccountModels();
    const state = openCodeStateCache;
    const plan = composePlan(state);
    server.reconfigure({
      providers: bridgeProviders(catalogSource ? catalogSource.providers() : baseProviders, config, cloudSessionStore, {
        openCodeState: state,
        ...chatgptPlanContext(),
        ...cloudAgentContext(),
      }),
      policy: plan.chatgptPlan.policy,
      defaultProviderId: pinnedProviderId ?? plan.chatgptPlan.defaultProviderId ?? config.defaultProviderId,
      defaultModel: pinnedProviderId ? config.defaultModel : plan.chatgptPlan.defaultModel ?? config.defaultModel,
    });
    const summary = describeChatGptPlan(plan.chatgptPlan);
    if (summary) console.log(`[chatgpt-plan] ${summary}`);
  };
  chatgptPlanAuth.onAccountChange(() => {
    void applyChatGptPlanChange().catch((err: unknown) => {
      console.error(`[chatgpt-plan] Could not apply the account change: ${(err as Error).message}`);
    });
  });

  const { url } = await server.listen(port, host);
  const byokSummary = describeOpenCodeByokPlan(byokPlan, config);
  const customSummary = describeCustomLanesPlan(customPlan);
  const chatgptPlanSummary = describeChatGptPlan(chatgptPlan);
  console.log(`\nModelHitch bridge v${VERSION} listening on ${url}
${pinnedProviderId ? `\nPinned to provider: ${pinnedProviderId} (--provider; other providers are used only when it is depleted or erroring)\n` : ''}${byokSummary ? `\n${byokSummary}\n` : ''}${customSummary ? `\n${customSummary}\n` : ''}${chatgptPlanSummary ? `\n${chatgptPlanSummary}\n` : ''}${chatgptPlanAuth.status().signedIn ? '' : chatGptPlanConfig(config)?.enabled ? `\nSign in to your ChatGPT account to serve this lane: open ${url}/settings (or run \`modelhitch chatgpt-plan sign-in\`).\n` : ''}
Point any OpenAI-compatible client (Android Studio Agent Mode, JetBrains AI,
Cursor, Codex CLI, Claude Code, Gemini CLI, ...) at:

  Base URL:   ${url}/v1
  API key:    any value (keys are resolved locally, never sent out)

Settings (local — no env digging):
  ${configPath}
  open ${url}/settings in a browser
${pinnedProviderId ? '\nRestart this bridge without --provider to go back to the configured rotation.\n' : ''}
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
  let pinned: string | undefined;
  try {
    const res = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(1200) });
    health = res.ok ? `yes — responding on http://${host}:${port}` : 'no';
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { pinnedProviderId?: string };
      pinned = body.pinnedProviderId;
    }
  } catch {
    /* not responding */
  }
  console.log('modelhitch status: running');
  console.log(`  pid:      ${status.pid}`);
  console.log(`  healthz:  ${health}`);
  if (pinned) console.log(`  provider: pinned to ${pinned} (started with --provider)`);
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
  let pkg: 'modelhitch' | 'zstack' = 'modelhitch';
  let targetArg: string | undefined = args[0];
  let remainingArgs = args.slice(1);

  if (targetArg === 'zstack') {
    pkg = 'zstack';
    const next = remainingArgs[0];
    if (next && SETUP_TARGETS.includes(next as SetupTarget)) {
      targetArg = next;
      remainingArgs = remainingArgs.slice(1);
    } else {
      targetArg = 'all';
    }
  }

  if (!targetArg || !SETUP_TARGETS.includes(targetArg as SetupTarget)) {
    throw new Error('Choose an agent: codex, claude, cursor, vscode, all (or run: modelhitch setup zstack [agent]).');
  }
  const known = new Set(['--project', '--dry-run', '--force']);
  const unknown = remainingArgs.filter((arg) => !known.has(arg));
  if (unknown.length > 0) throw new Error(`Unknown setup option: ${unknown[0]}`);

  const dryRun = remainingArgs.includes('--dry-run');
  const installed = installSkills({
    target: targetArg as SetupTarget,
    package: pkg,
    scope: remainingArgs.includes('--project') ? 'project' : 'user',
    force: remainingArgs.includes('--force'),
    dryRun,
  });
  const label = pkg === 'zstack' ? 'zstack' : 'ModelHitch';
  console.log(dryRun ? `${label} would install:` : `${label} skills installed:`);
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

/**
 * `modelhitch chatgpt-plan …` — the Sign in with ChatGPT account surface from
 * a terminal, for the same credential file the bridge and /settings use.
 *
 * The bridge is not required: sign in here, then start (or restart) the bridge
 * and the lane serves against the saved account.
 */
async function runChatGptPlanCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';
  const auth = new ChatGptPlanAuth({ path: defaultChatGptPlanCredentialsPath() });

  if (sub === 'status') {
    const status = auth.status();
    if (args.includes('--json')) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(`Credentials: ${status.credentialsPath}`);
    console.log(`Host id:     ${status.hostId}`);
    if (!status.signedIn) {
      console.log('\nNo ChatGPT account is signed in.');
      console.log('Sign in with: modelhitch chatgpt-plan sign-in');
      return;
    }
    for (const account of status.accounts) {
      const marker = account.active ? '*' : ' ';
      const plan = account.planUsage ? 'plan usage enabled' : 'plan usage NOT granted';
      const expiry = account.expiresAt ? `access token expires ${account.expiresAt}` : 'no expiry recorded';
      console.log(`${marker} ${account.label} — ${plan} — ${expiry}`);
      console.log(`    ${describeChatGptPlanAccount(auth.accounts().find((a) => a.key === account.key)!)}`);
    }
    console.log(`\nManage plan and per-app limits: ${CHATGPT_PLAN_USAGE_SETTINGS_URL}`);
    return;
  }

  if (sub === 'sign-in') {
    const accountKey = flagValue('--account');
    const registration = argsHasFlag(['--register']);
    const forceConsent = argsHasFlag(['--force-consent']);
    const noOpen = argsHasFlag(['--no-open']);
    try {
      const attempt = await auth.beginSignIn({
        ...(accountKey ? { accountKey } : {}),
        ...(registration ? { registration: true } : {}),
        ...(forceConsent ? { forceConsent: true } : {}),
        open: !noOpen,
      });
      console.log(`${noOpen ? 'Open this URL to sign in with ChatGPT:' : 'Opened your browser to sign in with ChatGPT.'}`);
      console.log(`\n  ${attempt.authUrl}\n`);
      console.log('Waiting for the browser to come back… (Ctrl+C to cancel)');
      const account = await auth.waitForSignIn(attempt.attemptId);
      console.log(`\nSigned in as ${account.label}.`);
      if (!account.planUsage) {
        console.log(
          'ChatGPT plan usage was NOT granted, so this lane cannot spend the plan yet.\n' +
            `Re-request it with: modelhitch chatgpt-plan sign-in --force-consent\n` +
            `Or enable it in ChatGPT settings: ${CHATGPT_PLAN_USAGE_SETTINGS_URL}`,
        );
        return;
      }
      console.log('Eligible requests can now use your ChatGPT plan.');
    } catch (err) {
      console.error(`Sign-in failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === 'models') {
    const models = await listChatGptPlanAccountModels({ tokens: auth });
    if (!models.length) {
      console.error(
        'No models were returned. Sign in first (modelhitch chatgpt-plan sign-in), or the account catalogue could not be read.',
      );
      process.exitCode = 1;
      return;
    }
    for (const model of models) console.log(model);
    console.log(`\nUse them as chatgpt-plan/<slug>. Add slots to the lane with:`);
    console.log(`  modelhitch bridge --chatgpt-plan --chatgpt-plan-models ${models.slice(0, 3).join(',')}`);
    return;
  }

  if (sub === 'accounts') {
    const accounts = auth.status().accounts;
    if (!accounts.length) {
      console.log('No saved ChatGPT accounts.');
      return;
    }
    for (const account of accounts) {
      console.log(`${account.active ? '*' : ' '} ${account.label}`);
      console.log(`    key: ${account.key}`);
    }
    return;
  }

  if (sub === 'use') {
    const accountKey = flagValue('--account') ?? args[1];
    if (!accountKey) {
      console.error('Usage: modelhitch chatgpt-plan use --account <accountKey>');
      process.exitCode = 1;
      return;
    }
    try {
      auth.activate(accountKey);
      console.log(`Active ChatGPT account: ${auth.describeAccount()}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
    return;
  }

  if (sub === 'sign-out') {
    const accountKey = flagValue('--account');
    try {
      const result = await auth.signOut({
        ...(accountKey ? { accountKey } : {}),
        ...(argsHasFlag(['--no-revoke']) ? { revoke: false } : {}),
      });
      console.log(
        result.revoked
          ? 'Signed out and revoked the renewable session.'
          : 'Signed out locally. Remote revocation was skipped or not confirmed.',
      );
      for (const warning of result.warnings) console.warn(`  ! ${warning}`);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
    return;
  }

  console.error(`Unknown chatgpt-plan subcommand: ${sub}`);
  console.error('  status | sign-in | models | accounts | use | sign-out');
  process.exitCode = 1;
}

/** Logo is for interactive help; keep background/status/stop output script-friendly. */
function shouldPrintLogo(args: string[]): boolean {
  const [cmd] = args;
  if (cmd === 'settings' || cmd === 'status' || cmd === 'stop') return false;
  if (cmd === 'chatgpt-plan') return false;
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
    case 'chatgpt-plan':
      await runChatGptPlanCommand(args.slice(1));
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
