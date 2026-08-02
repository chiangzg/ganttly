import { expect, test, type Page } from '@playwright/test';

/**
 * "Fit project range" E2E (editor-interaction-optimization-plan §4.5).
 *
 * Clicks the toolbar "适应范围" button and asserts:
 *  - the chosen zoom frames the project (earliest + latest tasks both in view)
 *  - a long span lands on a coarse zoom (year)
 *  - fit is navigation — it does NOT push onto the undo stack (plan §6.4)
 *
 * The chart pixel math mirrors the renderer (originDateFor + dateToPixel), the
 * same approach as today.spec.ts.
 */

interface TaskShape {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  start: string;
  end: string;
  duration: number;
  progress: number;
  isMilestone: boolean;
  dependencies: Array<{ targetId: string; type: 'FS' | 'SS' | 'FF' | 'SF'; lag: number }>;
  constraints: Record<string, unknown>;
  assignments: Array<{ resourceId: string; load: number }>;
  customFields: Record<string, unknown>;
}

interface FileState {
  tasks: TaskShape[];
  project: { startDate?: string };
  viewState: { scrollLeft: number; zoom: string };
}

function makeTask(
  id: string,
  start: string,
  end: string,
  overrides: Partial<TaskShape> = {},
): TaskShape {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start,
    end,
    duration: 1,
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
    ...overrides,
  };
}

async function injectTasks(page: Page, tasks: TaskShape[]): Promise<void> {
  await page.evaluate((injected) => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { file: FileState };
      setState: (s: { file: FileState }) => void;
    };
    const file = store.getState().file;
    store.setState({ file: { ...file, tasks: injected } });
  }, tasks);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
});

test('fit frames a 2-year project and lands on year zoom', async ({ page }) => {
  await injectTasks(page, [
    makeTask('early', '2026-01-05', '2026-02-05', { order: 0 }),
    makeTask('late', '2027-12-01', '2027-12-31', { order: 1 }),
  ]);

  await page.getByRole('button', { name: '适应范围' }).click();
  await page.waitForTimeout(200);

  const { zoom, scrollLeft } = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { file: FileState };
    };
    return {
      zoom: store.getState().file.viewState.zoom,
      scrollLeft: store.getState().file.viewState.scrollLeft,
    };
  });
  expect(zoom).toBe('year');
  expect(scrollLeft).toBe(0);
});

test('fit puts both the earliest and latest tasks inside the viewport', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '2026-01-05', '2026-01-12', { order: 0 }),
    makeTask('b', '2026-06-01', '2026-06-30', { order: 1 }),
  ]);

  await page.getByRole('button', { name: '适应范围' }).click();
  await page.waitForTimeout(200);

  // Recompute each task's bar span in viewport-local coords using the renderer
  // formula and assert both fit within [0, viewportWidth].
  const { earliestInView, latestInView } = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { file: FileState };
    };
    const file = store.getState().file;
    const fallback = file.project.startDate ?? '2026-01-05';
    const origin = file.tasks.reduce(
      (min, t) => (t.start < min ? t.start : min),
      file.tasks[0]?.start ?? fallback,
    );
    const zoom = file.viewState.zoom;
    const scrollLeft = file.viewState.scrollLeft;
    const COLUMN_WIDTH: Record<string, number> = { day: 32, week: 140, month: 120, year: 80 };
    const DAYS_PER_COLUMN: Record<string, number> = { day: 1, week: 7, month: 30, year: 30 };
    const pxPerDay = COLUMN_WIDTH[zoom]! / DAYS_PER_COLUMN[zoom]!;
    const pxOf = (iso: string) => {
      const [oy, om, od] = (origin as string).split('-').map(Number);
      const [yy, ym, yd] = iso.split('-').map(Number);
      const delta = Math.round(
        (Date.UTC(yy!, ym! - 1, yd!) - Date.UTC(oy!, om! - 1, od!)) / 86_400_000,
      );
      return delta * pxPerDay - scrollLeft;
    };
    const chartEl = document.querySelector('[data-gantt-chart]') as HTMLElement | null;
    const vw = chartEl ? chartEl.clientWidth : 800;
    const sorted = [...file.tasks].sort((a, b) => a.start.localeCompare(b.start));
    const earliestStart = pxOf(sorted[0]!.start);
    const latestEnd = pxOf(sorted[sorted.length - 1]!.end) + pxPerDay; // inclusive end
    return {
      earliestInView: earliestStart >= -24 && earliestStart <= vw,
      latestInView: latestEnd >= 0 && latestEnd <= vw + 24,
    };
  });
  expect(earliestInView, 'earliest task should be visible').toBe(true);
  expect(latestInView, 'latest task should be visible').toBe(true);
});

test('fit does not push onto the undo stack', async ({ page }) => {
  await injectTasks(page, [makeTask('a', '2026-01-05', '2026-06-30', { order: 0 })]);

  const before = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { undoStack: unknown[] };
    };
    return store.getState().undoStack.length;
  });

  await page.getByRole('button', { name: '适应范围' }).click();
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { undoStack: unknown[] };
    };
    return store.getState().undoStack.length;
  });
  expect(after, 'fit must not enter the undo stack').toBe(before);
});
