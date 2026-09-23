import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createModelHitchServer, mockProvider } from '../src/index.js';
import { WorkspaceStore } from '../src/workspace/store.js';

const dir = mkdtempSync(join(tmpdir(), 'mh-http-probe-'));
const store = new WorkspaceStore(dir);
const server = createModelHitchServer({
  providers: [mockProvider],
  defaultProviderId: 'mock',
  defaultModel: 'mock-model',
  workspaceStore: store,
});

const info = await server.listen(0, '127.0.0.1');
const start = performance.now();
const res = await fetch(`${info.url}/v1/work-orders`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'probe', target: { kind: 'rotation' } }),
});
const body = (await res.json()) as { status?: string };
const ms = performance.now() - start;
await server.close();
rmSync(dir, { recursive: true, force: true });

if (res.status !== 200 || body.status !== 'done') {
  console.error(`work order did not finish: HTTP ${res.status} ${JSON.stringify(body)}`);
  process.exit(1);
}

console.log(ms.toFixed(3));
if (ms >= 200) process.exit(1);
