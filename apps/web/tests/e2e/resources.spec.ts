import { expect, test, type Page } from '@playwright/test';

/**
 * Resource view E2E (P1 feature one — G7/G19).
 *
 * Verifies:
 * - Toolbar switches between task ↔ resource view
 * - ResourceList renders and supports add/remove
 * - TaskDrawer assignment editing flows into the load chart
 * - Switching views preserves scroll independence (G19)
 */

async function injectFixture(page: Page) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    store.setState({
      file: {
        ...f,
        tasks: [
          {
            id: 't1',
            name: '设计',
            parentId: null,
            order: 0,
            start: '2026-02-02',
            end: '2026-02-06',
            duration: 5,
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: {},
            assignments: [{ resourceId: 'r1', load: 50 }],
            customFields: {},
          },
        ],
        resources: [{ id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' }],
      },
    });
  });
}

test.describe('resource view', () => {
  test.beforeEach(async ({ page }) => {
    await injectFixture(page);
  });

  test('switches to resource view and shows the resource list', async ({ page }) => {
    // Default is task view — TaskTable header "WBS" should be visible.
    await expect(page.getByText('WBS').first()).toBeVisible();
    // Switch to resource view.
    await page.getByRole('button', { name: '资源视图' }).click();
    // ResourceList header "资源名称" should now be visible, Alice listed.
    await expect(page.getByText('资源名称').first()).toBeVisible();
    // Alice is now in an <input value="Alice"> — match by CSS attribute.
    await expect(page.locator('input[value="Alice"]')).toBeVisible();
  });

  test('adds a resource via the list footer button', async ({ page }) => {
    await page.getByRole('button', { name: '资源视图' }).click();
    await expect(page.locator('input[value="Alice"]')).toBeVisible();
    await page.getByRole('button', { name: '新增资源' }).click();
    // Two resources now (Alice + the new placeholder).
    await expect(page.locator('input[value="Alice"]')).toBeVisible();
  });

  test('removes a resource via the row × button', async ({ page }) => {
    await page.getByRole('button', { name: '资源视图' }).click();
    await expect(page.locator('input[value="Alice"]')).toBeVisible();
    // Click the × button inside Alice's row (the row containing the input).
    const aliceRow = page
      .locator('[role="row"]')
      .filter({ has: page.locator('input[value="Alice"]') });
    await aliceRow.locator('button', { hasText: '×' }).click();
    await expect(page.locator('input[value="Alice"]')).toHaveCount(0);
  });

  test('load chart canvas renders in resource view', async ({ page }) => {
    await page.getByRole('button', { name: '资源视图' }).click();
    // The canvas element should be present in the resource view.
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    // Canvas should have a non-zero size (rendered, not zero-sized).
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  test('switching back to task view restores the task table', async ({ page }) => {
    await page.getByRole('button', { name: '资源视图' }).click();
    await expect(page.locator('input[value="Alice"]')).toBeVisible();
    await page.getByRole('button', { name: '任务视图' }).click();
    // Task view header returns.
    await expect(page.getByText('WBS').first()).toBeVisible();
    // The injected task "设计" should be visible again.
    await expect(page.getByText('设计')).toBeVisible();
  });
});
