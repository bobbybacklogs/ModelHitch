import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHATGPT_PLAN_CALLBACK_PATH,
  CHATGPT_PLAN_DYNAMIC_CLIENT_ID,
  CHATGPT_PLAN_PROVIDER_ID,
  CHATGPT_PLAN_USAGE_SCOPE,
  chatGptPlanAccountKey,
  parseScopeValue,
} from '../src/chatgpt-plan.js';
import {
  ChatGptPlanAuth,
  buildChatGptPlanAuthorizeUrl,
  createHostId,
  createPkcePair,
  isValidHostId,
  pkceChallenge,
  readChatGptPlanCredentials,
  redactAuthorizeUrl,
  validateChatGptPlanIdToken,
  writeChatGptPlanCredentials,
} from '../src/chatgpt-plan-auth.js';
import { ModelHitchError } from '../src/core/errors.js';

/**
 * The Node half of the lane: PKCE, the authorization request, ID-token
 * validation, and the credential file.
 *
 * The ID-token checks run against a real RSA keypair and a real signature,
 * because a validator that only ever sees tokens it built itself proves
 * nothing. The sign-in flow runs over a real loopback listener, because the
 * redirect URI is the part OpenAI's rules constrain most tightly.
 *
 * Only the three OpenAI endpoints are stubbed. The single real socket is the
 * callback listener the flow opens for itself.
 */

// ---------------------------------------------------------------------------
// A real signer, so signature verification is genuinely exercised
// ---------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
const JWKS = { keys: [{ ...publicJwk, kid: 'test-key-1', alg: 'RS256', use: 'sig' }] };

const ISSUER = 'https://auth.openai.com';
const CLIENT_ID = 'oaiapp_test123';
const HOST_ID = 'urn:uuid:11111111-1111-4111-8111-111111111111';

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function signIdToken(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'test-key-1', typ: 'JWT' },
): string {
  const signing = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signing, 'utf8'), privateKey);
  return `${signing}.${signature.toString('base64url')}`;
}

function idTokenClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'sub_abc',
    email: 'user@example.com',
    nonce: 'nonce-1',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}

const validToken = (overrides: Record<string, unknown> = {}, header?: Record<string, unknown>) =>
  signIdToken(idTokenClaims(overrides), header ?? { alg: 'RS256', kid: 'test-key-1', typ: 'JWT' });

