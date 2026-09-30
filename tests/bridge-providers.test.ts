import { describe, expect, it } from 'vitest';
import { bridgeProviders } from '../src/bridge-providers.js';
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
