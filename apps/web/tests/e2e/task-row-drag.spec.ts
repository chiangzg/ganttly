import { expect, test, type Page } from '@playwright/test';

/**
 * Task-table row drag & drop: before / inside / after (plan §2.3).
 *
 * Verifies the four acceptance paths from the plan:
 *  - same-level move up (before)
 *  - same-level move down (after)
 *  - cross-parent reparent (inside)
 *  - become a child (inside)
 * Plus: dragging a parent onto its own descendant is forbidden, and a single
 * undo restores the entire tree (hierarchy + order + summary dates).
 *
 * The HTML5 DnD `dataTransfer` is not readable during dragover/dragleave (spec
 * quirk), so the component tracks the dragged id in React state instead. These
 * tests therefore drive the drag with `mouse.down/move/up`, which fire the full
 * React drag event sequence (dragstart → dragover → drop → dragend).
 */

interface StoreApi {
  getState: () => {
    file: {
      tasks: Array<{
        id: string;
        name: string;
        parentId: string | null;
        order: number;
        duration: number;
        progress: number;
        start: string;
        end: string;
      }>;
      viewState: Record<string, unknown>;
    };
    undoStack: Array<{ label: string }>;
    redoStack: Array<{ label: string }>;
    undo: () => void;
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}

interface InjectTask {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  start: string;
  end: string;
  duration: number;
  progress: number;
  isMilestone: boolean;
  dependencies: unknown[];
  constraints: { type: string };
  assignments: unknown[];
  customFields: Record<string, unknown>;
}

function makeTask(id: string, name: string, ov: Partial<InjectTask> = {}): InjectTask {
  return {
    id,
    name,
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
    ...ov,
  };
}

async function injectTasks(page: Page, tasks: InjectTask[]) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(
    ([ts]) => {
      const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      const f = s.getState().file;
      s.setState({
        file: {
          ...f,
          tasks: ts,
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
    },
    [tasks] as const,
  );
  await page.waitForTimeout(150);
}

const ROW_HEIGHT = 32;

/** Vertical center of the row whose name matches `name`, in viewport coords. */
async function rowCenter(page: Page, name: string): Promise<{ x: number; y: number }> {
  const row = page.locator('[role="row"]').filter({ hasText: name }).first();
  const box = await row.boundingBox();
  if (!box) throw new Error(`row "${name}" not found`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Drive a table-row drag end-to-end via synthetic HTML5 DragEvents.
 *
 * Playwright's `mouse` API fires MouseEvents only — it does NOT synthesize the
 * `dragstart` / `dragover` / `drop` events that `draggable` rows rely on. So
 * we dispatch them ourselves with a real `DataTransfer`, which React picks up
 * through its delegated event listeners. `offsetRatio` selects the drop band:
 * <0.25 → before, >0.75 → after, middle → inside (matches computeDropPosition).
 */
async function dragRow(page: Page, fromName: string, toName: string, offsetRatio: number) {
  const from = await rowCenter(page, fromName);
  const to = await rowCenter(page, toName);
  const dropY = to.y - ROW_HEIGHT / 2 + ROW_HEIGHT * offsetRatio;

  await page.evaluate(
    async ({ fromX, fromY, toX, toY }) => {
      const fromEl = document.elementFromPoint(fromX, fromY) as HTMLElement | null;
      const toEl = document.elementFromPoint(toX, toY) as HTMLElement | null;
      if (!fromEl || !toEl) throw new Error('drag source/target element not found');
      const source = fromEl.closest('[role="row"]') as HTMLElement | null;
      const target = toEl.closest('[role="row"]') as HTMLElement | null;
      if (!source || !target) throw new Error('row not found under pointer');

      const dt = new DataTransfer();
      const fire = (
        type: string,
        el: HTMLElement,
        x: number,
        y: number,
        dataTransfer: DataTransfer,
      ) => {
        // clientX/Y are relative to the viewport; elementFromPoint uses the same.
        const rect = el.getBoundingClientRect();
        const ev = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: rect.left + (x - rect.left),
          clientY: rect.top + (y - rect.top),
        });
        el.dispatchEvent(ev);
      };

      fire('dragstart', source, fromX, fromY, dt);
      // A few dragover ticks so the insertion-line preview updates and the
      // component records the active drop target.
      for (let i = 1; i <= 3; i++) {
        await new Promise((r) => setTimeout(r, 10));
        fire('dragover', target, toX, toY, dt);
      }
      fire('drop', target, toX, toY, dt);
      fire('dragend', source, fromX, fromY, dt);
    },
    {
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: dropY,
    },
  );
}

async function readTasks(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().file.tasks.map((t) => ({
      id: t.id,
      name: t.name,
      parentId: t.parentId,
      order: t.order,
    }));
  });
}

test('drag a task "before" its previous sibling moves it up (order, parentId)', async ({
  page,
}) => {
  await injectTasks(page, [
    makeTask('a', '任务A', { order: 0 }),
    makeTask('b', '任务B', { order: 1 }),
    makeTask('c', '任务C', { order: 2 }),
  ]);

  // Drag taskC onto the TOP band of taskA → before A (ratio 0.1).
  await dragRow(page, '任务C', '任务A', 0.1);

  const tasks = await readTasks(page);
  const c = tasks.find((t) => t.id === 'c')!;
  const aRow = tasks.find((t) => t.id === 'a')!;
  expect(c.order, 'c should be before a (lower order)').toBeLessThan(aRow.order);
  expect(c.parentId).toBeNull();
});

test('drag a task "after" its next sibling moves it down', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '任务A', { order: 0 }),
    makeTask('b', '任务B', { order: 1 }),
    makeTask('c', '任务C', { order: 2 }),
  ]);

  // Drag taskA onto the BOTTOM band of taskC → after C (ratio 0.9).
  await dragRow(page, '任务A', '任务C', 0.9);

  const tasks = await readTasks(page);
  const a = tasks.find((t) => t.id === 'a')!;
  const cRow = tasks.find((t) => t.id === 'c')!;
  expect(a.order, 'a should be after c (higher order)').toBeGreaterThan(cRow.order);
});

