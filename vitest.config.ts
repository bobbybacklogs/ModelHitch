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
    // expo-sdk is a separate package with its own vitest config (it aliases the
    // Expo/React Native peers to stubs). Run it with `npm test` inside expo-sdk.
    exclude: [...configDefaults.exclude, 'expo-sdk/**'],
  },
});
