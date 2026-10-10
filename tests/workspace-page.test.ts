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

describe('GET /settings workspace link', () => {
  it('links to the workspace page from settings', async () => {
    const res = await fetch(`${base}/settings`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes('href="/workspace"') || html.includes('/workspace')).toBe(true);
  });
});
