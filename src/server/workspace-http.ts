import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ModelHitch } from '../client.js';
import type { KeyStore } from '../core/keystore.js';
import type { ChatResult } from '../core/types.js';
import type { AutoModeOptions } from '../core/failover.js';
import type { Policy } from '../core/policy.js';
import type { Provider } from '../providers/types.js';
import { WorkspaceStore } from '../workspace/store.js';
import type { ChatSession, RunTarget, WorkOrder } from '../workspace/types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export interface WorkspaceHttpContext {
  store: WorkspaceStore;
  providers: Provider[];
  defaultProviderId?: string;
  defaultModel?: string;
  autoMode?: AutoModeOptions | boolean;
  policy?: Policy;
  keystore?: KeyStore;
  apiKeys?: Record<string, string>;
}

interface WorkspaceHttpHelpers {
  readBody: (req: IncomingMessage) => Promise<unknown>;
  sendJson: (res: ServerResponse, status: number, data: unknown) => void;
  log: (line: string) => void;
}

const inFlightWorkOrders = new Map<string, AbortController>();

function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

function assistantText(result: ChatResult): string {
  const content = result.message.content;
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

function parseTarget(value: unknown, fallback: RunTarget = { kind: 'rotation' }): RunTarget | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'object') return null;
  const target = value as Record<string, unknown>;
  if (target.kind === 'rotation') return { kind: 'rotation' };
  if (
    target.kind === 'model' &&
    typeof target.providerId === 'string' &&
    typeof target.modelId === 'string'
  ) {
    return { kind: 'model', providerId: target.providerId, modelId: target.modelId };
  }
  return null;
}

function createHitch(ctx: WorkspaceHttpContext): ModelHitch {
  return new ModelHitch({
    providers: ctx.providers,
    defaultProviderId: ctx.defaultProviderId,
    defaultModel: ctx.defaultModel,
    autoMode: ctx.policy ? undefined : ctx.autoMode,
    policy: ctx.policy,
    keystore: ctx.keystore,
  });
}

function chatInputForTarget(
  ctx: WorkspaceHttpContext,
  target: RunTarget,
  messages: ChatSession['messages'],
  signal?: AbortSignal,
) {
  if (target.kind === 'rotation') {
    const provider = ctx.defaultProviderId ?? ctx.providers[0]?.id;
    const model = ctx.defaultModel ?? ctx.providers.find((p) => p.id === provider)?.defaultModel;
    if (!provider || !model) {
      throw new Error('No default provider or model configured for rotation target.');
    }
    return {
      provider,
      model,
      messages,
      signal,
      ...(ctx.apiKeys?.[provider] ? { apiKey: ctx.apiKeys[provider] } : {}),
    };
  }
  return {
    provider: target.providerId,
    model: target.modelId,
    messages,
    signal,
    ...(ctx.apiKeys?.[target.providerId] ? { apiKey: ctx.apiKeys[target.providerId] } : {}),
  };
}

async function runChat(
  ctx: WorkspaceHttpContext,
  target: RunTarget,
  messages: ChatSession['messages'],
  signal?: AbortSignal,
): Promise<ChatResult> {
  const hitch = createHitch(ctx);
  return hitch.chat(chatInputForTarget(ctx, target, messages, signal));
}

function nowIso(): string {
  return new Date().toISOString();
}

async function handleCreateSession(
  body: unknown,
  ctx: WorkspaceHttpContext,
  sendJson: WorkspaceHttpHelpers['sendJson'],
  res: ServerResponse,
): Promise<void> {
  const record = (body ?? {}) as Record<string, unknown>;
  const target = parseTarget(record.target);
  if (!target) {
    sendJson(res, 400, { error: { message: 'Invalid target.', code: 'invalid_target' } });
    return;
  }
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : 'Untitled';
  const session: ChatSession = {
    id: randomUUID(),
    title,
    target,
    messages: [],
    updatedAt: nowIso(),
  };
  ctx.store.saveSession(session);
  sendJson(res, 200, session);
}

async function handleGetSession(
  id: string,
  ctx: WorkspaceHttpContext,
  sendJson: WorkspaceHttpHelpers['sendJson'],
  res: ServerResponse,
): Promise<void> {
  if (!isValidId(id)) {
    sendJson(res, 400, { error: { message: 'Invalid session id.', code: 'invalid_id' } });
    return;
  }
  const session = ctx.store.readSession(id);
  if (!session) {
    sendJson(res, 404, { error: { message: 'Session not found.', code: 'not_found' } });
    return;
  }
  sendJson(res, 200, session);
}

