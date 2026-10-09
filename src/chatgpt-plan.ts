import type { ChatGptPlanConfig, ModelHitchConfig } from './config.js';
import type { Policy, TrustListEntry } from './core/policy.js';

/**
 * Sign in with ChatGPT — ChatGPT plan usage as an ordinary ModelHitch lane.
 *
 * OpenAI's `chatgpt.tokens.use.direct` scope lets an open-source or locally
 * hosted client spend a user's ChatGPT plan on eligible Responses API requests.
 * That makes the plan a *lane*: it can lead the plan, sit behind the buffet, be
 * pinned as the main route, cool down on a 429, and be selected with
 * `--provider chatgpt-plan` exactly like every other lane.
 *
 * This module is the pure half — constants, credential-record shapes, the
 * token-source contract the provider adapter depends on, and the routing plan.
 * It imports nothing from `node:*`, so the browser entry can use it.
 *
 * The half that needs a filesystem, a loopback socket, and crypto lives in
 * `chatgpt-plan-auth.ts` and is Node-only.
 *
 * Spec: https://developers.openai.com/siwc/token-sharing-open-source
 */

/** Provider id for the lane. Routes as `chatgpt-plan/<model-slug>`. */
export const CHATGPT_PLAN_PROVIDER_ID = 'chatgpt-plan';

/** Display name used in the catalog, lane health, and the settings page. */
export const CHATGPT_PLAN_PROVIDER_NAME = 'ChatGPT plan';

