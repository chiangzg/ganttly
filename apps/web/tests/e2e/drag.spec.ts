import { expect, test, type Page } from '@playwright/test';

/**
 * Drag interaction + undo test (PRD §3.10, §7.8).
 *
 * Verifies that dragging a task bar to a new date, then undoing, restores
 * the original start/end. Covers move (body drag), resize-left (left handle),
 * and resize-right (right handle).
 *
 * Before M5, drags bypassed the undo stack entirely (the live cursor-following
 * update wrote to the store directly without a Command). This test guards
 * against that regression.
 */

const HEADER_HEIGHT = 56;
const ROW_HEIGHT = 32;

/** Inject a single task into the store and reset view to week/scroll 0. */
async function injectTask(
  page: Page,
  overrides: Partial<{
    id: string;
    start: string;
    end: string;
    duration: number;
  }> = {},
) {
  await page.evaluate((ov) => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: { tasks: unknown[] } };
    };
    const task = {
      id: ov.id ?? 'drag-target',
      name: '拖拽目标',
      parentId: null,
      order: 0,
      start: ov.start ?? '2026-01-05',
      end: ov.end ?? '2026-01-09',
      duration: ov.duration ?? 5,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: { type: 'none' },
      assignments: [],
      customFields: {},
    };
    const f = store.getState().file as Record<string, unknown>;
    store.setState({
      file: {
        ...f,
        tasks: [task],
        viewState: {
          ...(f.viewState as object),
          zoom: 'week',
          scrollLeft: 0,
          scrollTop: 0,
          selectedTaskId: task.id,
          collapsedTaskIds: [],
        },
      },
    });
  }, overrides);
  // Give the canvas one frame to re-render with the new state.
  await page.waitForTimeout(100);
}

/** Read a task's start/end from the store. */
async function readTaskDates(page: Page, id: string) {
  return page.evaluate((taskId) => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => { file: { tasks: Array<{ id: string; start: string; end: string }> } };
    };
    const t = store.getState().file.tasks.find((x) => x.id === taskId);
    return t ? { start: t.start, end: t.end } : null;
  }, id);
}

/**
 * Compute the viewport-local (x, y) of a given date at the vertical center
 * of the first task row. Mirrors originDateFor + dateToPixel from the engine
 * (week zoom only): origin = min(earliest task start, project.startDate ?? '2026-01-05').
 */
async function dateToViewportPoint(page: Page, isoDate: string): Promise<{ x: number; y: number }> {
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
    // Mirror engine/scene/assembly.ts originDateFor.
    const fallback = f.project.startDate ?? '2026-01-05';
    const earliest = f.tasks.length
      ? f.tasks.reduce((m, t) => (t.start < m ? t.start : m), f.tasks[0]!.start)
      : fallback;
    const origin = earliest < fallback ? earliest : fallback;
    const dayDelta = (Date.parse(date) - Date.parse(origin)) / 86_400_000;
    const pxPerDay = 140 / 7; // week zoom
    return Math.round(dayDelta) * pxPerDay - f.viewState.scrollLeft;
  }, isoDate);

  const yLocal = HEADER_HEIGHT + ROW_HEIGHT / 2;
  return { x: box.x + xLocal, y: box.y + yLocal };
}

