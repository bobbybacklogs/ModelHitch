import { ModelHitchError } from '../core/errors.js';
import type { CloudAgentConfig } from '../config.js';
import {
  CURSOR_CLOUD_PROVIDER_ID,
  type SseEvent,
  cancelCursorCloudAgent,
  getCursorCloudAgent,
  listCursorCloudAgents,
} from './cursor-cloud.js';
import { CursorCloudSessionStore } from './cursor-cloud-session.js';
import type { CloudAgentSessionStore } from './cloud-agent-session-store.js';
import type {
  CloudAgentBackend,
  CloudAgentRunEvent,
  CloudAgentSession,
  CloudAgentSessionAdopter,
} from './cloud-agent-backend.js';

/** Env var that supplies the Cursor key when the config has none. */
const CURSOR_CLOUD_API_KEY_ENV = 'CURSOR_API_KEY';

export interface CursorCloudBackendOptions {
  config: CloudAgentConfig;
  /**
   * Bridge conversation id -> Cursor agent id.
   *
   * Optional because the management surface (`list`/`get`/`cancel`) is
   * stateless: it addresses agents by their Cursor id, not by a bridge session.
   * The provider lane owns the store for run creation.
   *
   * In-memory only — pass `durableSessionStore` to survive a bridge restart.
   */
  sessionStore?: CursorCloudSessionStore;
  /**
   * Durable conversation -> agent map.
   *
   * Without this, a restarted bridge cannot tell which vendor agent belongs to
   * which conversation, so follow-up turns fork new agents. Backed by files
   * under `~/.modelhitch`, not memory.
   */
  durableSessionStore?: CloudAgentSessionStore;
  /** Explicit key (config `keys['cursor-cloud']`); falls back to the env var. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

interface CursorRunStreamPayload {
  text?: string;
  status?: string;
}

/**
 * Cursor Cloud Agent as a `CloudAgentBackend`.
 *
 * This is an adapter, not a rewrite: every vendor call still goes through the
 * existing `cursor-cloud.ts` client functions and the existing session store.
 * The shape of the traffic is unchanged — this only normalizes what the bridge
 * sees, so a second backend can slot in beside it.
 */
export function createCursorCloudBackend(
  options: CursorCloudBackendOptions,
): CloudAgentBackend & CloudAgentSessionAdopter {
  const { config } = options;

  function resolveApiKey(explicit?: string): string {
    const key = explicit ?? options.apiKey ?? process.env[CURSOR_CLOUD_API_KEY_ENV];
    if (!key) {
      throw new ModelHitchError(
        'missing-api-key',
        'Cursor Cloud Agent lane requires CURSOR_API_KEY or keys.cursor-cloud in ~/.modelhitch/config.json.',
        { status: 401, providerId: CURSOR_CLOUD_PROVIDER_ID },
      );
    }
    return key;
  }

  function clientOpts(): { fetchImpl?: typeof fetch; baseUrl?: string } {
    const merged: { fetchImpl?: typeof fetch; baseUrl?: string } = {};
    if (options.fetchImpl) merged.fetchImpl = options.fetchImpl;
    if (options.baseUrl) merged.baseUrl = options.baseUrl;
    return merged;
  }

  /** Cursor needs a vendor client at construction time even to list agents. */
  return {
    id: CURSOR_CLOUD_PROVIDER_ID,
    label: 'Cursor Cloud Agent',
    remoteToolExecution: true,

    readiness() {
      if (!config.enabled) {
        return {
          ready: false,
          error: new ModelHitchError(
            'bad-request',
            'Cursor Cloud Agent lane is disabled. Enable cloudAgent in ~/.modelhitch/config.json or via /settings.',
            { status: 403, providerId: CURSOR_CLOUD_PROVIDER_ID },
          ),
        };
      }
      try {
        resolveApiKey();
        return { ready: true };
      } catch (err) {
        if (err instanceof ModelHitchError) return { ready: false, error: err };
        throw err;
      }
    },

    async list(): Promise<CloudAgentSession[]> {
      const apiKey = resolveApiKey();
      const agents = await listCursorCloudAgents(apiKey, clientOpts());
      return agents.map((agent) => ({
        id: agent.id,
        ...(agent.status !== undefined ? { status: agent.status } : {}),
        ...(agent.name !== undefined ? { name: agent.name } : {}),
        ...(agent.createdAt !== undefined ? { createdAt: agent.createdAt } : {}),
      }));
    },

    async get(id: string): Promise<CloudAgentSession> {
      const apiKey = resolveApiKey();
      const agent = await getCursorCloudAgent(apiKey, id, clientOpts());
      return {
        id: agent.id,
        ...(agent.status !== undefined ? { status: agent.status } : {}),
        ...(agent.name !== undefined ? { name: agent.name } : {}),
        ...(agent.createdAt !== undefined ? { createdAt: agent.createdAt } : {}),
      };
    },

    async cancel(id: string): Promise<CloudAgentSession> {
      const apiKey = resolveApiKey();
      const agent = await cancelCursorCloudAgent(apiKey, id, clientOpts());
      return {
        id: agent.id,
        ...(agent.status !== undefined ? { status: agent.status } : {}),
        ...(agent.name !== undefined ? { name: agent.name } : {}),
        ...(agent.createdAt !== undefined ? { createdAt: agent.createdAt } : {}),
      };
    },

    /**
     * Resolve the durable agent id for a conversation, if one was recorded.
     *
     * This is the bridge-restart path. The vendor keeps agents, but it cannot
     * answer "which agent was conversation X?" — only the bridge knows that, so
     * the answer has to come from persisted state. Recorded ids are NOT
     * validated against the vendor here (that would cost a request per turn);
     * a stale id surfaces as a 404 on the next run and the caller can drop it.
     */
    async adoptConversation(conversationId: string): Promise<string | undefined> {
      const inMemory = options.sessionStore?.get(conversationId);
      if (inMemory) return inMemory;
      return options.durableSessionStore?.get(CURSOR_CLOUD_PROVIDER_ID, conversationId);
    },

    /** Remember which agent serves a conversation, in both stores when present. */
    async rememberConversation(conversationId: string, sessionId: string, status?: string): Promise<void> {
      options.sessionStore?.set(conversationId, sessionId);
      options.durableSessionStore?.set(CURSOR_CLOUD_PROVIDER_ID, conversationId, sessionId, status);
    },

    /** Drop a conversation's mapping after a run 404s against a stale agent id. */
    async forgetConversation(conversationId: string): Promise<void> {
      options.sessionStore?.delete(conversationId);
      options.durableSessionStore?.delete(CURSOR_CLOUD_PROVIDER_ID, conversationId);
    },

    /**
     * Cursor runs are driven by the `Provider` lane (`cursor-cloud.ts`), which
     * owns session reuse and the vendor request shape. The bridge does not ask
     * this adapter to drive a run, and pretending otherwise would mean two code
     * paths that could disagree about session reuse.
     *
     * A backend that *does* drive its own runs (a local lane over `harness/`)
     * implements these two normally. `execution` states which kind this is.
     */
    execution: 'provider-lane' as const,
  };
}

/**
 * Normalize a raw Cursor SSE event into the backend-neutral event shape.
 * Exported so the provider lane can reuse it without duplicating the parsing
 * rules (malformed payloads are skipped, not thrown).
 */
export function normalizeCursorRunEvent(event: SseEvent): CloudAgentRunEvent | undefined {
  if (event.event === 'assistant') {
    try {
      const payload = JSON.parse(event.data) as CursorRunStreamPayload;
      return payload.text ? { type: 'assistant', text: payload.text } : undefined;
    } catch {
      return undefined;
    }
  }
  if (event.event === 'result') {
    try {
      const payload = JSON.parse(event.data) as CursorRunStreamPayload;
      const normalized: CloudAgentRunEvent = { type: 'result' };
      if (payload.text !== undefined) normalized.text = payload.text;
      if (payload.status !== undefined) normalized.status = payload.status;
      return normalized;
    } catch {
      return undefined;
    }
  }
  if (event.event === 'error') {
    try {
      const payload = JSON.parse(event.data) as { message?: string };
      return { type: 'error', message: payload.message ?? 'Cursor run stream error.' };
    } catch {
      return { type: 'error', message: 'Cursor run stream error.' };
    }
  }
  return undefined;
}
