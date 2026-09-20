import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { MemoryKeyStore, type KeyStore } from 'modelhitch/browser';

const DEFAULT_PREFIX = 'modelhitch';

function storeFileName(prefix: string, providerId: string): string {
  return `${prefix}_${providerId}`.replace(/[^A-Za-z0-9._-]/g, '_') + '.enc';
}

export interface SafeStorageKeyStoreOptions {
  /** Namespace prepended to every on-disk entry. Default `"modelhitch"`. */
  prefix?: string;
  /**
   * Directory for encrypted key files. Defaults to
   * `app.getPath('userData')/modelhitch-keys`.
   */
  storageDir?: string;
  /**
   * KeyStore used when `safeStorage.isEncryptionAvailable()` is false (for
   * example, some Linux setups without a Secret Service provider). Defaults to
   * `MemoryKeyStore`, which does not persist across restarts.
   */
  fallback?: KeyStore;
}

/**
 * ModelHitch `KeyStore` backed by Electron `safeStorage`: keys are encrypted
 * with the OS credential store and written to the app's user-data directory.
 *
 * Run this in the **main process**. Renderer windows should use
 * {@link createIpcKeyStore} with {@link registerKeyStoreIpc} instead.
 */
export class SafeStorageKeyStore implements KeyStore {
  private readonly prefix: string;
  private readonly storageDir: string;
  private readonly fallback: KeyStore | null;
  private resolvedDir: string | null = null;

  constructor(options: SafeStorageKeyStoreOptions = {}) {
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.storageDir = options.storageDir ?? join(app.getPath('userData'), 'modelhitch-keys');
    this.fallback = safeStorage.isEncryptionAvailable() ? null : (options.fallback ?? new MemoryKeyStore());
  }

  private async dir(): Promise<string> {
    if (!this.resolvedDir) {
      await mkdir(this.storageDir, { recursive: true });
      this.resolvedDir = this.storageDir;
    }
    return this.resolvedDir;
  }

  private async fileFor(providerId: string): Promise<string> {
    return join(await this.dir(), storeFileName(this.prefix, providerId));
  }

  async get(providerId: string): Promise<string | null> {
    if (this.fallback) return this.fallback.get(providerId);
    try {
      const encrypted = await readFile(await this.fileFor(providerId));
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    if (this.fallback) return this.fallback.set(providerId, apiKey);
    const encrypted = safeStorage.encryptString(apiKey);
    await writeFile(await this.fileFor(providerId), encrypted);
  }

  async delete(providerId: string): Promise<void> {
    if (this.fallback) return this.fallback.delete(providerId);
    try {
      await unlink(await this.fileFor(providerId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
