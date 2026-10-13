import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModelHitchServer,
  mockProvider,
  type OpenAICompatibleServer,
} from '../src/index.js';
import { workspacePageHtml } from '../src/workspace-page.js';

let server: OpenAICompatibleServer;
let base: string;

beforeAll(async () => {
  server = createModelHitchServer({
    providers: [mockProvider],
    defaultProviderId: 'mock',
    defaultModel: 'mock-model',
  });
  const info = await server.listen(0, '127.0.0.1');
  base = info.url;
});

afterAll(async () => {
  await server.close();
});

describe('GET /workspace', () => {
  it('returns self-contained HTML with rotation target and work order controls', async () => {
    const res = await fetch(`${base}/workspace`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('value="rotation"');
    expect(html).toContain('Work order');
    expect(html).toContain('esc(wo.id)');
    expect(html).toContain('owned_by');
  });

  it('serves an inline script that actually parses (template escape-rot guard)', () => {
    // Same hazard as the settings page: this file is one big template literal,
    // so a bare escape or a stray backtick is consumed at build time and kills
    // the whole script while the static HTML still looks right.
    const html = workspacePageHtml();
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).toBeTruthy();
    expect(() => new Function(match![1]!)).not.toThrow();
    expect(html).toContain("errs.join('\\n')");
  });

  it('ships the target filter, refresh, and composer-state controls the page needs', async () => {
    const html = await (await fetch(`${base}/workspace`)).text();
    for (const id of [
      'chat-target-filter',
      'wo-target-filter',
      'chat-target-count',
      'refresh-sessions',
      'refresh-work-orders',
      'refresh-cloud-agents',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    // Behaviour that has to exist for those controls to mean anything.
    for (const fn of ['renderTargets', 'buildTargetOptions', 'scheduleRefresh', 'syncComposer', 'showPending']) {
      expect(html).toContain(fn);
    }
  });

  it('stacks the rails on narrow viewports instead of overflowing sideways', () => {
    // Regression: the three columns were fixed-width inside a flex row, so a
    // phone viewport got a page wider than the screen (280 + 280 + center).
    const html = workspacePageHtml();
    expect(html).toContain('@media (max-width: 900px)');
    expect(html).toContain('.rail { display: block; }');
    expect(html).not.toContain('calc(100vh - 52px)');
  });
});

/**
 * Pull a function out of the page's inline script, so these tests run the page's
 * own logic rather than a copy of it. Braces are counted so an object literal
 * inside the body does not truncate the source.
 */
function extractPageFunction(script: string, name: string): string {
  const start = script.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`page function ${name} not found`);
  let depth = 0;
  let end = script.indexOf('{', start);
  for (let i = end; i < script.length; i += 1) {
    if (script[i] === '{') depth += 1;
    else if (script[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return script.slice(start, end + 1);
}

type PageFn = (...args: unknown[]) => unknown;

/**
 * Run one of the page's own functions in a scope with a fake `state` and the id
 * prefix. `deps` are other page functions the target closes over.
 */
function pageFunction(
  name: string,
  options: { deps?: readonly string[]; state?: unknown } = {},
): PageFn {
  const html = workspacePageHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const prefix = script.match(/var INTENT_ID_PREFIX = '[^']*';/)?.[0] ?? '';
  const names = [name, ...(options.deps ?? [])];
  const declarations = names.map((dep) => extractPageFunction(script, dep)).join('\n');
  const factory = new Function(
    `${prefix}\nvar state = ${JSON.stringify(options.state ?? {})};\n${declarations}\nreturn ${name};`,
  );
  return factory() as PageFn;
}

describe('workspace target picker', () => {
  it('parses a pinned intent id back into an intent target', () => {
    const parseTargetValue = pageFunction('parseTargetValue');
    expect(parseTargetValue('modelhitch/auto:coding')).toEqual({ kind: 'intent', name: 'coding' });
    expect(parseTargetValue('rotation')).toEqual({ kind: 'rotation' });
    expect(parseTargetValue('')).toEqual({ kind: 'rotation' });
    expect(parseTargetValue('lane-two/two-model')).toEqual({
      kind: 'model',
      providerId: 'lane-two',
      modelId: 'two-model',
    });
  });

  it('labels an intent target so the rail and session rows read sensibly', () => {
    const targetLabel = pageFunction('targetLabel');
    expect(targetLabel({ kind: 'intent', name: 'coding' })).toBe('intent: coding');
    expect(targetLabel({ kind: 'rotation' })).toBe('rotation');
    expect(targetLabel({ kind: 'model', providerId: 'lane-two', modelId: 'two-model' })).toBe(
      'lane-two/two-model',
    );
  });

  it('offers a pinned intent row while collapsing the plain auto id into rotation', () => {
    const buildTargetOptions = pageFunction('buildTargetOptions', {
      deps: ['targetOptionValue'],
      state: {
        models: [
          { id: 'modelhitch/auto', name: 'ModelHitch Auto · whole rotation · 1 lane', modelhitch: { kind: 'auto', lanes: [] } },
          { id: 'modelhitch/auto:coding', name: 'ModelHitch Auto · coding · 2 lanes', modelhitch: { kind: 'auto', intent: 'coding', lanes: [] } },
          { id: 'lane-two/two-model', name: 'Two Model · Lane Two · trusted lane 1' },
        ],
      },
    });

    expect(buildTargetOptions()).toEqual([
      { value: 'modelhitch/auto:coding', label: 'ModelHitch Auto · coding · 2 lanes' },
      { value: 'lane-two/two-model', label: 'Two Model · Lane Two · trusted lane 1' },
    ]);
  });
});

describe('GET /settings workspace link', () => {
  it('links to the workspace page from settings', async () => {
    const res = await fetch(`${base}/settings`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes('href="/workspace"') || html.includes('/workspace')).toBe(true);
  });
});