export const CHATGPT_PLAN_ISSUER = 'https://auth.openai.com';
export const CHATGPT_PLAN_DISCOVERY_URL = `${CHATGPT_PLAN_ISSUER}/.well-known/openid-configuration`;
export const CHATGPT_PLAN_AUTHORIZE_ENDPOINT = `${CHATGPT_PLAN_ISSUER}/api/accounts/authorize`;
export const CHATGPT_PLAN_TOKEN_ENDPOINT = `${CHATGPT_PLAN_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_PLAN_REVOCATION_ENDPOINT = `${CHATGPT_PLAN_ISSUER}/api/accounts/oauth/revoke`;

/**
 * Inference and model listing go to the public Responses API, never to
 * ChatGPT's `backend-api` endpoints. The resource parameter must match.
 */
export const CHATGPT_PLAN_API_BASE_URL = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1';

/**
 * The first-time registration entrypoint. It is *not* a client id to save:
 * the callback returns the issued `oaiapp_…` id, which is what later
 * authorization and token exchanges use.
 */
export const CHATGPT_PLAN_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';

/** Every dynamic-registration request identifies the app by this name. */
export const CHATGPT_PLAN_AGENT_NAME = 'ModelHitch';

/** Only the port may vary; scheme, host, and path must stay exactly this. */
export const CHATGPT_PLAN_CALLBACK_PATH = '/auth/callback';
export const CHATGPT_PLAN_CALLBACK_HOST = '127.0.0.1';
export const CHATGPT_PLAN_DEFAULT_CALLBACK_PORT = 1455;

/** Identity scopes. */
export const CHATGPT_PLAN_IDENTITY_SCOPES = ['openid', 'profile', 'email'] as const;

/**
 * ChatGPT plan usage scopes plus `offline_access`, which is what makes the
 * token response carry a refresh token. Ask for the complete set on every
 * authorization so a later re-consent does not have to widen it.
 */
export const CHATGPT_PLAN_USAGE_SCOPES = [
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
] as const;

/** The one scope that actually authorizes spending the plan. */
export const CHATGPT_PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct';

/** Requested scopes in the order the OpenAI docs list them. */
export const CHATGPT_PLAN_SCOPES: readonly string[] = [
  ...CHATGPT_PLAN_IDENTITY_SCOPES,
  ...CHATGPT_PLAN_USAGE_SCOPES,
];

/** Where a user reviews plan and per-app usage limits. */
export const CHATGPT_PLAN_USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage';

/**
 * Host id scheme. A `urn:uuid:` value is the supported alternative to the
 * recommended RFC 9278 JWK thumbprint; it needs no key material and is opaque,
 * which is all the spec asks for.
 */
export const CHATGPT_PLAN_HOST_ID_PREFIX = 'urn:uuid:';

/** Access tokens last an hour; refresh this long before they actually expire. */
export const CHATGPT_PLAN_TOKEN_SKEW_MS = 60_000;

/** Refresh tokens last 30 days. */
export const CHATGPT_PLAN_REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a sign-in attempt may sit waiting for the browser before its
 * loopback listener is torn down.
 */
export const CHATGPT_PLAN_SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;

/** Where the error codes a caller should act on are documented. */
export const CHATGPT_PLAN_ERRORS_URL =
  'https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery';

/**
 * One saved ChatGPT account registration, exactly as the spec describes the
 * local credential record. Secrets live here and nowhere else — never in the
 * config document, which is masked on read.
 */
export interface ChatGptPlanAccount {
  /** Stable local key: issued client id plus validated subject. */
  key: string;
  /** Display label. Email helps a human pick; it does not identify a workspace. */
  label: string;
  email?: string;
  issuer: string;
  /** Validated ID-token `sub`. The account identity. */
  subject: string;
  /** The issued `oaiapp_…` client id. Never `dynamic_agent_client`. */
  clientId: string;
  /** This host's stable `ext_agent_host_id`. */
  hostId: string;
  idToken?: string;
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresIn?: number;
  /** Granted scopes, from the space-separated `scope` value. */
  scopes: string[];
  /** UTC timestamp of the token response this record holds. */
  savedAt: string;
  /** Absolute access-token expiry, derived from `expires_in` at `savedAt`. */
  expiresAt?: string;
  /** `earliest_refresh_at` from the token response, when the server sent one. */
  earliestRefreshAt?: string;
  /** False when the grant lacks `chatgpt.tokens.use.direct`. */
  planUsage: boolean;
}

/** The credential file's document shape. */
export interface ChatGptPlanCredentials {
  version: 1;
  /** Stable per-host identifier, chosen before the first sign-in. */
  hostId: string;
  /** Key of the account requests use when nothing else is pinned. */
  activeAccountKey?: string;
  accounts: ChatGptPlanAccount[];
}

/** A live access token plus what the caller needs to reason about it. */
export interface ChatGptPlanToken {
  accessToken: string;
  /** Account the token belongs to (local key). */
  accountKey: string;
  /** Epoch ms after which the token must be refreshed. */
  expiresAt: number;
  planUsage: boolean;
}

/**
 * What the provider adapter needs from whatever is holding credentials.
 *
 * Keeping this an interface is what lets `providers/chatgpt-plan.ts` stay free
 * of `node:*`: the Node credential store and a test fake both satisfy it, and
 * a browser build can put a server-mediated implementation behind it.
 */
export interface ChatGptPlanTokenSource {
  /**
   * A usable access token for the selected account, refreshed first when it is
   * at or past the skew window.
   */
  getToken(): Promise<ChatGptPlanToken>;
  /**
   * Force a refresh. `getToken()` has already failed with the stale token, so
   * this is the one retry the provider is allowed.
   */
  refreshToken(): Promise<ChatGptPlanToken>;
  /** Human-readable account label, for error messages. Never throws. */
  describeAccount(): string;
}

/** Lifecycle of one browser sign-in attempt. */
export type ChatGptPlanSignInStatus = 'pending' | 'completed' | 'failed' | 'cancelled';

/**
 * One sign-in attempt, as the settings page polls it.
 *
 * Sign-in finishes on a loopback listener the bridge does not own, so the page
 * reads this shape rather than awaiting a request: the browser tab the user is
 * typing in is a different request from the one that opened it.
 */
export interface ChatGptPlanSignInAttempt {
  attemptId: string;
  status: ChatGptPlanSignInStatus;
  /** One-time authorization URL. Carries an `id_token_hint` on reauthorization. */
  authUrl: string;
  redirectUri: string;
  startedAt: string;
  expiresAt: string;
  /** Set once the attempt fails, for the settings UI to show. */
  error?: string;
  /** Set once the attempt completes. */
  accountKey?: string;
  /** True when this attempt registered a new client rather than reauthorizing. */
  registration: boolean;
}

/** One saved account, described without any token material. */
export interface ChatGptPlanAccountStatus {
  key: string;
  label: string;
  email?: string;
  subject: string;
  clientId: string;
  planUsage: boolean;
  scopes: string[];
  savedAt: string;
  expiresAt?: string;
  expired: boolean;
  /** False once the 30-day refresh window has passed. */
  refreshable: boolean;
  active: boolean;
}

/** Everything the account panel needs, in one read. */
export interface ChatGptPlanStatus {
  signedIn: boolean;
  planUsage: boolean;
  hostId: string;
  credentialsPath: string;
  activeAccountKey?: string;
  account?: ChatGptPlanAccountStatus;
  accounts: ChatGptPlanAccountStatus[];
  pendingSignIn?: { attemptId: string; startedAt: string; expiresAt: string };
}

/** True when the granted scopes authorize spending the user's plan. */
export function hasChatGptPlanScope(scopes: readonly string[] | string | undefined): boolean {
  if (!scopes) return false;
  const list = typeof scopes === 'string' ? scopes.split(/\s+/) : scopes;
  return list.includes(CHATGPT_PLAN_USAGE_SCOPE);
}

/** Split a space-separated OAuth `scope` value into a de-duplicated list. */
export function parseScopeValue(value: string | undefined | null): string[] {
  if (typeof value !== 'string') return [];
  return [...new Set(value.split(/\s+/).map((s) => s.trim()).filter(Boolean))];
}

/** Mask a token for logs and diagnostics: keep nothing but its presence. */
export function redactToken(value: string | undefined): string {
  return value ? `«${value.length} chars»` : '«none»';
}

/**
 * Stable local key for an account registration.
 *
 * Subject alone is not enough — the same ChatGPT user can hold two separate
 * registrations, and the spec is explicit that two registrations must stay
 * separate even when they share an email address. Client id alone is not
 * enough either. The pair is the registration.
 */
export function chatGptPlanAccountKey(subject: string, clientId: string): string {
  return `${subject}::${clientId}`;
}

/** Default display label for an account: email when known, else the subject. */
export function chatGptPlanAccountLabel(input: { email?: string; subject: string }): string {
  const email = input.email?.trim();
  return email || input.subject;
}

/** True when a record's access token is expired or close enough to refresh. */
export function isTokenExpired(record: Pick<ChatGptPlanAccount, 'expiresAt'>, now = Date.now()): boolean {
  if (!record.expiresAt) return false;
  const at = Date.parse(record.expiresAt);
  if (Number.isNaN(at)) return false;
  return at - CHATGPT_PLAN_TOKEN_SKEW_MS <= now;
}

/**
 * Strip a `chatgpt-plan/` prefix from a model slug, so
 * `chatgpt-plan/gpt-5.1` and a bare slug both reach the API unchanged.
 */
export function chatGptPlanModelSlug(model: string): string {
  const prefix = `${CHATGPT_PLAN_PROVIDER_ID}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/**
 * A plan lane that survived resolution: enabled, with at least one model slot.
 *
 * Unlike a custom lane the endpoint is fixed, so resolution needs no URL. What
 * it does need is a model list — OpenAI publishes the account's catalog, and
 * ModelHitch never guesses a slug.
 */
