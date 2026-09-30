import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'markdown-as-text',
      transform(source, id) {
        if (id.endsWith('.md')) return `export default ${JSON.stringify(source)}`;
      },
    },
  ],
  test: {
    environment: 'node',
    // Platform SDK packages have their own vitest configs (they alias Electron,
    // Expo, and React Native peers to stubs). Run them with `npm test` inside
    // each package directory.
    //
    // The TUI frame test runs under bun instead: OpenTUI's renderer needs bun's
    // native FFI, so vitest cannot construct one and the import fails outright.
    // It is covered by `npm run test:tui`.
    //
    // The `.tmp-*` sandboxes are excluded for a subtler reason: several tests
    // build scratch trees under `tests/`, and a fixture legitimately named
    // `*.test.ts` (the workspace detector's heuristics are *about* test files)
    // matches vitest's own include pattern. When the suite runs in parallel a
    // worker can discover another worker's fixture mid-run and try to execute
    // it, which fails intermittently and looks like a real failure.
    exclude: [
      ...configDefaults.exclude,
      'expo-sdk/**',
      'electron-sdk/**',
      'agent-runtime/tests/**',
      'tests/harness-tui-frame.test.ts',
      'tests/.tmp-*/**',
    ],
  },
});
