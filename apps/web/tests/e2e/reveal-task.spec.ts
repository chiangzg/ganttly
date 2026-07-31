import { expect, test } from '@playwright/test';

/**
 * "新建任务后自动定位" E2E (editor-interaction-optimization-plan §2.1).
 *
 * Bug being fixed: `Toolbar.addRootTask()` creates a task dated `today`, but
 * never updates `scrollLeft`. A fresh project whose origin is the project
 * start date (e.g. 2026-01-05) leaves the canvas parked on January while the
 * new task bar sits at today (months away) — completely off-screen.
 *
 * Acceptance (plan §2.1 验收标准):
 *  - When the project start is 6+ months from today, creating a task brings
 *    the bar into the viewport.
 *  - The reveal is navigation (direct setState), so it does NOT add an undo
 *    record for "view change".
 *
 * The test injects a project whose start is fixed at 2026-01-05 and whose
 * tasks list starts empty (so originDateFor lands on January), then clicks
 * "新建任务" and asserts the new task's bar X is inside the visible window
 * AND that the undo stack depth is unchanged by the reveal.
 */

interface FileState {
  tasks: Array<{ start: string; id: string } & Record<string, unknown>>;
  project: { startDate?: string };
  viewState: {
    scrollLeft: number;
    scrollTop: number;
    zoom: string;
    selectedTaskId: string | null;
  };
}

interface StoreApi {
  getState: () => {
    file: FileState;
    canUndo: () => boolean;
    undoStack: unknown[];
  };
  setState: (s: { file: FileState }) => void;
}

test('新建任务后任务条自动进入视口 (origin 6+ months from today)', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);

  // Inject an empty project anchored at 2026-01-05 with scrollLeft 0.
  // With no tasks the renderer origin = project.startDate = 2026-01-05,
  // which is ~6+ months before today (2026-07-31).
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const file = store.getState().file;
    store.setState({
      file: {
        ...file,
        tasks: [],
        project: { ...file.project, startDate: '2026-01-05' },
        viewState: {
          ...file.viewState,
          scrollLeft: 0,
          scrollTop: 0,
          zoom: 'week',
        },
      },
    });
  });

  // Sanity: scrollLeft is 0 before creation.
  const before = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.viewState.scrollLeft;
  });
  expect(before).toBe(0);

  // Capture undo depth before creating (the toolbar "new task" dispatch IS
  // undoable, so depth grows by 1 from the add; the reveal must NOT add more).
  const undoDepthBefore = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().undoStack.length;
  });

  // Click 新建任务 in the toolbar.
  await page.getByRole('button', { name: /新建任务/ }).click();
  // Give the dispatch + reveal a tick to settle.
  await page.waitForTimeout(200);

  // After creation, scrollLeft must have moved so the new task's bar (at today)
  // is inside the visible window.
  const { scrollLeftAfter, barViewX, viewportWidth, taskId } = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const file = store.getState().file;
    const task = file.tasks[file.tasks.length - 1]!;
    const zoom = file.viewState.zoom;
    const COLUMN_WIDTH: Record<string, number> = { day: 32, week: 140, month: 120, year: 80 };
    const DAYS_PER_COLUMN: Record<string, number> = { day: 1, week: 7, month: 30, year: 30 };
    const pxPerDay = COLUMN_WIDTH[zoom]! / DAYS_PER_COLUMN[zoom]!;
    // Mirror renderer originDateFor with no tasks besides the new one:
    // min(earliest task = task.start, project.startDate).
    const fallback = file.project.startDate ?? '2026-01-05';
    const origin = task.start < fallback ? task.start : fallback;
    const [oy, om, od] = origin.split('-').map(Number);
    const [ty, tm, td] = task.start.split('-').map(Number);
    const dayDelta = Math.round(
      (Date.UTC(ty!, tm! - 1, td!) - Date.UTC(oy!, om! - 1, od!)) / 86_400_000,
    );
    const barPx = dayDelta * pxPerDay;
    const chartEl = document.querySelector('[data-gantt-chart]') as HTMLElement | null;
    return {
      scrollLeftAfter: file.viewState.scrollLeft,
      barViewX: barPx - file.viewState.scrollLeft,
      viewportWidth: chartEl ? chartEl.clientWidth : 800,
      taskId: task.id,
    };
  });

  expect(scrollLeftAfter, 'scrollLeft moved off 0 to reveal the task').toBeGreaterThan(0);
  expect(
    barViewX,
    `new task bar should be inside the viewport [0, ${viewportWidth}], got ${barViewX}`,
  ).toBeGreaterThanOrEqual(0);
  expect(barViewX).toBeLessThanOrEqual(viewportWidth);

  // The reveal itself is navigation and must NOT push a view-change command.
  // `addRootTask` already dispatches two undoable commands (addTask + select),
  // so depth grows by exactly 2 — NOT 3. If reveal leaked a "视图变更" entry
  // for the scrollLeft jump, depth would grow by 3.
  const undoDepthAfter = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().undoStack.length;
  });
  expect(undoDepthAfter - undoDepthBefore).toBe(2);

  // The new task should be selected (drawer wiring).
  const selectedId = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.viewState.selectedTaskId;
  });
  expect(selectedId).toBe(taskId);

  // Direct navigation-isolation check via the store (no UI dependency): confirm
  // the undo stack's top TWO labels are the add + select commands, and that
  // NONE of the new entries is a bare "视图变更" caused by the scrollLeft jump.
  // `addRootTask` dispatches addTaskCommand (新增任务) + setViewStateCommand
  // (视图变更, for selectedTaskId). The reveal writes scrollLeft via setState
  // and must NOT add a third "视图变更" entry.
  const newUndoLabels = await page.evaluate((depthBefore) => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const stack = store.getState().undoStack as Array<{ label: string }>;
    return stack.slice(depthBefore).map((c) => c.label);
  }, undoDepthBefore);
  expect(newUndoLabels).toHaveLength(2);
  expect(newUndoLabels.some((l) => l.includes('新增任务'))).toBe(true);
});

test('已可见任务不会发生横向跳动 (skipIfVisible)', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);

  // Inject a project anchored at today so the first task is already on-screen.
  await page.evaluate(() => {
    const today = new Date();
    const todayIso = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const file = store.getState().file;
    store.setState({
      file: {
        ...file,
        tasks: [
          {
            id: 'existing',
            name: 'Existing',
            parentId: null,
            order: 0,
            start: todayIso,
            end: todayIso,
            duration: 1,
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: { type: 'none' },
            assignments: [],
            customFields: {},
          },
        ],
        project: { ...file.project, startDate: todayIso },
        viewState: {
          ...file.viewState,
          scrollLeft: 0,
          scrollTop: 0,
          zoom: 'week',
        },
      },
    });
  });

  const scrollBefore = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.viewState.scrollLeft;
  });

  // Click 新建任务 — the new task is dated today, already visible, so the view
  // should NOT jump horizontally.
  await page.getByRole('button', { name: /新建任务/ }).click();
  await page.waitForTimeout(200);

  const scrollAfter = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.viewState.scrollLeft;
  });

  expect(scrollAfter, 'no horizontal jitter for an already-visible new task').toBe(scrollBefore);
});
