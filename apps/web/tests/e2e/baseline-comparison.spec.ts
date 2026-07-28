import { expect, test, type Page } from '@playwright/test';

/**
 * Baseline comparison E2E (baseline-comparison spec §9.2).
 *
 * Covers the core user flows via a mix of real UI clicks and store injection
 * (the same pattern used by critical-path.spec.ts). Store injection keeps the
 * tests deterministic and fast; the assertions exercise the real rendered DOM
 * (toolbar, task table, drawer, status bar) so the wiring is genuinely tested.
 */

/** Inject tasks + a baseline, then activate the baseline for comparison. */
async function injectBaselineScenario(
  page: Page,
  opts?: {
    delayed?: boolean;
  },
): Promise<void> {
  await page.evaluate((delayed) => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const view = (window as unknown as { __ganttlyViewStore: unknown }).__ganttlyViewStore as {
      getState: () => { setActiveBaselineId(id: string | null): void };
    };
    const f = store.getState().file as Record<string, unknown> & {
      viewState: Record<string, unknown>;
    };
    const start = delayed ? '2026-02-09' : '2026-02-02';
    const end = delayed ? '2026-02-13' : '2026-02-06';
    const tasks = [
      {
        id: 'A',
        name: 'Task A',
        parentId: null,
        order: 0,
        start,
        end,
        duration: 5,
        progress: 0,
        isMilestone: false,
        dependencies: [],
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
        overtimeDates: [],
      },
    ];
    // Baseline captured with the on-time dates.
    const baselines = [
      {
        id: 'b1',
        name: '初始计划',
        capturedAt: '2026-02-01T00:00:00.000Z',
        tasks: [{ id: 'A', start: '2026-02-02', end: '2026-02-06', duration: 5, progress: 0 }],
      },
    ];
    store.setState({
      file: {
        ...f,
        tasks,
        baselines,
        viewState: {
          ...f.viewState,
          zoom: 'week',
          scrollLeft: 0,
          scrollTop: 0,
          selectedTaskId: null,
          showCriticalPath: false,
          collapsedTaskIds: [],
        },
      },
    });
    view.getState().setActiveBaselineId('b1');
  }, opts?.delayed ?? false);
  await page.waitForTimeout(300);
}

test('creates the first baseline and enters comparison mode', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);

  // Add a task so the create-baseline entry is enabled.
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '✕' }).click();
  await page.waitForTimeout(200);

  // Open the baseline menu and create.
  await page.getByRole('button', { name: '创建基线' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: '保存当前计划为基线…' }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: '保存并比较' }).click();
  await page.waitForTimeout(400);

  // The toolbar should now show the active baseline.
  await expect(page.getByRole('button', { name: /基线：计划基线/ })).toBeVisible();
  // Status bar reports no delay (task unchanged from snapshot).
  await expect(page.getByText(/无完成延期/)).toBeVisible();
});

test('switches between two baselines via the radio menu', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file as Record<string, unknown> & {
      viewState: Record<string, unknown>;
    };
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
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
        overtimeDates: [],
      },
    ];
    const baselines = [
      {
        id: 'b1',
        name: '初始计划',
        capturedAt: '2026-02-01T00:00:00.000Z',
        tasks: [{ id: 'A', start: '2026-02-02', end: '2026-02-06', duration: 5, progress: 0 }],
      },
      {
        id: 'b2',
        name: '修订计划',
        capturedAt: '2026-02-05T00:00:00.000Z',
        tasks: [{ id: 'A', start: '2026-02-03', end: '2026-02-07', duration: 5, progress: 0 }],
      },
    ];
    store.setState({
      file: { ...f, tasks, baselines, viewState: { ...f.viewState, zoom: 'week' } },
    });
  });
  await page.waitForTimeout(300);

  // Open menu, select b1.
  await page.getByRole('button', { name: '基线' }).click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitemradio', { name: /初始计划/ }).click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: /基线：初始计划/ })).toBeVisible();

  // Switch to b2.
  await page.getByRole('button', { name: /基线：初始计划/ }).click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitemradio', { name: /修订计划/ }).click();
  await page.waitForTimeout(300);
  await expect(page.getByRole('button', { name: /基线：修订计划/ })).toBeVisible();
});

test('stops comparison by selecting "不比较"', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);
  await injectBaselineScenario(page);
  await expect(page.getByRole('button', { name: /基线：初始计划/ })).toBeVisible();

  await page.getByRole('button', { name: /基线：初始计划/ }).click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitemradio', { name: '不比较' }).click();
  await page.waitForTimeout(300);
  // Back to the non-comparing label.
  await expect(page.getByRole('button', { name: '基线' })).toBeVisible();
});

test('TaskTable, Drawer and StatusBar show consistent deviation after a delay', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);
  await injectBaselineScenario(page, { delayed: true });

  // StatusBar: delayed.
  await expect(page.getByText(/延期 1 项/)).toBeVisible();
  // TaskTable deviation cell shows +5 (Mon→Mon next week = 5 working days).
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'Task A' })
      .getByText(/\+\d+ 天/),
  ).toBeVisible();

  // Drawer: open and check the three-column variance block.
  await page.getByRole('row').filter({ hasText: 'Task A' }).dblclick();
  await page.waitForTimeout(400);
  await expect(page.getByText('相对「初始计划」')).toBeVisible();
  await expect(page.getByText('完成偏差')).toBeVisible();
});

