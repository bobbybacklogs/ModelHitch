import {
  CHATGPT_PLAN_PROVIDER_ID,
  type ChatGptPlanTokenSource,
  resolveChatGptPlan,
} from './chatgpt-plan.js';
import type { ModelHitchConfig } from './config.js';
import { createChatGptPlanProvider, type ChatGptPlanProviderOptions } from './providers/chatgpt-plan.js';
import type { Provider } from './providers/types.js';

/**
 * Runtime wiring for the ChatGPT plan lane.
 *
 * `chatgpt-plan.ts` decides *where the lane sits* in the routing plan; this
 * module is the one place that turns that decision into a `Provider`, so the
 * bridge, the harness, and the tests all build the same object from the same
 * config block.
 *
 * The lane needs a credential source, not a key in `config.keys`. When no
 * source is supplied — or the block is off, or no model slug is known — no
 * provider is built at all, which is how an unsigned bridge serves exactly the
 * registry it always did.
 *
 * A separate module rather than a function in `chatgpt-plan.ts` so the import
 * graph stays one-directional: the provider adapter imports the plan module's
 * constants and types, and this module imports both.
 */

export interface ChatGptPlanLaneOptions {
  /**
   * Credentials for the lane. Absent means the lane cannot serve, so nothing is
   * built.
   */
  tokens?: ChatGptPlanTokenSource;
  /**
   * Model slugs reported by the signed-in account, used when the config lists
   * none. Read once at startup by the caller.
   */
  accountModels?: readonly string[];
  fetchImpl?: typeof fetch;
  /**
   * API root override. The lane talks to the public Responses endpoint by
   * default; this exists for a self-hosted proxy or a regional gateway, and
   * lets a test drive the lane against a local server.
   */
  baseUrl?: string;
  capabilities?: ChatGptPlanProviderOptions['capabilities'];
  /** Diagnostics hook, forwarded to the adapter. Never a control path. */
  onHttpError?: ChatGptPlanProviderOptions['onHttpError'];
}

/** One `Provider` for the lane, or none when it cannot serve. */
export function chatGptPlanProviders(
  config: ModelHitchConfig | undefined,
  options: ChatGptPlanLaneOptions = {},
): Provider[] {
  const { tokens } = options;
  if (!tokens) return [];
  const lane = resolveChatGptPlan(config, { accountModels: options.accountModels });
  if (!lane) return [];

  return [
    createChatGptPlanProvider({
      tokens,
      models: lane.models,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.onHttpError ? { onHttpError: options.onHttpError } : {}),
    }),
  ];
}

/**
 * True when a provider belongs to this lane.
 *
 * Used to drop a stale provider before rebuilding, so a disabled or re-scoped
 * lane never lingers beside its replacement.
 */
export function isChatGptPlanProviderId(providerId: string): boolean {
  return providerId === CHATGPT_PLAN_PROVIDER_ID;
}

/**
 * Read the signed-in account's model slugs.
 *
 * ChatGPT plan catalogs are account-specific, so the bridge asks rather than
 * guessing. A failure returns an empty list instead of throwing: a bridge must
 * still start when the catalog cannot be read, and the lane simply serves
 * nothing until the config names a slug.
 */
export async function listChatGptPlanAccountModels(options: {
  tokens?: ChatGptPlanTokenSource;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): Promise<string[]> {
  const { tokens } = options;
  if (!tokens) return [];
  const probe = createChatGptPlanProvider({
    tokens,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
  if (!probe.listModels) return [];
  try {
    const models = await probe.listModels({});
    return [...new Set(models.map((model) => model.id).filter(Boolean))];
  } catch {
    return [];
  }
}
