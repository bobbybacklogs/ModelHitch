import { describe, expect, it } from 'vitest';
import { bridgeProviders } from '../src/bridge-providers.js';
import { CHATGPT_PLAN_PROVIDER_ID, type ChatGptPlanTokenSource } from '../src/chatgpt-plan.js';
import { CursorCloudSessionStore } from '../src/providers/cursor-cloud-session.js';
import { CURSOR_CLOUD_PROVIDER_ID } from '../src/providers/cursor-cloud.js';
import { defaultProviders } from '../src/registry.js';
import { mockProvider } from '../src/providers/mock.js';
import type { ModelHitchConfig } from '../src/config.js';
import type { Provider } from '../src/providers/types.js';

/**
 * `bridgeProviders` is the single seam that decides which providers exist for a
 * config document. Add-on lanes (Cursor Cloud, Console BYOK) must appear when
 * their block is on and vanish when it is off — including after a hot reload
 * that turns them off.
 */

const sessionStore = new CursorCloudSessionStore();
const base: Provider[] = [mockProvider];

/** A stand-in credential source for the ChatGPT plan lane. */
const fakeTokens: ChatGptPlanTokenSource = {
  async getToken() {
    return { accessToken: 'access', accountKey: 'k', expiresAt: Date.now() + 3_600_000, planUsage: true };
  },
  async refreshToken() {
    return { accessToken: 'access-2', accountKey: 'k', expiresAt: Date.now() + 3_600_000, planUsage: true };
  },
  describeAccount: () => 'user@example.com',
};

describe('bridgeProviders opencodeByok registration', () => {
  it('adds one provider per enabled connection', () => {
    const config: ModelHitchConfig = {
      version: 1,
      opencodeByok: {
        enabled: true,
        connections: [
          { id: 'conn_deepseek', label: 'deepseek', models: ['deepseek-chat'] },
          { id: 'conn_claude', label: 'claude', schema: 'anthropic', models: ['claude-sonnet-4-6'] },
        ],
      },
    };
    const providers = bridgeProviders(base, config, sessionStore);
    expect(providers.map((p) => p.id)).toEqual(['mock', 'opencode-byok-deepseek', 'opencode-byok-claude']);
    expect(providers.find((p) => p.id === 'opencode-byok-claude')?.defaultModel).toBe('claude-sonnet-4-6');
  });

  it('keeps disabled connections out of the provider set', () => {
    const config: ModelHitchConfig = {
      version: 1,
      opencodeByok: { enabled: true, connections: [{ id: 'conn_a', models: ['m'] }, { id: 'conn_b', models: ['m2'], enabled: false }] },
    };
    expect(bridgeProviders(base, config, sessionStore).map((p) => p.id)).toEqual(['mock', 'opencode-byok-a']);
  });

  it('drops BYOK providers when the block is turned off (hot-reload path)', () => {
    const on: ModelHitchConfig = {
      version: 1,
      opencodeByok: { enabled: true, connections: [{ id: 'conn_a', models: ['m'] }] },
    };
    const previous = bridgeProviders(base, on, sessionStore);
    // Feed the previous generation back in, as a reconfigure does.
    const off: ModelHitchConfig = { version: 1, opencodeByok: { enabled: false, connections: [{ id: 'conn_a', models: ['m'] }] } };
    expect(bridgeProviders(previous, off, sessionStore).map((p) => p.id)).toEqual(['mock']);
  });

  it('leaves the default registry untouched when the block is absent', () => {
    const providers = bridgeProviders(defaultProviders, { version: 1 }, sessionStore);
    expect(providers.map((p) => p.id)).toEqual(defaultProviders.map((p) => p.id));
    expect(providers.some((p) => p.id === CURSOR_CLOUD_PROVIDER_ID)).toBe(false);
  });
});

