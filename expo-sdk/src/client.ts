import { ModelHitch, type ModelHitchOptions } from 'modelhitch/browser';
import { installExpoFetch } from './fetch.js';
import { SecureStoreKeyStore, type SecureStoreKeyStoreOptions } from './secure-store.js';

export interface ExpoModelHitchOptions extends ModelHitchOptions {
  /** Options for the default `SecureStoreKeyStore`. Ignored when `keystore` is set. */
  secureStore?: SecureStoreKeyStoreOptions;
  /**
   * Install Expo's streaming `fetch` globally so the built-in providers can
   * stream token deltas. Default `true`. Set to `false` if the app manages
   * `globalThis.fetch` itself.
   */
  installGlobalFetch?: boolean;
}

function resolve(options: ExpoModelHitchOptions): ModelHitchOptions {
  const { secureStore, installGlobalFetch = true, ...rest } = options;
  if (installGlobalFetch) installExpoFetch();
  return { ...rest, keystore: rest.keystore ?? new SecureStoreKeyStore(secureStore) };
}

/**
 * A ModelHitch client wired for Expo: streaming `fetch` and device-encrypted
 * BYOK credentials, with every built-in provider available.
 *
 * ```ts
 * const mh = createExpoModelHitch({ defaultProviderId: 'openai' });
 * await mh.keystore?.set('openai', keyPastedByUser);
 * for await (const chunk of await mh.stream({ messages })) { ... }
 * ```
 */
export function createExpoModelHitch(options: ExpoModelHitchOptions = {}): ModelHitch {
  return new ModelHitch(resolve(options));
}

/**
 * Async variant for catalog mode (`{ catalog: { ... } }`), which must fetch the
 * models.dev inventory before the first call.
 */
export function createExpoModelHitchAsync(options: ExpoModelHitchOptions = {}): Promise<ModelHitch> {
  return ModelHitch.create(resolve(options));
}
