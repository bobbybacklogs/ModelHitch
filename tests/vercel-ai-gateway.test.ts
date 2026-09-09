import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelHitchError } from '../src/core/errors.js';
import type { ChatParams } from '../src/core/types.js';
import {
  createVercelAiGatewayProvider,
  vercelAiGateway,
} from '../src/providers/index.js';
import {
  readVercelCliAuthToken,
  resolveVercelGatewayCredential,
  vercelCliAuthPaths,
} from '../src/core/vercel-auth.js';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

const params: ChatParams = {
  model: 'anthropic/claude-sonnet-4.6',
  messages: [{ role: 'user', content: 'hi' }],
};

const originalGatewayKey = process.env.AI_GATEWAY_API_KEY;
const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;
const originalVercelToken = process.env.VERCEL_TOKEN;
const originalSkipCli = process.env.MODELHITCH_SKIP_VERCEL_CLI_AUTH;
const originalAppData = process.env.APPDATA;
const originalXdg = process.env.XDG_DATA_HOME;

afterEach(() => {
  if (originalGatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY;
  else process.env.AI_GATEWAY_API_KEY = originalGatewayKey;
  if (originalOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
  else process.env.VERCEL_OIDC_TOKEN = originalOidcToken;
  if (originalVercelToken === undefined) delete process.env.VERCEL_TOKEN;
  else process.env.VERCEL_TOKEN = originalVercelToken;
  if (originalSkipCli === undefined) delete process.env.MODELHITCH_SKIP_VERCEL_CLI_AUTH;
  else process.env.MODELHITCH_SKIP_VERCEL_CLI_AUTH = originalSkipCli;
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
});

function gatewayWithFetch(fetchImpl: typeof fetch) {
  return createVercelAiGatewayProvider({ fetchImpl });
}

describe('Vercel AI Gateway provider', () => {
  it('ships with the gateway endpoint and a creator-prefixed default model', () => {
    expect(vercelAiGateway.id).toBe('vercel-ai-gateway');
    expect(vercelAiGateway.name).toBe('Vercel AI Gateway');
    expect(vercelAiGateway.defaultModel).toBe('openai/gpt-5.4');
    expect(vercelAiGateway.capabilities).toMatchObject({
      streaming: true,
      toolCalling: true,
      vision: true,
      embeddings: false,
    });
  });

  it('uses the OpenAI-compatible chat endpoint without changing slash-containing model ids', async () => {
    const calls: CapturedRequest[] = [];
    const provider = gatewayWithFetch(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await provider.chat(params, { apiKey: 'gateway-test-key' });
    expect(calls[0]?.url).toBe('https://ai-gateway.vercel.sh/v1/chat/completions');
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: 'Bearer gateway-test-key' });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ model: 'anthropic/claude-sonnet-4.6' });
    expect(result.message.content).toBe('ok');
  });

  it('populates language models from the public catalog without requiring a key', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_TOKEN;
    process.env.MODELHITCH_SKIP_VERCEL_CLI_AUTH = '1';
    const calls: CapturedRequest[] = [];
    const provider = gatewayWithFetch(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'openai/gpt-5.4', name: 'GPT-5.4', type: 'language', context_window: 1_050_000 },
          { id: 'openai/text-embedding-3-small', name: 'Embedding', type: 'embedding', context_window: 8191 },
          { id: 'recraft/recraft-v3', name: 'Recraft V3', type: 'image' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(provider.listModels?.({})).resolves.toEqual([
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', contextLength: 1_050_000 },
    ]);
    expect(calls[0]?.url).toBe('https://ai-gateway.vercel.sh/v1/models');
    expect(calls[0]?.init.headers).not.toHaveProperty('Authorization');
  });

  it('falls back to Vercel OIDC for hosted inference', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_TOKEN;
    process.env.MODELHITCH_SKIP_VERCEL_CLI_AUTH = '1';
    process.env.VERCEL_OIDC_TOKEN = 'oidc-test-token';
    let authorization: string | undefined;
    const provider = gatewayWithFetch(async (_input, init) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'hosted' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(provider.chat(params, {})).resolves.toMatchObject({
      message: { role: 'assistant', content: 'hosted' },
    });
    expect(authorization).toBe('Bearer oidc-test-token');
  });

  it('reads a Vercel CLI auth.json token when env credentials are absent', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_TOKEN;
    delete process.env.MODELHITCH_SKIP_VERCEL_CLI_AUTH;

    const dir = mkdtempSync(join(tmpdir(), 'mh-vercel-auth-'));
    process.env.XDG_DATA_HOME = dir;
    const authDir = join(dir, 'com.vercel.cli');
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({ token: 'cli-auth-token' }), 'utf8');

    try {
      expect(readVercelCliAuthToken()).toBe('cli-auth-token');
      expect(resolveVercelGatewayCredential()).toEqual({
        apiKey: 'cli-auth-token',
        source: 'vercel-cli',
      });
      expect(vercelCliAuthPaths().some((p) => p.includes('com.vercel.cli'))).toBe(true);

      let authorization: string | undefined;
      const provider = gatewayWithFetch(async (_input, init) => {
        authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'cli' }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });

      await expect(provider.chat(params, {})).resolves.toMatchObject({
        message: { role: 'assistant', content: 'cli' },
      });
      expect(authorization).toBe('Bearer cli-auth-token');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still requires credentials for inference', async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_TOKEN;
    process.env.MODELHITCH_SKIP_VERCEL_CLI_AUTH = '1';

    const provider = createVercelAiGatewayProvider();
    const err = await provider.chat(params, {}).then(
      () => null,
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(ModelHitchError);
    expect((err as ModelHitchError).code).toBe('missing-api-key');
    expect((err as ModelHitchError).message).toContain('AI_GATEWAY_API_KEY');
  });
});
