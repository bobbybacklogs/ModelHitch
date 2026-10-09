import { spawn } from 'node:child_process';
import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import {
  CHATGPT_PLAN_AGENT_NAME,
  CHATGPT_PLAN_AUTHORIZE_ENDPOINT,
  CHATGPT_PLAN_CALLBACK_HOST,
  CHATGPT_PLAN_CALLBACK_PATH,
  CHATGPT_PLAN_DEFAULT_CALLBACK_PORT,
  CHATGPT_PLAN_DISCOVERY_URL,
  CHATGPT_PLAN_DYNAMIC_CLIENT_ID,
  CHATGPT_PLAN_ERRORS_URL,
  CHATGPT_PLAN_HOST_ID_PREFIX,
  CHATGPT_PLAN_ISSUER,
  CHATGPT_PLAN_REFRESH_TOKEN_LIFETIME_MS,
  CHATGPT_PLAN_RESOURCE,
  CHATGPT_PLAN_REVOCATION_ENDPOINT,
  CHATGPT_PLAN_SCOPES,
  CHATGPT_PLAN_SIGN_IN_TIMEOUT_MS,
  CHATGPT_PLAN_TOKEN_ENDPOINT,
  CHATGPT_PLAN_USAGE_SETTINGS_URL,
  type ChatGptPlanAccount,
  type ChatGptPlanAccountStatus,
  type ChatGptPlanCredentials,
  type ChatGptPlanSignInAttempt,
  type ChatGptPlanSignInStatus,
  type ChatGptPlanStatus,
  type ChatGptPlanToken,
  type ChatGptPlanTokenSource,
  chatGptPlanAccountKey,
  chatGptPlanAccountLabel,
  hasChatGptPlanScope,
  isTokenExpired,
  parseScopeValue,
  redactToken,
} from './chatgpt-plan.js';
import { modelhitchHome } from './config-file.js';
import { ModelHitchError } from './core/errors.js';

/**
 * Node-only half of the Sign in with ChatGPT lane: the OAuth authorization-code
 * flow with PKCE and dynamic client registration, the loopback callback
 * listener, ID-token validation against the publisher's JWKS, and the protected
 * local credential file.
 *
 * Everything here uses `node:` built-ins, so this module is deliberately absent
 * from `browser.ts`. The browser entry only sees the lane's plan functions and
 * the `ChatGptPlanTokenSource` interface.
 *
 * Spec: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 */

// ---------------------------------------------------------------------------
// Paths and stored record shape
// ---------------------------------------------------------------------------

/** Credential file path. Sits beside `config.json` in the ModelHitch home. */
export function defaultChatGptPlanCredentialsPath(): string {
  return join(modelhitchHome(), 'chatgpt-plan.json');
}

/**
 * The credential record exactly as the OpenAI docs describe it, plus the few
 * fields ModelHitch needs to pick between saved accounts.
 *
 * Field names are the documented snake_case on purpose: a user can hold this
 * file next to the spec's example and see the same keys.
 */
interface StoredAccount {
  email?: string;
  issuer: string;
  subject: string;
  client_id: string;
  ext_agent_host_id: string;
  id_token?: string;
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scopes: string[];
  saved_at: string;
  /** App-defined below this line. */
  label?: string;
  expires_at?: string;
  earliest_refresh_at?: string;
  plan_usage?: boolean;
}

interface StoredCredentialsFile {
  version: 1;
  ext_agent_host_id: string;
  active_account?: string;
  accounts: StoredAccount[];
}

function toStoredAccount(account: ChatGptPlanAccount): StoredAccount {
  return {
    ...(account.email ? { email: account.email } : {}),
    issuer: account.issuer,
    subject: account.subject,
    client_id: account.clientId,
    ext_agent_host_id: account.hostId,
    ...(account.idToken ? { id_token: account.idToken } : {}),
    access_token: account.accessToken,
    ...(account.refreshToken ? { refresh_token: account.refreshToken } : {}),
    token_type: account.tokenType,
    ...(account.expiresIn !== undefined ? { expires_in: account.expiresIn } : {}),
    scopes: account.scopes,
    saved_at: account.savedAt,
    label: account.label,
    ...(account.expiresAt ? { expires_at: account.expiresAt } : {}),
    ...(account.earliestRefreshAt ? { earliest_refresh_at: account.earliestRefreshAt } : {}),
    plan_usage: account.planUsage,
  };
}

function fromStoredAccount(stored: StoredAccount): ChatGptPlanAccount {
  const scopes = Array.isArray(stored.scopes) ? stored.scopes : [];
  return {
    key: chatGptPlanAccountKey(stored.subject, stored.client_id),
    label: stored.label?.trim() || chatGptPlanAccountLabel({ email: stored.email, subject: stored.subject }),
    ...(stored.email ? { email: stored.email } : {}),
    issuer: stored.issuer,
    subject: stored.subject,
    clientId: stored.client_id,
    hostId: stored.ext_agent_host_id,
    ...(stored.id_token ? { idToken: stored.id_token } : {}),
    accessToken: stored.access_token,
    ...(stored.refresh_token ? { refreshToken: stored.refresh_token } : {}),
    tokenType: stored.token_type,
    ...(stored.expires_in !== undefined ? { expiresIn: stored.expires_in } : {}),
    scopes,
    savedAt: stored.saved_at,
    ...(stored.expires_at ? { expiresAt: stored.expires_at } : {}),
    ...(stored.earliest_refresh_at ? { earliestRefreshAt: stored.earliest_refresh_at } : {}),
    planUsage: stored.plan_usage ?? hasChatGptPlanScope(scopes),
  };
}

/**
 * Read the credential file. A missing file is an empty store; a corrupt file is
 * an error rather than a silent wipe, because the tokens in it may be the only
 * copy of a 30-day refresh token.
 */
