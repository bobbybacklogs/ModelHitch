import { ModelHitch, type ModelHitchOptions } from 'modelhitch/browser';
import { SafeStorageKeyStore, type SafeStorageKeyStoreOptions } from './safe-storage.js';

export interface ElectronModelHitchOptions extends ModelHitchOptions {
  /** Options for the default `SafeStorageKeyStore`. Ignored when `keystore` is set. */
  safeStorage?: SafeStorageKeyStoreOptions;
}

function resolve(options: ElectronModelHitchOptions): ModelHitchOptions {
  const { safeStorage, ...rest } = options;
  return { ...rest, keystore: rest.keystore ?? new SafeStorageKeyStore(safeStorage) };
}

/**
 * A ModelHitch client wired for Electron: OS-backed encrypted BYOK credentials
 * and the browser-safe provider surface (no Node bridge server in renderer
 * bundles).
 *
 * Use this in the **main process**, or in a renderer that talks to a main-process
 * keystore through {@link createIpcKeyStore}.
 *
 * ```ts
 * const mh = createElectronModelHitch({ defaultProviderId: 'openai' });
 * await mh.keystore?.set('openai', keyPastedByUser);
 * for await (const chunk of await mh.stream({ messages })) { ... }
 * ```
 */
export function createElectronModelHitch(options: ElectronModelHitchOptions = {}): ModelHitch {
  return new ModelHitch(resolve(options));
}

/**
 * Async variant for catalog mode (`{ catalog: { ... } }`), which must fetch the
 * models.dev inventory before the first call.
 */
export function createElectronModelHitchAsync(
  options: ElectronModelHitchOptions = {},
): Promise<ModelHitch> {
  return ModelHitch.create(resolve(options));
}
