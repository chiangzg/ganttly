import { expect, test, type Page } from '@playwright/test';

/**
 * Holiday hover tooltip test (PRD §3.5, §7.3 — hard acceptance criterion).
 *
 * Verifies that hovering a holiday column surfaces a tooltip with the
 * holiday's name (e.g. "元旦"). Before M5 this tooltip did not exist.
 */

const HEADER_HEIGHT = 56;

/** Viewport-local x of a given ISO date in week zoom, mirroring originDateFor. */
async function dateToViewportX(page: Page, isoDate: string): Promise<number> {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const xLocal = await page.evaluate((date) => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => {
        file: {
          tasks: Array<{ start: string }>;
          project: { startDate?: string };
          viewState: { scrollLeft: number };
        };
      };
    };
    const f = store.getState().file as unknown as {
      tasks: Array<{ start: string }>;
      project: { startDate?: string };
      viewState: { scrollLeft: number };
    };
    const fallback = f.project.startDate ?? '2026-01-05';
    const earliest = f.tasks.length
      ? f.tasks.reduce((m, t) => (t.start < m ? t.start : m), f.tasks[0]!.start)
      : fallback;
    const origin = earliest < fallback ? earliest : fallback;
    const dayDelta = (Date.parse(date) - Date.parse(origin)) / 86_400_000;
    return Math.round(dayDelta) * (140 / 7) - f.viewState.scrollLeft;
  }, isoDate);
  return box.x + xLocal;
}

test('hovering a holiday column shows a tooltip with the holiday name', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);

  // Inject a task whose start is BEFORE new year, so originDate lands earlier
  // and 2026-01-01 (元旦) is visible in the viewport at week zoom.
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    const task = {
      id: 'hol-target',
      name: ' Holiday probe',
      parentId: null,
      order: 0,
      start: '2025-12-29',
      end: '2026-01-05',
      duration: 5,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: {},
      assignments: [],
      customFields: {},
    };
    store.setState({
      file: {
        ...f,
        tasks: [task],
        viewState: {
          ...(f.viewState as object),
          zoom: 'week',
          scrollLeft: 0,
          scrollTop: 0,
          selectedTaskId: null,
          collapsedTaskIds: [],
        },
      },
    });
  });
  await page.waitForTimeout(200);

  // Move to the canvas at the x of 2026-01-01 (元旦). The holiday column is
  // rendered behind the task rows, so hovering anywhere in that column at a
  // non-task y should trigger the tooltip.
  const x = await dateToViewportX(page, '2026-01-01');
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas box missing');
  // Hover in the header area (above task rows) — grid holiday columns extend
  // full height including header, so this is a reliable hit zone.
  await page.mouse.move(x, box.y + HEADER_HEIGHT / 2);
  await page.waitForTimeout(300);

  const tooltip = page.locator('[data-gantt-holiday-tooltip]');
  await expect(tooltip).toBeVisible({ timeout: 2000 });
  await expect(tooltip).toContainText('元旦');
});

test('holiday tooltip has a stable visual baseline', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    const task = {
      id: 'hol-shot',
      name: 'Holiday shot',
      parentId: null,
      order: 0,
      start: '2025-12-29',
      end: '2026-01-05',
      duration: 5,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: {},
      assignments: [],
      customFields: {},
    };
    store.setState({
      file: {
        ...f,
        tasks: [task],
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
  await page.waitForTimeout(200);

  const x = await dateToViewportX(page, '2026-01-01');
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas box missing');
  await page.mouse.move(x, box.y + HEADER_HEIGHT / 2);
  await page.waitForTimeout(300);

  // Screenshot the whole chart container so the tooltip is included (it's a
  // DOM overlay above the canvas).
  await expect(page.locator('[data-gantt-chart]')).toHaveScreenshot('holiday-tooltip.png', {
    maxDiffPixelRatio: 0.01,
  });
});

test('hovering a non-holiday column shows no tooltip', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);

  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    const task = {
      id: 'hol-target2',
      name: 'Non-holiday probe',
      parentId: null,
      order: 0,
      start: '2025-12-29',
      end: '2026-01-05',
      duration: 5,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: {},
      assignments: [],
      customFields: {},
    };
    store.setState({
      file: {
        ...f,
        tasks: [task],
        viewState: {
          ...(f.viewState as object),
          zoom: 'week',
          scrollLeft: 0,
          scrollTop: 0,
          selectedTaskId: null,
          collapsedTaskIds: [],
        },
      },
    });
  });
  await page.waitForTimeout(200);

  // 2026-01-02 is also 元旦 (3-day holiday Jan 1-3 in our data). Use a plain
  // working day instead: 2025-12-30 (a Tuesday, not in any holiday list).
  const x = await dateToViewportX(page, '2025-12-30');
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas box missing');
  await page.mouse.move(x, box.y + HEADER_HEIGHT / 2);
  await page.waitForTimeout(300);

  await expect(page.locator('[data-gantt-holiday-tooltip]')).toHaveCount(0);
});
