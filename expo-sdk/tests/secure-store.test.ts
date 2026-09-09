import { beforeEach, describe, expect, it } from 'vitest';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { MemoryKeyStore } from 'modelhitch/browser';
import { SecureStoreKeyStore } from '../src/secure-store.js';

const store = SecureStore as unknown as typeof import('../stubs/expo-secure-store.js');
const platform = Platform as { OS: 'android' | 'ios' | 'web' };

beforeEach(() => {
  store.__reset();
  platform.OS = 'ios';
});

describe('SecureStoreKeyStore', () => {
  it('round-trips a key per provider', async () => {
    const keys = new SecureStoreKeyStore();
    await keys.set('openai', 'sk-openai');
    await keys.set('groq', 'gsk-groq');

    expect(await keys.get('openai')).toBe('sk-openai');
    expect(await keys.get('groq')).toBe('gsk-groq');
  });

  it('returns null for a provider that has no stored key', async () => {
    expect(await new SecureStoreKeyStore().get('openai')).toBeNull();
  });

  it('deletes only the requested provider', async () => {
    const keys = new SecureStoreKeyStore();
    await keys.set('openai', 'sk-openai');
    await keys.set('groq', 'gsk-groq');

    await keys.delete('openai');

    expect(await keys.get('openai')).toBeNull();
    expect(await keys.get('groq')).toBe('gsk-groq');
  });

  it('namespaces entries and keeps keys inside the SecureStore charset', async () => {
    await new SecureStoreKeyStore().set('vercel-ai-gateway', 'k');
    expect([...store.__store.keys()]).toEqual(['modelhitch_vercel-ai-gateway']);
  });

  it('sanitizes characters SecureStore rejects', async () => {
    await new SecureStoreKeyStore().set('vendor/model:1', 'k');
    expect([...store.__store.keys()]).toEqual(['modelhitch_vendor_model_1']);
  });

  it('honors a custom prefix', async () => {
    await new SecureStoreKeyStore({ prefix: 'acme' }).set('openai', 'k');
    expect([...store.__store.keys()]).toEqual(['acme_openai']);
  });

  it('forwards SecureStore options to every call', async () => {
    const secureStoreOptions = { keychainService: 'acme', requireAuthentication: true };
    const keys = new SecureStoreKeyStore({ secureStoreOptions });

    await keys.set('openai', 'k');
    await keys.get('openai');
    await keys.delete('openai');

    expect(store.__calls.map((c) => c.op)).toEqual(['set', 'get', 'delete']);
    for (const call of store.__calls) expect(call.options).toEqual(secureStoreOptions);
  });

  it('uses the web fallback instead of SecureStore on web', async () => {
    platform.OS = 'web';
    const fallback = new MemoryKeyStore();
    const keys = new SecureStoreKeyStore({ webFallback: fallback });

    await keys.set('openai', 'sk-web');

    expect(await keys.get('openai')).toBe('sk-web');
    expect(await fallback.get('openai')).toBe('sk-web');
    expect(store.__calls).toEqual([]);
  });

  it('falls back to in-memory storage on web when localStorage is missing', async () => {
    platform.OS = 'web';
    const keys = new SecureStoreKeyStore();

    await keys.set('openai', 'sk-web');

    expect(await keys.get('openai')).toBe('sk-web');
    expect(store.__calls).toEqual([]);
  });
});
