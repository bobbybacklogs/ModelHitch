/**
 * Resolve credentials for Vercel AI Gateway with seamless local DX.
 *
 * Precedence (see `resolveVercelGatewayCredential`):
 * 1. Explicit API key (request / keystore / config)
 * 2. `AI_GATEWAY_API_KEY`
 * 3. `VERCEL_OIDC_TOKEN` (from `vercel env pull` or Vercel-hosted OIDC)
 * 4. `VERCEL_TOKEN`
 * 5. Token from the local Vercel CLI `auth.json` (after `vercel login`)
 *
 * Intentionally avoids static `node:` imports so the browser entry graph stays
 * free of Node built-ins. CLI auth uses `process.getBuiltinModule` when available
 * (Node 22+); older Node runtimes still resolve env / OIDC credentials.
 */

const APP_DIR = 'com.vercel.cli';
const AUTH_FILE = 'auth.json';

export type VercelCredentialSource =
  | 'explicit'
  | 'AI_GATEWAY_API_KEY'
  | 'VERCEL_OIDC_TOKEN'
  | 'VERCEL_TOKEN'
  | 'vercel-cli';

export interface ResolvedVercelCredential {
  apiKey?: string;
  source?: VercelCredentialSource;
}

/** Guidance shown when no gateway credential can be resolved. */
export const VERCEL_GATEWAY_MISSING_KEY_HINT =
  'Set AI_GATEWAY_API_KEY (https://vercel.com/ai-gateway), run `vercel login` (CLI auth is used automatically on Node 22+), or `vercel env pull` for VERCEL_OIDC_TOKEN.';

interface NodeBuiltins {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, encoding: string) => string;
  join: (...parts: string[]) => string;
  homedir: () => string;
}

function loadNodeBuiltins(): NodeBuiltins | undefined {
  if (typeof process === 'undefined' || !process.versions?.node) return undefined;
  const getBuiltin = (
    process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  if (typeof getBuiltin !== 'function') return undefined;
  try {
    const fs = getBuiltin('fs') as { existsSync: NodeBuiltins['existsSync']; readFileSync: NodeBuiltins['readFileSync'] };
    const path = getBuiltin('path') as { join: NodeBuiltins['join'] };
    const os = getBuiltin('os') as { homedir: NodeBuiltins['homedir'] };
    if (!fs?.existsSync || !path?.join || !os?.homedir) return undefined;
    return {
      existsSync: fs.existsSync.bind(fs),
      readFileSync: fs.readFileSync.bind(fs),
      join: path.join.bind(path),
      homedir: os.homedir.bind(os),
    };
  } catch {
    return undefined;
  }
}

/** Candidate paths for Vercel CLI auth.json across platforms and CLI versions. */
export function vercelCliAuthPaths(node: NodeBuiltins = loadNodeBuiltins()!): string[] {
  if (!node) return [];
  const home = node.homedir();
  const paths: string[] = [];

  const push = (dir: string) => {
    paths.push(node.join(dir, AUTH_FILE));
    paths.push(node.join(dir, 'Data', AUTH_FILE));
  };

  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) push(node.join(xdg, APP_DIR));

  push(node.join(home, '.local', 'share', APP_DIR));
  push(node.join(home, 'Library', 'Application Support', APP_DIR));

  const appData = process.env.APPDATA;
  if (appData) {
    push(node.join(appData, APP_DIR));
    push(node.join(appData, 'Roaming', 'xdg.data', APP_DIR));
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) push(node.join(localAppData, APP_DIR));

  paths.push(node.join(home, '.now', AUTH_FILE));

  return [...new Set(paths)];
}

/** Read the Vercel CLI access token from disk, if present. Never throws. */
export function readVercelCliAuthToken(): string | undefined {
  if (typeof process === 'undefined') return undefined;
  if (process.env.MODELHITCH_SKIP_VERCEL_CLI_AUTH === '1') return undefined;
  const node = loadNodeBuiltins();
  if (!node) return undefined;

  for (const path of vercelCliAuthPaths(node)) {
    if (!node.existsSync(path)) continue;
    try {
      const parsed = JSON.parse(node.readFileSync(path, 'utf8')) as { token?: unknown };
      if (typeof parsed.token === 'string' && parsed.token.trim()) {
        return parsed.token.trim();
      }
    } catch {
      // Unreadable or invalid JSON — try the next candidate.
    }
  }
  return undefined;
}

/**
 * Resolve a bearer credential for AI Gateway inference.
 * Pass `explicit` for request/keystore/config keys (highest priority).
 */
export function resolveVercelGatewayCredential(explicit?: string): ResolvedVercelCredential {
  if (explicit?.trim()) {
    return { apiKey: explicit.trim(), source: 'explicit' };
  }

  const env = typeof process !== 'undefined' ? process.env : undefined;
  if (env?.AI_GATEWAY_API_KEY?.trim()) {
    return { apiKey: env.AI_GATEWAY_API_KEY.trim(), source: 'AI_GATEWAY_API_KEY' };
  }
  if (env?.VERCEL_OIDC_TOKEN?.trim()) {
    return { apiKey: env.VERCEL_OIDC_TOKEN.trim(), source: 'VERCEL_OIDC_TOKEN' };
  }
  if (env?.VERCEL_TOKEN?.trim()) {
    return { apiKey: env.VERCEL_TOKEN.trim(), source: 'VERCEL_TOKEN' };
  }

  const cliToken = readVercelCliAuthToken();
  if (cliToken) {
    return { apiKey: cliToken, source: 'vercel-cli' };
  }

  return {};
}
