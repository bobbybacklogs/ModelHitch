// Local stub for `electron`. In-memory, mirrors the API surface the adapter
// touches. Never bundled or published.
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const __userData = join(tmpdir(), 'modelhitch-electron-stub-userdata');
export const __state = { encryptionAvailable: true };
export const __ipcHandlers = new Map<string, (...args: any[]) => unknown>();
export const __ipcCalls: Array<{ channel: string; args: unknown[] }> = [];

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return __state.encryptionAvailable;
  },
  encryptString(plainText: string): Buffer {
    return Buffer.from(`enc:${plainText}`, 'utf8');
  },
  decryptString(encrypted: Buffer): string {
    const value = encrypted.toString('utf8');
    if (!value.startsWith('enc:')) throw new Error('decrypt failed');
    return value.slice(4);
  },
};

export const app = {
  getPath(name: string): string {
    if (name === 'userData') return __userData;
    throw new Error(`unsupported app path: ${name}`);
  },
};

export const ipcMain = {
  handle(channel: string, listener: (...args: any[]) => unknown): void {
    __ipcHandlers.set(channel, listener);
  },
};

export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    __ipcCalls.push({ channel, args });
    const handler = __ipcHandlers.get(channel);
    if (!handler) throw new Error(`no ipc handler for ${channel}`);
    return handler({} as unknown, ...args);
  },
};

export function __reset(): void {
  __ipcHandlers.clear();
  __ipcCalls.length = 0;
}

export async function __resetStorage(): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(__userData, { recursive: true, force: true });
  await mkdir(__userData, { recursive: true });
}
