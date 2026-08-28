import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/react.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  // The DTS step resolves the external peers via tsconfig.build.json's paths
  // (in-repo stubs); the emitted declarations still name the real peers.
  tsconfig: 'tsconfig.build.json',
  // Everything an Expo app already owns stays external — the adapter is a thin
  // layer, never a second copy of ModelHitch, React, or the Expo modules.
  external: ['expo', 'expo/fetch', 'expo-secure-store', 'modelhitch', 'modelhitch/browser', 'modelhitch/react', 'react', 'react/jsx-runtime', 'react-native'],
});