export function readChatGptPlanCredentials(path: string): ChatGptPlanCredentials | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Failed to read ChatGPT plan credentials at ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `ChatGPT plan credentials at ${path} are not valid JSON. Move the file aside and sign in again.`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ChatGPT plan credentials at ${path} must be a JSON object.`);
  }
  const file = parsed as Partial<StoredCredentialsFile>;
  const accounts = Array.isArray(file.accounts) ? file.accounts.filter((a): a is StoredAccount => !!a && typeof a === 'object') : [];
  return {
    version: 1,
    hostId: typeof file.ext_agent_host_id === 'string' ? file.ext_agent_host_id : '',
    ...(typeof file.active_account === 'string' ? { activeAccountKey: file.active_account } : {}),
    accounts: accounts.map(fromStoredAccount),
  };
}

/**
 * Write the credential file: owner-only where the platform supports it, and
 * atomically so a crash cannot leave a half-written token file behind.
 */
export function writeChatGptPlanCredentials(path: string, credentials: ChatGptPlanCredentials): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const document: StoredCredentialsFile = {
    version: 1,
    ext_agent_host_id: credentials.hostId,
    ...(credentials.activeAccountKey ? { active_account: credentials.activeAccountKey } : {}),
    accounts: credentials.accounts.map(toStoredAccount),
  };
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    // 0600 is the documented expectation. Windows ignores the mode, so this is
    // best-effort there and exact on Unix.
    chmodSync(temp, 0o600);
  } catch {
    // Platform does not support POSIX modes — the atomic rename still matters.
  }
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Same as above.
  }
}

// ---------------------------------------------------------------------------
// PKCE, state, nonce, host id
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A fresh PKCE verifier and its S256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** `BASE64URL(SHA256(verifier))` with the padding stripped. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** A fresh opaque value for `state` or `nonce`. */
export function createRandomValue(): string {
  return randomBytes(32).toString('base64url');
}

/** A new host id in the supported `urn:uuid:` form. */
export function createHostId(): string {
  return `${CHATGPT_PLAN_HOST_ID_PREFIX}${randomUUID()}`;
}

/** True when the value looks like one of the host-id forms the spec accepts. */
export function isValidHostId(value: string | undefined): boolean {
  if (!value) return false;
  return (
    value.startsWith('urn:ietf:params:oauth:jwk-thumbprint:') ||
    value.startsWith(CHATGPT_PLAN_HOST_ID_PREFIX) ||
    value.startsWith('did:key:')
  );
}

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------

export interface BuildAuthorizeUrlInput {
  /** Issued client id, or `dynamic_agent_client` for a first registration. */
  clientId: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  /**
   * Included only on initial dynamic registration. The user may edit it; it is
   * display metadata, never identity.
   */
  agentNameHint?: string;
  /** Retained ID token for a returning account. Skips the account selector. */
  idTokenHint?: string;
  /** Saved email for a returning account. Pre-selects the account. */
  loginHint?: string;
  /** `prompt=consent` re-asks for the scope set. Never used on ordinary sign-in. */
  forceConsent?: boolean;
  endpoint?: string;
  scope?: readonly string[];
}

/**
 * Build the authorization URL.
 *
 * Every value is URL-encoded, and `ext_agent_host_id` travels on both the
 * registration and the reauthorization request so plan usage stays associated
 * with this host rather than with the issued client id alone.
 */
export function buildChatGptPlanAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(input.endpoint ?? CHATGPT_PLAN_AUTHORIZE_ENDPOINT);
  const params = url.searchParams;
  params.set('client_id', input.clientId);
  params.set('response_type', 'code');
  params.set('redirect_uri', input.redirectUri);
  params.set('scope', (input.scope ?? CHATGPT_PLAN_SCOPES).join(' '));
  params.set('resource', CHATGPT_PLAN_RESOURCE);
  params.set('state', input.state);
  params.set('nonce', input.nonce);
  params.set('code_challenge_method', 'S256');
  params.set('code_challenge', input.codeChallenge);
  params.set('ext_agent_host_id', input.hostId);
  if (input.clientId === CHATGPT_PLAN_DYNAMIC_CLIENT_ID) {
    params.set('agent_name_hint', input.agentNameHint ?? CHATGPT_PLAN_AGENT_NAME);
  }
  if (input.idTokenHint) params.set('id_token_hint', input.idTokenHint);
  if (input.loginHint) params.set('login_hint', input.loginHint);
  if (input.forceConsent) params.set('prompt', 'consent');
  return url.toString();
}

/**
 * Redact a URL that may carry an `id_token_hint`, for logs and diagnostics.
 * The spec calls this out explicitly: the hint must never be logged.
 */
export function redactAuthorizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.searchParams.has('id_token_hint')) url.searchParams.set('id_token_hint', '«redacted»');
    if (url.searchParams.has('login_hint')) url.searchParams.set('login_hint', '«redacted»');
    return url.toString();
  } catch {
    return '«unparseable authorize url»';
  }
}

// ---------------------------------------------------------------------------
// ID token validation
// ---------------------------------------------------------------------------

interface Jwk extends Record<string, unknown> {
  kid?: string;
  kty?: string;
}

export interface ValidateIdTokenInput {
  idToken: string;
  /** Expected audience: the issued client id for this attempt. */
  clientId: string;
  /** The nonce generated for this attempt. */
  nonce: string;
  issuer?: string;
  jwks?: { keys: Jwk[] };
  now?: number;
  /** Clock skew allowance in ms. Default 60s. */
  skewMs?: number;
}

export interface ValidatedIdToken {
  subject: string;
  email?: string;
  claims: Record<string, unknown>;
}

/** Decode a JWT segment as JSON without verifying it. */
function decodeJwtSegment(segment: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object') throw new Error('segment is not an object');
  return parsed as Record<string, unknown>;
}

/** True when the JWT uses an RSA signature algorithm this module can verify. */
function isRsaAlg(alg: unknown): alg is 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' {
  return alg === 'RS256' || alg === 'RS384' || alg === 'RS512' || alg === 'PS256' || alg === 'PS384' || alg === 'PS512';
}

/**
 * Verify an ID token against the publisher's JWKS and check its claims.
 *
 * The spec requires all five checks: signature, issuer, audience, expiry, and
 * the nonce saved for this attempt. A token that fails any of them is rejected
 * outright — the validated `sub` is what identifies the account, and guessing
 * past a failed check would let one registration overwrite another's
 * credentials.
 */
export function validateChatGptPlanIdToken(input: ValidateIdTokenInput): ValidatedIdToken {
  const parts = input.idToken.split('.');
  if (parts.length !== 3) {
    throw new ModelHitchError('invalid-api-key', 'The ID token from ChatGPT is not a well-formed JWT.', {
      providerId: 'chatgpt-plan',
    });
  }
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJwtSegment(headerSegment);
    claims = decodeJwtSegment(payloadSegment);
  } catch {
    throw new ModelHitchError('invalid-api-key', 'The ID token from ChatGPT could not be decoded.', {
      providerId: 'chatgpt-plan',
    });
  }

  if (!isRsaAlg(header.alg)) {
    throw new ModelHitchError(
      'invalid-api-key',
      `The ID token from ChatGPT uses an unsupported signing algorithm ("${String(header.alg)}").`,
      { providerId: 'chatgpt-plan' },
    );
  }

  const keys = input.jwks?.keys ?? [];
  if (!keys.length) {
    throw new ModelHitchError('invalid-api-key', 'No signing keys were available to validate the ID token.', {
      providerId: 'chatgpt-plan',
    });
  }

  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const candidates = kid ? keys.filter((key) => key.kid === kid) : keys;
  if (!candidates.length) {
    throw new ModelHitchError(
      'invalid-api-key',
      `No published signing key matches the ID token's key id (${kid ?? 'none'}).`,
      { providerId: 'chatgpt-plan' },
    );
  }

  const signed = Buffer.from(`${headerSegment}.${payloadSegment}`, 'utf8');
  const signature = Buffer.from(signatureSegment, 'base64url');
  let verified = false;
  for (const jwk of candidates) {
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' });
      const algorithm = header.alg === 'PS256' || header.alg === 'PS384' || header.alg === 'PS512' ? 'RSA-SHA256' : 'RSA-SHA256';
      if (verifySignature(algorithm, signed, key, signature)) {
        verified = true;
        break;
      }
    } catch {
      // A key this runtime cannot import is skipped; another may verify.
    }
  }
  if (!verified) {
    throw new ModelHitchError('invalid-api-key', 'The ID token signature did not verify against the published JWKS.', {
      providerId: 'chatgpt-plan',
    });
  }

  const issuer = input.issuer ?? CHATGPT_PLAN_ISSUER;
  if (claims.iss !== issuer) {
    throw new ModelHitchError('invalid-api-key', `The ID token issuer ("${String(claims.iss)}") is not "${issuer}".`, {
      providerId: 'chatgpt-plan',
    });
  }

  // `aud` is a string or an array of strings; the issued client id must be in it.
  const audience = claims.aud;
  const audienceList = Array.isArray(audience) ? audience : [audience];
  if (!audienceList.includes(input.clientId)) {
    throw new ModelHitchError(
      'invalid-api-key',
      'The ID token audience does not match the client id issued for this registration.',
      { providerId: 'chatgpt-plan' },
    );
  }

  const now = input.now ?? Date.now();
  const skew = input.skewMs ?? 60_000;
  const nowSeconds = Math.floor(now / 1000);
  const exp = typeof claims.exp === 'number' ? claims.exp : undefined;
  if (exp === undefined) {
    throw new ModelHitchError('invalid-api-key', 'The ID token has no expiry claim.', { providerId: 'chatgpt-plan' });
  }
  if (exp * 1000 + skew <= now) {
    throw new ModelHitchError('invalid-api-key', 'The ID token from ChatGPT has expired.', { providerId: 'chatgpt-plan' });
  }
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 - skew > now) {
    throw new ModelHitchError('invalid-api-key', 'The ID token is not valid yet.', { providerId: 'chatgpt-plan' });
  }

  if (typeof claims.nonce !== 'string' || claims.nonce !== input.nonce) {
    throw new ModelHitchError(
      'invalid-api-key',
      'The ID token nonce does not match this sign-in attempt. The response was not for this request.',
      { providerId: 'chatgpt-plan' },
    );
  }

  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  if (!subject) {
    throw new ModelHitchError('invalid-api-key', 'The ID token has no subject claim to identify the account.', {
      providerId: 'chatgpt-plan',
    });
  }

  return {
    subject,
    ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
    claims,
  };
}

