// Local stub for `expo-secure-store`. In-memory, mirrors the real API surface
// the adapter touches. Never bundled or published.
export interface SecureStoreOptions {
  accessGroup?: string;
  authenticationPrompt?: string;
  keychainAccessible?: number;
  keychainService?: string;
  requireAuthentication?: boolean;
}

export const __store = new Map<string, string>();
export const __calls: Array<{ op: string; key: string; options: SecureStoreOptions }> = [];

export async function getItemAsync(key: string, options: SecureStoreOptions = {}): Promise<string | null> {
  __calls.push({ op: 'get', key, options });
  return __store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string, options: SecureStoreOptions = {}): Promise<void> {
  __calls.push({ op: 'set', key, options });
  __store.set(key, value);
}

export async function deleteItemAsync(key: string, options: SecureStoreOptions = {}): Promise<void> {
  __calls.push({ op: 'delete', key, options });
  __store.delete(key);
}

export function __reset(): void {
  __store.clear();
  __calls.length = 0;
}
