import { expect, test } from '@playwright/test';

/**
 * Screenshot baselines for the gantt canvas (PRD §5.5).
 *
 * These are checked into Git under `__screenshots__/`. Run `pnpm test:e2e`
 * locally; if the diff is intentional, accept with `--update-snapshots`.
 *
 * Cross-platform anti-aliasing differences may push us to bump
 * `maxDiffPixelRatio` per-snapshot. Keep it tight by default.
 */

test('canvas renders with a task', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('button', { name: '取消' }).click();

  await expect(page.locator('canvas')).toHaveScreenshot('canvas-with-task.png', {
    maxDiffPixelRatio: 0.01,
  });
});

test('day-view zoom renders compact columns', async ({ page }) => {
  await page.goto('/');
  // Zoom in to day view: week is default, click "+" once.
  await page.locator('button[title="放大"]').click();
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('button', { name: '取消' }).click();

  await expect(page.locator('canvas')).toHaveScreenshot('canvas-day-view.png', {
    maxDiffPixelRatio: 0.01,
  });
});