export interface ResolvedChatGptPlanLane {
  providerId: string;
  /** Model slugs, de-duplicated, in rotation order. Never empty after resolution. */
  models: string[];
  /** Model that leads when `mode` is `pinned`. */
  pinnedModel: string;
  mode: 'rotation' | 'pinned';
  placement: 'lead' | 'fallback';
  /** True when a limit on this lane stops the walk instead of rotating. */
  stopOnLimit: boolean;
  /** Account the lane prefers; undefined means the active account. */
  accountKey?: string;
}

/** Tolerant config accessor: the document may predate the chatgptPlan block. */
export function chatGptPlanConfig(config: ModelHitchConfig | undefined): ChatGptPlanConfig | undefined {
  return config?.chatgptPlan;
}

/** Where the lane sits in the plan. Default: `lead`. */
export function chatGptPlanPlacement(config: ModelHitchConfig | undefined): 'lead' | 'fallback' {
  return chatGptPlanConfig(config)?.placement === 'fallback' ? 'fallback' : 'lead';
}

/** Rotation or pin. Default: `rotation`. */
export function chatGptPlanMode(config: ModelHitchConfig | undefined): 'rotation' | 'pinned' {
  return chatGptPlanConfig(config)?.mode === 'pinned' ? 'pinned' : 'rotation';
}

export interface ResolveChatGptPlanOptions {
  /**
   * Model slugs read from the signed-in account (`GET /v1/models`). Used only
   * when the config lists none, so a freshly signed-in bridge serves the lane
   * without the user hand-typing slugs first.
   */
  accountModels?: readonly string[];
}

/**
 * Resolve the config block into a serving lane, or `undefined` when it cannot
 * be served.
 *
 * The block is served only when it is on *and* at least one model slug is
 * known — from the config, or from the account catalog the caller passed in.
 * There is no built-in slug list on purpose: ChatGPT plan model slugs are
 * account-specific, and inventing one would produce a lane that 404s.
 */
export function resolveChatGptPlan(
  config: ModelHitchConfig | undefined,
  options: ResolveChatGptPlanOptions = {},
): ResolvedChatGptPlanLane | undefined {
  const block = chatGptPlanConfig(config);
  if (!block?.enabled) return undefined;

  const configured = (block.models ?? []).map((m) => chatGptPlanModelSlug(m.trim())).filter(Boolean);
  const fromAccount = (options.accountModels ?? []).map((m) => chatGptPlanModelSlug(m.trim())).filter(Boolean);
  const models = [...new Set(configured.length ? configured : fromAccount)];
  if (!models.length) return undefined;

  const mode = block.mode === 'pinned' ? 'pinned' : 'rotation';
  const requestedPin = block.pinnedModel ? chatGptPlanModelSlug(block.pinnedModel.trim()) : undefined;
  // A pin that names a model outside the list is a config error the validator
  // reports; at runtime the first slot leads rather than routing to nothing.
  const pinnedModel = requestedPin && models.includes(requestedPin) ? requestedPin : models[0]!;

  return {
    providerId: CHATGPT_PLAN_PROVIDER_ID,
    models,
    pinnedModel,
    mode,
    placement: chatGptPlanPlacement(config),
    stopOnLimit: block.onLimit === 'stop',
    ...(block.accountKey?.trim() ? { accountKey: block.accountKey.trim() } : {}),
  };
}

