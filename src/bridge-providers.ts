import type { ModelHitchConfig } from './config.js';
import { createCursorCloudProvider, CURSOR_CLOUD_PROVIDER_ID } from './providers/cursor-cloud.js';
import { CursorCloudSessionStore } from './providers/cursor-cloud-session.js';
import type { Provider } from './providers/types.js';

/** Built-in registry (or catalog) providers plus optional cursor-cloud when enabled. */
export function bridgeProviders(
  base: readonly Provider[],
  config: ModelHitchConfig,
  sessionStore: CursorCloudSessionStore,
): Provider[] {
  const providers = [...base];
  if (!config.cloudAgent?.enabled) {
    return providers.filter((p) => p.id !== CURSOR_CLOUD_PROVIDER_ID);
  }
  if (!providers.some((p) => p.id === CURSOR_CLOUD_PROVIDER_ID)) {
    providers.push(
      createCursorCloudProvider({
        config: config.cloudAgent,
        sessionStore,
      }),
    );
  }
  return providers;
}
