import { beforeEach, describe, expect, it } from 'vitest';
import * as electron from 'electron';
import { MemoryKeyStore } from 'modelhitch/browser';
import { createIpcKeyStore, registerKeyStoreIpc } from '../src/ipc.js';

const stub = electron as typeof import('../stubs/electron.js');

beforeEach(() => {
  stub.__reset();
});

describe('registerKeyStoreIpc', () => {
  it('proxies get, set, and delete between processes', async () => {
    const mainStore = new MemoryKeyStore();
    registerKeyStoreIpc(mainStore);

    const rendererStore = createIpcKeyStore();

    await rendererStore.set('openai', 'sk-device');
    expect(await rendererStore.get('openai')).toBe('sk-device');
    await rendererStore.delete('openai');
    expect(await rendererStore.get('openai')).toBeNull();
  });

  it('honors a custom channel prefix', async () => {
    const mainStore = new MemoryKeyStore();
    registerKeyStoreIpc(mainStore, { channelPrefix: 'acme:keys' });

    const rendererStore = createIpcKeyStore({ channelPrefix: 'acme:keys' });
    await rendererStore.set('openai', 'k');

    expect(stub.__ipcCalls.map((call) => call.channel)).toContain('acme:keys:set');
  });
});
