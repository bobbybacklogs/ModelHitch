import type { ModelHitchConfig } from './config.js';
import { createCursorCloudProvider, CURSOR_CLOUD_PROVIDER_ID } from './providers/cursor-cloud.js';
import { CursorCloudSessionStore } from './providers/cursor-cloud-session.js';
import { openCodeByokProviders, type OpenCodeLocalState } from './opencode-byok.js';
import { isOpenCodeByokProviderId } from './providers/opencode-byok.js';
import type { Provider } from './providers/types.js';

/**
 * Built-in registry (or catalog) providers plus the optional lanes the config
 * switches on: Cursor Cloud Agent and the OpenCode Console BYOK connections.
 *
 * Both are add-ons, so they are filtered out when their config block is off —
 * a bridge configured without them serves exactly the registry it always did.
 */
export function bridgeProviders(
  base: readonly Provider[],
  config: ModelHitchConfig,
  sessionStore: CursorCloudSessionStore,
  context: { openCodeState?: OpenCodeLocalState } = {},
): Provider[] {
  const byok = openCodeByokProviders(config, { state: context.openCodeState });
  // BYOK connections are rebuilt from config on every call: a renamed, edited,
  // or disabled connection must never linger from a previous reconfigure, so
  // every existing BYOK provider is dropped before the fresh set is appended.
  const merged = base.filter((p) => !isOpenCodeByokProviderId(p.id));
  for (const provider of byok) {
    if (!merged.some((p) => p.id === provider.id)) merged.push(provider);
  }

  if (!config.cloudAgent?.enabled) {
    return merged.filter((p) => p.id !== CURSOR_CLOUD_PROVIDER_ID);
  }
  if (!merged.some((p) => p.id === CURSOR_CLOUD_PROVIDER_ID)) {
    merged.push(
      createCursorCloudProvider({
        config: config.cloudAgent,
        sessionStore,
      }),
    );
  }
  return merged;
}
