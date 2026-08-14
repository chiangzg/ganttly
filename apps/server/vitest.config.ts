import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests require a live PostgreSQL (TEST_DATABASE_URL). They
    // self-skip when unset, so `pnpm -r test` stays green without a database.
    // All integration files share that one database (and several wipe tables
    // in beforeAll), so files must not run in parallel.
    fileParallelism: false,
  },
});
