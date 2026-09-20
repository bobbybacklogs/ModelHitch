import { ipcMain, ipcRenderer } from 'electron';
import type { KeyStore } from 'modelhitch/browser';

const CHANNEL_PREFIX = 'modelhitch:keystore';

function channel(op: 'get' | 'set' | 'delete'): string {
  return `${CHANNEL_PREFIX}:${op}`;
}

export interface RegisterKeyStoreIpcOptions {
  /** Override the default `modelhitch:keystore:*` channel prefix. */
  channelPrefix?: string;
}

/**
 * Register IPC handlers in the **main process** so renderer code can read and
 * write BYOK credentials without direct access to `safeStorage`.
 */
export function registerKeyStoreIpc(
  store: KeyStore,
  options: RegisterKeyStoreIpcOptions = {},
): void {
  const prefix = options.channelPrefix ?? CHANNEL_PREFIX;
  const ch = (op: 'get' | 'set' | 'delete') => `${prefix}:${op}`;

  ipcMain.handle(ch('get'), async (_event: unknown, providerId: string) => store.get(providerId));
  ipcMain.handle(ch('set'), async (_event: unknown, providerId: string, apiKey: string) => {
    await store.set(providerId, apiKey);
  });
  ipcMain.handle(ch('delete'), async (_event: unknown, providerId: string) => {
    await store.delete(providerId);
  });
}

export interface IpcKeyStoreOptions {
  /** Must match {@link RegisterKeyStoreIpcOptions.channelPrefix} on the main process. */
  channelPrefix?: string;
}

/**
 * Renderer-side `KeyStore` that delegates to the main process over IPC.
 */
export class IpcKeyStore implements KeyStore {
  private readonly prefix: string;

  constructor(options: IpcKeyStoreOptions = {}) {
    this.prefix = options.channelPrefix ?? CHANNEL_PREFIX;
  }

  private ch(op: 'get' | 'set' | 'delete'): string {
    return `${this.prefix}:${op}`;
  }

  async get(providerId: string): Promise<string | null> {
    return ipcRenderer.invoke(this.ch('get'), providerId) as Promise<string | null>;
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    await ipcRenderer.invoke(this.ch('set'), providerId, apiKey);
  }

  async delete(providerId: string): Promise<void> {
    await ipcRenderer.invoke(this.ch('delete'), providerId);
  }
}

/**
 * Convenience factory for renderer windows.
 */
export function createIpcKeyStore(options: IpcKeyStoreOptions = {}): IpcKeyStore {
  return new IpcKeyStore(options);
}
