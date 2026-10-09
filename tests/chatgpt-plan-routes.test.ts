import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHATGPT_PLAN_PROVIDER_ID,
  type ChatGptPlanSignInAttempt,
  type ChatGptPlanStatus,
} from '../src/chatgpt-plan.js';
import type { ChatGptPlanBridge } from '../src/server/server.js';
import { createModelHitchServer } from '../src/server/server.js';
import { ModelHitchError } from '../src/core/errors.js';
import { mockProvider } from '../src/providers/mock.js';

/**
 * The `/v1/chatgpt-plan*` routes: the account panel and sign-in flow the
 * settings page drives.
 *
 * These are the wire shapes the browser code depends on, so they are asserted
 * directly. The bridge deliberately never touches tokens here — it opens the
 * authorization page and reports what the daemon knows — which is why the
 * fixture is a small in-test implementation rather than a real credential store.
 */

const status: ChatGptPlanStatus = {
  signedIn: true,
  planUsage: true,
  hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111',
  credentialsPath: '/home/u/.modelhitch/chatgpt-plan.json',
  activeAccountKey: 'sub::oaiapp_x',
  account: {
    key: 'sub::oaiapp_x',
    label: 'user@example.com',
    email: 'user@example.com',
    subject: 'sub',
    clientId: 'oaiapp_x',
    planUsage: true,
    scopes: ['openid', 'chatgpt.tokens.use.direct'],
    savedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-01T01:00:00.000Z',
    expired: false,
    refreshable: true,
    active: true,
  },
  accounts: [
    {
      key: 'sub::oaiapp_x',
      label: 'user@example.com',
      subject: 'sub',
      clientId: 'oaiapp_x',
      planUsage: true,
      scopes: ['openid'],
      savedAt: '2026-01-01T00:00:00.000Z',
      expired: false,
      refreshable: true,
      active: true,
    },
  ],
};

const attempt: ChatGptPlanSignInAttempt = {
  attemptId: 'attempt-1',
  status: 'pending',
  authUrl: 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=s',
  redirectUri: 'http://127.0.0.1:1455/auth/callback',
  startedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:10:00.000Z',
  registration: true,
};

/** What the fixture bridge recorded, so the tests can assert the arguments. */
interface Recorded {
  beginSignIn: Array<Record<string, unknown>>;
  signOut: Array<Record<string, unknown>>;
  activated: string[];
  cancelled: Array<string | undefined>;
}

function fixtureBridge(recorded: Recorded, overrides: Partial<ChatGptPlanBridge> = {}): ChatGptPlanBridge {
  return {
    status: () => status,
    beginSignIn: async (options) => {
      recorded.beginSignIn.push(options as Record<string, unknown>);
      return attempt;
    },
    signInAttempt: (attemptId) => (attemptId === 'attempt-1' ? attempt : undefined),
    cancelSignIn: (attemptId) => {
      recorded.cancelled.push(attemptId);
      return true;
    },
    signOut: async (options) => {
      recorded.signOut.push(options as Record<string, unknown>);
      return { revoked: true, warnings: ['revocation unconfirmed'] };
    },
    activate: (accountKey) => {
      recorded.activated.push(accountKey);
    },
    listModels: async () => [{ id: 'gpt-5.1', name: 'GPT-5.1' }],
    ...overrides,
  };
}

