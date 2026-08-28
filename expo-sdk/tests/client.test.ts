import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { MemoryKeyStore, mockProvider } from 'modelhitch/browser';
import { expoFetch, hasStreamingFetch, installExpoFetch } from '../src/fetch.js';
import { createExpoModelHitch, createExpoModelHitchAsync } from '../src/client.js';
import { SecureStoreKeyStore } from '../src/secure-store.js';

const store = SecureStore as unknown as typeof import('../stubs/expo-secure-store.js');
const platform = Platform as { OS: 'android' | 'ios' | 'web' };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  store.__reset();
  platform.OS = 'ios';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('installExpoFetch', () => {
  it('installs the streaming fetch globally and is idempotent', () => {
    expect(hasStreamingFetch()).toBe(false);

    expect(installExpoFetch()).toBe(expoFetch);
    expect(globalThis.fetch).toBe(expoFetch);
    expect(hasStreamingFetch()).toBe(true);

    installExpoFetch();
    expect(globalThis.fetch).toBe(expoFetch);
  });
});

describe('createExpoModelHitch', () => {
  it('defaults to a SecureStore-backed keystore', async () => {
    const mh = createExpoModelHitch();
    expect(mh.keystore).toBeInstanceOf(SecureStoreKeyStore);

    await mh.keystore?.set('openai', 'sk-device');
    expect(store.__store.get('modelhitch_openai')).toBe('sk-device');
  });

  it('installs the streaming fetch by default', () => {
    createExpoModelHitch();
    expect(globalThis.fetch).toBe(expoFetch);
  });

  it('leaves globalThis.fetch alone when opted out', () => {
    createExpoModelHitch({ installGlobalFetch: false });
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('keeps an explicitly supplied keystore', () => {
    const keystore = new MemoryKeyStore();
    expect(createExpoModelHitch({ keystore }).keystore).toBe(keystore);
  });

  it('passes secureStore options through to the default keystore', async () => {
    const mh = createExpoModelHitch({ secureStore: { prefix: 'acme' } });
    await mh.keystore?.set('openai', 'k');
    expect([...store.__store.keys()]).toEqual(['acme_openai']);
  });

  it('runs a chat through the core client', async () => {
    const mh = createExpoModelHitch({ providers: [mockProvider], defaultProviderId: 'mock' });
    const result = await mh.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(typeof result.message.content).toBe('string');
  });
});

describe('createExpoModelHitchAsync', () => {
  it('resolves a client with the Expo defaults applied', async () => {
    const mh = await createExpoModelHitchAsync({ providers: [mockProvider], defaultProviderId: 'mock' });
    expect(mh.keystore).toBeInstanceOf(SecureStoreKeyStore);
    expect(globalThis.fetch).toBe(expoFetch);
  });
});