/** True when the block is on and the lane is complete enough to serve. */
export function isChatGptPlanEnabled(
  config: ModelHitchConfig | undefined,
  options: ResolveChatGptPlanOptions = {},
): boolean {
  return resolveChatGptPlan(config, options) !== undefined;
}

export interface ChatGptPlanPlanInput {
  config: ModelHitchConfig | undefined;
  /** Plan to merge into — the custom-lane plan, when that block is on. */
  policy?: Policy;
  defaultProviderId?: string;
  defaultModel?: string;
  /** Model slugs read from the signed-in account. */
  accountModels?: readonly string[];
}

export interface ChatGptPlanPlan {
  policy?: Policy;
  defaultProviderId?: string;
  defaultModel?: string;
  /** Ordered provider/model lanes this block contributed, for logging. */
  lanes: Array<{ providerId: string; model: string }>;
  placement: 'lead' | 'fallback';
  mode: 'rotation' | 'pinned';
  /** True when the lane became the primary route. */
  leads: boolean;
  /** Set when the lane stops the walk instead of rotating. */
  stopping: string[];
}

/**
 * Merge the ChatGPT plan lane into the routing plan.
 *
 * `mode` decides the order inside the lane, `placement` decides where the lane
 * sits relative to everything else:
 *
 *   rotation + lead      every model trails in the lane's own order, at the
 *                        front of `trusted`, and the first model is primary.
 *   pinned + lead        the pinned model leads and the remaining models follow
 *                        immediately — pinning a lane keeps its siblings as the
 *                        first fallback rather than abandoning them.
 *   fallback             the lane is appended to `fallback`, reached only when
 *                        the configured lanes are depleted or erroring.
 *
 * Returns the input untouched when the block is off or has no usable model.
 */
export function applyChatGptPlanPlan(input: ChatGptPlanPlanInput): ChatGptPlanPlan {
  const lane = resolveChatGptPlan(input.config, { accountModels: input.accountModels });
  const placement = chatGptPlanPlacement(input.config);
  const mode = chatGptPlanMode(input.config);
  const untouched: ChatGptPlanPlan = {
    policy: input.policy,
    defaultProviderId: input.defaultProviderId,
    defaultModel: input.defaultModel,
    lanes: [],
    placement,
    mode,
    leads: false,
    stopping: [],
  };
  if (!lane) return untouched;

  const ordered =
    lane.mode === 'pinned'
      ? [lane.pinnedModel, ...lane.models.filter((m) => m !== lane.pinnedModel)]
      : lane.models;

  const entry: TrustListEntry = {
    providerId: lane.providerId,
    models: ordered,
    ...(lane.stopOnLimit ? { terminal: true } : {}),
  };
  const flat = ordered.map((model) => ({ providerId: lane.providerId, model }));
  const stopping = lane.stopOnLimit ? [lane.providerId] : [];
  const base: Policy = input.policy ?? { trusted: [], fallback: [] };

  if (lane.placement === 'fallback') {
    return {
      policy: {
        ...base,
        trusted: [...(base.trusted ?? [])],
        fallback: [...(base.fallback ?? []), entry],
      },
      // The primary route is unchanged: this lane is for when it is depleted.
      defaultProviderId: input.defaultProviderId,
      defaultModel: input.defaultModel,
      lanes: flat,
      placement: lane.placement,
      mode: lane.mode,
      leads: false,
      stopping,
    };
  }

  return {
    policy: {
      ...base,
      trusted: [entry, ...(base.trusted ?? [])],
      fallback: [...(base.fallback ?? [])],
    },
    defaultProviderId: lane.providerId,
    defaultModel: ordered[0],
    lanes: flat,
    placement: lane.placement,
    mode: lane.mode,
    leads: true,
    stopping,
  };
}

/** One-line summary of the lane's plan, for the bridge banner and the log. */
export function describeChatGptPlan(plan: ChatGptPlanPlan): string | undefined {
  if (!plan.lanes.length) return undefined;
  const where = plan.placement === 'fallback' ? 'as fallback' : 'leading';
  const how = plan.mode === 'pinned' ? `pinned to ${plan.lanes[0]!.model}` : `${plan.lanes.length} model slot(s)`;
  const stops = plan.stopping.length ? ' · stop-on-limit' : '';
  return `ChatGPT plan ${where}: ${how}${stops}`;
}
