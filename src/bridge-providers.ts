import type { ModelHitchConfig } from './config.js';
import { chatGptPlanProviders, isChatGptPlanProviderId } from './chatgpt-plan-lane.js';
import type { ChatGptPlanTokenSource } from './chatgpt-plan.js';
import { customLaneProviders } from './custom-lanes.js';
import { createCursorCloudProvider, CURSOR_CLOUD_PROVIDER_ID } from './providers/cursor-cloud.js';
import { CursorCloudSessionStore } from './providers/cursor-cloud-session.js';
import { openCodeByokProviders, type OpenCodeLocalState } from './opencode-byok.js';
import { isCustomLaneProviderId } from './providers/custom-lane.js';
import { isOpenCodeByokProviderId } from './providers/opencode-byok.js';
import type { Provider } from './providers/types.js';

/** Runtime inputs the optional lanes need beyond the config document. */
export interface BridgeProviderContext {
  openCodeState?: OpenCodeLocalState;
  /**
   * Credentials for the Sign in with ChatGPT lane. Absent means the lane is not
   * served, whatever the config says — the block holds routing preferences, and
   * the tokens live in their own protected file.
   */
  chatgptPlanTokens?: ChatGptPlanTokenSource;
  /** Model slugs read from the signed-in ChatGPT account. */
  chatgptPlanAccountModels?: readonly string[];
  /**
   * Overrides the ChatGPT plan lane's API root. Unset means the public
   * Responses endpoint. Set it for a self-hosted proxy, or to drive the lane
   * against a local server in a test.
   */
  chatgptPlanBaseUrl?: string;
  /** Transport for the ChatGPT plan lane. Unset means the global `fetch`. */
  chatgptPlanFetch?: typeof fetch;
}

/**
 * Built-in registry (or catalog) providers plus the optional lanes the config
 * switches on: Cursor Cloud Agent, the OpenCode Console BYOK connections, the
 * user's own custom BYOK lanes, and the Sign in with ChatGPT plan lane.
 *
 * All four are add-ons, so they are filtered out when their config block is
 * off — a bridge configured without them serves exactly the registry it always
 * did.
 */
export function bridgeProviders(
  base: readonly Provider[],
  config: ModelHitchConfig,
  sessionStore: CursorCloudSessionStore,
  context: BridgeProviderContext = {},
): Provider[] {
  const byok = openCodeByokProviders(config, { state: context.openCodeState });
  // BYOK connections are rebuilt from config on every call: a renamed, edited,
  // or disabled connection must never linger from a previous reconfigure, so
  // every existing BYOK provider is dropped before the fresh set is appended.
  const merged = base.filter((p) => !isOpenCodeByokProviderId(p.id));
  for (const provider of byok) {
    if (!merged.some((p) => p.id === provider.id)) merged.push(provider);
  }

  // Custom lanes are dropped and rebuilt on every call for the same reason: an
  // edited URL, key, or model slot must replace the lane, never linger beside it.
  const custom = customLaneProviders(config);
  const withCustom = merged.filter((p) => !isCustomLaneProviderId(p.id));
  for (const provider of custom) {
    if (!withCustom.some((p) => p.id === provider.id)) withCustom.push(provider);
  }

  // The ChatGPT plan lane is also rebuilt every time: signing out, switching
  // accounts, or re-scoping the model slots must replace it outright.
  const chatgptPlan = chatGptPlanProviders(config, {
    ...(context.chatgptPlanTokens ? { tokens: context.chatgptPlanTokens } : {}),
    ...(context.chatgptPlanAccountModels ? { accountModels: context.chatgptPlanAccountModels } : {}),
    ...(context.chatgptPlanBaseUrl ? { baseUrl: context.chatgptPlanBaseUrl } : {}),
    ...(context.chatgptPlanFetch ? { fetchImpl: context.chatgptPlanFetch } : {}),
  });
  const withPlan = withCustom.filter((p) => !isChatGptPlanProviderId(p.id));
  for (const provider of chatgptPlan) {
    if (!withPlan.some((p) => p.id === provider.id)) withPlan.push(provider);
  }

  if (!config.cloudAgent?.enabled) {
    return withPlan.filter((p) => p.id !== CURSOR_CLOUD_PROVIDER_ID);
  }
  if (!withPlan.some((p) => p.id === CURSOR_CLOUD_PROVIDER_ID)) {
    withPlan.push(
      createCursorCloudProvider({
        config: config.cloudAgent,
        sessionStore,
      }),
    );
  }
  return withPlan;
}