test('a task added after the baseline shows "新增"', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);

  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const view = (window as unknown as { __ganttlyViewStore: unknown }).__ganttlyViewStore as {
      getState: () => { setActiveBaselineId(id: string | null): void };
    };
    const f = store.getState().file as Record<string, unknown> & {
      viewState: Record<string, unknown>;
    };
    const tasks = [
      {
        id: 'A',
        name: 'Original',
        parentId: null,
        order: 0,
        start: '2026-02-02',
        end: '2026-02-06',
        duration: 5,
        progress: 0,
        isMilestone: false,
        dependencies: [],
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
        overtimeDates: [],
      },
      {
        id: 'B',
        name: 'Added Later',
        parentId: null,
        order: 1,
        start: '2026-02-09',
        end: '2026-02-13',
        duration: 5,
        progress: 0,
        isMilestone: false,
        dependencies: [],
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
        overtimeDates: [],
      },
    ];
    const baselines = [
      {
        id: 'b1',
        name: '初始计划',
        capturedAt: '2026-02-01T00:00:00.000Z',
        tasks: [
          { id: 'A', start: '2026-02-02', end: '2026-02-06', duration: 5, progress: 0 },
          { id: 'GONE', start: '2026-02-09', end: '2026-02-13', duration: 5, progress: 0 },
        ],
      },
    ];
    store.setState({
      file: { ...f, tasks, baselines, viewState: { ...f.viewState, zoom: 'week' } },
    });
    view.getState().setActiveBaselineId('b1');
  });
  await page.waitForTimeout(300);

  await expect(
    page.getByRole('row').filter({ hasText: 'Added Later' }).getByText('新增'),
  ).toBeVisible();

  await page.getByRole('button', { name: /基线：初始计划/ }).click();
  await expect(page.getByText('新增 1 项 · 原任务已删除 1 项')).toBeVisible();
});

test('JSON export and re-import preserves multiple baselines', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);

  // Inject a file with two baselines.
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file as Record<string, unknown>;
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
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
        overtimeDates: [],
      },
    ];
    const baselines = [
      {
        id: 'b1',
        name: '基线一',
        capturedAt: '2026-02-01T00:00:00.000Z',
        tasks: [{ id: 'A', start: '2026-02-02', end: '2026-02-06', duration: 5, progress: 0 }],
      },
      {
        id: 'b2',
        name: '基线二',
        capturedAt: '2026-02-10T00:00:00.000Z',
        tasks: [{ id: 'A', start: '2026-02-03', end: '2026-02-07', duration: 5, progress: 0 }],
      },
    ];
    store.setState({ file: { ...f, tasks, baselines } });
  });
  await page.waitForTimeout(300);

  await page.getByRole('button', { name: '更多操作' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: '导出 JSON' }).click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  await page.getByRole('menuitem', { name: '导出 JSON' }).press('Escape');

  // Import the downloaded payload through the production project-center flow.
  await page.getByRole('button', { name: 'G', exact: true }).click();
  await page.getByRole('banner').getByRole('button', { name: '新建项目', exact: true }).click();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByLabel('导入 ganttly JSON', { exact: true }).click(),
  ]);
  await fileChooser.setFiles(downloadPath!);

  const restored = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => {
        file: {
          baselines: Array<{
            id: string;
            name: string;
            capturedAt: string;
            tasks: Array<{
              id: string;
              start: string;
              end: string;
              duration: number;
              progress: number;
            }>;
          }>;
        };
      };
    };
    return store.getState().file.baselines;
  });
  expect(restored).toHaveLength(2);
  expect(restored.map((baseline) => baseline.name)).toEqual(['基线一', '基线二']);
  expect(restored[1]!.tasks[0]).toEqual({
    id: 'A',
    start: '2026-02-03',
    end: '2026-02-07',
    duration: 5,
    progress: 0,
  });
});

test('canvas screenshot with baseline comparison (delayed task)', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);
  await injectBaselineScenario(page, { delayed: true });

  await expect(page.locator('canvas')).toHaveScreenshot('canvas-baseline-compare.png', {
    maxDiffPixelRatio: 0.01,
  });
});

test('hovering the baseline track shows a deviation tooltip', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);
  await injectBaselineScenario(page, { delayed: true });

  // The canvas chart origin is 2026-01-05 at canvas-x 0 (scrollLeft 0, week
  // zoom = 20px/day). The baseline track for the 02-02..06 snapshot renders at
  // canvas-x ≈ 560..645, in the lower band of row 0 (yTop 56 + 24..28 ≈ 80..84).
  // Hover the live bar (02-09..13 → canvas-x ≈ 700) which also triggers the
  // tooltip; either band is accepted by the hit test.
  const canvas = page.locator('canvas');
  await canvas.hover({ position: { x: 580, y: 80 } });
  await page.waitForTimeout(400);
  // The deviation tooltip is a DOM overlay.
  await expect(page.locator('[data-gantt-baseline-tooltip]')).toBeVisible();
  await expect(page.locator('[data-gantt-baseline-tooltip]')).toContainText(/完成偏差/);
});

test('canvas screenshot with baseline comparison (dark mode)', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);
  await injectBaselineScenario(page, { delayed: true });

  // Emulate dark mode and re-render.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(400);

  await expect(page.locator('canvas')).toHaveScreenshot('canvas-baseline-compare-dark.png', {
    maxDiffPixelRatio: 0.01,
  });
});
