import { describe, expect, it } from 'vitest';
import { applySettingsForm, configToSettingsForm, type SettingsFormState } from '../src/settings-form.js';
import type { ModelHitchConfig } from '../src/config.js';

const config: ModelHitchConfig = {
  version: 1,
  defaultProviderId: 'openai',
  defaultModel: 'gpt-4o-mini',
  policy: { trusted: [{ providerId: 'openai' }], fallback: [{ providerId: 'gemini' }] },
  catalog: { providers: ['openai', 'gemini'], ttlMs: 5000 },
  cooldown: { type: 'circuit-breaker', failureThreshold: 3, baseTripMs: 15000, maxTripMs: 120000 },
  imageGeneration: { enabled: false, providerId: 'openai', model: 'gpt-image-2', quality: 'medium', size: '1024x1024' },
  keys: { openai: 'sk-secret', gemini: 'gemini-secret' },
};

function form(overrides: Partial<SettingsFormState> = {}): SettingsFormState {
  return { ...configToSettingsForm(config), ...overrides };
}

describe('settings TUI form mapping', () => {
  it('round-trips editable fields without exposing or dropping untouched config', () => {
    const next = applySettingsForm(config, form({ defaultModel: 'gpt-5', imageEnabled: true }));
    expect(next.defaultModel).toBe('gpt-5');
    expect(next.imageGeneration?.enabled).toBe(true);
    expect(next.keys).toEqual(config.keys);
    expect(next.policy).toEqual(config.policy);
    expect(next.catalog).toEqual(config.catalog);
  });

  it('edits trusted and fallback rotation lanes with compact route syntax', () => {
    const next = applySettingsForm(config, form({
      trustedLanes: 'openai/gpt-5,gpt-4.1; vercel-ai-gateway/openai/gpt-5.4',
      fallbackLanes: 'vercel-ai-gateway/anthropic/claude-sonnet-4.6; ollama',
    }));
    expect(next.policy).toEqual({
      trusted: [
        { providerId: 'openai', models: ['gpt-5', 'gpt-4.1'] },
        { providerId: 'vercel-ai-gateway', models: ['openai/gpt-5.4'] },
      ],
      fallback: [
        { providerId: 'vercel-ai-gateway', models: ['anthropic/claude-sonnet-4.6'] },
        { providerId: 'ollama' },
      ],
    });
  });

  it('rejects incomplete lane routes before writing', () => {
    expect(() => applySettingsForm(config, form({ trustedLanes: 'openai/' }))).toThrow(/must name a model/);
  });

  it('maps Gemini and memory cooldown settings', () => {
    const next = applySettingsForm(config, form({
      imageProvider: 'gemini',
      imageModel: 'gemini-3.1-flash-image',
      cooldownType: 'memory',
    }));
    expect(next.imageGeneration).toEqual({
      enabled: false,
      providerId: 'gemini',
      model: 'gemini-3.1-flash-image',
      quality: undefined,
      size: '1024x1024',
    });
    expect(next.cooldown).toEqual({ type: 'memory' });
  });

  it('rejects invalid numeric and image combinations before write', () => {
    expect(() => applySettingsForm(config, form({ cooldownType: 'circuit-breaker', failureThreshold: '0' }))).toThrow(/positive integer/);
    expect(() => applySettingsForm(config, form({ imageModel: 'gpt-image-1.5', imageQuality: 'low' }))).toThrow(/medium quality/);
  });

  it('removes optional defaults when fields are cleared', () => {
    const next = applySettingsForm(config, form({ defaultProviderId: ' ', defaultModel: '' }));
    expect(next.defaultProviderId).toBeUndefined();
    expect(next.defaultModel).toBeUndefined();
  });
});