# Changelog

## 0.1.0

- Initial Electron adapter for the published `modelhitch` npm package.
- Adds `SafeStorageKeyStore` for OS-backed encrypted BYOK credentials in the main process.
- Adds renderer IPC helpers (`registerKeyStoreIpc`, `createIpcKeyStore`).
- Re-exports the browser-safe ModelHitch surface and React hooks.
