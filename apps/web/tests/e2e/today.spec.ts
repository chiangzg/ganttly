import { expect, test } from '@playwright/test';

/**
 * "今天" button E2E (bug fix: the Today button used to land on the wrong date).
 *
 * Root cause: jumpToToday computed the pixel offset from file.tasks[0]?.start,
 * but the renderer anchors on originDateFor(file) = min(earliest task start,
 * project.startDate ?? '2026-01-05'). When the two diverged the scrolled-to
 * column was off by months (e.g. February instead of July).
 *
 * The fix uses the same originDateFor + centers today in the viewport. This
 * test injects a task starting well before today, clicks "今天", and asserts
 * the red today-line lands inside the visible chart viewport.
 */

interface FileState {
  // Tasks are a partial shape here — we only read start/id, but the injected
  // objects carry the full Task shape. Use a permissive type to avoid spelling
  // out every field in this test.
  tasks: Array<{ start: string; id: string } & Record<string, unknown>>;
  project: { startDate?: string };
  viewState: { scrollLeft: number; zoom: string };
}

test('今天 button scrolls the viewport so today is visible', async ({ page }) => {
  await page.goto('/');
  // Wait for the store to finish init (it can overwrite injected state).
  await page.waitForTimeout(500);

  // Inject one task that starts in early January — this guarantees the
  // renderer's originDate differs from today by many months, which is exactly
  // the scenario where the old bug surfaced.
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as
      | {
          getState: () => { file: FileState };
          setState: (s: { file: FileState }) => void;
        }
      | undefined;
    if (!store) throw new Error('store not exposed');
    const file = store.getState().file;
    store.setState({
      file: {
        ...file,
        tasks: [
          {
            id: 'early',
            name: 'Early task',
            parentId: null,
            order: 0,
            start: '2026-01-05',
            end: '2026-01-09',
            duration: 5,
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: {},
            assignments: [],
            customFields: {},
          },
        ],
      },
    });
  });

  // Sanity: scrollLeft starts at 0.
  const before = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as
      { getState: () => { file: FileState } } | undefined;
    return store!.getState().file.viewState.scrollLeft;
  });
  expect(before).toBe(0);

  // Click the Today button.
  await page.getByRole('button', { name: '今天' }).click();

  // After the click, the chart's scrollLeft must put today's column within the
  // visible window. We recompute the today-line's viewport-local X using the
  // same formula as the renderer (dateToPixel(today, origin, zoom) - scrollLeft)
  // and assert 0 <= x <= viewportWidth.
  const { todayX, viewportWidth } = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as
      { getState: () => { file: FileState } } | undefined;
    const file = store!.getState().file;
    // Mirror the renderer's originDateFor: min(earliest task, project.startDate ?? '2026-01-05').
    const fallback = file.project.startDate ?? '2026-01-05';
    const minStart = file.tasks.reduce(
      (min, t) => (t.start < min ? t.start : min),
      file.tasks[0]?.start ?? fallback,
    );
    const origin = minStart < fallback ? minStart : fallback;
    const scrollLeft = file.viewState.scrollLeft;
    const zoom = file.viewState.zoom;
    const COLUMN_WIDTH: Record<string, number> = { day: 32, week: 140, month: 120, year: 80 };
    const DAYS_PER_COLUMN: Record<string, number> = { day: 1, week: 7, month: 30, year: 30 };
    const pxPerDay = COLUMN_WIDTH[zoom]! / DAYS_PER_COLUMN[zoom]!;
    const today = new Date();
    const todayIso = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    const [oy, om, od] = origin.split('-').map(Number);
    const [ty, tm, td] = todayIso.split('-').map(Number);
    const dayDelta = Math.round(
      (Date.UTC(ty!, tm! - 1, td!) - Date.UTC(oy!, om! - 1, od!)) / 86_400_000,
    );
    const todayPx = dayDelta * pxPerDay;
    const chartEl = document.querySelector('[data-gantt-chart]') as HTMLElement | null;
    return {
      todayX: todayPx - scrollLeft,
      viewportWidth: chartEl ? chartEl.clientWidth : 800,
    };
  });

  expect(
    todayX,
    `today line should be inside the viewport [0, ${viewportWidth}]`,
  ).toBeGreaterThanOrEqual(0);
  expect(todayX).toBeLessThanOrEqual(viewportWidth);
});
