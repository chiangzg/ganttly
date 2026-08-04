import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Panel/column width resize E2E (editor-interaction-optimization-plan §4.1).
 *
 * Covers:
 *  - dragging the task panel divider resizes the table; rows stay aligned
 *  - widths clamp to the §4.1 bounds (task 320-720, resource 300-640)
 *  - widths persist across reloads (per-project localStorage)
 *  - double-clicking a divider/separator resets to the default
 *  - dragging a column separator resizes header AND row cells in sync
 *  - resource view: panel + role column resize; capacity input shows the %
 *    unit (plan §5.3)
 *
 * Stores are exposed at `window.__ganttlyStore`.
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

interface ResourceShape {
  id: string;
  name: string;
  capacity: number;
  role?: string;
}

interface StoreApi {
  getState: () => { file: { tasks: TaskShape[]; viewState: Record<string, unknown> } };
  setState: (s: { file: Record<string, unknown> }) => void;
}

function makeTask(id: string, overrides: Partial<TaskShape> = {}): TaskShape {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-01-05',
    end: '2026-01-09',
    duration: 5,
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
    ...overrides,
  };
}

async function injectFile(
  page: Page,
  tasks: TaskShape[],
  resources?: ResourceShape[],
): Promise<void> {
  await page.evaluate(
    ({ injectedTasks, injectedResources }) => {
      const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      if (!store) throw new Error('store not exposed');
      const file = store.getState().file;
      store.setState({
        file: {
          ...file,
          tasks: injectedTasks,
          ...(injectedResources ? { resources: injectedResources } : {}),
        },
      });
    },
    { injectedTasks: tasks, injectedResources: resources },
  );
}

/** Drag a resize handle by dx px (pointer down → move in steps → up). */
async function dragBy(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

async function widthOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluate((el) => el.getBoundingClientRect().width);
}

function row(page: Page, id: string) {
  return page.locator(`[data-task-id="${id}"]`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
});

test('dragging the task panel divider resizes the table and keeps rows aligned', async ({
  page,
}) => {
  await injectFile(page, [makeTask('a', { order: 0 }), makeTask('b', { order: 1 })]);

  expect(await widthOf(page, '[data-task-table]')).toBeCloseTo(480, 0);

  const rowYBefore = (await row(page, 'a').boundingBox())!.y;
  await dragBy(page, page.locator('[data-resize="task-panel"]'), 120);
  expect(await widthOf(page, '[data-task-table]')).toBeCloseTo(600, 0);

  // Rows span the pane (minus the pane's 1px border) and keep their vertical
  // position (alignment with the canvas is purely vertical — §4.1 验收 "左右表
  // 与 Canvas 行保持对齐").
  const paneBox = (await page.locator('[data-task-table]').boundingBox())!;
  const rowBox = (await row(page, 'a').boundingBox())!;
  expect(Math.abs(rowBox.width - paneBox.width)).toBeLessThanOrEqual(2);
  expect(rowBox.y).toBeCloseTo(rowYBefore, 0);
});

test('task panel width clamps to the §4.1 bounds (320-720)', async ({ page }) => {
  await injectFile(page, [makeTask('a', { order: 0 })]);

  await dragBy(page, page.locator('[data-resize="task-panel"]'), 500);
  expect(await widthOf(page, '[data-task-table]')).toBeCloseTo(720, 0);

  await dragBy(page, page.locator('[data-resize="task-panel"]'), -500);
  expect(await widthOf(page, '[data-task-table]')).toBeCloseTo(320, 0);
});

test('panel width persists across reloads and double-click resets it', async ({ page }) => {
  await injectFile(page, [makeTask('a', { order: 0 })]);

  await dragBy(page, page.locator('[data-resize="task-panel"]'), 120);
  expect(await widthOf(page, '[data-task-table]')).toBeCloseTo(600, 0);

  // Persisted per project id (plan §4.1).
  await page.reload();
  await page.waitForTimeout(500);
  expect(await widthOf(page, '[data-task-table]')).toBeCloseTo(600, 0);

  // Double-click resets to the default.
  await page.locator('[data-resize="task-panel"]').dblclick();
  expect(await widthOf(page, '[data-task-table]')).toBeCloseTo(480, 0);
});

test('dragging a column separator resizes header and row cells in sync', async ({ page }) => {
  await injectFile(page, [makeTask('a', { order: 0 })]);

  const headerCellWidth = () =>
    page
      .locator('[data-resize="task-col-duration"]')
      .evaluate((el) => (el.parentElement as HTMLElement).getBoundingClientRect().width);
  const rowCellWidth = () =>
    row(page, 'a')
      .locator('[data-field="duration"]')
      .evaluate((el) => el.getBoundingClientRect().width);

  expect(await headerCellWidth()).toBeCloseTo(72, 0);
  await dragBy(page, page.locator('[data-resize="task-col-duration"]'), 40);

  // Header and row share the same computed template — never diverged (§4.1).
  expect(await headerCellWidth()).toBeCloseTo(112, 0);
  expect(await rowCellWidth()).toBeCloseTo(112, 0);
});

test('column width persists and double-click resets that column', async ({ page }) => {
  await injectFile(page, [makeTask('a', { order: 0 })]);

  await dragBy(page, page.locator('[data-resize="task-col-effort"]'), 30);
  const cellWidth = () =>
    page
      .locator('[data-resize="task-col-effort"]')
      .evaluate((el) => (el.parentElement as HTMLElement).getBoundingClientRect().width);
  expect(await cellWidth()).toBeCloseTo(86, 0);

  await page.reload();
  await page.waitForTimeout(500);
  expect(await cellWidth()).toBeCloseTo(86, 0);

  await page.locator('[data-resize="task-col-effort"]').dblclick();
  expect(await cellWidth()).toBeCloseTo(56, 0);
});

test('resource panel and role column resize in the resource view', async ({ page }) => {
  await injectFile(
    page,
    [makeTask('a', { order: 0 })],
    [{ id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' }],
  );
  await page.getByRole('button', { name: '资源视图' }).click();

  expect(await widthOf(page, '[data-resource-list]')).toBeCloseTo(420, 0);
  await dragBy(page, page.locator('[data-resize="resource-panel"]'), 100);
  expect(await widthOf(page, '[data-resource-list]')).toBeCloseTo(520, 0);

  // Role column separator.
  const roleCellWidth = () =>
    page
      .locator('[data-resize="resource-col-role"]')
      .evaluate((el) => (el.parentElement as HTMLElement).getBoundingClientRect().width);
  expect(await roleCellWidth()).toBeCloseTo(76, 0);
  await dragBy(page, page.locator('[data-resize="resource-col-role"]'), 30);
  expect(await roleCellWidth()).toBeCloseTo(106, 0);

  // Double-click resets the panel.
  await page.locator('[data-resize="resource-panel"]').dblclick();
  expect(await widthOf(page, '[data-resource-list]')).toBeCloseTo(420, 0);
});

test('capacity input shows the % unit (plan §5.3)', async ({ page }) => {
  await injectFile(
    page,
    [makeTask('a', { order: 0 })],
    [{ id: 'r1', name: 'Alice', capacity: 0.5, role: '前端' }],
  );
  await page.getByRole('button', { name: '资源视图' }).click();

  // The capacity cell wraps the number input + a % suffix.
  const cell = page.locator('[data-resource-list] input[type="number"]').locator('..');
  await expect(cell).toContainText('%');
});
