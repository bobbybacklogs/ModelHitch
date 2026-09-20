// ModelHitch for Electron — desktop adapter around the browser-safe core.
//
// Electron renderer bundles should import from this package rather than
// `modelhitch` directly: some bundlers resolve the Node entry and pull in the
// bridge server and `node:sqlite`.

export * from 'modelhitch/browser';

export { SafeStorageKeyStore, type SafeStorageKeyStoreOptions } from './safe-storage.js';
export {
  createElectronModelHitch,
  createElectronModelHitchAsync,
  type ElectronModelHitchOptions,
} from './client.js';