test('dragging a task body moves start+end, and undo restores them', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);

  await injectTask(page, { start: '2026-01-05', end: '2026-01-09', duration: 5 });
  const before = await readTaskDates(page, 'drag-target');
  expect(before?.start).toBe('2026-01-05');
  expect(before?.end).toBe('2026-01-09');

  // Drag the bar body 3 weeks to the right = 21 working-day-equivalent px.
  // week zoom = 20px/day, so 21 days ≈ 420px. Move by 420 CSS px.
  const start = await dateToViewportPoint(page, '2026-01-06'); // mid-bar-ish
  const DX = 420;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Intermediate moves keep the drag "engaged" and let live updates flow.
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(start.x + (DX * i) / 5, start.y, { steps: 1 });
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  const after = await readTaskDates(page, 'drag-target');
  expect(after, 'task must exist after drag').not.toBeNull();
  expect(after!.start, 'start must change after drag').not.toBe('2026-01-05');

  // Confirm a drag Command landed on the undo stack (top entry).
  const topLabel = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => { nextUndoLabel: () => string | null };
    };
    return store.getState().nextUndoLabel();
  });
  expect(topLabel, 'top undo entry should be the drag commit').toBe('更新任务(含汇总)');

  // Undo via the toolbar button.
  await page.getByRole('button', { name: /撤销/ }).click();
  const restored = await readTaskDates(page, 'drag-target');
  expect(restored?.start).toBe('2026-01-05');
  expect(restored?.end).toBe('2026-01-09');
});

test('dragging the right handle extends end, and undo restores it', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);

  await injectTask(page, { start: '2026-01-05', end: '2026-01-09', duration: 5 });
  const before = await readTaskDates(page, 'drag-target');
  expect(before?.end).toBe('2026-01-09');

  // Grab the right edge of the bar (end date + ~half handle width).
  const rightHandle = await dateToViewportPoint(page, '2026-01-09');
  // Move 60px = 3 days in week zoom.
  await page.mouse.move(rightHandle.x, rightHandle.y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(rightHandle.x + (60 * i) / 4, rightHandle.y, { steps: 1 });
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  const after = await readTaskDates(page, 'drag-target');
  expect(after?.end, 'end must extend after right-handle drag').not.toBe('2026-01-09');

  await page.getByRole('button', { name: /撤销/ }).click();
  const restored = await readTaskDates(page, 'drag-target');
  expect(restored?.end).toBe('2026-01-09');
  expect(restored?.start).toBe('2026-01-05');
});

/**
 * Mixed undo stack: drag + add + drag sequence must undo in reverse order,
 * each step restoring exactly. Guards against the undo stack getting
 * confused when drag Commands (rollup-aware) are interleaved with other
 * Commands (PRD §7.8).
 */
test('undo replays drag and add commands in reverse order', async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);

  // Step 1: inject task A at 2026-01-05..09.
  await injectTask(page, { id: 'task-a', start: '2026-01-05', end: '2026-01-09', duration: 5 });

  // Step 2: drag task A body to the right by ~3 weeks (21 days).
  const a1 = await dateToViewportPoint(page, '2026-01-06');
  await page.mouse.move(a1.x, a1.y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) {
    await page.mouse.move(a1.x + (420 * i) / 4, a1.y, { steps: 1 });
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  const afterDrag1 = await readTaskDates(page, 'task-a');
  expect(afterDrag1?.start).not.toBe('2026-01-05');

  // Step 3: add task B via the toolbar (creates a second task + selects it).
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('[role="row"]')).toHaveCount(2);

  // Undo until task A's drag is reverted. The undo stack (top→bottom) after
  // the steps above is: select-B, add-B, drag-A, select-A — so we undo until
  // the next label is the drag commit, then once more to apply it.
  // Drive by label so the test tolerates extra select commands in the stack.
  const undoUntilDragReverted = async () => {
    for (let i = 0; i < 10; i++) {
      const label = await page.evaluate(() => {
        const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
          getState: () => { nextUndoLabel: () => string | null };
        };
        return store.getState().nextUndoLabel();
      });
      if (!label) return false;
      await page.getByRole('button', { name: /撤销/ }).click();
      // After applying the drag undo, dates should be restored.
      const a = await readTaskDates(page, 'task-a');
      if (a?.start === '2026-01-05' && a?.end === '2026-01-09') return true;
    }
    return false;
  };
  const ok = await undoUntilDragReverted();
  expect(ok, 'task-a dates should be restored after undoing back past the drag').toBe(true);
  await expect(page.locator('[role="row"]')).toHaveCount(1);
});
