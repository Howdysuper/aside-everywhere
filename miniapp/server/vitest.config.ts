import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-owner.ts'],
    // Day/time wording is asserted for a fixed zone, whatever the machine's zone is.
    env: { TZ: 'America/Chicago' },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
