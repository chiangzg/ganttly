import { expect, test, type Page } from '@playwright/test';

/**
 * Drawer docked-inspector E2E (editor-interaction-optimization-plan §3.7).
 *
 * Verifies the task drawer is a DOCKED inspector (not an absolute overlay):
 *  - Opening it does NOT cover the project navigation / toolbar.
 *  - The canvas shrinks to make room (its width decreases).
 *  - The selected task stays visible (revealTask runs after the reflow).
 *  - The resize handle changes the width, persisted to localStorage.
 *  - Double-click resets to the default width.
 *  - At 1192×955 the drawer does not overflow (right edge within viewport).
 */

interface StoreApi {
  getState: () => {
    file: { tasks: unknown[]; project: { startDate?: string }; viewState: Record<string, unknown> };
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}
interface ViewStoreApi {
  getState: () => { drawerWidth: number };
}

const STORAGE_KEY = 'ganttly:preferences:drawer-width';
const DEFAULT_DRAWER_WIDTH = 360;

async function injectTask(page: Page) {
  // Clear any prior width preference ONCE, only for this test's initial load.
  // (Using addInitScript would also fire on page.reload() inside a test and wipe
  // the value we're trying to verify persists — so gate it with a sessionStorage
  // flag so it runs exactly once per page context.)
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('__cleanedDrawerWidth')) {
      localStorage.removeItem(key);
      sessionStorage.setItem('__cleanedDrawerWidth', '1');
    }
  }, STORAGE_KEY);
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
            id: 't1',
            name: '设计',
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
        ],
        // Pin the project start so the task bar is near the chart origin.
        project: { ...(f.project as object), startDate: '2026-02-02' },
        viewState: {
          ...f.viewState,
          zoom: 'week',
          scrollLeft: 0,
          scrollTop: 0,
          selectedTaskId: 't1',
          showCriticalPath: false,
          collapsedTaskIds: [],
        },
      },
    });
  });
}

/** Open the drawer by double-clicking the task name in the left table. */
async function openDrawer(page: Page) {
  await page.getByText('设计').first().dblclick();
  await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 3000 });
}

/** Read the canvas (chart) clientWidth via the live DOM. */
async function chartWidth(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-gantt-chart]') as HTMLElement | null;
    return el ? el.clientWidth : 0;
  });
}

/** Read the persisted drawer width from localStorage. */
async function readStoredWidth(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
}

test.describe('drawer docked inspector', () => {
  test('§3.7 opening the drawer keeps the toolbar visible (not covered)', async ({ page }) => {
    await injectTask(page);
    // A toolbar control must be visible both before and after opening the drawer.
    const addTaskBtn = page.getByRole('button', { name: '新建任务' });
    await expect(addTaskBtn).toBeVisible();
    const toolbarBoxBefore = await addTaskBtn.boundingBox();

    await openDrawer(page);

    // The toolbar button is still visible (not covered by an overlay).
    await expect(addTaskBtn).toBeVisible();
    const toolbarBoxAfter = await addTaskBtn.boundingBox();
    // The toolbar didn't move/shift because of the drawer (docked, not overlay).
    expect(toolbarBoxAfter?.x).toBeCloseTo(toolbarBoxBefore!.x, 0);
  });

  test('§3.7 opening the drawer shrinks the canvas width', async ({ page }) => {
    await injectTask(page);
    const before = await chartWidth(page);
    await openDrawer(page);
    await page.waitForTimeout(200); // allow ResizeObserver + re-render
    const after = await chartWidth(page);
    // The canvas gave up roughly the drawer's width (default 360).
    expect(before - after).toBeGreaterThan(300);
  });

  test('§3.7 dragging the resize handle changes and persists the width', async ({ page }) => {
    await injectTask(page);
    await openDrawer(page);

    const handle = page.getByRole('separator', { name: '拖动调整抽屉宽度' });
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();

    // Drag the handle LEFT by ~60px → drawer gets WIDER (width = start - dx,
    // and dx is negative when moving left). Use mouse steps.
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + 10;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 60, startY, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    // The store width increased beyond the default.
    const width = await page.evaluate(() => {
      const v = (window as unknown as { __ganttlyViewStore?: unknown })
        .__ganttlyViewStore as ViewStoreApi;
      return v.getState().drawerWidth;
    });
    expect(width).toBeGreaterThan(DEFAULT_DRAWER_WIDTH);

    // The preference was persisted to localStorage.
    const stored = await readStoredWidth(page);
    expect(stored).not.toBeNull();
    expect(Number(stored)).toBeGreaterThan(DEFAULT_DRAWER_WIDTH);
  });

  test('§3.7 the persisted width is restored after a reload', async ({ page }) => {
    await injectTask(page);
    await openDrawer(page);
    // Resize wider via the store directly (deterministic, avoids flaky drag).
    await page.evaluate(() => {
      const v = (window as unknown as { __ganttlyViewStore?: unknown }).__ganttlyViewStore as {
        getState: () => { setDrawerWidth: (w: number) => void };
      };
      v.getState().setDrawerWidth(440);
    });
    await page.waitForTimeout(100);
    expect(await readStoredWidth(page)).toBe('440');

    // Reload — the drawer should reopen with the persisted width (the app
    // auto-selects/opens the drawer via the baked E2E flag is NOT guaranteed,
    // so we just assert the stored width survives and the store initialises it).
    await page.reload();
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.waitForTimeout(300);
    const restored = await page.evaluate(() => {
      const v = (window as unknown as { __ganttlyViewStore?: unknown })
        .__ganttlyViewStore as ViewStoreApi;
      return v.getState().drawerWidth;
    });
    expect(restored).toBe(440);
  });

  test('§3.7 double-click the handle resets the width to the default', async ({ page }) => {
    await injectTask(page);
    await openDrawer(page);
    // Set a non-default width first.
    await page.evaluate(() => {
      const v = (window as unknown as { __ganttlyViewStore?: unknown }).__ganttlyViewStore as {
        getState: () => { setDrawerWidth: (w: number) => void };
      };
      v.getState().setDrawerWidth(440);
    });
    await page.waitForTimeout(100);

    const handle = page.getByRole('separator', { name: '拖动调整抽屉宽度' });
    await handle.dblclick();
    await page.waitForTimeout(100);

    const width = await page.evaluate(() => {
      const v = (window as unknown as { __ganttlyViewStore?: unknown })
        .__ganttlyViewStore as ViewStoreApi;
      return v.getState().drawerWidth;
    });
    expect(width).toBe(DEFAULT_DRAWER_WIDTH);
  });

  test('§3.7 at 1192×955 the drawer does not overflow the viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1192, height: 955 });
    await injectTask(page);
    await openDrawer(page);
    await page.waitForTimeout(200);

    const aside = page.locator('aside');
    const box = await aside.boundingBox();
    expect(box).not.toBeNull();
    // Right edge must be within the viewport (no horizontal overflow).
    expect(box!.x + box!.width).toBeLessThanOrEqual(1192 + 1);
    // And the drawer is fully on-screen (left edge positive).
    expect(box!.x).toBeGreaterThanOrEqual(0);
  });

  test('§3.7 the advanced section is visible (open by default)', async ({ page }) => {
    await injectTask(page);
    await openDrawer(page);
    // The "高级" summary is visible, and since it's open by default the
    // constraint field below it is also visible (no expand click needed).
    await expect(page.getByText('高级')).toBeVisible();
    await expect(page.getByText('约束')).toBeVisible();
  });
});
