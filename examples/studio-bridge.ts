/**
 * Local multi-wire bridge for coding agents / IDEs (ModelHitch V2).
 *
 * - Model routing: "providerId/modelId" (e.g. "vercel-ai-gateway/openai/gpt-5.4",
 *   "anthropic/claude-sonnet-4.6"). Bare model ids route through the configured
 *   default provider (vercel-ai-gateway here).
 * - Keys resolve locally: AI_GATEWAY_API_KEY / VERCEL_OIDC_TOKEN / VERCEL_TOKEN /
 *   Vercel CLI auth (`vercel login`), then other provider env vars.
 * - auto-mode is ON: if a lane gets rate-limited (429) or returns a provider 5xx /
 *   network error, the request rotates to the next configured lane.
 *
 *   npx tsx examples/studio-bridge.ts
 */
import { createModelHitchServer, printAsciiLogo } from '../src/index.js';

printAsciiLogo();

const port = Number(process.env.MODELHITCH_PORT ?? 3939);
const host = process.env.MODELHITCH_HOST ?? '127.0.0.1';

const server = createModelHitchServer({
  defaultProviderId: 'vercel-ai-gateway',
  defaultModel: 'openai/gpt-5.4',
  logger: (line) => console.log(line),
  onFailover: (event) =>
    console.log(
      `[failover] ${event.from.providerId}/${event.from.model} -> ${event.to.providerId}/${event.to.model} (${event.error.code}${event.error.status ? ` HTTP ${event.error.status}` : ''})`,
    ),
});

server.listen(port, host).then(() => {
  console.log(`
ModelHitch bridge listening on http://${host}:${port}

Try:
  vercel-ai-gateway/openai/gpt-5.4     (AI_GATEWAY_API_KEY or vercel login)
  vercel-ai-gateway/anthropic/claude-sonnet-4.6
  mock/mock-model

Default failover:
  vercel-ai-gateway/anthropic/claude-sonnet-4.6 ->
  vercel-ai-gateway/google/gemini-3-flash -> openai/gpt-5.4
`);
});
