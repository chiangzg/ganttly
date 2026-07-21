import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config. E2E + screenshot tests live in `tests/e2e/`.
 *
 * PRD §5.5: screenshot tests are required for Canvas visual regression.
 * To keep CI cross-platform pixel diffs tractable, we run them on a single
 * platform/browser in CI (linux + chromium in a Docker image), but locally
 * the dev can run any combination.
 */
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  fullyParallel: !CI,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  workers: CI ? 1 : undefined,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  expect: {
    // Screenshot diff tolerance — kept tight. Cross-platform font anti-alias
    // differences may force this up; prefer per-snapshot `maxDiffPixelRatio`.
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, threshold: 0.2 },
  },
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !CI,
    timeout: 60_000,
    cwd: '.',
  },
});
