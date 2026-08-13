import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests require a live PostgreSQL (TEST_DATABASE_URL). They
    // self-skip when unset, so `pnpm -r test` stays green without a database.
  },
});