test('drag a task "inside" another makes it a child (parentId, order)', async ({ page }) => {
  await injectTasks(page, [
    makeTask('parent', '父任务', { order: 0 }),
    makeTask('lone', '孤立任务', { order: 1 }),
  ]);

  // Drag lone onto the MIDDLE band of parent → becomes a child (ratio 0.5).
  await dragRow(page, '孤立任务', '父任务', 0.5);

  const tasks = await readTasks(page);
  const lone = tasks.find((t) => t.id === 'lone')!;
  expect(lone.parentId, 'lone should now be a child of parent').toBe('parent');
  expect(lone.order).toBe(0);
});

test('dragging a parent onto its own descendant is forbidden (no move)', async ({ page }) => {
  await injectTasks(page, [
    makeTask('parent', '父任务', { order: 0 }),
    makeTask('child', '子任务', { parentId: 'parent', order: 0 }),
  ]);
  const before = await readTasks(page);

  // Drag parent onto the middle of child → should be rejected.
  await dragRow(page, '父任务', '子任务', 0.5);

  const after = await readTasks(page);
  expect(after).toEqual(before);
});

test('a single undo restores hierarchy and order after a reparent', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '任务A', { order: 0 }),
    makeTask('b', '任务B', { order: 1 }),
    makeTask('c', '任务C', { order: 2 }),
  ]);
  const snapshot = await readTasks(page);

  // Reparent: drag c inside a (middle band).
  await dragRow(page, '任务C', '任务A', 0.5);

  const moved = await readTasks(page);
  expect(moved.find((t) => t.id === 'c')!.parentId).toBe('a');

  // One undo restores everything.
  await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    s.getState().undo();
  });
  const restored = await readTasks(page);
  expect(restored).toEqual(snapshot);
});

test('Escape cancels an in-flight drag (no dispatch)', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '任务A', { order: 0 }),
    makeTask('b', '任务B', { order: 1 }),
    makeTask('c', '任务C', { order: 2 }),
  ]);
  const before = await readTasks(page);
  const undoDepthBefore = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().undoStack.length;
  });

  // Start dragging c, press Escape mid-drag, then release via dragend.
  const from = await rowCenter(page, '任务C');
  const to = await rowCenter(page, '任务A');
  await page.evaluate(
    async ({ fromX, fromY, toX, toY }) => {
      const fromEl = document.elementFromPoint(fromX, fromY) as HTMLElement | null;
      const toEl = document.elementFromPoint(toX, toY) as HTMLElement | null;
      if (!fromEl || !toEl) throw new Error('element not found');
      const source = fromEl.closest('[role="row"]') as HTMLElement;
      const target = toEl.closest('[role="row"]') as HTMLElement;
      const dt = new DataTransfer();
      const fire = (type: string, el: HTMLElement, x: number, y: number) => {
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: rect.left + (x - rect.left),
            clientY: rect.top + (y - rect.top),
          }),
        );
      };
      fire('dragstart', source, fromX, fromY);
      fire('dragover', target, toX, toY);
    },
    { fromX: from.x, fromY: from.y, toX: to.x, toY: to.y },
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(30);
  // dragend fires on the source after Escape.
  await page.evaluate(
    async ({ fromX, fromY }) => {
      const fromEl = document.elementFromPoint(fromX, fromY) as HTMLElement | null;
      const source = fromEl?.closest('[role="row"]') as HTMLElement | null;
      if (!source) return;
      const rect = source.getBoundingClientRect();
      source.dispatchEvent(
        new DragEvent('dragend', {
          bubbles: true,
          cancelable: true,
          dataTransfer: new DataTransfer(),
          clientX: rect.left,
          clientY: rect.top,
        }),
      );
    },
    { fromX: from.x, fromY: from.y },
  );

  const after = await readTasks(page);
  expect(after, 'task list unchanged after Escape-cancelled drag').toEqual(before);
  const undoDepthAfter = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().undoStack.length;
  });
  expect(undoDepthAfter, 'no command pushed for a cancelled drag').toBe(undoDepthBefore);
});

test('a move pushes exactly one undo entry labelled 移动任务(含汇总)', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '任务A', { order: 0 }),
    makeTask('b', '任务B', { order: 1 }),
  ]);
  const undoDepthBefore = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().undoStack.length;
  });

  // Move b before a.
  await dragRow(page, '任务B', '任务A', 0.1);

  const { depth, topLabel } = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const stack = s.getState().undoStack;
    return { depth: stack.length, topLabel: stack[stack.length - 1]?.label ?? null };
  });
  expect(depth, 'exactly one command for one drag').toBe(undoDepthBefore + 1);
  expect(topLabel).toBe('移动任务(含汇总)');
});