describe('bridgeProviders custom lane registration', () => {
  const custom: ModelHitchConfig = {
    version: 1,
    customLanes: {
      enabled: true,
      lanes: [
        { id: 'my-provider', label: 'My Provider', baseUrl: 'https://api.example.test/v1', models: ['m1', 'm2'] },
        { id: 'off', baseUrl: 'https://api.off.test/v1', models: ['m'], enabled: false },
      ],
    },
  };

  it('serves one provider per enabled lane, advertising the typed slots', async () => {
    const providers = bridgeProviders(base, custom, sessionStore);
    expect(providers.map((p) => p.id)).toEqual(['mock', 'custom-my-provider']);
    const lane = providers.find((p) => p.id === 'custom-my-provider');
    expect(lane?.name).toBe('My Provider');
    expect(lane?.defaultModel).toBe('m1');
    expect((await lane?.listModels?.({}))?.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('coexists with the other add-on lanes', () => {
    const both: ModelHitchConfig = {
      version: 1,
      opencodeByok: { enabled: true, connections: [{ id: 'conn_a', models: ['m'] }] },
      customLanes: custom.customLanes,
      cloudAgent: { enabled: true },
    };
    const providers = bridgeProviders(base, both, sessionStore);
    expect(providers.map((p) => p.id)).toEqual([
      'mock',
      'opencode-byok-a',
      'custom-my-provider',
      CURSOR_CLOUD_PROVIDER_ID,
    ]);
  });

  it('drops custom providers on every rebuild so an edited lane replaces itself', () => {
    const previous = bridgeProviders(base, custom, sessionStore);
    // Rename the lane the way a settings Apply does: the old provider id must
    // not linger beside the new one.
    const renamed: ModelHitchConfig = {
      version: 1,
      customLanes: { enabled: true, lanes: [{ id: 'renamed', baseUrl: 'https://api.example.test/v1', models: ['m1'] }] },
    };
    expect(bridgeProviders(previous, renamed, sessionStore).map((p) => p.id)).toEqual(['mock', 'custom-renamed']);

    // Turning the block off retires every custom lane.
    const off: ModelHitchConfig = { version: 1, customLanes: { enabled: false, lanes: custom.customLanes!.lanes } };
    expect(bridgeProviders(previous, off, sessionStore).map((p) => p.id)).toEqual(['mock']);
  });
});

describe('bridgeProviders ChatGPT plan lane registration', () => {
  const enabledPlan: ModelHitchConfig = {
    version: 1,
    chatgptPlan: { enabled: true, models: ['gpt-5.1', 'gpt-5.1-mini'] },
  };

  it('serves the lane when the block is on and a credential source exists', () => {
    const providers = bridgeProviders(base, enabledPlan, sessionStore, { chatgptPlanTokens: fakeTokens });
    expect(providers.map((p) => p.id)).toEqual(['mock', CHATGPT_PLAN_PROVIDER_ID]);
    const lane = providers.find((p) => p.id === CHATGPT_PLAN_PROVIDER_ID);
    expect(lane?.name).toBe('ChatGPT plan');
    expect(lane?.defaultModel).toBe('gpt-5.1');
  });

  it('serves nothing without a credential source, however the config reads', () => {
    // Tokens live in their own protected file, not in the config document, so a
    // bridge with no store cannot serve the lane even when it is switched on.
    expect(bridgeProviders(base, enabledPlan, sessionStore).map((p) => p.id)).toEqual(['mock']);
  });

  it('serves nothing while the block is off, even with credentials on hand', () => {
    const off: ModelHitchConfig = { version: 1, chatgptPlan: { enabled: false, models: ['gpt-5.1'] } };
    expect(bridgeProviders(base, off, sessionStore, { chatgptPlanTokens: fakeTokens }).map((p) => p.id)).toEqual([
      'mock',
    ]);
  });

  it('uses the account catalogue when the config names no slots', () => {
    const noSlots: ModelHitchConfig = { version: 1, chatgptPlan: { enabled: true, models: [] } };
    const withoutCatalogue = bridgeProviders(base, noSlots, sessionStore, { chatgptPlanTokens: fakeTokens });
    expect(withoutCatalogue.map((p) => p.id)).toEqual(['mock']);

    const withCatalogue = bridgeProviders(base, noSlots, sessionStore, {
      chatgptPlanTokens: fakeTokens,
      chatgptPlanAccountModels: ['account-model-1', 'account-model-2'],
    });
    expect(withCatalogue.find((p) => p.id === CHATGPT_PLAN_PROVIDER_ID)?.defaultModel).toBe('account-model-1');
  });

  it('replaces the lane on every rebuild so a re-scoped or disabled one never lingers', () => {
    const previous = bridgeProviders(base, enabledPlan, sessionStore, { chatgptPlanTokens: fakeTokens });
    const rescoped: ModelHitchConfig = { version: 1, chatgptPlan: { enabled: true, models: ['other-model'] } };
    const rebuilt = bridgeProviders(previous, rescoped, sessionStore, { chatgptPlanTokens: fakeTokens });
    expect(rebuilt.map((p) => p.id)).toEqual(['mock', CHATGPT_PLAN_PROVIDER_ID]);
    expect(rebuilt.find((p) => p.id === CHATGPT_PLAN_PROVIDER_ID)?.defaultModel).toBe('other-model');

    // Signing out and switching the lane off retires it.
    const off: ModelHitchConfig = { version: 1, chatgptPlan: { enabled: false, models: ['other-model'] } };
    expect(bridgeProviders(rebuilt, off, sessionStore, { chatgptPlanTokens: fakeTokens }).map((p) => p.id)).toEqual([
      'mock',
    ]);
  });

  it('coexists with every other add-on lane', () => {
    const all: ModelHitchConfig = {
      version: 1,
      opencodeByok: { enabled: true, connections: [{ id: 'conn_a', models: ['m'] }] },
      customLanes: { enabled: true, lanes: [{ id: 'mine', baseUrl: 'https://api.example.test/v1', models: ['m1'] }] },
      chatgptPlan: { enabled: true, models: ['gpt-5.1'] },
      cloudAgent: { enabled: true },
    };
    expect(bridgeProviders(base, all, sessionStore, { chatgptPlanTokens: fakeTokens }).map((p) => p.id)).toEqual([
      'mock',
      'opencode-byok-a',
      'custom-mine',
      CHATGPT_PLAN_PROVIDER_ID,
      CURSOR_CLOUD_PROVIDER_ID,
    ]);
  });
});
