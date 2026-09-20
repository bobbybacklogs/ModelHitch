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
    alias: {
      electron: here('./stubs/electron.ts'),
      'modelhitch/browser': here('../src/browser.ts'),
      'modelhitch/react': here('../src/react/index.ts'),
    },
  },
  test: {
    root: here('.'),
    environment: 'node',
    fileParallelism: false,
  },
});
