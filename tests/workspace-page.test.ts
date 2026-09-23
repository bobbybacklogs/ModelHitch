import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModelHitchServer,
  mockProvider,
  type OpenAICompatibleServer,
} from '../src/index.js';

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
