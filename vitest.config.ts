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
    exclude: [...configDefaults.exclude, 'expo-sdk/**', 'electron-sdk/**', 'agent-runtime/tests/**'],
  },
});
