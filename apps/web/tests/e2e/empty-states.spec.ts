import { expect, test, type Page } from '@playwright/test';

/**
 * Empty states E2E (editor-interaction-optimization-plan §5.2).
 *
 * Covers:
 *  - zero tasks: the task table shows a "create first task" CTA inside the
 *    content area (not just the far toolbar), and clicking it creates a task
 *    and opens the drawer
 *  - zero tasks: the Gantt canvas still renders its timeline (no crash)
 *  - tasks exist but the search/filter excludes everything: a "no matches"
 *    panel shows INSTEAD of the create-first-task CTA (§5.2: the CTA must not
 *    appear when emptiness is filter-induced)
 *  - zero resources: the resource list shows a hint + the bottom "+ 新增资源"
 *    button remains the CTA
 *
 * Stores are exposed at `window.__ganttlyStore` / `__ganttlyViewStore`.
 */

interface StoreApi {
  getState: () => {
    file: { tasks: unknown[]; resources: unknown[]; viewState: Record<string, unknown> };
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}

async function clearTasks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    if (!store) throw new Error('store not exposed');
    const file = store.getState().file;
    store.setState({ file: { ...file, tasks: [], resources: [] } });
  });
  await page.waitForTimeout(150);
}

async function injectOneTask(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    if (!store) throw new Error('store not exposed');
    const file = store.getState().file;
    store.setState({
      file: {
        ...file,
        tasks: [
          {
            id: 'a',
            name: 'alpha',
            parentId: null,
            order: 0,
            start: '2026-01-05',
            end: '2026-01-06',
            duration: 2,
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: { type: 'none' },
            assignments: [],
            customFields: {},
          },
        ],
        resources: [],
      },
    });
  });
  await page.waitForTimeout(150);
}

test.describe('§5.2 empty states', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.waitForTimeout(400);
  });

  test('zero tasks: table shows the create-first-task CTA, canvas still renders', async ({
    page,
  }) => {
    await clearTasks(page);

    // CTA inside the task table content area (§5.2: 新用户无需移动到页面右上角).
    const cta = page.getByRole('button', { name: '新建首个任务' });
    await expect(cta).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('还没有任务')).toBeVisible();

    // The Gantt canvas still exists with its timeline (no crash, no fake data).
    await expect(page.locator('[data-gantt-chart] canvas').first()).toBeVisible();

    // Clicking the CTA creates the first root task and opens the edit drawer.
    await cta.click();
    await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 3000 });
    const taskCount = await page.evaluate(() => {
      const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      return store.getState().file.tasks.length;
    });
    expect(taskCount).toBe(1);

    // Empty state disappears once a task exists.
    await expect(page.getByText('还没有任务')).toHaveCount(0);
  });

  test('filter-no-match: shows "no matching tasks", NOT the create CTA', async ({ page }) => {
    await injectOneTask(page);

    // Search for a name that cannot match.
    await page.getByPlaceholder('搜索任务名或 WBS…').fill('zzz-not-a-task');
    await expect(page.getByText('没有匹配的任务')).toBeVisible({ timeout: 3000 });
    // The create-first-task CTA must NOT appear (emptiness is filter-induced).
    await expect(page.getByRole('button', { name: '新建首个任务' })).toHaveCount(0);

    // Clearing the search restores the row and removes the panel.
    await page.getByPlaceholder('搜索任务名或 WBS…').fill('');
    await expect(page.getByText('没有匹配的任务')).toHaveCount(0);
    await expect(page.locator('[data-task-id="a"]')).toBeVisible();
  });

  test('zero resources: list shows a hint and the bottom add button remains', async ({ page }) => {
    await clearTasks(page);

    // Switch to the resource view.
    await page.getByRole('button', { name: '资源视图' }).click();
    await expect(page.getByText('还没有资源')).toBeVisible({ timeout: 3000 });

    // The pinned bottom "+ 新增资源" button is still the CTA (§5.2).
    const addBtn = page.getByRole('button', { name: /新增资源/ });
    await expect(addBtn).toBeVisible();

    // Clicking it creates a resource.
    await addBtn.click();
    const resourceCount = await page.evaluate(() => {
      const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      return store.getState().file.resources.length;
    });
    expect(resourceCount).toBe(1);
    await expect(page.getByText('还没有资源')).toHaveCount(0);
  });
});
