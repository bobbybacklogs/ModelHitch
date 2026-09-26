import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Isolated config for the Phase 1 agent-runtime suite. Deliberately separate
// from the root vitest.config.ts so it cannot interfere with the existing
// ModelHitch root suite contracts. Run with `npm run test:agent-runtime`.
export default defineConfig({
  test: {
    root: here('.'),
    environment: 'node',
    include: ['*.test.ts'],
  },
});