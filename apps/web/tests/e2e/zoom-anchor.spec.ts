import { expect, test, type Page } from '@playwright/test';

/**
 * Zoom-anchor E2E (editor-interaction-optimization-plan §4.5).
 *
 * Asserts:
 *  - toolbar zoom buttons keep the viewport-CENTER date stable across a zoom step
 *  - repeated zoom steps don't pollute the undo stack (navigation, not edit)
 *
 * The chart pixel math mirrors the renderer (originDateFor + dateToPixel),
 * matching today.spec.ts.
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

/** Compute the ISO date at the viewport center, using the renderer's formula. */
async function centerDate(page: Page): Promise<string> {
  return page.evaluate(() => {
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
    const chartEl = document.querySelector('[data-gantt-chart]') as HTMLElement | null;
    const vw = chartEl ? chartEl.clientWidth : 800;
    const COLUMN_WIDTH: Record<string, number> = { day: 32, week: 140, month: 120, year: 80 };
    const DAYS_PER_COLUMN: Record<string, number> = { day: 1, week: 7, month: 30, year: 30 };
    const pxPerDay = COLUMN_WIDTH[zoom]! / DAYS_PER_COLUMN[zoom]!;
    const centerPx = scrollLeft + vw / 2;
    const dayDelta = Math.floor(centerPx / pxPerDay);
    const [oy, om, od] = (origin as string).split('-').map(Number);
    const d = new Date(Date.UTC(oy!, om! - 1, od!));
    d.setUTCDate(d.getUTCDate() + dayDelta);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
});

test('toolbar zoom keeps the viewport-center date stable', async ({ page }) => {
  // A wide project so the center is a meaningful date well into the chart.
  await injectTasks(page, [makeTask('a', '2026-01-05', '2026-12-31', { order: 0 })]);
  // Scroll somewhere into the middle so the center isn't the origin.
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { file: FileState };
      setState: (s: { file: FileState }) => void;
    };
    const file = store.getState().file;
    store.setState({ file: { ...file, viewState: { ...file.viewState, scrollLeft: 400 } } });
  });
  await page.waitForTimeout(150);

  const before = await centerDate(page);

  // Zoom in one step (week → day). The center date should be unchanged.
  await page.getByRole('button', { name: '放大' }).click();
  await page.waitForTimeout(200);

  const after = await centerDate(page);
  expect(after, 'center date must be preserved across a zoom step').toBe(before);
});

test('repeated zoom steps do not pile onto the undo stack', async ({ page }) => {
  await injectTasks(page, [makeTask('a', '2026-01-05', '2026-06-30', { order: 0 })]);

  const before = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { undoStack: unknown[] };
    };
    return store.getState().undoStack.length;
  });

  // Zoom in then out a few times.
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '放大' }).click();
    await page.waitForTimeout(80);
  }
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '缩小' }).click();
    await page.waitForTimeout(80);
  }

  const after = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { undoStack: unknown[] };
    };
    return store.getState().undoStack.length;
  });
  expect(after, 'zoom must be non-undoable navigation').toBe(before);
});
