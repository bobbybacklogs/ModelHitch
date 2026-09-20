import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as electron from 'electron';
import { MemoryKeyStore } from 'modelhitch/browser';
import { SafeStorageKeyStore } from '../src/safe-storage.js';

const stub = electron as typeof import('../stubs/electron.js');

beforeEach(async () => {
  stub.__reset();
  await stub.__resetStorage();
});

afterEach(() => {
  stub.__state.encryptionAvailable = true;
});

describe('SafeStorageKeyStore', () => {
  it('round-trips a key per provider', async () => {
    const keys = new SafeStorageKeyStore();
    await keys.set('openai', 'sk-openai');
    await keys.set('groq', 'gsk-groq');

    expect(await keys.get('openai')).toBe('sk-openai');
    expect(await keys.get('groq')).toBe('gsk-groq');
  });

  it('returns null for a provider that has no stored key', async () => {
    expect(await new SafeStorageKeyStore().get('openai')).toBeNull();
  });

  it('deletes only the requested provider', async () => {
    const keys = new SafeStorageKeyStore();
    await keys.set('openai', 'sk-openai');
    await keys.set('groq', 'gsk-groq');

    await keys.delete('openai');

    expect(await keys.get('openai')).toBeNull();
    expect(await keys.get('groq')).toBe('gsk-groq');
  });

  it('writes encrypted files under the configured storage directory', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'modelhitch-keys-'));
    const keys = new SafeStorageKeyStore({ storageDir, prefix: 'acme' });

    await keys.set('openai', 'sk-openai');

    const files = await readdir(storageDir);
    expect(files).toEqual(['acme_openai.enc']);
    const encrypted = await readFile(join(storageDir, 'acme_openai.enc'), 'utf8');
    expect(encrypted).toBe('enc:sk-openai');
  });

  it('sanitizes provider ids in filenames', async () => {
    const storageDir = await mkdtemp(join(tmpdir(), 'modelhitch-keys-'));
    const keys = new SafeStorageKeyStore({ storageDir });

    await keys.set('vendor/model:1', 'k');

    const files = await readdir(storageDir);
    expect(files).toEqual(['modelhitch_vendor_model_1.enc']);
  });

  it('uses the fallback keystore when OS encryption is unavailable', async () => {
    stub.__state.encryptionAvailable = false;
    const fallback = new MemoryKeyStore();
    const keys = new SafeStorageKeyStore({ fallback });

    await keys.set('openai', 'sk-fallback');

    expect(await keys.get('openai')).toBe('sk-fallback');
    expect(await fallback.get('openai')).toBe('sk-fallback');
  });
});
