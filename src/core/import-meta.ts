import { pathToFileURL } from 'node:url';

/**
 * Absolute file URL of the module currently executing (e.g.
 * `file:///.../modelhitch/dist/cli.js` or `.cjs`).
 *
 * Both dist formats bundle the whole source tree into one output file, so
 * every module resolves to the same directory — which is exactly what we rely
 * on when resolving sibling files (`../package.json`, `./settings-tui.${ext}`).
 *
 * The lookups differ per format:
 *  - ESM output (`dist/*.js`): Node provides `import.meta.url` natively.
 *  - CJS output (`dist/*.cjs`): esbuild/tsup shim `import.meta` as an empty
 *    `{}` and never populate `.url`, so `import.meta.url` is `undefined` there
 *    and `new URL(rel, import.meta.url)` / `createRequire(import.meta.url)`
 *    throw. Fall back to `__filename`, which Node always defines in CJS.
 */
export function currentModuleUrl(): string {
  return typeof __filename !== 'undefined' ? pathToFileURL(__filename).href : import.meta.url;
}