// ---------------------------------------------------------------------------
// Endpoints (discovery, with the documented values as defaults)
// ---------------------------------------------------------------------------

export interface ChatGptPlanEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  jwksUri: string;
}

export const DEFAULT_CHATGPT_PLAN_ENDPOINTS: ChatGptPlanEndpoints = {
  issuer: CHATGPT_PLAN_ISSUER,
  authorizationEndpoint: CHATGPT_PLAN_AUTHORIZE_ENDPOINT,
  tokenEndpoint: CHATGPT_PLAN_TOKEN_ENDPOINT,
  revocationEndpoint: CHATGPT_PLAN_REVOCATION_ENDPOINT,
  jwksUri: `${CHATGPT_PLAN_ISSUER}/.well-known/jwks.json`,
};

// ---------------------------------------------------------------------------
// Sign-in attempts
// ---------------------------------------------------------------------------

interface PendingAttempt {
  public: ChatGptPlanSignInAttempt;
  clientId: string;
  state: string;
  nonce: string;
  verifier: string;
  server?: Server;
  settle: (result: { ok: true; accountKey: string } | { ok: false; error: Error }) => void;
  settled: boolean;
  timer?: NodeJS.Timeout;
  /** Resolves when the attempt reaches a terminal status. */
  done: Promise<{ ok: true; accountKey: string } | { ok: false; error: Error }>;
}

/** Options for the Node-side auth object. */
export interface ChatGptPlanAuthOptions {
  /** Credential file path. Default: `<MODELHITCH_HOME>/chatgpt-plan.json`. */
  path?: string;
  fetchImpl?: typeof fetch;
  /** Fixed callback port, or 0 to always take an ephemeral one. Default 1455. */
  callbackPort?: number;
  /** Endpoint overrides, for tests and for a self-hosted issuer. */
  endpoints?: Partial<ChatGptPlanEndpoints>;
  /** Clock override, for tests. */
  now?: () => number;
  /** Replaces the browser launch. Tests pass a no-op. */
  openUrl?: (url: string) => void | Promise<void>;
  /** Time a sign-in attempt may wait for the browser. */
  signInTimeoutMs?: number;
}

/**
 * The credential store, token source, and sign-in coordinator for the lane.
 *
 * One instance per process. It owns the credential file, refreshes tokens
 * serialized so two concurrent requests cannot race a rotating refresh token,
 * and exposes the same `ChatGptPlanTokenSource` contract the provider adapter
 * consumes.
 */
export class ChatGptPlanAuth implements ChatGptPlanTokenSource {
  readonly path: string;
  private readonly fetchImpl: typeof fetch;
  private readonly callbackPort: number;
  private readonly endpoints: ChatGptPlanEndpoints;
  private readonly now: () => number;
  private readonly openUrl: (url: string) => void | Promise<void>;
  private readonly signInTimeoutMs: number;

  private credentials: ChatGptPlanCredentials | null = null;
  /** Serializes refreshes; a rotating refresh token tolerates exactly one winner. */
  private refreshInFlight: Promise<ChatGptPlanToken> | null = null;
  private readonly attempts = new Map<string, PendingAttempt>();
  private readonly listeners = new Set<() => void>();
  /** Cached JWKS, refreshed once when a token's key id is unknown. */
  private jwks: { keys: Jwk[] } | null = null;