describe('chatgpt plan routes', () => {
  let base = '';
  let server: ReturnType<typeof createModelHitchServer>;
  let bare = '';
  let bareServer: ReturnType<typeof createModelHitchServer>;
  const recorded: Recorded = { beginSignIn: [], signOut: [], activated: [], cancelled: [] };

  beforeAll(async () => {
    server = createModelHitchServer({
      providers: [mockProvider],
      defaultProviderId: CHATGPT_PLAN_PROVIDER_ID,
      chatGptPlan: fixtureBridge(recorded),
    });
    base = (await server.listen(0, '127.0.0.1')).url;

    // A bridge built without the ChatGPT plan surface, to pin the 501 story.
    bareServer = createModelHitchServer({ providers: [mockProvider], defaultProviderId: 'mock' });
    bare = (await bareServer.listen(0, '127.0.0.1')).url;
  });

  afterAll(async () => {
    await server.close();
    await bareServer.close();
  });

  it('reports the account panel state', async () => {
    const response = await fetch(`${base}/v1/chatgpt-plan`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatGptPlanStatus;
    expect(body.signedIn).toBe(true);
    expect(body.planUsage).toBe(true);
    expect(body.account?.clientId).toBe('oaiapp_x');
    expect(body.accounts).toHaveLength(1);
    expect(body.credentialsPath).toContain('chatgpt-plan.json');
  });

  it('starts a sign-in and hands back the authorization URL', async () => {
    const response = await fetch(`${base}/v1/chatgpt-plan/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registration: true }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; attempt: ChatGptPlanSignInAttempt };
    expect(body.ok).toBe(true);
    expect(body.attempt.authUrl).toContain('auth.openai.com/api/accounts/authorize');
    expect(body.attempt.redirectUri).toBe('http://127.0.0.1:1455/auth/callback');
    expect(recorded.beginSignIn[0]).toEqual({ registration: true });
  });

  it('passes an account key and a forced re-consent through to the store', async () => {
    await fetch(`${base}/v1/chatgpt-plan/sign-in`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountKey: 'sub::oaiapp_x', forceConsent: true }),
    });
    expect(recorded.beginSignIn.at(-1)).toEqual({ accountKey: 'sub::oaiapp_x', forceConsent: true });
  });

  it('accepts a sign-in with no body at all', async () => {
    const response = await fetch(`${base}/v1/chatgpt-plan/sign-in`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(recorded.beginSignIn.at(-1)).toEqual({});
  });

  it('reports one attempt and 404s an unknown one', async () => {
    const found = await fetch(`${base}/v1/chatgpt-plan/sign-in/attempt-1`);
    expect(found.status).toBe(200);
    expect(((await found.json()) as { attempt: ChatGptPlanSignInAttempt }).attempt.status).toBe('pending');

    const missing = await fetch(`${base}/v1/chatgpt-plan/sign-in/nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('cancels a pending attempt', async () => {
    const response = await fetch(`${base}/v1/chatgpt-plan/sign-in/attempt-1/cancel`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cancelled: true });
    expect(recorded.cancelled).toEqual(['attempt-1']);
  });

  it('signs out and reports whether revocation was confirmed', async () => {
    const response = await fetch(`${base}/v1/chatgpt-plan/sign-out`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountKey: 'sub::oaiapp_x' }),
    });
    expect(response.status).toBe(200);
    // The warnings travel with the response: the page has to tell the user when
    // remote revocation was not confirmed.
    expect(await response.json()).toEqual({ ok: true, revoked: true, warnings: ['revocation unconfirmed'] });
    expect(recorded.signOut[0]).toEqual({ accountKey: 'sub::oaiapp_x' });
  });

  it('activates a saved account and rejects a request with no key', async () => {
    const ok = await fetch(`${base}/v1/chatgpt-plan/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountKey: 'sub::oaiapp_y' }),
    });
    expect(ok.status).toBe(200);
    expect(recorded.activated).toEqual(['sub::oaiapp_y']);

    const missing = await fetch(`${base}/v1/chatgpt-plan/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: { message: string } }).error.message).toMatch(/accountKey is required/);
  });

  it('lists the signed-in account catalogue', async () => {
    const response = await fetch(`${base}/v1/chatgpt-plan/models`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ models: [{ id: 'gpt-5.1', name: 'GPT-5.1' }] });
  });

  it('answers 501 on every route when the bridge has no ChatGPT plan surface', async () => {
    for (const [method, path] of [
      ['GET', '/v1/chatgpt-plan'],
      ['POST', '/v1/chatgpt-plan/sign-in'],
      ['GET', '/v1/chatgpt-plan/sign-in/attempt-1'],
      ['POST', '/v1/chatgpt-plan/sign-in/attempt-1/cancel'],
      ['POST', '/v1/chatgpt-plan/sign-out'],
      ['POST', '/v1/chatgpt-plan/activate'],
      ['POST', '/v1/chatgpt-plan/models'],
    ] as const) {
      const response = await fetch(`${bare}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(501);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('not_implemented');
    }
  });

  it('falls through to 404 for an unknown path under the prefix', async () => {
    const response = await fetch(`${base}/v1/chatgpt-plan/nonsense`);
    expect(response.status).toBe(404);
  });

  it('surfaces a limit as a 429 with the plan-usage link', async () => {
    const limited = createModelHitchServer({
      providers: [mockProvider],
      chatGptPlan: fixtureBridge(recorded, {
        beginSignIn: async () => {
          throw new ModelHitchError('rate-limited', 'subscription_sharing_usage_limit_exceeded', {
            providerId: CHATGPT_PLAN_PROVIDER_ID,
            status: 429,
          });
        },
      }),
    });
    const url = (await limited.listen(0, '127.0.0.1')).url;
    try {
      const response = await fetch(`${url}/v1/chatgpt-plan/sign-in`, { method: 'POST' });
      expect(response.status).toBe(429);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('rate-limited');
      // The UI guidelines ask for a Manage usage link on a limit, so the bridge
      // supplies it rather than leaving every client to remember the URL.
      expect(body.error.message).toContain('https://chatgpt.com/settings/usage');
    } finally {
      await limited.close();
    }
  });

  it('maps a bad request from the store onto a 400', async () => {
    const failing = createModelHitchServer({
      providers: [mockProvider],
      chatGptPlan: fixtureBridge(recorded, {
        signOut: async () => {
          throw new ModelHitchError('bad-request', 'No saved ChatGPT account to sign out.', {
            providerId: CHATGPT_PLAN_PROVIDER_ID,
          });
        },
      }),
    });
    const url = (await failing.listen(0, '127.0.0.1')).url;
    try {
      const response = await fetch(`${url}/v1/chatgpt-plan/sign-out`, { method: 'POST' });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/No saved ChatGPT/);
    } finally {
      await failing.close();
    }
  });

  it('reports a status failure as a server error rather than an empty panel', async () => {
    const failing = createModelHitchServer({
      providers: [mockProvider],
      chatGptPlan: fixtureBridge(recorded, {
        status: () => {
          throw new Error('credential file is corrupt');
        },
      }),
    });
    const url = (await failing.listen(0, '127.0.0.1')).url;
    try {
      const response = await fetch(`${url}/v1/chatgpt-plan`);
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('chatgpt_plan_status_failed');
    } finally {
      await failing.close();
    }
  });

  it('hot-swaps the ChatGPT plan surface on reconfigure', async () => {
    const swapped = createModelHitchServer({ providers: [mockProvider] });
    const url = (await swapped.listen(0, '127.0.0.1')).url;
    try {
      expect((await fetch(`${url}/v1/chatgpt-plan`)).status).toBe(501);
      swapped.reconfigure({ chatGptPlan: fixtureBridge(recorded) });
      expect((await fetch(`${url}/v1/chatgpt-plan`)).status).toBe(200);
    } finally {
      await swapped.close();
    }
  });
});
