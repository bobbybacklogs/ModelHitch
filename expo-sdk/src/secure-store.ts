import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { LocalStorageKeyStore, MemoryKeyStore, type KeyStore } from 'modelhitch/browser';

const DEFAULT_PREFIX = 'modelhitch';

/** SecureStore only accepts alphanumerics, `.`, `-`, and `_` in a key. */
function storeKey(prefix: string, providerId: string): string {
  return `${prefix}_${providerId}`.replace(/[^A-Za-z0-9._-]/g, '_');
}

export interface SecureStoreKeyStoreOptions {
  /** Namespace prepended to every entry. Default `"modelhitch"`. */
  prefix?: string;
  /**
   * Forwarded to every `expo-secure-store` call — `keychainService`,
   * `keychainAccessible`, `requireAuthentication`, `authenticationPrompt`, ...
   * The same options must be used for reads and writes.
   */
  secureStoreOptions?: SecureStore.SecureStoreOptions;
  /**
   * KeyStore used on Expo web, where `expo-secure-store` has no native
   * backing. Defaults to `LocalStorageKeyStore` when `localStorage` exists and
   * `MemoryKeyStore` otherwise. Web storage is **not** encrypted.
   */
  webFallback?: KeyStore;
}

/**
 * ModelHitch `KeyStore` backed by `expo-secure-store`: the Android Keystore on
 * Android and the iOS keychain on iOS. Keys the user pastes stay encrypted on
 * their device and are read straight from the store on each request — they
 * never need to reach your backend.
 *
 * ```ts
 * const keys = new SecureStoreKeyStore();
 * await keys.set('openai', keyPastedByUser);
 * const mh = createExpoModelHitch({ keystore: keys });
 * ```
 */
export class SecureStoreKeyStore implements KeyStore {
  private readonly prefix: string;
  private readonly options: SecureStore.SecureStoreOptions;
  private readonly fallback: KeyStore | null;

  constructor(options: SecureStoreKeyStoreOptions = {}) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.options = options.secureStoreOptions ?? {};
    this.fallback = Platform.OS === 'web' ? (options.webFallback ?? defaultWebFallback()) : null;
  }

  async get(providerId: string): Promise<string | null> {
    if (this.fallback) return this.fallback.get(providerId);
    return SecureStore.getItemAsync(storeKey(this.prefix, providerId), this.options);
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    if (this.fallback) return this.fallback.set(providerId, apiKey);
    await SecureStore.setItemAsync(storeKey(this.prefix, providerId), apiKey, this.options);
  }

  async delete(providerId: string): Promise<void> {
    if (this.fallback) return this.fallback.delete(providerId);
    await SecureStore.deleteItemAsync(storeKey(this.prefix, providerId), this.options);
  }
}

function defaultWebFallback(): KeyStore {
  const storage = (globalThis as { localStorage?: Storage }).localStorage;
  return storage ? new LocalStorageKeyStore(storage) : new MemoryKeyStore();
}