  constructor(options: ChatGptPlanAuthOptions = {}) {
    this.path = options.path ?? defaultChatGptPlanCredentialsPath();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.callbackPort = options.callbackPort ?? CHATGPT_PLAN_DEFAULT_CALLBACK_PORT;
    this.endpoints = { ...DEFAULT_CHATGPT_PLAN_ENDPOINTS, ...options.endpoints };
    this.now = options.now ?? (() => Date.now());
    this.openUrl = options.openUrl ?? openInBrowser;
    this.signInTimeoutMs = options.signInTimeoutMs ?? CHATGPT_PLAN_SIGN_IN_TIMEOUT_MS;
  }

  /**
   * Subscribe to credential changes: a completed sign-in, a refresh, a
   * sign-out. The bridge uses this to rebuild the lane's providers so a
   * freshly signed-in account starts serving without a restart.
   */
  onAccountChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener must never break a token operation.
      }
    }
  }

  /** Load the credential file once, then serve from memory. */
  private load(): ChatGptPlanCredentials {
    if (!this.credentials) {
      this.credentials = readChatGptPlanCredentials(this.path) ?? { version: 1, hostId: '', accounts: [] };
    }
    return this.credentials;
  }

  /** Re-read from disk, discarding the in-memory copy. */
  reload(): ChatGptPlanCredentials {
    this.credentials = readChatGptPlanCredentials(this.path) ?? { version: 1, hostId: '', accounts: [] };
    return this.credentials;
  }

  /**
   * Write the credential file, and say whether this write changes *which
   * account the lane serves*.
   *
   * Only then is it worth waking the bridge: a token refresh replaces secrets
   * in place and leaves the served account exactly as it was, so notifying on
   * one would rebuild every provider and re-read the account catalogue once an
   * hour for no change. Sign-in, sign-out, and activation do change it.
   */
  private persist(options: { accountChanged?: boolean } = {}): void {
    const credentials = this.load();
    writeChatGptPlanCredentials(this.path, credentials);
    if (options.accountChanged) this.notify();
  }

  /**
   * This host's stable `ext_agent_host_id`. Chosen and persisted before the
   * first sign-in, then reused for every later sign-in on this host.
   */
  hostId(): string {
    const credentials = this.load();
    if (!isValidHostId(credentials.hostId)) {
      credentials.hostId = createHostId();
      this.persist();
    }
    return credentials.hostId;
  }

  accounts(): ChatGptPlanAccount[] {
    return [...this.load().accounts];
  }

  /** The account requests use: the configured one, else the active one. */
  activeAccount(preferredKey?: string): ChatGptPlanAccount | undefined {
    const credentials = this.load();
    const wanted = preferredKey?.trim() || credentials.activeAccountKey;
    if (wanted) {
      const found = credentials.accounts.find((a) => a.key === wanted);
      if (found) return found;
    }
    return credentials.accounts[0];
  }

  describeAccount(): string {
    const account = this.activeAccount();
    return account ? account.label : 'no ChatGPT account';
  }

  /** Set which saved account serves requests. */
  activate(accountKey: string): void {
    const credentials = this.load();
    if (!credentials.accounts.some((a) => a.key === accountKey)) {
      throw new ModelHitchError('bad-request', `No saved ChatGPT account matches "${accountKey}".`, {
        providerId: 'chatgpt-plan',
      });
    }
    credentials.activeAccountKey = accountKey;
    this.persist({ accountChanged: true });
  }

  /** Snapshot for the settings UI and the status route. */
  status(): ChatGptPlanStatus {
    const credentials = this.load();
    const now = this.now();
    const describe = (account: ChatGptPlanAccount): ChatGptPlanAccountStatus => {
      const savedAt = Date.parse(account.savedAt);
      const refreshDeadline = Number.isNaN(savedAt) ? undefined : savedAt + CHATGPT_PLAN_REFRESH_TOKEN_LIFETIME_MS;
      return {
        key: account.key,
        label: account.label,
        ...(account.email ? { email: account.email } : {}),
        subject: account.subject,
        clientId: account.clientId,
        planUsage: account.planUsage,
        scopes: [...account.scopes],
        savedAt: account.savedAt,
        ...(account.expiresAt ? { expiresAt: account.expiresAt } : {}),
        expired: isTokenExpired(account, now),
        refreshable: !!account.refreshToken && (refreshDeadline === undefined || refreshDeadline > now),
        active: account.key === credentials.activeAccountKey,
      };
    };
    const active = this.activeAccount();
    const pending = [...this.attempts.values()].find((a) => a.public.status === 'pending');
    return {
      signedIn: !!active,
      planUsage: !!active && active.planUsage,
      hostId: this.hostId(),
      credentialsPath: this.path,
      ...(credentials.activeAccountKey ? { activeAccountKey: credentials.activeAccountKey } : {}),
      ...(active ? { account: describe(active) } : {}),
      accounts: credentials.accounts.map(describe),
      ...(pending
        ? { pendingSignIn: { attemptId: pending.public.attemptId, startedAt: pending.public.startedAt, expiresAt: pending.public.expiresAt } }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Token access
  // -------------------------------------------------------------------------

  /**
   * A usable access token for the active account, refreshed first when it is
   * inside the skew window.
   */
  async getToken(preferredKey?: string): Promise<ChatGptPlanToken> {
    const account = this.activeAccount(preferredKey);
    if (!account) throw this.notSignedIn();
    if (isTokenExpired(account, this.now())) return this.refreshAccount(account.key);
    return this.toToken(account);
  }

  /** Force a refresh, serialized so concurrent callers share one attempt. */
  async refreshToken(preferredKey?: string): Promise<ChatGptPlanToken> {
    const account = this.activeAccount(preferredKey);
    if (!account) throw this.notSignedIn();
    return this.refreshAccount(account.key);
  }

  private toToken(account: ChatGptPlanAccount): ChatGptPlanToken {
    const expiresAt = account.expiresAt ? Date.parse(account.expiresAt) : this.now() + 3_600_000;
    return {
      accessToken: account.accessToken,
      accountKey: account.key,
      expiresAt: Number.isNaN(expiresAt) ? this.now() + 3_600_000 : expiresAt,
      planUsage: account.planUsage,
    };
  }

  private notSignedIn(): ModelHitchError {
    return new ModelHitchError(
      'missing-api-key',
      `No ChatGPT account is signed in. Use "Continue with ChatGPT" on the bridge's /settings page, or run \`modelhitch chatgpt-plan sign-in\`.`,
      { providerId: 'chatgpt-plan' },
    );
  }

  private refreshAccount(accountKey: string): Promise<ChatGptPlanToken> {
    // One refresh at a time: the refresh token rotates, so a second concurrent
    // exchange would present an already-spent token and kill the session.
    if (this.refreshInFlight) return this.refreshInFlight;
    const run = (async () => {
      try {
        const account = this.load().accounts.find((a) => a.key === accountKey);
        if (!account) throw this.notSignedIn();
        if (!account.refreshToken) {
          throw new ModelHitchError(
            'invalid-api-key',
            `The saved ChatGPT account "${account.label}" has no refresh token, so its access token cannot be renewed. Sign in with ChatGPT again.`,
            { providerId: 'chatgpt-plan' },
          );
        }

        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: account.clientId,
          refresh_token: account.refreshToken,
          resource: CHATGPT_PLAN_RESOURCE,
        });
        const response = await this.postForm(this.endpoints.tokenEndpoint, body, 'refresh');
        const payload = await this.readTokenResponse(response, 'refresh');

        // The replacement refresh token must be stored with the new access
        // token, atomically: a partial update would strand the session.
        const updated: ChatGptPlanAccount = {
          ...account,
          ...payload,
          // The refresh response does not repeat identity; keep the validated one.
          key: account.key,
          label: account.label,
          issuer: account.issuer,
          subject: account.subject,
          clientId: account.clientId,
          hostId: account.hostId,
          idToken: account.idToken,
          // A refresh omits `scope` to retain the existing grant, so an absent
          // scope list must not erase what was granted at sign-in.
          scopes: payload.scopes.length ? payload.scopes : account.scopes,
          planUsage: account.planUsage,
          refreshToken: payload.refreshToken ?? account.refreshToken,
        };
        this.replaceAccount(updated);
        return this.toToken(updated);
      } finally {
        this.refreshInFlight = null;
      }
    })();
    this.refreshInFlight = run;
    return run;
  }

  private replaceAccount(updated: ChatGptPlanAccount): void {
    const credentials = this.load();
    const index = credentials.accounts.findIndex((a) => a.key === updated.key);
    if (index === -1) credentials.accounts.push(updated);
    else credentials.accounts[index] = updated;
    this.persist();
  }

  private async postForm(endpoint: string, body: URLSearchParams, phase: 'exchange' | 'refresh' | 'revoke'): Promise<Response> {
    try {
      return await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });
    } catch (err) {
      throw new ModelHitchError(
        'network-error',
        `Could not reach the ChatGPT ${phase} endpoint: ${(err as Error).message}`,
        { providerId: 'chatgpt-plan', cause: err },
      );
    }
  }

  /**
   * Read a token response into the fields a credential record stores.
   *
   * Refresh failures are classified by their machine-readable code, because the
   * recovery differs: an unusable refresh token means sign in again, while a
   * transport failure means keep the credentials and retry later.
   */
  private async readTokenResponse(
    response: Response,
    phase: 'exchange' | 'refresh',
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    tokenType: string;
    expiresIn?: number;
    scopes: string[];
    savedAt: string;
    expiresAt: string;
    earliestRefreshAt?: string;
  }> {
    const text = await response.text().catch(() => '');
    const payload = parseJsonObject(text);

    if (!response.ok) {
      const code = typeof payload.error === 'string' ? payload.error : undefined;
      const description =
        typeof payload.error_description === 'string'
          ? payload.error_description
          : text.slice(0, 300) || `HTTP ${response.status}`;
      throw tokenEndpointError({ phase, status: response.status, code, description });
    }

    const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
    if (!accessToken) {
      throw new ModelHitchError('provider-error', `The ChatGPT ${phase} response carried no access token.`, {
        providerId: 'chatgpt-plan',
      });
    }
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : undefined;
    const issuedAt = this.now();
    const scopes = parseScopeValue(typeof payload.scope === 'string' ? payload.scope : undefined);

    return {
      accessToken,
      ...(typeof payload.refresh_token === 'string' ? { refreshToken: payload.refresh_token } : {}),
      ...(typeof payload.id_token === 'string' ? { idToken: payload.id_token } : {}),
      tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
      ...(expiresIn !== undefined ? { expiresIn } : {}),
      scopes,
      savedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(issuedAt + (expiresIn ?? 3600) * 1000).toISOString(),
      ...(typeof payload.earliest_refresh_at === 'string' ? { earliestRefreshAt: payload.earliest_refresh_at } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  /**
   * Start an authorization attempt and open the system browser.
   *
   * The loopback listener is bound before the URL is handed out, because the
   * redirect URI must name the exact port the exchange will reuse.
   */
  async beginSignIn(
    options: { accountKey?: string; registration?: boolean; forceConsent?: boolean; open?: boolean } = {},
  ): Promise<ChatGptPlanSignInAttempt> {
    const credentials = this.load();
    const existing = options.accountKey
      ? credentials.accounts.find((a) => a.key === options.accountKey)
      : undefined;
    if (options.accountKey && !existing) {
      throw new ModelHitchError('bad-request', `No saved ChatGPT account matches "${options.accountKey}".`, {
        providerId: 'chatgpt-plan',
      });
    }

    // A first-time registration uses the dynamic entrypoint; everything else
    // reauthorizes with the client id that registration was issued.
    const registration = options.registration ?? !existing;
    const clientId = registration ? CHATGPT_PLAN_DYNAMIC_CLIENT_ID : existing!.clientId;

    const { verifier, challenge } = createPkcePair();
    const state = createRandomValue();
    const nonce = createRandomValue();

    const listener = await this.listen();
    const redirectUri = `http://${CHATGPT_PLAN_CALLBACK_HOST}:${listener.port}${CHATGPT_PLAN_CALLBACK_PATH}`;
    const authUrl = buildChatGptPlanAuthorizeUrl({
      clientId,
      hostId: this.hostId(),
      redirectUri,
      state,
      nonce,
      codeChallenge: challenge,
      endpoint: this.endpoints.authorizationEndpoint,
      ...(registration ? {} : existing?.idToken ? { idTokenHint: existing.idToken } : {}),
      ...(registration ? {} : existing?.email ? { loginHint: existing.email } : {}),
      ...(options.forceConsent ? { forceConsent: true } : {}),
    });

    const attemptId = randomUUID();
    const startedAt = this.now();
    const expiresAtMs = startedAt + this.signInTimeoutMs;

    let settle!: PendingAttempt['settle'];
    const done = new Promise<{ ok: true; accountKey: string } | { ok: false; error: Error }>((resolve) => {
      settle = resolve;
    });

    const attempt: PendingAttempt = {
      clientId,
      state,
      nonce,
      verifier,
      server: listener.server,
      settle,
      settled: false,
      done,
      public: {
        attemptId,
        status: 'pending',
        authUrl,
        redirectUri,
        startedAt: new Date(startedAt).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        registration,
      },
    };

    attempt.timer = setTimeout(() => {
      this.failAttempt(attempt, new Error('The sign-in attempt timed out before the browser returned to ModelHitch.'));
    }, this.signInTimeoutMs);
    // Never hold the process open for a browser round trip.
    attempt.timer.unref?.();

    this.attempts.set(attemptId, attempt);
    listener.server.on('request', (req, res) => {
      void this.handleCallback(attempt, req.url ?? '/', res);
    });
    listener.server.on('error', (err) => {
      this.failAttempt(attempt, err instanceof Error ? err : new Error(String(err)));
    });

    if (options.open !== false) {
      try {
        await this.openUrl(authUrl);
      } catch {
        // The URL is returned to the caller, which can show it as a fallback.
      }
    }

    return attempt.public;
  }

  /** Current state of one attempt, for polling from the settings page. */
  signInAttempt(attemptId: string): ChatGptPlanSignInAttempt | undefined {
    return this.attempts.get(attemptId)?.public;
  }

  /** Every attempt still being tracked, newest first. */
  signInAttempts(): ChatGptPlanSignInAttempt[] {
    return [...this.attempts.values()].map((a) => a.public).reverse();
  }

  /** Resolve once an attempt reaches a terminal status. */
  async waitForSignIn(attemptId: string): Promise<ChatGptPlanAccount> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new ModelHitchError('bad-request', `No ChatGPT sign-in attempt matches "${attemptId}".`, {
        providerId: 'chatgpt-plan',
      });
    }
    const result = await attempt.done;
    if (!result.ok) throw result.error;
    const account = this.load().accounts.find((a) => a.key === result.accountKey);
    if (!account) {
      throw new ModelHitchError('provider-error', 'The sign-in completed but the account record is missing.', {
        providerId: 'chatgpt-plan',
      });
    }
    return account;
  }

  /** Cancel a pending attempt and release its loopback port. */
  cancelSignIn(attemptId?: string): boolean {
    const targets = attemptId
      ? [this.attempts.get(attemptId)].filter((a): a is PendingAttempt => !!a)
      : [...this.attempts.values()].filter((a) => a.public.status === 'pending');
    let cancelled = false;
    for (const attempt of targets) {
      if (attempt.public.status !== 'pending') continue;
      attempt.public.status = 'cancelled';
      this.closeAttempt(attempt);
      this.finish(attempt, { ok: false, error: new ModelHitchError('bad-request', 'The ChatGPT sign-in was cancelled.', { providerId: 'chatgpt-plan' }) });
      cancelled = true;
    }
    return cancelled;
  }

  /**
   * Bind the loopback listener.
   *
   * The documented default port is tried first. If it is taken, an ephemeral
   * port is used: only the port may vary, and the scheme, host, and path stay
   * `http://127.0.0.1/auth/callback` either way. `localhost` is never used.
   */
  private async listen(): Promise<{ server: Server; port: number }> {
    const attemptBind = (port: number) =>
      new Promise<{ server: Server; port: number }>((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(port, CHATGPT_PLAN_CALLBACK_HOST, () => {
          server.removeListener('error', reject);
          const address = server.address();
          const bound = typeof address === 'object' && address ? address.port : port;
          resolve({ server, port: bound });
        });
      });

    if (this.callbackPort > 0) {
      try {
        return await attemptBind(this.callbackPort);
      } catch {
        // Port busy or unavailable — fall through to an ephemeral one.
      }
    }
    try {
      return await attemptBind(0);
    } catch (err) {
      throw new ModelHitchError(
        'network-error',
        `Could not start the local callback listener for Sign in with ChatGPT: ${(err as Error).message}`,
        { providerId: 'chatgpt-plan', cause: err },
      );
    }
  }

  /** Handle the browser's redirect to the loopback callback. */
  private async handleCallback(attempt: PendingAttempt, rawUrl: string, res: import('node:http').ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(rawUrl, `http://${CHATGPT_PLAN_CALLBACK_HOST}`);
    } catch {
      respond(res, 400, 'Bad request', 'The callback URL could not be parsed.');
      return;
    }
    if (url.pathname !== CHATGPT_PLAN_CALLBACK_PATH) {
      respond(res, 404, 'Not found', `ModelHitch only handles ${CHATGPT_PLAN_CALLBACK_PATH} here.`);
      return;
    }
    if (attempt.public.status !== 'pending') {
      respond(res, 409, 'Already handled', 'This sign-in attempt has already finished.');
      return;
    }

    const returnedState = url.searchParams.get('state') ?? '';
    // Validate state before reading anything else out of the callback.
    if (returnedState !== attempt.state) {
      respond(res, 400, 'Sign-in rejected', 'The returned state did not match this sign-in attempt.');
      this.failAttempt(attempt, new Error('The callback state did not match the pending sign-in attempt.'));
      return;
    }

    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description') ?? '';
      const declined = error === 'access_denied';
      respond(
        res,
        200,
        declined ? 'Sign-in cancelled' : 'Sign-in failed',
        declined
          ? 'ChatGPT did not grant access. You can close this tab and try again from ModelHitch settings.'
          : `ChatGPT returned "${error}". ${description} You can close this tab and try again from ModelHitch settings.`,
      );
      this.failAttempt(
        attempt,
        new ModelHitchError(
          'invalid-api-key',
          declined
            ? `ChatGPT plan use was not granted (access_denied). Enable it from ModelHitch settings, or use another billing path such as your own API key. See ${CHATGPT_PLAN_ERRORS_URL}.`
            : `The ChatGPT authorization failed: ${error}${description ? ` — ${description}` : ''}.`,
          { providerId: 'chatgpt-plan' },
        ),
      );
      return;
    }

    const code = url.searchParams.get('code') ?? '';
    if (!code) {
      respond(res, 400, 'Sign-in failed', 'The callback carried neither an authorization code nor an error.');
      this.failAttempt(attempt, new Error('The callback carried no authorization code.'));
      return;
    }

    // A new registration returns the issued client id in the callback. Without
    // it, registration did not complete and there is no id to save later.
    const returnedClientId = url.searchParams.get('client_id') ?? undefined;
    let clientId = attempt.clientId;
    if (attempt.public.registration) {
      if (!returnedClientId) {
        respond(res, 400, 'Sign-in incomplete', 'ChatGPT did not return an issued client id for the new registration.');
        this.failAttempt(attempt, new Error('The registration callback did not include an issued client id.'));
        return;
      }
      clientId = returnedClientId;
    } else if (returnedClientId && returnedClientId !== attempt.clientId) {
      // Never combine one registration's client id with another's tokens.
      respond(res, 400, 'Sign-in rejected', 'ChatGPT returned a different client id than the saved registration.');
      this.failAttempt(
        attempt,
        new Error(
          `The callback returned client id "${returnedClientId}" but this registration is "${attempt.clientId}". The result was rejected rather than replacing the saved account's registration.`,
        ),
      );
      return;
    }

    if (clientId === CHATGPT_PLAN_DYNAMIC_CLIENT_ID) {
      respond(res, 400, 'Sign-in incomplete', 'ChatGPT did not issue a client id for this registration.');
      this.failAttempt(attempt, new Error('The registration did not yield an issued client id.'));
      return;
    }

    try {
      const account = await this.completeExchange(attempt, clientId, code, url.searchParams.get('scope') ?? undefined);
      respond(
        res,
        200,
        'Signed in',
        `ModelHitch is now using your ChatGPT plan as ${escapeHtml(account.label)}. You can close this tab.`,
      );
      this.closeAttempt(attempt);
      attempt.public.status = 'completed';
      attempt.public.accountKey = account.key;
      this.finish(attempt, { ok: true, accountKey: account.key });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond(res, 400, 'Sign-in failed', escapeHtml(message));
      this.failAttempt(attempt, err instanceof Error ? err : new Error(message));
    }
  }

  /** Exchange the code, validate the ID token, and save the account. */
  private async completeExchange(
    attempt: PendingAttempt,
    clientId: string,
    code: string,
    returnedScope?: string,
  ): Promise<ChatGptPlanAccount> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: attempt.verifier,
      redirect_uri: attempt.public.redirectUri,
      resource: CHATGPT_PLAN_RESOURCE,
    });
    const response = await this.postForm(this.endpoints.tokenEndpoint, body, 'exchange');
    const payload = await this.readTokenResponse(response, 'exchange');

    if (!payload.idToken) {
      throw new ModelHitchError('invalid-api-key', 'The ChatGPT token response carried no ID token to validate.', {
        providerId: 'chatgpt-plan',
      });
    }

    const jwks = await this.fetchJwks();
    let validated: ValidatedIdToken;
    try {
      validated = validateChatGptPlanIdToken({
        idToken: payload.idToken,
        clientId,
        nonce: attempt.nonce,
        issuer: this.endpoints.issuer,
        jwks,
        now: this.now(),
      });
    } catch (err) {
      // A rotated signing key is the only recoverable failure here: refetch
      // once and retry. Every other rejection (audience, nonce, expiry) would
      // fail again, so it propagates as-is.
      if (!isSigningKeyMismatch(err)) throw err;
      const refreshed = await this.fetchJwks(true);
      validated = validateChatGptPlanIdToken({
        idToken: payload.idToken,
        clientId,
        nonce: attempt.nonce,
        issuer: this.endpoints.issuer,
        jwks: refreshed,
        now: this.now(),
      });
    }

    // Granted scopes come from the token response, which is authoritative.
    // The callback's `scope` is a fallback when the response omits it.
    const scopes = payload.scopes.length ? payload.scopes : parseScopeValue(returnedScope);
    const planUsage = hasChatGptPlanScope(scopes);

    if (!planUsage) {
      // Sign-in still counts: the user is authenticated, they just did not
      // grant plan usage. Saying so is better than a lane that 401s later.
      const withoutUsage: ChatGptPlanAccount = {
        key: chatGptPlanAccountKey(validated.subject, clientId),
        label: chatGptPlanAccountLabel({ email: validated.email, subject: validated.subject }),
        ...(validated.email ? { email: validated.email } : {}),
        issuer: this.endpoints.issuer,
        subject: validated.subject,
        clientId,
        hostId: this.hostId(),
        idToken: payload.idToken,
        accessToken: payload.accessToken,
        ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
        tokenType: payload.tokenType,
        ...(payload.expiresIn !== undefined ? { expiresIn: payload.expiresIn } : {}),
        scopes,
        savedAt: payload.savedAt,
        expiresAt: payload.expiresAt,
        ...(payload.earliestRefreshAt ? { earliestRefreshAt: payload.earliestRefreshAt } : {}),
        planUsage: false,
      };
      this.saveAccount(withoutUsage);
      return withoutUsage;
    }

    const account: ChatGptPlanAccount = {
      key: chatGptPlanAccountKey(validated.subject, clientId),
      label: chatGptPlanAccountLabel({ email: validated.email, subject: validated.subject }),
      ...(validated.email ? { email: validated.email } : {}),
      issuer: this.endpoints.issuer,
      subject: validated.subject,
      clientId,
      hostId: this.hostId(),
      idToken: payload.idToken,
      accessToken: payload.accessToken,
      ...(payload.refreshToken ? { refreshToken: payload.refreshToken } : {}),
      tokenType: payload.tokenType,
      ...(payload.expiresIn !== undefined ? { expiresIn: payload.expiresIn } : {}),
      scopes,
      savedAt: payload.savedAt,
      expiresAt: payload.expiresAt,
      ...(payload.earliestRefreshAt ? { earliestRefreshAt: payload.earliestRefreshAt } : {}),
      planUsage: true,
    };
    this.saveAccount(account);
    return account;
  }

  /**
   * Save a validated registration and make it active.
   *
   * A returning account replaces its own record in place; a different subject
   * or client id appends, which is what keeps two ChatGPT accounts separate
   * even when they share an email address.
   */
  private saveAccount(account: ChatGptPlanAccount): void {
    const credentials = this.load();
    const index = credentials.accounts.findIndex((a) => a.key === account.key);
    if (index === -1) credentials.accounts.push(account);
    else credentials.accounts[index] = account;
    credentials.activeAccountKey = account.key;
    this.persist({ accountChanged: true });
  }

  private async fetchJwks(force = false): Promise<{ keys: Jwk[] }> {
    if (this.jwks && !force) return this.jwks;
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoints.jwksUri, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      if (this.jwks) return this.jwks;
      throw new ModelHitchError(
        'network-error',
        `Could not fetch the ChatGPT signing keys from ${this.endpoints.jwksUri}: ${(err as Error).message}`,
        { providerId: 'chatgpt-plan', cause: err },
      );
    }
    if (!response.ok) {
      if (this.jwks) return this.jwks;
      throw new ModelHitchError(
        'provider-error',
        `The ChatGPT signing-key endpoint answered HTTP ${response.status}.`,
        { providerId: 'chatgpt-plan', status: response.status },
      );
    }
    const payload = parseJsonObject(await response.text().catch(() => ''));
    const keys = Array.isArray(payload.keys) ? (payload.keys as Jwk[]).filter((k) => !!k && typeof k === 'object') : [];
    if (!keys.length) {
      if (this.jwks) return this.jwks;
      throw new ModelHitchError('provider-error', 'The ChatGPT signing-key document contained no keys.', {
        providerId: 'chatgpt-plan',
      });
    }
    this.jwks = { keys };
    return this.jwks;
  }

  private failAttempt(attempt: PendingAttempt, error: Error): void {
    if (attempt.public.status === 'pending') {
      attempt.public.status = 'failed';
      attempt.public.error = error.message;
    }
    this.closeAttempt(attempt);
    this.finish(attempt, { ok: false, error });
  }

  private closeAttempt(attempt: PendingAttempt): void {
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.timer = undefined;
    try {
      attempt.server?.close();
    } catch {
      // Already closed.
    }
    attempt.server = undefined;
  }

  private finish(attempt: PendingAttempt, result: { ok: true; accountKey: string } | { ok: false; error: Error }): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.settle(result);
  }

  // -------------------------------------------------------------------------
  // Sign-out
  // -------------------------------------------------------------------------

  /**
   * Stop using an account and clear its tokens locally.
   *
   * The renewable session is revoked first so the grant does not linger on
   * OpenAI's side. Revocation is best-effort: a transport failure clears the
   * local tokens anyway and says so, because keeping a token the user asked to
   * drop is the worse outcome.
   */
  async signOut(options: { accountKey?: string; revoke?: boolean } = {}): Promise<{ revoked: boolean; warnings: string[] }> {
    const credentials = this.load();
    const key = options.accountKey?.trim() || credentials.activeAccountKey || credentials.accounts[0]?.key;
    const account = key ? credentials.accounts.find((a) => a.key === key) : undefined;
    if (!account) {
      throw new ModelHitchError('bad-request', 'No saved ChatGPT account to sign out.', { providerId: 'chatgpt-plan' });
    }

    const warnings: string[] = [];
    let revoked = false;
    if (options.revoke !== false && account.refreshToken) {
      try {
        revoked = await this.revokeRefreshToken(account);
      } catch (err) {
        warnings.push(
          `Remote revocation was not confirmed (${(err as Error).message}). Local tokens were cleared; you can also disconnect ModelHitch in ChatGPT settings.`,
        );
      }
    }

    credentials.accounts = credentials.accounts.filter((a) => a.key !== account.key);
    // Retain the account/client mapping and this host's id: signing out is not
    // the same as forgetting the registration, and a later sign-in reuses the
    // issued client id for the same ChatGPT account.
    if (credentials.activeAccountKey === account.key) {
      if (credentials.accounts.length) credentials.activeAccountKey = credentials.accounts[0]!.key;
      else delete credentials.activeAccountKey;
    }
    this.persist({ accountChanged: true });
    return { revoked, warnings };
  }

  /** Revoke the renewable session with bounded retries. */
  private async revokeRefreshToken(account: ChatGptPlanAccount): Promise<boolean> {
    const body = new URLSearchParams({
      token: account.refreshToken!,
      token_type_hint: 'refresh_token',
      client_id: account.clientId,
    });
    const delays = [0, 500, 1500];
    let lastError: Error | undefined;
    for (const delay of delays) {
      if (delay) await sleep(delay);
      try {
        const response = await this.postForm(this.endpoints.revocationEndpoint, body, 'revoke');
        // An empty 200 is the success response, including for an
        // already-invalid token.
        if (response.ok) return true;
        if (response.status < 500) {
          throw new ModelHitchError(
            'bad-request',
            `The ChatGPT revocation endpoint answered HTTP ${response.status}.`,
            { providerId: 'chatgpt-plan', status: response.status },
          );
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err as Error;
        // A 4xx is final; only transport and 5xx failures are worth retrying.
        if (err instanceof ModelHitchError && err.status !== undefined && err.status < 500) throw err;
      }
    }
    throw lastError ?? new Error('revocation did not complete');
  }
}

