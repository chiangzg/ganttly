import { expect, test, type Page } from '@playwright/test';

/**
 * Person-days column + constraint editor E2E (P1 features two & three).
 *
 * Verifies:
 * - The person-days column is shown by default (the toolbar toggle was
 *   removed — the column now always renders in task and resource views).
 * - The effort column displays computed person-days for assigned tasks.
 * - The TaskDrawer exposes the constraint editor section.
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
            name: '开发',
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
            assignments: [{ resourceId: 'r1', load: 50 }],
            customFields: {},
          },
        ],
        resources: [{ id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' }],
      },
    });
  });
}

test.describe('person-days column', () => {
  test.beforeEach(async ({ page }) => {
    await injectFixture(page);
  });

  test('the effort column shows the 人天 header and value by default', async ({ page }) => {
    // The person-days column is always shown now — no toolbar toggle required.
    // t1: load=50%, capacity=1.0, duration=5 → 0.5 × 1.0 × 5 = 2.5 person-days.
    // Verify via the DOM that "2.5" appears somewhere in the task table area.
    // Use a broad search since the value renders inside a grid cell.
    const tableArea = page.locator('.border-r.border-border').first();
    await expect(tableArea.getByText('2.5')).toBeVisible({ timeout: 5000 });
  });

  test('resource-view drill-down shows per-resource person-days in task lanes', async ({
    page,
  }) => {
    // Switch to resource view, where Alice (r1) carries task "开发" at 50% load.
    await page.getByRole('button', { name: '资源视图' }).click();
    await expect(page.locator('input[value="Alice"]')).toBeVisible();

    // The person-days column is always shown — no toggle needed.
    const resourceList = page.locator('[data-resource-list]');
    // Task columns belong to the expanded resource group, not the fixed
    // resource summary header.
    await expect(resourceList.getByText('工期', { exact: true })).toHaveCount(0);
    await expect(resourceList.getByText('人天', { exact: true })).toHaveCount(0);

    // Drill down Alice to reveal her task lane.
    const aliceRow = page
      .locator('[role="row"]')
      .filter({ has: page.locator('input[value="Alice"]') });
    await aliceRow.locator('button', { hasText: '▶' }).click();
    await expect(resourceList.getByText('工期', { exact: true })).toBeVisible();
    await expect(resourceList.getByText('人天', { exact: true })).toBeVisible();
    // The drilled-down task lane "开发" now appears beneath Alice's row.
    const taskLane = page.locator('[role="row"]').filter({ hasText: '开发' });
    await expect(taskLane).toBeVisible();

    // r1: load=50%, capacity=1.0, duration=5 → 0.5 × 1.0 × 5 = 2.5 person-days
    // for THIS resource on this task. Scope the assertion to the task lane so
    // it isn't confused by the StatusBar's project-total "2.5 人天".
    await expect(taskLane.getByText('2.5')).toBeVisible({ timeout: 5000 });
  });

  test('explicit overtime is editable and affects effort without inferring the whole weekend', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
        setState: (s: unknown) => void;
        getState: () => {
          file: { tasks: Array<Record<string, unknown>> } & Record<string, unknown>;
        };
      };
      const file = store.getState().file;
      store.setState({
        file: {
          ...file,
          tasks: file.tasks.map((task) =>
            task.id === 't1'
              ? { ...task, end: '2026-02-09', duration: 6, overtimeDates: [] }
              : task,
          ),
        },
      });
    });

    // Open the drawer via right-click → "编辑" (double-click edits inline now).
    await page.locator('[role="row"]', { hasText: '开发' }).first().click({ button: 'right' });
    await page.locator('.fixed.z-30 button', { hasText: '编辑' }).first().click();
    await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 3000 });
    const drawer = page.locator('aside');
    await expect(drawer.getByText('3', { exact: true })).toBeVisible();

    const dateInputs = drawer.locator('input[type="date"]');
    await dateInputs.nth(2).fill('2026-02-07'); // Saturday inside the task range
    await drawer.getByRole('button', { name: '添加' }).click();
    const removeOvertime = drawer.getByRole('button', { name: '删除加班日 2026-02-07' });
    await expect(removeOvertime).toBeVisible();
    await expect(drawer.getByText('3.5', { exact: true })).toBeVisible();

    // A normal working day cannot be marked as an extra full overtime day.
    await dateInputs.nth(2).fill('2026-02-06');
    await drawer.getByRole('button', { name: '添加' }).click();
    await expect(drawer.getByText('只能将项目日历中的休息日标记为加班日')).toBeVisible();

    // Moving the end before the overtime date prunes the marker immediately.
    await dateInputs.nth(1).fill('2026-02-06');
    await expect(removeOvertime).toHaveCount(0);
    await expect(drawer.getByText('2.5', { exact: true })).toBeVisible();
  });
});

test.describe('constraint editor', () => {
  test.beforeEach(async ({ page }) => {
    await injectFixture(page);
  });

  test('the drawer exposes the constraint editor section', async ({ page }) => {
    // Open the task drawer via right-click → "编辑" (double-click edits inline
    // now — PR 8 §4.3).
    await page.locator('[role="row"]', { hasText: '开发' }).first().click({ button: 'right' });
    await page.locator('.fixed.z-30 button', { hasText: '编辑' }).first().click();
    await page.waitForTimeout(200);
    // The constraint field label "约束" should be visible in the drawer.
    await expect(page.getByText('约束')).toBeVisible();
    // The constraint type select should be present in the drawer (aside).
    const drawer = page.locator('aside');
    await expect(drawer.locator('select').last()).toBeVisible();
  });
});
