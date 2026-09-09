import { expect, test } from '@playwright/test';

/**
 * Critical-path highlight E2E (PRD §3.6, M3, §5.5).
 *
 * Builds a 3-task chain via store injection, turns on the critical-path
 * toggle, and screenshots the canvas. All three tasks should be on the
 * critical path (single chain) and rendered in red.
 */
test('critical path toggle highlights a 3-task chain', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
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
        dependencies: [{ targetId: 'A', type: 'FS', lag: 0 }],
        constraints: {},
        assignments: [],
        customFields: {},
      },
      {
        id: 'C',
        name: 'Task C',
        parentId: null,
        order: 2,
        start: '2026-02-16',
        end: '2026-02-20',
        duration: 5,
        progress: 0,
        isMilestone: false,
        dependencies: [{ targetId: 'B', type: 'FS', lag: 0 }],
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
          showCriticalPath: true,
          collapsedTaskIds: [],
        },
      },
    });
  });
  await page.waitForTimeout(250);

  await expect(page.locator('canvas')).toHaveScreenshot('canvas-critical-path.png', {
    maxDiffPixelRatio: 0.01,
  });
});

/**
 * SS regression (2026-09-09): the CPM used to read every dependency as FS,
 * inverting the critical path when an SS link existed. A(10d) with B(2d) on
 * `SS A +2`: A ends later and must be the critical one. Asserted through the
 * task-table criticalPath quick filter (same shared computation as the canvas
 * highlight, but DOM-visible) instead of a screenshot baseline.
 */
test('SS dependency does not invert the critical path', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    const base = {
      parentId: null,
      progress: 0,
      isMilestone: false,
      constraints: {},
      assignments: [],
      customFields: {},
    };
    const tasks = [
      {
        ...base,
        id: 'A',
        name: 'Task A',
        order: 0,
        start: '2026-02-02',
        end: '2026-02-13',
        duration: 10,
        dependencies: [],
      },
      {
        ...base,
        id: 'B',
        name: 'Task B',
        order: 1,
        start: '2026-02-04',
        end: '2026-02-05',
        duration: 2,
        dependencies: [{ targetId: 'A', type: 'SS', lag: 2 }],
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
          showCriticalPath: true,
          collapsedTaskIds: [],
        },
      },
    });
  });
  await page.waitForTimeout(250);

  // Critical path = { A } (B has float). The quick filter must keep A's row.
  await page.getByRole('button', { name: '筛选：关键路径' }).click();
  await page.waitForTimeout(250);
  await expect(page.locator('[data-task-id="A"]')).toBeVisible();
  await expect(page.locator('[data-task-id="B"]')).toHaveCount(0);
});
