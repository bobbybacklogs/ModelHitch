// Minimal Electron surface for publish-time typechecking. Consumers resolve the
// real `electron` peer at runtime; this file avoids requiring the Electron
// binary download during `npm run typecheck:pkg` / `prepublishOnly`.
declare module 'electron' {
  export const safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plainText: string): Buffer;
    decryptString(encrypted: Buffer): string;
  };

  export const app: {
    getPath(name: string): string;
  };

  export const ipcMain: {
    handle(channel: string, listener: (...args: any[]) => unknown): void;
  };

  export const ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  };
}