function validate(idToken: string, overrides: Partial<Parameters<typeof validateChatGptPlanIdToken>[0]> = {}) {
  return validateChatGptPlanIdToken({
    idToken,
    clientId: CLIENT_ID,
    nonce: 'nonce-1',
    issuer: ISSUER,
    jwks: JWKS,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// PKCE and the authorization request
// ---------------------------------------------------------------------------

describe('PKCE', () => {
  it('computes the challenge from RFC 7636 Appendix B', () => {
    // The published vector: if this drifts, every authorization request fails.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('produces a fresh, URL-safe verifier and matching challenge each time', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier).toMatch(/^[A-Za-z0-9\-_]{43,128}$/);
    expect(a.challenge).toBe(pkceChallenge(a.verifier));
    // base64url, so it survives a query string without escaping.
    expect(a.challenge).not.toMatch(/[+/=]/);
  });
});

describe('authorization request', () => {
  const base = {
    clientId: CHATGPT_PLAN_DYNAMIC_CLIENT_ID,
    hostId: HOST_ID,
    redirectUri: 'http://127.0.0.1:1455/auth/callback',
    state: 'state-1',
    nonce: 'nonce-1',
    codeChallenge: 'challenge-1',
  };

  it('sends the complete parameter set the spec requires for registration', () => {
    const url = new URL(buildChatGptPlanAuthorizeUrl(base));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
    expect(url.searchParams.get('client_id')).toBe(CHATGPT_PLAN_DYNAMIC_CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
    expect(url.searchParams.get('resource')).toBe('https://api.openai.com/v1');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('nonce')).toBe('nonce-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('ext_agent_host_id')).toBe(HOST_ID);
    // The app name is display metadata, sent on registration only.
    expect(url.searchParams.get('agent_name_hint')).toBe('ModelHitch');
  });

  it('requests the identity scopes plus the complete plan-usage set', () => {
    const scope = new URL(buildChatGptPlanAuthorizeUrl(base)).searchParams.get('scope') ?? '';
    expect(parseScopeValue(scope)).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'resource.invoke',
      CHATGPT_PLAN_USAGE_SCOPE,
    ]);
  });

  it('omits the name hint and adds login hints on reauthorization', () => {
    const url = new URL(
      buildChatGptPlanAuthorizeUrl({
        ...base,
        clientId: CLIENT_ID,
        idTokenHint: 'retained.id.token',
        loginHint: 'user@example.com',
      }),
    );
    expect(url.searchParams.has('agent_name_hint')).toBe(false);
    expect(url.searchParams.get('id_token_hint')).toBe('retained.id.token');
    expect(url.searchParams.get('login_hint')).toBe('user@example.com');
  });

  it('never sends prompt=consent on an ordinary sign-in, and can when asked', () => {
    expect(new URL(buildChatGptPlanAuthorizeUrl(base)).searchParams.has('prompt')).toBe(false);
    expect(new URL(buildChatGptPlanAuthorizeUrl({ ...base, forceConsent: true })).searchParams.get('prompt')).toBe(
      'consent',
    );
  });

  it('URL-encodes hint values so they cannot break out of their parameter', () => {
    const url = buildChatGptPlanAuthorizeUrl({ ...base, clientId: CLIENT_ID, loginHint: 'a&b=c d' });
    expect(url).toContain('login_hint=a%26b%3Dc+d');
  });

  it('redacts retained tokens from a URL meant for logs', () => {
    const raw = buildChatGptPlanAuthorizeUrl({ ...base, clientId: CLIENT_ID, idTokenHint: 'secret.jwt.value' });
    const redacted = redactAuthorizeUrl(raw);
    expect(redacted).not.toContain('secret.jwt.value');
    expect(redacted).toContain('redacted');
  });
});

describe('host id', () => {
  it('generates a urn:uuid host id and accepts the documented forms', () => {
    const hostId = createHostId();
    expect(hostId).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(isValidHostId(hostId)).toBe(true);
    expect(isValidHostId('urn:ietf:params:oauth:jwk-thumbprint:sha-256:abc')).toBe(true);
    expect(isValidHostId('did:key:z6Mk')).toBe(true);
    // Other DID methods and a bare string are not host ids.
    expect(isValidHostId('did:web:example.com')).toBe(false);
    expect(isValidHostId('user@example.com')).toBe(false);
    expect(isValidHostId(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ID token validation
// ---------------------------------------------------------------------------

describe('ID token validation', () => {
  it('accepts a correctly signed token and returns the account identity', () => {
    const result = validate(validToken());
    expect(result.subject).toBe('sub_abc');
    expect(result.email).toBe('user@example.com');
  });

  it('rejects a token signed by a different key', () => {
    const { privateKey: otherKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signing = `${base64url(JSON.stringify({ alg: 'RS256', kid: 'test-key-1', typ: 'JWT' }))}.${base64url(
      JSON.stringify(idTokenClaims()),
    )}`;
    const forged = `${signing}.${sign('RSA-SHA256', Buffer.from(signing, 'utf8'), otherKey).toString('base64url')}`;
    expect(() => validate(forged)).toThrowError(/signature did not verify/);
  });

  it('rejects a tampered payload, because the signature covers it', () => {
    const [header, , signature] = validToken().split('.') as [string, string, string];
    const tampered = base64url(JSON.stringify(idTokenClaims({ sub: 'sub_attacker' })));
    expect(() => validate(`${header}.${tampered}.${signature}`)).toThrowError(/signature did not verify/);
  });

  it('rejects an unknown key id rather than falling back to another key', () => {
    expect(() => validate(validToken({}, { alg: 'RS256', kid: 'rotated-away', typ: 'JWT' }))).toThrowError(
      /No published signing key matches/,
    );
  });

  it('rejects an unsupported signing algorithm', () => {
    // The issuer advertises RS256 only; accepting `none` would accept anything.
    expect(() => validate(validToken({}, { alg: 'none', kid: 'test-key-1' }))).toThrowError(
      /unsupported signing algorithm/,
    );
  });

  it('rejects the wrong audience', () => {
    expect(() => validate(validToken({ aud: 'oaiapp_someone_else' }))).toThrowError(/audience does not match/);
  });

  it('accepts an audience array that contains the issued client id', () => {
    expect(validate(validToken({ aud: ['other', CLIENT_ID] })).subject).toBe('sub_abc');
  });

  it('rejects the wrong issuer', () => {
    expect(() => validate(validToken({ iss: 'https://evil.test' }))).toThrowError(/issuer/);
  });

  it('rejects an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 7200;
    expect(() => validate(validToken({ iat: past, exp: past + 3600 }))).toThrowError(/expired/);
  });

  it('rejects a token that is not valid yet', () => {
    const future = Math.floor(Date.now() / 1000) + 7200;
    expect(() => validate(validToken({ nbf: future, exp: future + 3600 }))).toThrowError(/not valid yet/);
  });

  it('rejects a replayed token from a different attempt by its nonce', () => {
    // Without this check a token captured from another attempt would be accepted.
    expect(() => validate(validToken({ nonce: 'some-other-attempt' }))).toThrowError(/nonce does not match/);
  });

  it('rejects a token with no subject to identify the account', () => {
    expect(() => validate(validToken({ sub: undefined }))).toThrowError(/no subject claim/);
  });

  it('rejects a malformed token and an empty key set', () => {
    expect(() => validate('not-a-jwt')).toThrowError(/well-formed JWT/);
    expect(() => validate(validToken(), { jwks: { keys: [] } })).toThrowError(/No signing keys/);
    expect(() => validate(validToken(), { jwks: undefined })).toThrowError(/No signing keys/);
  });

  it('reports auth failures with the code that makes a lane skip', () => {
    try {
      validate(validToken({ nonce: 'wrong' }));
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(ModelHitchError);
      expect((err as ModelHitchError).code).toBe('invalid-api-key');
      expect((err as ModelHitchError).providerId).toBe(CHATGPT_PLAN_PROVIDER_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// Credential file
// ---------------------------------------------------------------------------

describe('credential file', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mh-chatgpt-plan-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const record = {
    key: 'sub_abc::oaiapp_test123',
    label: 'user@example.com',
    email: 'user@example.com',
    issuer: ISSUER,
    subject: 'sub_abc',
    clientId: CLIENT_ID,
    hostId: HOST_ID,
    idToken: 'id.token.value',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    tokenType: 'Bearer',
    expiresIn: 3600,
    scopes: ['openid', CHATGPT_PLAN_USAGE_SCOPE],
    savedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    planUsage: true,
  };

  it('round-trips an account', () => {
    const path = join(dir, 'roundtrip.json');
    writeChatGptPlanCredentials(path, {
      version: 1,
      hostId: HOST_ID,
      activeAccountKey: record.key,
      accounts: [record],
    });
    const read = readChatGptPlanCredentials(path);
    expect(read?.hostId).toBe(HOST_ID);
    expect(read?.activeAccountKey).toBe(record.key);
    expect(read?.accounts[0]).toMatchObject({
      key: record.key,
      clientId: CLIENT_ID,
      subject: 'sub_abc',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      planUsage: true,
    });
  });

  it('writes the documented snake_case field names', () => {
    // The spec's example uses these names, so the file can be held next to the
    // docs without a translation table.
    const path = join(dir, 'shape.json');
    writeChatGptPlanCredentials(path, { version: 1, hostId: HOST_ID, activeAccountKey: record.key, accounts: [record] });
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(raw.ext_agent_host_id).toBe(HOST_ID);
    expect(raw.active_account).toBe(record.key);
    const account = (raw.accounts as Array<Record<string, unknown>>)[0]!;
    for (const field of [
      'client_id',
      'ext_agent_host_id',
      'id_token',
      'access_token',
      'refresh_token',
      'token_type',
      'expires_in',
      'scopes',
      'saved_at',
    ]) {
      expect(account).toHaveProperty(field);
    }
  });

  it('restricts the file to its owner where the platform supports it', () => {
    const path = join(dir, 'perms.json');
    writeChatGptPlanCredentials(path, { version: 1, hostId: HOST_ID, accounts: [record] });
    if (process.platform !== 'win32') {
      // Tokens, not preferences: nothing else on the machine should read this.
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it('leaves no temporary file behind after an atomic write', () => {
    const path = join(dir, 'atomic.json');
    writeChatGptPlanCredentials(path, { version: 1, hostId: HOST_ID, accounts: [record] });
    writeChatGptPlanCredentials(path, { version: 1, hostId: HOST_ID, accounts: [] });
    expect(readdirSync(dir).filter((name) => name.startsWith('atomic.json.') && name.endsWith('.tmp'))).toEqual([]);
  });

  it('returns null for a missing file and is honest about a corrupt one', () => {
    expect(readChatGptPlanCredentials(join(dir, 'absent.json'))).toBeNull();
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json', 'utf8');
    // Never silently empty: the file may hold the only copy of a 30-day token.
    expect(() => readChatGptPlanCredentials(corrupt)).toThrowError(/not valid JSON/);
    const notObject = join(dir, 'array.json');
    writeFileSync(notObject, '[]', 'utf8');
    expect(() => readChatGptPlanCredentials(notObject)).toThrowError(/must be a JSON object/);
  });
});

// ---------------------------------------------------------------------------
// Sign-in flow over a real loopback callback
// ---------------------------------------------------------------------------

interface StubOptions {
  /** Token-response override for every grant, including the sign-in exchange. */
  tokenResponse?: (nonce: string, body: URLSearchParams) => Response;
  /** Token-response override for the refresh grant only. */
  refreshResponse?: (nonce: string, body: URLSearchParams) => Response;
  /** Makes the JWKS and revocation endpoints fail, to reach the recovery paths. */
  reverseFailure?: string;
}

function planUsageTokenResponse(nonce: string, overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      id_token: signIdToken({ ...idTokenClaims(), nonce, aud: CLIENT_ID }),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_USAGE_SCOPE}`,
      ...overrides,
    }),
    { status: 200 },
  );
}

/** A `fetch` stub for the JWKS, token, and revocation endpoints. */
function endpointStub(options: StubOptions = {}) {
  const calls = { token: [] as URLSearchParams[], revoke: [] as URLSearchParams[], jwks: 0 };
  let nonce = 'nonce-1';
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('jwks')) {
      calls.jwks += 1;
      if (options.reverseFailure) throw new Error(options.reverseFailure);
      return new Response(JSON.stringify(JWKS), { status: 200 });
    }
    if (url.includes('/oauth/revoke')) {
      calls.revoke.push(new URLSearchParams(String(init?.body ?? '')));
      if (options.reverseFailure) throw new Error(options.reverseFailure);
      return new Response('', { status: 200 });
    }
    if (url.includes('/oauth/token')) {
      const body = new URLSearchParams(String(init?.body ?? ''));
      calls.token.push(body);
      const isRefresh = body.get('grant_type') === 'refresh_token';
      if (options.tokenResponse) return options.tokenResponse(nonce, body);
      if (isRefresh && options.refreshResponse) return options.refreshResponse(nonce, body);
      return planUsageTokenResponse(nonce, isRefresh ? { access_token: 'access-2', refresh_token: 'refresh-2' } : {});
    }
    throw new Error(`unexpected endpoint ${url}`);
  };
  return { calls, impl, setNonce: (value: string) => { nonce = value; } };
}

function authFor(dir: string, name: string, impl: typeof fetch) {
  return new ChatGptPlanAuth({
    path: join(dir, name),
    fetchImpl: impl,
    // Ephemeral port: the test must not depend on 1455 being free.
    callbackPort: 0,
    openUrl: () => {},
    signInTimeoutMs: 5_000,
  });
}

/** Drive the browser half: hit the loopback callback with the given query. */
async function hitCallback(authUrl: string, query: Record<string, string>): Promise<{ status: number; body: string }> {
  const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri')!);
  for (const [key, value] of Object.entries(query)) redirect.searchParams.set(key, value);
  const response = await fetch(redirect);
  return { status: response.status, body: await response.text() };
}

interface CompleteOptions {
  /** `null` omits `client_id` from the callback entirely. */
  returnedClientId?: string | null;
  begin?: Parameters<ChatGptPlanAuth['beginSignIn']>[0];
  query?: Record<string, string>;
}

/**
 * Run one complete attempt: start it, tell the stub which nonce to sign, then
 * return through the loopback callback exactly as a browser would.
 */
async function completeSignIn(
  auth: ChatGptPlanAuth,
  stub: ReturnType<typeof endpointStub>,
  options: CompleteOptions = {},
) {
  const attempt = await auth.beginSignIn(options.begin);
  const authorize = new URL(attempt.authUrl);
  stub.setNonce(authorize.searchParams.get('nonce')!);
  const query: Record<string, string> = {
    code: 'auth-code-1',
    state: authorize.searchParams.get('state')!,
    ...options.query,
  };
  if (options.returnedClientId !== null) query.client_id = options.returnedClientId ?? CLIENT_ID;
  const response = await hitCallback(attempt.authUrl, query);
  return { attempt, authorize, response, account: await auth.waitForSignIn(attempt.attemptId) };
}

describe('sign-in flow', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mh-chatgpt-plan-flow-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('completes a first registration and saves the issued client id', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'register.json', stub.impl);

    const { attempt, authorize, response, account } = await completeSignIn(auth, stub);
    expect(response.status).toBe(200);
    expect(attempt.registration).toBe(true);
    expect(authorize.searchParams.get('client_id')).toBe(CHATGPT_PLAN_DYNAMIC_CLIENT_ID);

    // The redirect the exchange reuses must keep scheme, host, and path fixed.
    const redirectUri = authorize.searchParams.get('redirect_uri')!;
    expect(new URL(redirectUri).pathname).toBe(CHATGPT_PLAN_CALLBACK_PATH);
    expect(new URL(redirectUri).hostname).toBe('127.0.0.1');

    expect(account.clientId).toBe(CLIENT_ID);
    expect(account.subject).toBe('sub_abc');
    expect(account.label).toBe('user@example.com');
    expect(account.planUsage).toBe(true);
    expect(account.hostId).toMatch(/^urn:uuid:/);

    const exchange = stub.calls.token[0]!;
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('client_id')).toBe(CLIENT_ID);
    expect(exchange.get('code')).toBe('auth-code-1');
    expect(exchange.get('redirect_uri')).toBe(redirectUri);
    expect(exchange.get('code_verifier')).toMatch(/^[A-Za-z0-9\-_]{43,}$/);
    expect(exchange.get('resource')).toBe('https://api.openai.com/v1');
    // This flow is a public client: there is no secret to send.
    expect(exchange.get('client_secret')).toBeNull();

    const status = auth.status();
    expect(status.signedIn).toBe(true);
    expect(status.planUsage).toBe(true);
    expect(status.account?.clientId).toBe(CLIENT_ID);
  });

  it('never saves the dynamic entrypoint as the issued client id', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'entrypoint.json', stub.impl);
    const attempt = await auth.beginSignIn();
    const authorize = new URL(attempt.authUrl);
    stub.setNonce(authorize.searchParams.get('nonce')!);
    // A registration callback with no issued id is an incomplete registration.
    const { status } = await hitCallback(attempt.authUrl, {
      code: 'c',
      state: authorize.searchParams.get('state')!,
    });
    expect(status).toBe(400);
    await expect(auth.waitForSignIn(attempt.attemptId)).rejects.toThrowError(/issued client id/);
    expect(auth.status().signedIn).toBe(false);
    expect(stub.calls.token).toEqual([]);
  });

  it('keeps the host id stable across sign-ins', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'host.json', stub.impl);
    const first = auth.hostId();
    await completeSignIn(auth, stub);
    expect(auth.hostId()).toBe(first);
  });

  it('rejects a callback whose state does not match the pending attempt', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'state.json', stub.impl);
    const attempt = await auth.beginSignIn();
    const { status, body } = await hitCallback(attempt.authUrl, { code: 'c', state: 'not-the-state' });
    expect(status).toBe(400);
    expect(body).toContain('state');
    await expect(auth.waitForSignIn(attempt.attemptId)).rejects.toThrowError(/state did not match/);
  });

  it('stops on access_denied without exchanging a code, and says what to do', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'denied.json', stub.impl);
    const attempt = await auth.beginSignIn();
    const authorize = new URL(attempt.authUrl);
    const { status } = await hitCallback(attempt.authUrl, {
      error: 'access_denied',
      error_description: 'user said no',
      state: authorize.searchParams.get('state')!,
    });
    expect(status).toBe(200);

    await expect(auth.waitForSignIn(attempt.attemptId)).rejects.toThrowError(/access_denied/);
    // No code to exchange, so no token request was attempted.
    expect(stub.calls.token).toEqual([]);
    expect(auth.status().signedIn).toBe(false);
  });

  it('reuses the issued client id and skips the name hint on reauthorization', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'reauth.json', stub.impl);
    const first = await completeSignIn(auth, stub);

    const second = await completeSignIn(auth, stub, { begin: { accountKey: first.account.key } });
    expect(second.attempt.registration).toBe(false);
    expect(second.authorize.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(second.authorize.searchParams.has('agent_name_hint')).toBe(false);
    // A retained ID token skips the account selector, and never lands in a log.
    const hint = second.authorize.searchParams.get('id_token_hint');
    expect(hint).toBeTruthy();
    expect(redactAuthorizeUrl(second.attempt.authUrl)).not.toContain(hint!);
    expect(second.account.clientId).toBe(CLIENT_ID);
  });

  it('rejects a callback that returns a different client id on reauthorization', async () => {
    // Combining one registration's client id with another's tokens is exactly
    // what the spec forbids.
    const stub = endpointStub();
    const auth = authFor(dir, 'mismatch.json', stub.impl);
    const first = await completeSignIn(auth, stub);

    const attempt = await auth.beginSignIn({ accountKey: first.account.key });
    const authorize = new URL(attempt.authUrl);
    stub.setNonce(authorize.searchParams.get('nonce')!);
    const { status } = await hitCallback(attempt.authUrl, {
      code: 'c2',
      state: authorize.searchParams.get('state')!,
      client_id: 'oaiapp_someone_else',
    });
    expect(status).toBe(400);
    await expect(auth.waitForSignIn(attempt.attemptId)).rejects.toThrowError(/rejected rather than replacing/);
    // The original registration is untouched.
    expect(auth.status().account?.clientId).toBe(CLIENT_ID);
  });

  it('saves a signed-in account that lacks plan usage and reports it as such', async () => {
    // Authenticated but not authorized to spend the plan: the sign-in counts,
    // and the lane simply cannot serve until the grant is widened.
    const stub = endpointStub({
      tokenResponse: (nonce) =>
        planUsageTokenResponse(nonce, { scope: 'openid profile email offline_access' }),
    });
    const auth = authFor(dir, 'noplan.json', stub.impl);
    const { account } = await completeSignIn(auth, stub);

    expect(account.planUsage).toBe(false);
    expect(auth.status().planUsage).toBe(false);
    // Signed in is still true: the identity is valid, only plan spending is not.
    expect(auth.status().signedIn).toBe(true);
  });

  it('cancels a pending attempt and releases its loopback port', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'cancel.json', stub.impl);
    const attempt = await auth.beginSignIn();
    expect(auth.status().pendingSignIn?.attemptId).toBe(attempt.attemptId);

    expect(auth.cancelSignIn(attempt.attemptId)).toBe(true);
    await expect(auth.waitForSignIn(attempt.attemptId)).rejects.toThrowError(/cancelled/);
    expect(auth.signInAttempt(attempt.attemptId)?.status).toBe('cancelled');
    // Cancelling twice is a no-op, not an error.
    expect(auth.cancelSignIn(attempt.attemptId)).toBe(false);
  });

  it('refuses to reauthorize an account key it does not have', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'unknown.json', stub.impl);
    await expect(auth.beginSignIn({ accountKey: 'nope' })).rejects.toMatchObject({ code: 'bad-request' });
  });

  it('answers a wrong callback path with 404 rather than completing', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'path.json', stub.impl);
    const attempt = await auth.beginSignIn();
    const redirect = new URL(new URL(attempt.authUrl).searchParams.get('redirect_uri')!);
    redirect.pathname = '/callback';
    redirect.searchParams.set('code', 'c');
    const response = await fetch(redirect);
    expect(response.status).toBe(404);
    auth.cancelSignIn(attempt.attemptId);
  });
});

// ---------------------------------------------------------------------------
// Token access, refresh, and sign-out
// ---------------------------------------------------------------------------

describe('token access and refresh', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mh-chatgpt-plan-token-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the saved access token while it is still valid', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'valid.json', stub.impl);
    await completeSignIn(auth, stub);

    const token = await auth.getToken();
    expect(token.accessToken).toBe('access-1');
    expect(token.planUsage).toBe(true);
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    expect(stub.calls.token).toHaveLength(1); // the sign-in exchange only
  });

  it('refreshes with the issued client id and stores the replacement refresh token', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'refresh.json', stub.impl);
    await completeSignIn(auth, stub);

    const refreshed = await auth.refreshToken();
    expect(refreshed.accessToken).toBe('access-2');

    const body = stub.calls.token[1]!;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('refresh_token')).toBe('refresh-1');
    expect(body.get('resource')).toBe('https://api.openai.com/v1');
    // Omitting scope retains the existing grant.
    expect(body.get('scope')).toBeNull();

    // The rotating refresh token replaced the spent one on disk.
    const stored = readChatGptPlanCredentials(join(dir, 'refresh.json'));
    expect(stored?.accounts[0]?.refreshToken).toBe('refresh-2');
    expect(stored?.accounts[0]?.accessToken).toBe('access-2');
  });

  it('keeps the granted scopes when a refresh response omits scope', async () => {
    const stub = endpointStub({
      refreshResponse: () =>
        new Response(JSON.stringify({ access_token: 'access-x', refresh_token: 'refresh-x', expires_in: 3600 }), {
          status: 200,
        }),
    });
    const auth = authFor(dir, 'scopes.json', stub.impl);
    await completeSignIn(auth, stub);

    const refreshed = await auth.refreshToken();
    expect(refreshed.planUsage).toBe(true);
    // A refresh that omits `scope` retains the grant; erasing it would silently
    // disable plan usage on the next request.
    expect(readChatGptPlanCredentials(join(dir, 'scopes.json'))?.accounts[0]?.scopes).toContain(
      CHATGPT_PLAN_USAGE_SCOPE,
    );
  });

  it('collapses concurrent refreshes into one exchange so the rotating token is not spent twice', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'race.json', stub.impl);
    await completeSignIn(auth, stub);

    const before = stub.calls.token.length;
    await Promise.all([auth.refreshToken(), auth.refreshToken(), auth.refreshToken()]);
    expect(stub.calls.token.length - before).toBe(1);
  });

  it('reports an unusable refresh token as sign-in-again, not as a transport blip', async () => {
    const stub = endpointStub({
      refreshResponse: () =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'refresh token reused' }), {
          status: 400,
        }),
    });
    const auth = authFor(dir, 'invalid-grant.json', stub.impl);
    await completeSignIn(auth, stub);

    try {
      await auth.refreshToken();
      throw new Error('expected the refresh to fail');
    } catch (err) {
      expect((err as ModelHitchError).code).toBe('invalid-api-key');
      expect((err as Error).message).toMatch(/sign in with ChatGPT again/);
    }
  });

  it('keeps credentials when the refresh endpoint has a 5xx', async () => {
    const stub = endpointStub({
      refreshResponse: () => new Response(JSON.stringify({ error: 'server_error' }), { status: 503 }),
    });
    const auth = authFor(dir, 'retryable.json', stub.impl);
    await completeSignIn(auth, stub);

    try {
      await auth.refreshToken();
      throw new Error('expected the refresh to fail');
    } catch (err) {
      // The spec is explicit: a 5xx means retry later, not sign in again.
      expect((err as ModelHitchError).code).toBe('provider-error');
      expect((err as Error).message).toMatch(/retry later/);
    }
    expect(readChatGptPlanCredentials(join(dir, 'retryable.json'))?.accounts).toHaveLength(1);
  });

  it('reports no signed-in account rather than an opaque failure', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'empty.json', stub.impl);
    await expect(auth.getToken()).rejects.toMatchObject({ code: 'missing-api-key' });
    expect(auth.describeAccount()).toBe('no ChatGPT account');
  });
});

describe('sign-out', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mh-chatgpt-plan-out-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('revokes the renewable session, then clears the local tokens', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'out.json', stub.impl);
    await completeSignIn(auth, stub);

    const result = await auth.signOut();
    expect(result.revoked).toBe(true);
    expect(result.warnings).toEqual([]);

    const revoke = stub.calls.revoke[0]!;
    expect(revoke.get('token')).toBe('refresh-1');
    expect(revoke.get('token_type_hint')).toBe('refresh_token');
    expect(revoke.get('client_id')).toBe(CLIENT_ID);

    expect(auth.status().signedIn).toBe(false);
    // Tokens are gone; the registration and host id are deliberately retained
    // so a later sign-in reuses the issued client id.
    const stored = readChatGptPlanCredentials(join(dir, 'out.json'));
    expect(stored?.accounts).toEqual([]);
    expect(stored?.hostId).toMatch(/^urn:uuid:/);
  });

  it('clears local tokens and warns when revocation cannot be confirmed', async () => {
    const stub = endpointStub({ reverseFailure: 'network down' });
    const auth = authFor(dir, 'warn.json', stub.impl);
    // Seed a signed-in account directly: this test is about revocation, not the flow.
    const seeded = chatGptPlanAccountKey('sub_abc', CLIENT_ID);
    writeChatGptPlanCredentials(join(dir, 'warn.json'), {
      version: 1,
      hostId: HOST_ID,
      activeAccountKey: seeded,
      accounts: [
        {
          key: seeded,
          label: 'user@example.com',
          issuer: ISSUER,
          subject: 'sub_abc',
          clientId: CLIENT_ID,
          hostId: HOST_ID,
          accessToken: 'a',
          refreshToken: 'r',
          tokenType: 'Bearer',
          scopes: ['openid'],
          savedAt: new Date().toISOString(),
          planUsage: true,
        },
      ],
    });

    const result = await auth.signOut();
    expect(result.revoked).toBe(false);
    // Keeping a token the user asked to drop is the worse outcome, so this
    // warns and clears rather than failing the sign-out.
    expect(result.warnings.join(' ')).toMatch(/not confirmed/);
    expect(auth.status().signedIn).toBe(false);
  });

  it('skips remote revocation when asked to', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'local.json', stub.impl);
    await completeSignIn(auth, stub);

    const result = await auth.signOut({ revoke: false });
    expect(result.revoked).toBe(false);
    expect(stub.calls.revoke).toEqual([]);
    expect(auth.status().signedIn).toBe(false);
  });

  it('refuses to sign out when nothing is saved', async () => {
    const stub = endpointStub();
    const auth = authFor(dir, 'nothing.json', stub.impl);
    await expect(auth.signOut()).rejects.toMatchObject({ code: 'bad-request' });
  });
});

describe('account management', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mh-chatgpt-plan-acct-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A stored record. The local key is derived from subject + client id, not
   * trusted from the file, so the helper builds it the same way the store does.
   */
  const seedRecord = (label: string, clientId: string, subject = 'sub_1') => ({
    key: chatGptPlanAccountKey(subject, clientId),
    label,
    email: label,
    issuer: ISSUER,
    subject,
    clientId,
    hostId: HOST_ID,
    accessToken: `access-${clientId}`,
    refreshToken: `refresh-${clientId}`,
    tokenType: 'Bearer',
    scopes: ['openid', CHATGPT_PLAN_USAGE_SCOPE],
    savedAt: new Date().toISOString(),
    planUsage: true,
  });

  it('keeps two registrations separate even when they share an email, and switches between them', async () => {
    const path = join(dir, 'multi.json');
    const a = seedRecord('user@example.com', 'oaiapp_a');
    const b = seedRecord('user@example.com', 'oaiapp_b');
    writeChatGptPlanCredentials(path, {
      version: 1,
      hostId: HOST_ID,
      activeAccountKey: a.key,
      accounts: [a, b],
    });
    const auth = authFor(dir, 'multi.json', endpointStub().impl);

    expect(auth.status().accounts).toHaveLength(2);
    expect((await auth.getToken()).accessToken).toBe('access-oaiapp_a');

    auth.activate(b.key);
    expect((await auth.getToken()).accessToken).toBe('access-oaiapp_b');
    expect(auth.status().account?.clientId).toBe('oaiapp_b');
    // Same email, two registrations: only the client id tells them apart.
    expect(auth.status().account?.label).toBe('user@example.com');

    expect(() => auth.activate('missing')).toThrowError(/No saved ChatGPT account/);
  });

  it('notifies listeners only when the served account actually changes', async () => {
    const path = join(dir, 'notify.json');
    const stub = endpointStub();
    const auth = authFor(dir, 'notify.json', stub.impl);
    const changes: string[] = [];
    const unsubscribe = auth.onAccountChange(() => {
      changes.push('change');
    });

    // Choosing a host id is not an account change, and neither is a token
    // refresh: both rewrite the file, and waking the bridge for either would
    // rebuild every provider and re-read the catalogue once an hour for nothing.
    auth.hostId();
    expect(changes).toEqual([]);

    await completeSignIn(auth, stub);
    expect(changes).toEqual(['change']);

    await auth.refreshToken();
    expect(changes).toEqual(['change']);

    const account = auth.accounts()[0]!;
    auth.activate(account.key);
    expect(changes).toEqual(['change', 'change']);

    unsubscribe();
    await auth.signOut();
    expect(changes).toEqual(['change', 'change']);
    expect(readChatGptPlanCredentials(path)?.hostId).toMatch(/^urn:uuid:/);
  });

  it('reloads the credential file from disk after another process writes it', async () => {
    const path = join(dir, 'reload.json');
    const auth = authFor(dir, 'reload.json', endpointStub().impl);
    expect(auth.status().signedIn).toBe(false);

    writeChatGptPlanCredentials(path, {
      version: 1,
      hostId: HOST_ID,
      activeAccountKey: seedRecord('user@example.com', 'oaiapp_a').key,
      accounts: [seedRecord('user@example.com', 'oaiapp_a')],
    });
    expect(auth.status().signedIn).toBe(false); // still the cached copy
    auth.reload();
    expect(auth.status().signedIn).toBe(true);
    expect((await auth.getToken()).accessToken).toBe('access-oaiapp_a');
  });
});
