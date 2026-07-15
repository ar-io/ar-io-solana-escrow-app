import { defineConfig } from 'vitest/config';

// Scope unit tests to the TypeScript sources under src/. Pure logic only
// (canonical rebuild, claim-flow security controls) — no DOM, no RPC.
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
