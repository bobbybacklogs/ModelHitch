import { performance } from 'node:perf_hooks';
import { createModelHitchServer, mockProvider } from '../src/index.js';

const server = createModelHitchServer({
  providers: [mockProvider],
  defaultProviderId: 'mock',
  defaultModel: 'mock-model',
});
const info = await server.listen(0, '127.0.0.1');
const start = performance.now();
const res = await fetch(`${info.url}/workspace`);
const html = await res.text();
const ms = performance.now() - start;
await server.close();

if (res.status !== 200 || !html.includes('id="chat-prompt"')) {
  console.error(`workspace page missing composer: HTTP ${res.status}`);
  process.exit(1);
}

console.log(ms.toFixed(3));
if (ms >= 100) process.exit(1);
