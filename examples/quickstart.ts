/**
 * Quickstart — ModelHitch V2 against Vercel AI Gateway (or mock).
 *
 * Set AI_GATEWAY_API_KEY (or run `vercel login` / `vercel env pull`) for live calls:
 *
 *   AI_GATEWAY_API_KEY=… npx tsx examples/quickstart.ts
 */
import {
  ModelHitch,
  VERCEL_AI_GATEWAY_DEFAULT_MODEL,
  printAsciiLogo,
} from '../src/index.js';

const GATEWAY_KEY =
  process.env.AI_GATEWAY_API_KEY ??
  process.env.VERCEL_OIDC_TOKEN ??
  process.env.VERCEL_TOKEN;

async function main() {
  printAsciiLogo();

  const provider = GATEWAY_KEY
    ? { id: 'vercel-ai-gateway', model: process.env.MODELHITCH_MODEL ?? VERCEL_AI_GATEWAY_DEFAULT_MODEL }
    : { id: 'mock', model: 'mock-model' };

  const mh = new ModelHitch({ defaultProviderId: provider.id, defaultModel: provider.model });

  console.log(`Using ${provider.id}/${provider.model}${GATEWAY_KEY ? '' : ' (set AI_GATEWAY_API_KEY for live gateway)'}\n`);

  const result = await mh.chat({
    provider: provider.id,
    model: provider.model,
    messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
  });
  console.log('chat:', result.message.content);

  process.stdout.write('stream: ');
  for await (const chunk of await mh.stream({
    provider: provider.id,
    model: provider.model,
    messages: [{ role: 'user', content: 'Count to three.' }],
  })) {
    if (chunk.type === 'text-delta') process.stdout.write(chunk.text);
  }
  process.stdout.write('\n');

  if (GATEWAY_KEY) {
    const models = await mh.listModels('vercel-ai-gateway');
    console.log(`\n${models.length} gateway language models available (showing 5):`);
    for (const m of models.slice(0, 5)) console.log(`  - ${m.id}`);
  }

  console.log('\nDone. For live calls set AI_GATEWAY_API_KEY or run `vercel login`.\n');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
