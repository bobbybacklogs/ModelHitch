import { fetch as expoFetchImpl } from 'expo/fetch';

/**
 * Expo's WinterCG-compliant `fetch`. Unlike React Native's built-in `fetch`
 * (XMLHttpRequest under the hood) it exposes `response.body` as a real
 * `ReadableStream`, which is what ModelHitch needs to stream SSE token deltas
 * instead of buffering the whole reply.
 *
 * Pass it to any provider factory as `fetchImpl`, or call `installExpoFetch()`
 * once at app start to make the built-in providers use it.
 */
export const expoFetch = expoFetchImpl as unknown as typeof fetch;

/**
 * Point `globalThis.fetch` at {@link expoFetch}.
 *
 * On Android and iOS Expo already installs its fetch globally, so this is a
 * no-op — unless the app opted out with `EXPO_PUBLIC_USE_RN_FETCH=1`, in which
 * case the built-in providers would otherwise fall back to the non-streaming
 * React Native implementation. Idempotent and safe to call on every launch.
 *
 * @returns the streaming fetch that is now installed globally.
 */
export function installExpoFetch(): typeof fetch {
  const target = globalThis as { fetch?: typeof fetch };
  if (target.fetch !== expoFetch) target.fetch = expoFetch;
  return expoFetch;
}

/** True when the current `globalThis.fetch` can stream a response body. */
export function hasStreamingFetch(): boolean {
  return (globalThis as { fetch?: typeof fetch }).fetch === expoFetch;
}
