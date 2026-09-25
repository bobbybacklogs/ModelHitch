import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/browser.ts', 'src/react/index.ts', 'src/cli.ts', 'src/settings-tui.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    loader: { '.md': 'text' },
    // mdev-sdk is ESM-only with no CJS entry — bundle it into dist so both the
    // ESM and CJS builds (and the browser entry) keep working for consumers.
    // React stays a peer dependency of the `modelhitch/react` entry — never
    // bundle it.
    external: ['react', 'react/jsx-runtime', '@opentui/core'],
    noExternal: ['mdev-sdk'],
  },
  {
    // Local-dev harness CLI (unpublished). ESM-only node launcher so
    // `npm link` can expose a `modelhitch-harness` command without tsx.
    // Rebuild after editing harness/* via `npm run build`.
    entry: { 'harness-cli': 'harness/cli.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'es2022',
    external: ['react', 'react/jsx-runtime', '@opentui/core'],
    noExternal: ['mdev-sdk'],
  },
]);
