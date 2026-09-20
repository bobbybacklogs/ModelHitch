import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/ipc.ts', 'src/react.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  tsconfig: 'tsconfig.build.json',
  external: [
    'electron',
    'modelhitch',
    'modelhitch/browser',
    'modelhitch/react',
    'react',
    'react/jsx-runtime',
  ],
});
