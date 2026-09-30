import { describe, expect, it } from 'vitest';
import {
  RISK_PREVIEW_CHARS,
  buildRiskRequest,
  createRiskClassifier,
  mayAutoApprove,
  parseRiskResponse,
  riskCacheKey,
  riskTone,
  UNCLASSIFIED,
} from '../harness/risk.js';

/**
 * The risk label is advice attached to a gate, so the cases that matter are the
 * ones where it could quietly become a gate of its own. A classifier that
 * cannot answer must leave the prompt exactly as it was, and the one level that
 * may skip a prompt must be reachable only from a real answer.
 */

const reply = (text: string) => async (): Promise<string> => text;

describe('parseRiskResponse', () => {
  it('reads the shape the prompt asks for', () => {
    expect(parseRiskResponse('{"level":"dangerous","reason":"recursive delete"}')).toEqual({
      level: 'dangerous',
      reason: 'recursive delete',
    });
  });

  it('finds the object inside the prose and fences models add anyway', () => {
    const wrapped = 'Sure!\n```json\n{"level":"safe","reason":"reads a file"}\n```\nHope that helps.';
    expect(parseRiskResponse(wrapped)).toEqual({ level: 'safe', reason: 'reads a file' });
  });

  it('never promotes an unreadable answer to safe', () => {
    // Every one of these must fall back to the cautious default; a typo or a
    // truncated response becoming `safe` is how an unread call gets approved.
    for (const bad of [
      'not json at all',
      '{"level":"SAFE","reason":"shouting"}',
      '{"level":"low","reason":"a level that does not exist"}',
      '{"reason":"no level at all"}',
      '{"level":"safe"',
      '[]',
      '',
    ]) {
      expect(parseRiskResponse(bad)).toEqual(UNCLASSIFIED);
    }
  });

  it('supplies a reason rather than leaving a renderer to invent one', () => {
    expect(parseRiskResponse('{"level":"caution"}').reason).toBe('no reason given');
    expect(parseRiskResponse('{"level":"caution","reason":"   "}').reason).toBe('no reason given');
  });
});

describe('buildRiskRequest', () => {
  it('asks for strict JSON and names the tool', () => {
    const request = buildRiskRequest('bash', { command: 'rm -rf /' }, '$ rm -rf /');
    expect(request).toContain('bash');
    expect(request).toContain('rm -rf /');
    expect(request).toContain('"level"');
  });

  it('caps the preview, because the change is read twice otherwise', () => {
    const request = buildRiskRequest('write', { path: 'x' }, 'y'.repeat(RISK_PREVIEW_CHARS * 2));
    expect(request.length).toBeLessThan(RISK_PREVIEW_CHARS * 2);
    expect(request).toContain('…');
  });
});

describe('riskCacheKey', () => {
  it('ignores key order, which a model does not promise', () => {
    expect(riskCacheKey('write', { path: 'a', content: 'b' })).toBe(
      riskCacheKey('write', { content: 'b', path: 'a' }),
    );
  });

  it('separates the same arguments under a different tool', () => {
    expect(riskCacheKey('write', { path: 'a' })).not.toBe(riskCacheKey('edit', { path: 'a' }));
  });

  it('separates different arguments, so a verdict cannot be reused', () => {
    expect(riskCacheKey('write', { path: 'a' })).not.toBe(riskCacheKey('write', { path: 'b' }));
  });
});

