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

test('nested WBS numbers remain visible as the hierarchy gets deeper', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible();

  await page.evaluate(() => {
    type TestStore = {
      getState: () => { file: Record<string, unknown> };
      setState: (state: { file: Record<string, unknown> }) => void;
    };
    const store = (window as unknown as { __ganttlyStore?: TestStore }).__ganttlyStore;
    if (!store) throw new Error('store not exposed');
    const file = store.getState().file;
    const task = (id: string, parentId: string | null, order: number) => ({
      id,
      name: id,
      parentId,
      order,
      start: '2026-01-05',
      end: '2026-01-05',
      duration: 1,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: { type: 'none' },
      assignments: [],
      customFields: {},
    });
    store.setState({
      file: {
        ...file,
        tasks: [task('root', null, 0), task('child', 'root', 0), task('grandchild', 'child', 0)],
      },
    });
  });
  const grandchildRow = page.locator('[data-task-id="grandchild"]');
  await expect(grandchildRow).toBeVisible();
  const grandchildWbs = grandchildRow.locator('[data-field="wbs"]');
  await expect(grandchildWbs).toContainText('1.1.1');
  const metrics = await grandchildWbs.evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
});

test('Delete removes a task after confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('[role="row"]')).toHaveCount(1);

  // Press Delete on the row — opens the in-app confirmation dialog.
  await page.locator('[role="row"]').first().click();
  await page.locator('[role="row"]').first().press('Delete');

  // Click the confirm delete button in the dialog.
  await page.getByRole('button', { name: '删除' }).click();

  await expect(page.locator('[role="row"]')).toHaveCount(0);
});