async function handleAppendMessage(
  id: string,
  body: unknown,
  ctx: WorkspaceHttpContext,
  sendJson: WorkspaceHttpHelpers['sendJson'],
  res: ServerResponse,
): Promise<void> {
  if (!isValidId(id)) {
    sendJson(res, 400, { error: { message: 'Invalid session id.', code: 'invalid_id' } });
    return;
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const prompt = typeof record.prompt === 'string' ? record.prompt : '';
  if (!prompt.trim()) {
    sendJson(res, 400, { error: { message: 'Prompt must not be empty.', code: 'empty_prompt' } });
    return;
  }
  const session = ctx.store.readSession(id);
  if (!session) {
    sendJson(res, 404, { error: { message: 'Session not found.', code: 'not_found' } });
    return;
  }
  session.messages.push({ role: 'user', content: prompt });
  try {
    const result = await runChat(ctx, session.target, session.messages);
    session.messages.push(result.message);
    session.updatedAt = nowIso();
    ctx.store.saveSession(session);
    sendJson(res, 200, session);
  } catch (err) {
    sendJson(res, 500, {
      error: { message: err instanceof Error ? err.message : String(err), code: 'chat_failed' },
    });
  }
}

async function handleCreateWorkOrder(
  body: unknown,
  ctx: WorkspaceHttpContext,
  sendJson: WorkspaceHttpHelpers['sendJson'],
  res: ServerResponse,
): Promise<void> {
  const record = (body ?? {}) as Record<string, unknown>;
  const prompt = typeof record.prompt === 'string' ? record.prompt : '';
  if (!prompt.trim()) {
    sendJson(res, 400, { error: { message: 'Prompt must not be empty.', code: 'empty_prompt' } });
    return;
  }
  const target = parseTarget(record.target);
  if (!target) {
    sendJson(res, 400, { error: { message: 'Invalid target.', code: 'invalid_target' } });
    return;
  }
  const id = randomUUID();
  const createdAt = nowIso();
  const controller = new AbortController();
  inFlightWorkOrders.set(id, controller);

  let order: WorkOrder = {
    id,
    prompt,
    target,
    status: 'running',
    createdAt,
    updatedAt: createdAt,
  };
  ctx.store.saveWorkOrder(order);

  try {
    const result = await runChat(
      ctx,
      target,
      [{ role: 'user', content: prompt }],
      controller.signal,
    );
    order = {
      ...order,
      status: 'done',
      result: assistantText(result),
      updatedAt: nowIso(),
    };
    ctx.store.saveWorkOrder(order);
    sendJson(res, 200, { id: order.id, status: order.status, result: order.result });
  } catch (err) {
    if (controller.signal.aborted) {
      order = { ...order, status: 'cancelled', updatedAt: nowIso() };
      ctx.store.saveWorkOrder(order);
      sendJson(res, 200, { id: order.id, status: order.status });
      return;
    }
    order = {
      ...order,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      updatedAt: nowIso(),
    };
    ctx.store.saveWorkOrder(order);
    sendJson(res, 200, { id: order.id, status: order.status, error: order.error });
  } finally {
    inFlightWorkOrders.delete(id);
  }
}

async function handleCancelWorkOrder(
  id: string,
  ctx: WorkspaceHttpContext,
  sendJson: WorkspaceHttpHelpers['sendJson'],
  res: ServerResponse,
): Promise<void> {
  if (!isValidId(id)) {
    sendJson(res, 400, { error: { message: 'Invalid work order id.', code: 'invalid_id' } });
    return;
  }
  const order = ctx.store.readWorkOrder(id);
  if (!order) {
    sendJson(res, 404, { error: { message: 'Work order not found.', code: 'not_found' } });
    return;
  }
  if (order.status === 'done' || order.status === 'failed') {
    sendJson(res, 409, { error: { message: 'Work order already finished.', code: 'already_finished' } });
    return;
  }
  const controller = inFlightWorkOrders.get(id);
  if (controller) controller.abort();
  const updated: WorkOrder = { ...order, status: 'cancelled', updatedAt: nowIso() };
  ctx.store.saveWorkOrder(updated);
  sendJson(res, 200, { id: updated.id, status: updated.status });
}

/**
 * Handle workspace session and work-order routes. Returns true when the
 * request was handled (including error responses).
 */
export async function handleWorkspaceHttp(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  ctx: WorkspaceHttpContext,
  helpers: WorkspaceHttpHelpers,
): Promise<boolean> {
  const { readBody, sendJson, log } = helpers;

  if (method === 'POST' && path === '/v1/sessions') {
    log(`${method} ${path} ->`);
    const body = await readBody(req);
    await handleCreateSession(body, ctx, sendJson, res);
    return true;
  }

  const sessionMatch = path.match(/^\/v1\/sessions\/([^/]+)$/);
  if (method === 'GET' && sessionMatch) {
    log(`${method} ${path} ->`);
    await handleGetSession(decodeURIComponent(sessionMatch[1]!), ctx, sendJson, res);
    return true;
  }

  const messageMatch = path.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
  if (method === 'POST' && messageMatch) {
    log(`${method} ${path} ->`);
    const body = await readBody(req);
    await handleAppendMessage(decodeURIComponent(messageMatch[1]!), body, ctx, sendJson, res);
    return true;
  }

  if (method === 'POST' && path === '/v1/work-orders') {
    log(`${method} ${path} ->`);
    const body = await readBody(req);
    await handleCreateWorkOrder(body, ctx, sendJson, res);
    return true;
  }

  const cancelMatch = path.match(/^\/v1\/work-orders\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancelMatch) {
    log(`${method} ${path} ->`);
    await handleCancelWorkOrder(decodeURIComponent(cancelMatch[1]!), ctx, sendJson, res);
    return true;
  }

  return false;
}
