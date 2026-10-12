import { ModelHitchError } from '../core/errors.js';
import { streamHarness, type HarnessOptions } from '../../harness/index.js';
import { newSessionId, loadSession, saveSession, type SessionRecord } from '../../harness/session.js';
import type {
  CloudAgentBackend,
  CloudAgentRunDriver,
  CloudAgentRunEvent,
  CloudAgentRunHandle,
  CloudAgentSession,
  CloudAgentStartInput,
} from './cloud-agent-backend.js';
import type { CloudAgentSessionStore } from './cloud-agent-session-store.js';

/** Provider id for the local lane. Bare enough to read well in a model picker. */
export const LOCAL_AGENT_PROVIDER_ID = 'local-agent';

export interface LocalAgentBackendOptions {
  /** Master switch, mirroring the `cloudAgent.enabled` shape. */
  enabled: boolean;
  /** Working tree the agent operates in. Defaults to the process cwd. */
  workspaceDir?: string;
  /** `provider/model` override for the underlying tool loop. */
  model?: string;
  /** Config document to read, defaulting to the harness default. */
  configPath?: string;
  maxTurns?: number;
  /** Durable conversation -> session map, so runs survive a bridge restart. */
  sessionStore?: CloudAgentSessionStore;
  /**
   * Injected for tests: runs a prompt and yields normalized events.
   *
   * Defaults to `streamHarness`. Injecting it keeps the backend testable
   * without a provider, a workspace, or a network.
   */
  runPrompt?: (prompt: string, options: HarnessOptions) => AsyncGenerator<LocalRunEvent>;
  /** Injected for tests: session persistence. */
  persistence?: LocalAgentPersistence;
}

/**
 * The subset of `ToolLoopEvent` this backend consumes.
 *
 * Declared structurally rather than importing the union so a test double does
 * not have to fabricate `StreamChunk`/`Usage` values it never uses.
 */
export type LocalRunEvent =
  | { type: 'chunk'; chunk: { type: 'text-delta'; text: string } }
  | { type: 'done'; messages?: unknown[]; turns?: number }
  | { type: 'tool'; call: { name: string }; output?: string };

/** Session persistence seam, so tests can run without touching the home dir. */
export interface LocalAgentPersistence {
  save(record: SessionRecord): string;
  /** `null` when there is no such session (the harness loader throws instead). */
  read(id: string): SessionRecord | null;
  newId(): string;
}

const defaultPersistence: LocalAgentPersistence = {
  save: (record) => saveSession(record),
  read: (id) => {
    // The harness loader throws a human-readable error for every failure mode
    // (missing file, bad JSON, no system prompt). Here "not found" is an
    // ordinary answer, so it is narrowed to null rather than propagated.
    try {
      return loadSession(id);
    } catch {
      return null;
    }
  },
  newId: () => newSessionId(),
};

/**
 * A cloud agent that runs in a local working tree.
 *
 * This is the second implementation of `CloudAgentBackend`, and the reason the
 * interface exists: the bridge's `/v1/cloud-agents` routes, the workspace rail,
 * and the cancel button work against this exactly as they do against Cursor.
 *
 * Honest differences from the remote lane, all of which the caller can see:
 *
 * - `execution: 'backend'` — it drives its own runs rather than delegating to a
 *   `Provider` lane, because a local run is a tool loop over a working tree.
 * - `remoteToolExecution: false` — but note the loop still executes tools
 *   locally. The flag describes the *bridge's* contract (drop client tools or
 *   not), and here the tools belong to the harness, not to the API caller.
 * - A "running" session only makes progress while the bridge process is alive.
 *   There is no supervisor, so a restart mid-run loses that run. Completed
 *   sessions are durable and resumable; in-flight ones are not.
 */