/**
 * True when ID-token validation failed because the key that signed the token
 * was not in the JWKS we held. That is the one failure a JWKS refetch can fix;
 * an audience, nonce, issuer, or expiry failure cannot be.
 */
function isSigningKeyMismatch(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return message.includes('No published signing key matches') || message.includes('signature did not verify');
}

/** Classify a token-endpoint failure by its machine-readable code. */
function tokenEndpointError(input: {
  phase: 'exchange' | 'refresh';
  status: number;
  code?: string;
  description: string;
}): ModelHitchError {
  const unusableRefreshCodes = new Set([
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
  ]);
  const id = input.code ? ` (${input.code})` : '';

  if (input.code && unusableRefreshCodes.has(input.code)) {
    return new ModelHitchError(
      'invalid-api-key',
      `The ChatGPT ${input.phase} failed${id}: ${input.description}. The saved tokens are no longer usable — sign in with ChatGPT again.`,
      { providerId: 'chatgpt-plan', status: input.status },
    );
  }
  if (input.code === 'invalid_client') {
    return new ModelHitchError(
      'invalid-api-key',
      `The ChatGPT ${input.phase} failed${id}: the saved client registration was rejected. Sign in with ChatGPT again to register a new client.`,
      { providerId: 'chatgpt-plan', status: input.status },
    );
  }
  if (input.status >= 500) {
    return new ModelHitchError(
      'provider-error',
      `The ChatGPT ${input.phase} endpoint answered HTTP ${input.status}${id}: ${input.description}. Credentials were kept; retry later.`,
      { providerId: 'chatgpt-plan', status: input.status },
    );
  }
  return new ModelHitchError(
    'bad-request',
    `The ChatGPT ${input.phase} was rejected with HTTP ${input.status}${id}: ${input.description}`,
    { providerId: 'chatgpt-plan', status: input.status },
  );
}

