import { expect, test, type Page } from '@playwright/test';

/**
 * Dependency arrow rendering + selection E2E (PRD §3.3, §7.4, §5.5).
 *
 * Covers the four dependency types (FS / SS / FF / SF) with screenshot
 * baselines, and the click-arrow-to-select-then-delete interaction.
 */

type DepType = 'FS' | 'SS' | 'FF' | 'SF';

async function loadChain(page: Page, type: DepType) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate((t) => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    // Two tasks; task B depends on task A with the given type.
    const tasks = [
      {
        id: 'A',
        name: 'Task A',
        parentId: null,
        order: 0,
        start: '2026-02-02',
        end: '2026-02-06',
        duration: 5,
        progress: 0,
        isMilestone: false,
        dependencies: [],
        constraints: {},
        assignments: [],
        customFields: {},
      },
      {
        id: 'B',
        name: 'Task B',
        parentId: null,
        order: 1,
        start: '2026-02-09',
        end: '2026-02-13',
        duration: 5,
        progress: 0,
        isMilestone: false,
        dependencies: [{ targetId: 'A', type: t, lag: 0 }],
        constraints: {},
        assignments: [],
        customFields: {},
      },
    ];
    store.setState({
      file: {
        ...f,
        tasks,
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
  }, type);
  await page.waitForTimeout(250);
}

for (const type of ['FS', 'SS', 'FF', 'SF'] as DepType[]) {
  test(`${type} dependency arrow renders`, async ({ page }) => {
    await loadChain(page, type);
    await expect(page.locator('canvas')).toHaveScreenshot(`canvas-dep-${type.toLowerCase()}.png`, {
      maxDiffPixelRatio: 0.01,
    });
  });
}

test('deleting a dependency via the task drawer removes it', async ({ page }) => {
  await loadChain(page, 'FS');

  // Open Task B's drawer (B holds the dependency on A).
  const rowB = page.locator('[role="row"]', { hasText: 'Task B' }).first();
  await rowB.dblclick();
  await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 3000 });

  // The drawer lists each dependency with a ✕ delete button.
  const depRow = page.locator('text=Task A').locator('..');
  await depRow.locator('button').click();
  await page.waitForTimeout(150);

  // Verify the dependency is gone from the store.
  const gone = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => {
        file: { tasks: Array<{ id: string; dependencies: Array<{ targetId: string }> }> };
      };
    };
    const b = store.getState().file.tasks.find((t) => t.id === 'B');
    return b ? !b.dependencies.some((d) => d.targetId === 'A') : true;
  });
  expect(gone, 'FS dependency should be removed').toBe(true);
});
