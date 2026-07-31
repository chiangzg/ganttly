import { expect, test, type Page } from '@playwright/test';

/**
 * Delete confirmation + undo toast E2E
 * (editor-interaction-optimization-plan §2.4).
 *
 * Acceptance criteria:
 *  1. Deleting a parent task shows child count in the confirmation dialog.
 *  2. Deleting a resource shows affected assignment count.
 *  3. After deletion, an undo toast appears; clicking undo restores the data.
 *  4. Keyboard: Escape closes the dialog; focus returns to the trigger element.
 */

interface StoreApi {
  getState: () => {
    file: {
      tasks: Array<{ id: string; name: string } & Record<string, unknown>>;
      resources: Array<{ id: string; name: string } & Record<string, unknown>>;
      viewState: Record<string, unknown>;
    };
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}

async function injectFixture(page: Page) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const f = s.getState().file;
    s.setState({
      file: {
        ...f,
        tasks: [
          {
            id: 'parent',
            name: '父任务',
            parentId: null,
            order: 0,
            start: '2026-02-02',
            end: '2026-02-06',
            duration: 5,
            overtimeDates: [],
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: { type: 'none' },
            assignments: [],
            customFields: {},
          },
          {
            id: 'child1',
            name: '子任务1',
            parentId: 'parent',
            order: 0,
            start: '2026-02-02',
            end: '2026-02-03',
            duration: 2,
            overtimeDates: [],
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: { type: 'none' },
            assignments: [],
            customFields: {},
          },
          {
            id: 'child2',
            name: '子任务2',
            parentId: 'parent',
            order: 1,
            start: '2026-02-04',
            end: '2026-02-06',
            duration: 3,
            overtimeDates: [],
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: { type: 'none' },
            assignments: [],
            customFields: {},
          },
        ],
        resources: [{ id: 'r1', name: 'Alice', capacity: 1.0 }],
        viewState: {
          ...(f.viewState as object),
          zoom: 'week',
          scrollLeft: 0,
          scrollTop: 0,
          selectedTaskId: null,
          showCriticalPath: false,
          collapsedTaskIds: [],
        },
      },
    });
  });
}

test('删除父任务时显示子任务影响数量', async ({ page }) => {
  await injectFixture(page);

  await page.locator('[role="row"]', { hasText: '父任务' }).first().click();
  await page.locator('[role="row"]', { hasText: '父任务' }).first().press('Delete');

  await expect(page.getByText(/2 个子任务.*删除/)).toBeVisible({ timeout: 3000 });
  await expect(page.getByText(/共将删除 3 个任务/)).toBeVisible();

  // Cancel.
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('[role="row"]')).toHaveCount(3);
});

test('删除无子任务的任务时对话框仅显示确认描述', async ({ page }) => {
  await injectFixture(page);

  // Delete a leaf task (child1 has no children).
  await page.locator('[role="row"]', { hasText: '子任务1' }).first().click();
  await page.locator('[role="row"]', { hasText: '子任务1' }).first().press('Delete');

  // The confirm dialog appears without impact lines (no children, no deps).
  await expect(page.getByText('确认删除此任务？')).toBeVisible({ timeout: 3000 });
  // Impact section should NOT show children or dependencies.
  await expect(page.getByText(/个子任务/)).toHaveCount(0);

  // Confirm the delete.
  await page.getByRole('button', { name: '删除' }).click();
  await page.waitForTimeout(200);

  // Toast should appear for single task deletion.
  await expect(page.getByText(/已删除任务: 子任务1/)).toBeVisible({ timeout: 3000 });

  // Undo via toolbar (toast undo button is scoped separately).
  await page.getByLabel('撤销').click();
  await page.waitForTimeout(200);

  // Child1 should be restored (filter by role="row" to avoid toast text).
  await expect(page.locator('[role="row"]').filter({ hasText: '子任务1' })).toBeVisible();
});

test('删除后显示撤销 toast，点击撤销可恢复数据', async ({ page }) => {
  await injectFixture(page);

  await page.locator('[role="row"]', { hasText: '父任务' }).first().click();
  await page.locator('[role="row"]', { hasText: '父任务' }).first().press('Delete');
  await page.getByRole('button', { name: '删除' }).click();
  await page.waitForTimeout(200);

  // The undo toast should appear.
  const toast = page.locator('text=已删除 3 个任务');
  await expect(toast).toBeVisible({ timeout: 3000 });

  // Click undo in the toast (scope to the toast container to avoid the
  // toolbar undo button which has the same accessible name "撤销").
  const toastContainer = toast.locator('..');
  await toastContainer.getByRole('button', { name: '撤销' }).click();
  await page.waitForTimeout(200);

  // All 3 tasks restored.
  await expect(page.locator('[role="row"]')).toHaveCount(3);
  await expect(page.getByText('父任务')).toBeVisible();
});

test('Escape 可关闭确认弹窗', async ({ page }) => {
  await injectFixture(page);

  await page.locator('[role="row"]', { hasText: '父任务' }).first().focus();
  await page.locator('[role="row"]', { hasText: '父任务' }).first().press('Delete');

  await expect(page.getByText('确认删除此任务？')).toBeVisible({ timeout: 3000 });

  // Escape closes Radix dialog.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // Dialog gone, no deletion.
  await expect(page.getByText('确认删除此任务？')).toHaveCount(0);
  await expect(page.locator('[role="row"]')).toHaveCount(3);
});
