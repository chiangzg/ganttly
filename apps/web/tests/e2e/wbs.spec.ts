import { expect, test } from '@playwright/test';

/**
 * WBS editing E2E — verifies the task-table interactions (PRD §3.1, §3.10).
 * We create a task via the toolbar, then drive keyboard interactions.
 */

test('Tab indents a task under its predecessor', async ({ page }) => {
  await page.goto('/');

  // Create two top-level tasks.
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('button', { name: '取消' }).click();
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('button', { name: '取消' }).click();

  // Two rows should be present.
  await expect(page.locator('[role="row"]')).toHaveCount(2);

  // Focus the second row, press Tab to indent it under the first.
  await page.locator('[role="row"]').nth(1).click();
  await page.locator('[role="row"]').nth(1).press('Tab');

  // The second task's WBS number should now be `1.1`.
  const second = page.locator('[role="row"]').nth(1);
  await expect(second).toContainText('1.1');
});

test('Delete removes a task after confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('[role="row"]')).toHaveCount(1);

  page.on('dialog', (d) => d.accept());
  await page.locator('[role="row"]').first().click();
  await page.locator('[role="row"]').first().press('Delete');

  await expect(page.locator('[role="row"]')).toHaveCount(0);
});
