// ModelHitch for Expo — React Native adapter around the browser-safe core.
//
// Apps should import from this package rather than `modelhitch` directly:
// Metro does not resolve the `browser` export condition, so a bare
// `modelhitch` import would pull in the Node bridge server and `node:sqlite`.

export * from 'modelhitch/browser';

export { expoFetch, installExpoFetch, hasStreamingFetch } from './fetch.js';
export { SecureStoreKeyStore, type SecureStoreKeyStoreOptions } from './secure-store.js';
export { createExpoModelHitch, createExpoModelHitchAsync, type ExpoModelHitchOptions } from './client.js';
