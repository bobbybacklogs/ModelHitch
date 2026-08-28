import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    {
      name: 'markdown-as-text',
      transform(source, id) {
        if (id.endsWith('.md')) return `export default ${JSON.stringify(source)}`;
      },
    },
  ],
  resolve: {
    // The Expo/React Native peers and the `modelhitch` browser entry are not
    // installed here; point them at in-repo stubs and sources instead.
    alias: {
      'expo/fetch': here('./stubs/expo-fetch.ts'),
      'expo-secure-store': here('./stubs/expo-secure-store.ts'),
      'react-native': here('./stubs/react-native.ts'),
      'modelhitch/browser': here('../src/browser.ts'),
      'modelhitch/react': here('../src/react/index.ts'),
    },
  },
  test: {
    root: here('.'),
    environment: 'node',
  },
});
