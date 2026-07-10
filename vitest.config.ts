import { defineConfig } from 'vitest/config';

// Scope unit tests to the TypeScript sources. The legacy `test/*.test.mjs`
// files are `node --test` cross-checks (run separately, not under vitest).
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
