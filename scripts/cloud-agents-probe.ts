import { performance } from 'node:perf_hooks';
import { createModelHitchServer, mockProvider } from '../src/index.js';

const fetchImpl: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
  const method = init?.method ?? 'GET';
  if (method === 'GET' && url.endsWith('/agents')) {
    return new Response(JSON.stringify({ items: [{ id: 'agent_stub', status: 'RUNNING' }] }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: { message: `unmocked ${method} ${url}` } }), { status: 400 });
};

const server = createModelHitchServer({
  providers: [mockProvider],
  defaultProviderId: 'mock',
  defaultModel: 'mock-model',
  cloudAgent: { enabled: true, repos: [{ url: 'https://github.com/org/repo' }] },
  apiKeys: { 'cursor-cloud': 'probe-key' },
  imageFetch: fetchImpl,
});

const info = await server.listen(0, '127.0.0.1');
const start = performance.now();
const res = await fetch(`${info.url}/v1/cloud-agents`);
const body = (await res.json()) as { agents?: Array<{ id?: string }> };
const ms = performance.now() - start;
await server.close();

const ids = (body.agents ?? []).map((agent) => agent.id);
if (res.status !== 200 || !ids.includes('agent_stub')) {
  console.error(`cloud list missing agent_stub: HTTP ${res.status} ${JSON.stringify(body)}`);
  process.exit(1);
}

console.log(ms.toFixed(3));
if (ms >= 100) process.exit(1);
