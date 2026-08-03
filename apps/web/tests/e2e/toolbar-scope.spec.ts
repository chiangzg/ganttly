import { expect, test } from '@playwright/test';

/**
 * Toolbar scope E2E (editor-interaction-optimization-plan §5.1 + §3.1).
 *
 * Covers:
 *  - the task-creation primary entry now lives in the TaskTable header (near
 *    the task list, §3.1), and the layer-2 editor toolbar no longer carries a
 *    "新建任务" button (§5.1: layer 2 keeps undo/redo/save/export only)
 *  - the editor overflow menu's group headers are visible & i18n'd
 *    (时间缩放 / 显示选项 / 导出当前项目) at narrow widths
 *  - the project overflow menu has a "项目操作" group header (§5.1)
 *
 * Stores are exposed at `window.__ganttlyStore`.
 */

interface StoreApi {
  getState: () => { file: { tasks: unknown[] } };
  setState: (s: { file: Record<string, unknown> }) => void;
}

test.describe('§5.1 toolbar scope', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.waitForTimeout(400);
  });

  test('task creation lives in the TaskTable header, not the editor toolbar', async ({ page }) => {
    // The editor toolbar (layer 2) must NOT have a "新建任务" button.
    const toolbar = page.locator('[data-editor-toolbar]');
    await expect(toolbar.getByRole('button', { name: '新建任务' })).toHaveCount(0);

    // The TaskTable header does.
    const headerBtn = page.locator('[data-task-search]').getByRole('button', { name: '新建任务' });
    await expect(headerBtn).toBeVisible({ timeout: 3000 });

    // Clicking it creates a root task (same shared path as the empty state).
    await headerBtn.click();
    const taskCount = await page.evaluate(() => {
      const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      return store.getState().file.tasks.length;
    });
    expect(taskCount).toBe(1);
  });

  test('editor overflow menu shows group headers at narrow width', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/');
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.waitForTimeout(400);

    // Open the "更多操作" overflow (far-right MoreHorizontal button).
    await page.locator('[data-editor-toolbar] button[title="更多操作"]').click();

    // §5.1 group headers, in the portal menu.
    await expect(page.getByText('时间缩放')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('显示选项')).toBeVisible();
    await expect(page.getByText('导出当前项目')).toBeVisible();
  });

  test('project overflow menu shows the "项目操作" group header', async ({ page }) => {
    // Open the project-header "项目更多" menu (MoreHorizontal, title 项目操作).
    await page.locator('header button[title="项目操作"]').click();
    await expect(page.getByText('项目操作')).toBeVisible({ timeout: 3000 });
  });
});
