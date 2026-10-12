import type { ModelHitchError } from '../core/errors.js';

/**
 * Backend-neutral contract for a durable cloud agent.
 *
 * The bridge's `/v1/cloud-agents` routes and the Cursor lane were written
 * against one vendor. This interface is the seam that lets a second backend
 * (a local lane over `harness/`, or a sandbox vendor later) sit behind the same
 * routes, the same workspace-page rail, and the same cancel button.
 *
 * It deliberately describes only what the bridge already needs. Nothing here
 * assumes a VM, a git checkout, or an HTTP transport — a backend that runs in a
 * local working tree implements the same four calls.
 *
 * Two properties are load-bearing and must not be quietly dropped:
 *
 * 1. `createSession` returns an id that outlives a single prompt. Follow-up
 *    prompts go to `sendPrompt(id, …)` on the same id, which is what makes a
 *    cloud agent a *session* rather than a stateless request.
 * 2. `list` must be enough to re-adopt sessions after a bridge restart. The
 *    in-memory session map is lost on restart, so recovery has to be possible
 *    from the backend itself.
 */
export interface CloudAgentBackend {
  /**
   * Stable backend id, used as the provider id and the model prefix.
   * Existing example: `cursor-cloud`.
   */
  readonly id: string;

  /** Human label for the workspace rail and settings page. */
  readonly label: string;

  /**
   * Whether the backend executes its own tool loop inside the run.
   *
   * `true` means the bridge must drop client tool definitions before sending,
   * because the remote side owns the tools. `false` means the lane behaves like
   * an ordinary chat provider. Getting this wrong causes double execution, so
   * it is a property of the backend rather than a per-request flag.
   */
  readonly remoteToolExecution: boolean;

  /**
   * Whether the backend can run at all with the currently configured
   * credentials. Returns the reason when it cannot, so the route layer can
   * answer 403/401 with an honest message instead of guessing which vendor is
   * missing a key.
   */
  readiness(): { ready: true } | { ready: false; error: ModelHitchError };

  /**
   * Who drives a run.
   *
   * - `provider-lane`: execution flows through the `Provider` interface
   *   (`chat`/`stream`), which owns session reuse and the vendor request shape.
   *   The bridge dispatches to it like any other lane; this backend only
   *   supplies the management surface. This is how Cursor works today.
   * - `backend`: the backend drives its own runs, so it implements `startRun`
   *   and `streamRun`. This is what a local lane over `harness/` needs.
   *
   * Stating this explicitly matters because the two kinds differ in where
   * tool execution lives, and silently having both paths would let session
   * reuse diverge between them.
   */
  readonly execution: 'provider-lane' | 'backend';

  /** List known sessions. Must be usable to re-adopt after a bridge restart. */
  list(): Promise<CloudAgentSession[]>;

  /** Fetch one session, or throw a not-found `ModelHitchError`. */
  get(id: string): Promise<CloudAgentSession>;

  /** Cancel an in-flight session. Idempotent where the vendor allows it. */
  cancel(id: string): Promise<CloudAgentSession>;
}

/**
 * A backend that drives its own runs (`execution: 'backend'`).
 *
 * Kept separate from `CloudAgentBackend` on purpose: a provider-lane backend
 * has no meaningful `startRun`, and forcing it to implement one would either
 * duplicate session-reuse logic or throw at runtime.
 */
export interface CloudAgentRunDriver extends CloudAgentBackend {
  readonly execution: 'backend';

  /**
   * Resolve (or create) the session for a conversation, and start one run.
   *
   * `sessionKey` is the bridge's own conversation identity. Honoring it is what
   * implements `sessionReuse`; a backend with `per-request` semantics may ignore
   * it and always create a fresh session.
   */
  startRun(input: CloudAgentStartInput): Promise<CloudAgentRunHandle>;

  /** Stream incremental text for a run until it reaches a terminal state. */
  streamRun(handle: CloudAgentRunHandle, signal?: AbortSignal): AsyncGenerator<CloudAgentRunEvent>;
}

/**
 * Durable conversation -> session mapping.
 *
 * Separate from the base contract because it is only meaningful for backends
 * whose sessions outlive a bridge process. `list()` cannot substitute for it:
 * a vendor knows its own agent ids but not what the bridge called a
 * conversation, so recovery needs persisted state on the bridge side.
 */
export interface CloudAgentSessionAdopter {
  /** The conversation's session id, or undefined if this conversation is new. */
  adoptConversation(conversationId: string): Promise<string | undefined>;

  /** Record which session serves a conversation. */
  rememberConversation(conversationId: string, sessionId: string, status?: string): Promise<void>;

  /** Forget a conversation, e.g. after its recorded session 404s. */
  forgetConversation(conversationId: string): Promise<void>;
}

/** Narrowing helper for the durable-mapping methods. */
export function adoptsSessions(
  backend: CloudAgentBackend,
): backend is CloudAgentBackend & CloudAgentSessionAdopter {
  const candidate = backend as Partial<CloudAgentSessionAdopter>;
  return typeof candidate.adoptConversation === 'function';
}

/** Narrowing helper so callers can drive runs without an unchecked cast. */
export function drivesOwnRuns(backend: CloudAgentBackend): backend is CloudAgentRunDriver {
  return backend.execution === 'backend';
}

/** A durable agent session, normalized across backends. */
export interface CloudAgentSession {
  id: string;
  status?: string;
  name?: string;
  createdAt?: string;
}

/** What the bridge knows when it asks a backend to start work. */
export interface CloudAgentStartInput {
  /** Bridge conversation identity used for session reuse. */
  sessionKey: string;
  /** Prompt text extracted from the latest user message. */
  prompt: string;
  /** Model id, already stripped of the backend's `id/` prefix. */
  model: string;
  /** Optional image attachments, in the vendor-neutral shape the bridge holds. */
  images?: CloudAgentPromptImage[];
  /** Repository targets, when the backend checks out code. */
  repos?: CloudAgentRepo[];
}

/** An image attached to a prompt, before vendor-specific encoding. */
export interface CloudAgentPromptImage {
  data?: string;
  url?: string;
  mimeType?: string;
}

/** A repository target for backends that work against a checkout. */
export interface CloudAgentRepo {
  url: string;
  startingRef?: string;
}

/**
 * A started run. `sessionId` is returned because the backend may create the
 * session lazily — the bridge needs the id to remember it.
 */
export interface CloudAgentRunHandle {
  sessionId: string;
  runId: string;
}

/**
 * One normalized event from a running agent.
 *
 * - `assistant` carries incremental text.
 * - `result` is terminal and carries the final text plus the vendor status.
 * - `error` is terminal and carries a message the bridge turns into a provider
 *   error.
 */
export type CloudAgentRunEvent =
  | { type: 'assistant'; text: string }
  | { type: 'result'; text?: string; status?: string }
  | { type: 'error'; message: string };