function parseJsonObject(text: string): Record<string, unknown> {  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Small HTML response for the loopback callback tab. */
function respond(res: import('node:http').ServerResponse, status: number, title: string, message: string): void {
  if (res.writableEnded) return;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f7;color:#111}
main{max-width:34rem;padding:2rem;background:#fff;border:1px solid #e4e4e7;border-radius:12px}h1{font-size:1.15rem;margin:0 0 .5rem}p{margin:0;color:#3f3f46}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;
  try {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    // The browser may have gone away; nothing to do.
  }
}

/**
 * Open a URL in the system browser. Used for the authorization request, which
 * the spec requires to happen in the system browser rather than an embedded
 * view.
 */
export function openInBrowser(url: string): void {
  const platform = process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // Callers still receive the URL and can print it.
    });
    child.unref();
  } catch {
    // Same: the URL is the fallback.
  }
}

/** Human-readable summary of a saved record, with no token material in it. */
export function describeChatGptPlanAccount(account: ChatGptPlanAccount): string {
  const parts = [`${account.label}`, `client ${account.clientId}`, `plan usage ${account.planUsage ? 'enabled' : 'off'}`];
  if (account.expiresAt) parts.push(`access token expires ${account.expiresAt}`);
  parts.push(`refresh token ${redactToken(account.refreshToken)}`);
  return parts.join(' · ');
}
