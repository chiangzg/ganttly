import { expect, test, type Page } from '@playwright/test';

/**
 * Person-days column + constraint editor E2E (P1 features two & three).
 *
 * Verifies:
 * - The Toolbar "人天列" toggle button exists and is clickable.
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

  test('toggling the effort column adds the 人天 header and shows the value', async ({ page }) => {
    // Toggle on via the toolbar button.
    await page.getByRole('button', { name: '人天列' }).click();
    await page.waitForTimeout(300);
    // t1: load=50%, capacity=1.0, duration=5 → 0.5 × 1.0 × 5 = 2.5 person-days.
    // Verify via the DOM that "2.5" appears somewhere in the task table area.
    // Use a broad search since the value renders inside a grid cell.
    const tableArea = page.locator('.border-r.border-border').first();
    await expect(tableArea.getByText('2.5')).toBeVisible({ timeout: 5000 });

    // Toggle off.
    await page.getByRole('button', { name: '人天列' }).click();
    await page.waitForTimeout(300);
  });
});

test.describe('constraint editor', () => {
  test.beforeEach(async ({ page }) => {
    await injectFixture(page);
  });

  test('the drawer exposes the constraint editor section', async ({ page }) => {
    // Open the task drawer by double-clicking the task row.
    await page.getByText('开发').dblclick();
    await page.waitForTimeout(200);
    // The constraint field label "约束" should be visible in the drawer.
    await expect(page.getByText('约束')).toBeVisible();
    // The constraint type select should be present in the drawer (aside).
    const drawer = page.locator('aside');
    await expect(drawer.locator('select').last()).toBeVisible();
  });
});
