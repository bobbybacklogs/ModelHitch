import type { ModelMessage } from './types.js';
import { serializeText } from './content.js';

/** Well-known session and conversation headers sent by various clients and gateways. */
export const SESSION_HEADER_CANDIDATES = [
  'x-session-id',
  'session-id',
  'x-conversation-id',
  'conversation-id',
  'x-request-session-id',
  'x-client-session-id',
  'prompt-cache-key',
  // Legacy inbound alias still accepted for older clients.
  'x-opencode-session',
] as const;

/**
 * Extract a stable session ID from incoming HTTP headers if one was provided.
 */
export function extractSessionId(
  headers: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  if (!headers) return undefined;
  for (const name of SESSION_HEADER_CANDIDATES) {
    const val = headers[name];
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (Array.isArray(val) && val.length && val[0]?.trim()) return val[0].trim();
  }
  return undefined;
}

/**
 * Fast, pure JavaScript 32-bit FNV-1a hash formatted as 8 hex characters.
 * Safe across Node.js, browsers, Cloudflare Workers, and edge runtimes
 * without any 
ode:crypto imports.
 */
function fnv1aHex(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Fast pseudo-random ID generator safe in all environments (browser & Node).
 */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

/**
 * Derive a stable, deterministic session identifier from a message list when no
 * explicit session header was provided by the client.
 *
 * Hashing the conversation's initial root message or prefix allows multiple
 * turns of the same dialogue to share a stable cache lane even when the calling
 * client didn't send an explicit session header.
 */
export function deriveSessionId(messages: ModelMessage[] | undefined, fallbackSeed?: string): string {
  if (!messages || messages.length === 0) {
    return fallbackSeed ? 'mh-sess-' + fallbackSeed : 'mh-sess-' + randomId();
  }

  const anchor = messages.find((m) => m.role === 'system' || m.role === 'user') ?? messages[0];
  const content = anchor ? serializeText(anchor.content) : '';
  const hash1 = fnv1aHex(content.slice(0, 500));
  const hash2 = fnv1aHex(content.slice(500, 1000) + ':' + content.length);

  return 'mh-sess-' + hash1 + hash2;
}