describe('createRiskClassifier', () => {
  it('returns what the model said', async () => {
    const classifier = createRiskClassifier({
      complete: reply('{"level":"caution","reason":"overwrites an existing file"}'),
    });
    const assessment = await classifier.classify('write', { path: 'a' }, 'diff');
    expect(assessment.level).toBe('caution');
    expect(assessment.reason).toBe('overwrites an existing file');
    expect(classifier.calls).toBe(1);
  });

  it('degrades to unclassified caution when the call throws', async () => {
    const warnings: string[] = [];
    const classifier = createRiskClassifier({
      complete: async () => {
        throw new Error('502 from provider');
      },
      log: (message) => warnings.push(message),
    });
    const assessment = await classifier.classify('bash', { command: 'ls' }, '$ ls');
    expect(assessment).toEqual(UNCLASSIFIED);
    expect(assessment.level).toBe('caution');
    // Exactly one warning per run, not one per call.
    await classifier.classify('bash', { command: 'pwd' }, '$ pwd');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('risk classification unavailable');
  });

  it('degrades when the model answers with something unusable', async () => {
    const classifier = createRiskClassifier({ complete: reply('I think it is fine!') });
    expect(await classifier.classify('write', { path: 'a' }, 'd')).toEqual(UNCLASSIFIED);
  });

  it('gives up on its own budget instead of holding the run', async () => {
    const classifier = createRiskClassifier({
      timeoutMs: 30,
      log: () => undefined,
      complete: async (_request, signal) =>
        await new Promise<string>((resolve) => {
          // A client that resolves on abort rather than rejecting — which is what
          // a real one does when it hands back whatever it had. The late answer
          // here says `safe`, and reading it would auto-approve an unread call.
          signal.addEventListener('abort', () => resolve('{"level":"safe","reason":"too late"}'));
        }),
    });
    const assessment = await classifier.classify('bash', { command: 'ls' }, '$ ls');
    expect(assessment).toEqual(UNCLASSIFIED);
  });

  it('rejects a verdict that arrives after the budget, even a clean one', async () => {
    let resolvedLate = false;
    const classifier = createRiskClassifier({
      timeoutMs: 20,
      log: () => undefined,
      complete: async () =>
        await new Promise<string>((resolve) => {
          setTimeout(() => {
            resolvedLate = true;
            resolve('{"level":"safe","reason":"slow but happy"}');
          }, 60);
        }),
    });
    const assessment = await classifier.classify('write', { path: 'a' }, 'd');
    expect(resolvedLate).toBe(false); // the classifier returned before the answer existed
    expect(assessment.level).toBe('caution');
  });

  it('caches per (tool, arguments) and counts the hits', async () => {
    let calls = 0;
    const classifier = createRiskClassifier({
      complete: async () => {
        calls++;
        return '{"level":"safe","reason":"reads a file"}';
      },
    });
    await classifier.classify('read', { path: 'a' }, 'p1');
    await classifier.classify('read', { path: 'a' }, 'p2');
    expect(calls).toBe(1);
    expect(classifier.cacheHits).toBe(1);

    // Different arguments are a different question and must be asked again.
    await classifier.classify('read', { path: 'b' }, 'p3');
    expect(calls).toBe(2);
  });

  it('does not cache a failure, so a flaky answer is not permanent', async () => {
    let attempt = 0;
    const classifier = createRiskClassifier({
      complete: async () => {
        attempt++;
        if (attempt === 1) throw new Error('temporary');
        return '{"level":"safe","reason":"fine"}';
      },
      log: () => undefined,
    });
    expect((await classifier.classify('write', { path: 'a' }, 'd')).unclassified).toBe(true);
    expect((await classifier.classify('write', { path: 'a' }, 'd')).level).toBe('safe');
  });

  it('keeps two classifiers in one process from sharing verdicts', async () => {
    const first = createRiskClassifier({ complete: reply('{"level":"safe","reason":"a"}') });
    const second = createRiskClassifier({ complete: reply('{"level":"dangerous","reason":"b"}') });
    expect((await first.classify('write', { path: 'a' }, 'd')).level).toBe('safe');
    // A run that changed the policy must not inherit the previous run's answer.
    expect((await second.classify('write', { path: 'a' }, 'd')).level).toBe('dangerous');
    expect(second.cacheHits).toBe(0);
  });
});

describe('mayAutoApprove', () => {
  it('skips the prompt only for a real safe verdict', () => {
    expect(mayAutoApprove({ level: 'safe', reason: 'reads a file' })).toBe(true);
  });

  it('never skips caution or dangerous', () => {
    expect(mayAutoApprove({ level: 'caution', reason: 'overwrites a file' })).toBe(false);
    expect(mayAutoApprove({ level: 'dangerous', reason: 'rm -rf' })).toBe(false);
  });

  it('never skips when there is no classifier or no verdict', () => {
    expect(mayAutoApprove(undefined)).toBe(false);
    expect(mayAutoApprove(UNCLASSIFIED)).toBe(false);
  });
});

describe('riskTone', () => {
  it('maps every level to a palette role', () => {
    expect(riskTone('safe')).toBe('ok');
    expect(riskTone('caution')).toBe('warn');
    expect(riskTone('dangerous')).toBe('error');
  });
});
