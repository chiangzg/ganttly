import { expect, test } from '@playwright/test';

/**
 * Smoke test — confirms the app boots, shows the toolbar, and renders an
 * empty-state canvas without console errors. Deeper screenshot tests are
 * added per milestone (M1 baseline, M3 critical path, etc.).
 */
test('app boots and shows the toolbar', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  // Toolbar buttons render.
  await expect(page.getByRole('button', { name: '今天' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '关键路径' }).or(page.getByText('显示关键路径')),
  ).toBeVisible();

  // No console errors.
  expect(errors, errors.join('\n')).toEqual([]);
});

test('adding a task from toolbar creates a row in the table', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建任务' }).click();

  // A row appears in the task table.
  await expect(page.locator('[role="row"]').first()).toBeVisible({ timeout: 2000 });

  // The drawer opens.
  await expect(page.getByText('编辑任务')).toBeVisible();
});
