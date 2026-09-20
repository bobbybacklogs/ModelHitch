import { beforeEach, describe, expect, it } from 'vitest';
import * as electron from 'electron';
import { MemoryKeyStore, mockProvider } from 'modelhitch/browser';
import { createElectronModelHitch, createElectronModelHitchAsync } from '../src/client.js';
import { SafeStorageKeyStore } from '../src/safe-storage.js';

const stub = electron as typeof import('../stubs/electron.js');

beforeEach(async () => {
  stub.__reset();
  await stub.__resetStorage();
});

describe('createElectronModelHitch', () => {
  it('defaults to a SafeStorage-backed keystore', async () => {
    const mh = createElectronModelHitch();
    expect(mh.keystore).toBeInstanceOf(SafeStorageKeyStore);

    await mh.keystore?.set('openai', 'sk-device');
    expect(await mh.keystore?.get('openai')).toBe('sk-device');
  });

  it('keeps an explicitly supplied keystore', () => {
    const keystore = new MemoryKeyStore();
    expect(createElectronModelHitch({ keystore }).keystore).toBe(keystore);
  });

  it('passes safeStorage options through to the default keystore', async () => {
    const mh = createElectronModelHitch({ safeStorage: { prefix: 'acme' } });
    await mh.keystore?.set('openai', 'k');
    expect(await mh.keystore?.get('openai')).toBe('k');
  });

  it('runs a chat through the core client', async () => {
    const mh = createElectronModelHitch({ providers: [mockProvider], defaultProviderId: 'mock' });
    const result = await mh.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(typeof result.message.content).toBe('string');
  });
});

describe('createElectronModelHitchAsync', () => {
  it('resolves a client with the Electron defaults applied', async () => {
    const mh = await createElectronModelHitchAsync({ providers: [mockProvider], defaultProviderId: 'mock' });
    expect(mh.keystore).toBeInstanceOf(SafeStorageKeyStore);
  });
});
