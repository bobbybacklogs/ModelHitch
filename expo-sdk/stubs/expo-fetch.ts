// Local stub for `expo/fetch` so the adapter can be typechecked and tested
// without an Expo app's dependency tree. Never bundled or published.
export const fetch: typeof globalThis.fetch = (...args) =>
  Promise.reject(new Error(`expo/fetch stub called with ${String(args[0])}`));