export function createLocalAgentBackend(options: LocalAgentBackendOptions): CloudAgentRunDriver {
  const persistence = options.persistence ?? defaultPersistence;
  const runPrompt = options.runPrompt ?? (streamHarness as unknown as LocalAgentBackendOptions['runPrompt'])!;
  /** Sessions started in this process. Durable records are the session files. */
  const live = new Map<string, LocalSessionState>();
  /** Prompts for runs that have been started but not yet streamed. */
  const pending = new Map<
    string,
    { prompt: string; workspaceDir: string; conversationKey: string }
  >();

  interface LocalSessionState {
    id: string;
    status: 'RUNNING' | 'FINISHED' | 'CANCELLED';
    createdAt: string;
    controller?: AbortController;
  }

  function harnessOptions(workspaceDir: string, initialMessages?: unknown[]): HarnessOptions {
    const merged: HarnessOptions = { workspaceDir };
    if (options.model !== undefined) merged.model = options.model;
    if (options.configPath !== undefined) merged.configPath = options.configPath;
    if (options.maxTurns !== undefined) merged.maxTurns = options.maxTurns;
    if (initialMessages !== undefined && initialMessages.length > 0) {
      // A resumed run already carries its system prompt, so supplying messages
      // replaces the prompt build instead of stacking another one on top.
      merged.initialMessages = initialMessages as HarnessOptions['initialMessages'];
    }
    return merged;
  }

  function toSession(state: LocalSessionState): CloudAgentSession {
    return { id: state.id, status: state.status, name: `local ${state.id}`, createdAt: state.createdAt };
  }

  function requireEnabled(): void {
    if (!options.enabled) {
      throw new ModelHitchError(
        'bad-request',
        'The local agent lane is disabled. Enable cloudAgent.local in ~/.modelhitch/config.json or via /settings.',
        { status: 403, providerId: LOCAL_AGENT_PROVIDER_ID },
      );
    }
  }

  /**
   * The working tree a run operates in.
   *
   * An explicit `workspaceDir` is REQUIRED. Falling back to `process.cwd()`
   * looks convenient but silently grants the agent read/write over whatever
   * directory the bridge happened to be started in — for a bridge launched from
   * a repo root, that is the whole repository. A misconfigured lane should fail
   * loudly, not run somewhere surprising.
   */
  function resolveWorkspaceDir(): string {
    const dir = options.workspaceDir?.trim();
    if (!dir) {
      throw new ModelHitchError(
        'bad-request',
        'The local agent lane needs an explicit workspaceDir. Set localAgent.workspaceDir in ' +
          '~/.modelhitch/config.json (or via /settings) to the directory the agent may work in.',
        { status: 400, providerId: LOCAL_AGENT_PROVIDER_ID },
      );
    }
    return dir;
  }

  return {
    id: LOCAL_AGENT_PROVIDER_ID,
    label: 'Local agent',
    remoteToolExecution: false,
    execution: 'backend',

    readiness() {
      if (!options.enabled) {
        return {
          ready: false,
          error: new ModelHitchError(
            'bad-request',
            'The local agent lane is disabled. Enable cloudAgent.local in ~/.modelhitch/config.json or via /settings.',
            { status: 403, providerId: LOCAL_AGENT_PROVIDER_ID },
          ),
        };
      }
      // A lane with no workspace is not ready: it would otherwise run in
      // whatever directory the bridge was launched from.
      try {
        resolveWorkspaceDir();
      } catch (err) {
        if (err instanceof ModelHitchError) return { ready: false, error: err };
        throw err;
      }
      return { ready: true };
    },

    async list(): Promise<CloudAgentSession[]> {
      requireEnabled();
      const sessions = [...live.values()].map(toSession);
      // Completed runs from an earlier bridge process are still listable: they
      // are on disk, which is what makes a resumed conversation possible.
      const seen = new Set(sessions.map((s) => s.id));
      for (const record of options.sessionStore?.list(LOCAL_AGENT_PROVIDER_ID) ?? []) {
        if (seen.has(record.sessionId)) continue;
        sessions.push({
          id: record.sessionId,
          status: record.status ?? 'FINISHED',
          ...(record.updatedAt !== undefined ? { createdAt: record.updatedAt } : {}),
        });
      }
      return sessions;
    },

    async get(id: string): Promise<CloudAgentSession> {
      requireEnabled();
      const state = live.get(id);
      if (state) return toSession(state);
      const persisted = persistence.read(id);
      if (persisted) {
        return { id: persisted.id, status: 'FINISHED', createdAt: persisted.createdAt };
      }
      throw new ModelHitchError('model-not-found', `Cloud agent "${id}" was not found.`, {
        status: 404,
        providerId: LOCAL_AGENT_PROVIDER_ID,
      });
    },

    async cancel(id: string): Promise<CloudAgentSession> {
      requireEnabled();
      const state = live.get(id);
      if (!state) {
        throw new ModelHitchError('model-not-found', `Cloud agent "${id}" was not found.`, {
          status: 404,
          providerId: LOCAL_AGENT_PROVIDER_ID,
        });
      }
      // Aborting is cooperative: the tool loop stops between steps. A tool
      // already executing finishes its own call.
      state.controller?.abort();
      state.status = 'CANCELLED';
      return toSession(state);
    },

    async startRun(input: CloudAgentStartInput): Promise<CloudAgentRunHandle> {
      requireEnabled();
      const workspaceDir = resolveWorkspaceDir();
      // The durable map is the ONLY thing that can tie a conversation to a
      // session across a restart, because the session id is minted per run and
      // the session file is keyed by that id. With no store, every run is a
      // fresh session — reuse is simply not available, rather than silently
      // half-working.
      const recorded = options.sessionStore?.get(LOCAL_AGENT_PROVIDER_ID, input.sessionKey);
      const id = recorded ?? persistence.newId();
      const state: LocalSessionState = live.get(id) ?? {
        id,
        status: 'RUNNING',
        createdAt: new Date().toISOString(),
      };
      state.status = 'RUNNING';
      state.controller = new AbortController();
      live.set(id, state);
      options.sessionStore?.set(LOCAL_AGENT_PROVIDER_ID, input.sessionKey, id, 'RUNNING');
      // The prompt and workspace travel with the handle so `streamRun` does not
      // need them passed again (the interface only gives it the handle). The
      // conversation key travels too, because the durable map is keyed by
      // CONVERSATION, not by session id — recording it under the session id
      // would make the next lookup miss.
      pending.set(id, { prompt: input.prompt, workspaceDir, conversationKey: input.sessionKey });
      return { sessionId: id, runId: id };
    },

    async *streamRun(handle: CloudAgentRunHandle, signal?: AbortSignal): AsyncGenerator<CloudAgentRunEvent> {
      const state = live.get(handle.sessionId);
      const queued = pending.get(handle.sessionId);
      if (!state || !queued) {
        throw new ModelHitchError('bad-request', `No pending run for session "${handle.sessionId}".`, {
          status: 400,
          providerId: LOCAL_AGENT_PROVIDER_ID,
        });
      }
      pending.delete(handle.sessionId);

      if (signal) {
        if (signal.aborted) state.controller?.abort();
        else signal.addEventListener('abort', () => state.controller?.abort(), { once: true });
      }

      const previous = persistence.read(state.id);
      const opts = harnessOptions(queued.workspaceDir, previous?.messages);
      let text = '';

      try {
        for await (const event of runPrompt(queued.prompt, opts)) {
          if (state.controller?.signal.aborted) {
            state.status = 'CANCELLED';
            yield { type: 'result', text, status: 'CANCELLED' };
            return;
          }
          if (event.type === 'chunk') {
            const delta = event.chunk;
            if (delta.type === 'text-delta' && delta.text) {
              text += delta.text;
              yield { type: 'assistant', text: delta.text };
            }
          } else if (event.type === 'done') {
            // Persist the finished history so a later run can resume it. This is
            // what makes a local session durable where a remote run's state
            // lives on the vendor.
            if (Array.isArray(event.messages)) {
              persistence.save({
                id: state.id,
                createdAt: state.createdAt,
                model: options.model ?? 'harness-default',
                playbook: 'harness',
                turns: event.turns ?? 0,
                messages: event.messages as SessionRecord['messages'],
              });
            }
          }
        }
        state.status = 'FINISHED';
        options.sessionStore?.set(LOCAL_AGENT_PROVIDER_ID, queued.conversationKey, state.id, 'FINISHED');
        yield { type: 'result', text, status: 'FINISHED' };
      } catch (err) {
        state.status = 'FINISHED';
        const message = err instanceof Error ? err.message : String(err);
        yield { type: 'error', message };
      }
    },
  };
}
