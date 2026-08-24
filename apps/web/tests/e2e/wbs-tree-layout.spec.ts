import { expect, test, type Page } from '@playwright/test';

/**
 * WBS tree layout & interaction regressions (wbs-tree-ui-interaction-design).
 *
 * Locks down the three bugs this redesign fixed:
 *  1. Hover must NEVER shift layout — the drag grip fades in inside a
 *     reserved 18px slot, so the WBS number's x/y are identical before and
 *     after hovering the row (the old `display:none → inline-block` handle
 *     pushed the number ~18px to the right).
 *  2. WBS numbers are FLAT: every depth renders at the same x, so the column
 *     reads like spreadsheet row numbers instead of a noisy indented tree.
 *  3. treegrid semantics: rows expose aria-level / aria-expanded; expand-all
 *     / collapse-all buttons drive the whole tree without touching undo.
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
  dependencies: unknown[];
  constraints: Record<string, unknown>;
  assignments: unknown[];
  customFields: Record<string, unknown>;
}

interface StoreApi {
  setState: (s: unknown) => void;
  getState: () => {
    file: { tasks: TaskShape[]; viewState: Record<string, unknown> };
    undoStack: Array<{ label: string }>;
  };
}

function makeTask(id: string, overrides: Partial<TaskShape> = {}): TaskShape {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-01-05',
    end: '2026-01-06',
    duration: 2,
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
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    if (!store) throw new Error('store not exposed');
    const file = store.getState().file;
    store.setState({
      file: {
        ...file,
        tasks: injected,
        viewState: { ...(file.viewState as object), collapsedTaskIds: [] },
      },
    });
  }, tasks);
  await page.waitForTimeout(150);
}

test.describe('WBS tree layout regressions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.waitForTimeout(400);
  });

  test('hovering a row does not shift the WBS number or the expand toggle', async ({ page }) => {
    await injectTasks(page, [
      makeTask('p', { name: '父任务', order: 0 }),
      makeTask('c1', { name: '子任务一', parentId: 'p', order: 0 }),
    ]);

    const row = page.locator('[data-task-id="p"]');
    const number = row.locator('[data-testid="wbs-number"]');
    const toggle = row.locator('[data-testid="expand-toggle"]');

    const numberBefore = await number.boundingBox();
    const toggleBefore = await toggle.boundingBox();

    await row.hover();
    await page.waitForTimeout(120); // let the opacity transition run

    const numberAfter = await number.boundingBox();
    const toggleAfter = await toggle.boundingBox();

    // Zero layout shift: the grip fades in inside its reserved slot.
    expect(numberAfter?.x).toBe(numberBefore?.x);
    expect(numberAfter?.y).toBe(numberBefore?.y);
    expect(toggleAfter?.x).toBe(toggleBefore?.x);
    expect(toggleAfter?.y).toBe(toggleBefore?.y);
  });

  test('WBS numbers align at one x across depths (flat number column)', async ({ page }) => {
    await injectTasks(page, [
      makeTask('p', { name: '父任务', order: 0 }),
      makeTask('c1', { name: '子任务一', parentId: 'p', order: 0 }),
      makeTask('g', { name: '孙任务', parentId: 'c1', order: 0 }),
    ]);

    const xs = await Promise.all(
      ['p', 'c1', 'g'].map(async (id) => {
        const box = await page
          .locator(`[data-task-id="${id}"] [data-testid="wbs-number"]`)
          .boundingBox();
        if (!box) throw new Error(`wbs number for ${id} not found`);
        return box.x;
      }),
    );
    expect(new Set(xs).size, 'all depths share the same number x').toBe(1);
  });

  test('rows expose treegrid aria-level / aria-expanded', async ({ page }) => {
    await injectTasks(page, [
      makeTask('p', { name: '父任务', order: 0 }),
      makeTask('c1', { name: '子任务一', parentId: 'p', order: 0 }),
    ]);

    await expect(page.locator('[role="treegrid"]')).toBeVisible();
    await expect(page.locator('[data-task-id="p"]')).toHaveAttribute('aria-level', '1');
    await expect(page.locator('[data-task-id="p"]')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-task-id="c1"]')).toHaveAttribute('aria-level', '2');
    // Leaf rows carry no aria-expanded at all.
    expect(await page.locator('[data-task-id="c1"]').getAttribute('aria-expanded')).toBeNull();
  });

  test('expand-all / collapse-all drive the tree without touching undo', async ({ page }) => {
    await injectTasks(page, [
      makeTask('p1', { name: '父一', order: 0 }),
      makeTask('c1', { name: '子一', parentId: 'p1', order: 0 }),
      makeTask('c2', { name: '子二', parentId: 'p1', order: 1 }),
      makeTask('p2', { name: '父二', order: 1 }),
      makeTask('c3', { name: '子三', parentId: 'p2', order: 0 }),
    ]);
    expect(await page.locator('[role="row"]').count()).toBe(5);

    const undoDepthBefore = await page.evaluate(() => {
      const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      return s.getState().undoStack.length;
    });

    // Collapse all → only the two roots remain, each with a count chip.
    await page.getByRole('button', { name: '全部收起' }).click();
    await page.waitForTimeout(150);
    expect(await page.locator('[role="row"]').count()).toBe(2);
    await expect(page.locator('[data-task-id="p1"] [data-testid="child-count"]')).toHaveText(
      '2 项',
    );
    await expect(page.locator('[data-task-id="p2"] [data-testid="child-count"]')).toHaveText(
      '1 项',
    );

    // Expand all → every row is back.
    await page.getByRole('button', { name: '全部展开' }).click();
    await page.waitForTimeout(150);
    expect(await page.locator('[role="row"]').count()).toBe(5);

    // Batch navigation is a direct view-state write — no undo entries.
    const undoDepthAfter = await page.evaluate(() => {
      const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      return s.getState().undoStack.length;
    });
    expect(undoDepthAfter).toBe(undoDepthBefore);
  });
});
