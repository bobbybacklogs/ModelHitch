import { describe, expect, it } from 'vitest';
import {
  inferRequirements,
  satisfiesRequirements,
  filterEligibleLanes,
  CapabilityUnavailableError,
  isCapabilityUnavailableError,
} from '../src/core/capabilities.js';
import type { Capabilities } from '../src/core/types.js';

const caps = (overrides: Partial<Capabilities> = {}): Capabilities => ({
  streaming: true,
  toolCalling: true,
  vision: true,
  embeddings: true,
  ...overrides,
});

describe('inferRequirements', () => {
  it('infers no requirements from a plain text request', () => {
    expect(inferRequirements({ tools: undefined })).toEqual({});
    expect(inferRequirements({ tools: [] })).toEqual({});
  });

  it('infers toolCalling when tools are present', () => {
    expect(inferRequirements({ tools: [{ name: 'get_weather' }] })).toEqual({ toolCalling: true });
  });

  it('merges in extra requirements the caller already knows about', () => {
    expect(inferRequirements({ tools: undefined }, { streaming: true })).toEqual({ streaming: true });
    expect(inferRequirements({ tools: [{ name: 'x' }] }, { streaming: true })).toEqual({
      streaming: true,
      toolCalling: true,
    });
  });
});

describe('satisfiesRequirements', () => {
  it('is true when no requirement is set', () => {
    expect(satisfiesRequirements(caps({ toolCalling: false }), {})).toBe(true);
  });

  it('is false when a required capability is missing', () => {
    expect(satisfiesRequirements(caps({ toolCalling: false }), { toolCalling: true })).toBe(false);
  });

  it('is true when every required capability is present', () => {
    expect(satisfiesRequirements(caps(), { toolCalling: true, vision: true })).toBe(true);
  });

  it('ignores requirement keys explicitly set to false', () => {
    expect(satisfiesRequirements(caps({ vision: false }), { vision: false })).toBe(true);
  });
});

describe('filterEligibleLanes', () => {
  const targets = [
    { providerId: 'a', model: 'a-model' },
    { providerId: 'b', model: 'b-model' },
    { providerId: 'c', model: 'c-model' },
  ];
  const capabilitiesFor = (t: (typeof targets)[number]) =>
    ({ a: caps({ toolCalling: false }), b: caps({ toolCalling: true }), c: caps({ toolCalling: false }) })[
      t.providerId
    ];

  it('returns every target unchanged when nothing is required', () => {
    const { eligible, skipped } = filterEligibleLanes(targets, {}, capabilitiesFor);
    expect(eligible).toEqual(targets);
    expect(skipped).toEqual([]);
  });

  it('skips lanes whose provider lacks the required capability', () => {
    const { eligible, skipped } = filterEligibleLanes(targets, { toolCalling: true }, capabilitiesFor);
    expect(eligible).toEqual([{ providerId: 'b', model: 'b-model' }]);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatchObject({ target: { providerId: 'a', model: 'a-model' } });
    expect(skipped[0]!.reason).toMatch(/toolCalling/);
  });

  it('treats an unknown provider (no capabilities) as eligible — fail open, let the call surface its own error', () => {
    const { eligible, skipped } = filterEligibleLanes(
      targets,
      { toolCalling: true },
      () => undefined,
    );
    expect(eligible).toEqual(targets);
    expect(skipped).toEqual([]);
  });
});

describe('CapabilityUnavailableError', () => {
  it('carries the requirements and the skipped lanes, and is identifiable via the type guard', () => {
    const err = new CapabilityUnavailableError(
      { toolCalling: true },
      [{ target: { providerId: 'a', model: 'a-model' }, reason: 'missing required capability: toolCalling' }],
    );
    expect(err.code).toBe('capability-unavailable');
    expect(err.status).toBe(400);
    expect(err.requirements).toEqual({ toolCalling: true });
    expect(err.skipped).toHaveLength(1);
    expect(err.message).toContain('toolCalling');
    expect(err.message).toContain('a/a-model');
    expect(isCapabilityUnavailableError(err)).toBe(true);
    expect(isCapabilityUnavailableError(new Error('nope'))).toBe(false);
  });
});
