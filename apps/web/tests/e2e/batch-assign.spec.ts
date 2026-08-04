import { expect, test, type Page } from '@playwright/test';

/**
 * Batch owner assignment E2E (editor-interaction-optimization-plan §4.6, scoped
 * to assignee assignment only).
 *
 * Covers:
 *  - selecting ≥2 tasks shows the batch action bar
 *  - assigning a resource updates every selected leaf task in ONE undo record
 *  - summary tasks are excluded from the targets (parent+child both selected →
 *    only the child is assigned)
 *  - empty resources show a hint and disable the apply path
 *  - clearing the selection hides the bar
 *  - Escape closes the assign popover
 *
 * Stores are exposed at `window.__ganttlyStore` / `__ganttlyViewStore`.
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
  getState: () => {
    file: {
      tasks: TaskShape[];
      resources: ResourceShape[];
      viewState: Record<string, unknown>;
    };
    undoStack: unknown[];
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

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

async function readAssignments(page: Page, id: string): Promise<TaskShape['assignments'] | null> {
  return page.evaluate((taskId) => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const task = store.getState().file.tasks.find((t) => t.id === taskId);
    return task?.assignments ?? null;
  }, id);
}

async function readUndoStackLength(page: Page): Promise<number> {
  return page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().undoStack.length;
  });
}

/** Locate a task row by its data-task-id (stable, independent of a11y name). */
function row(page: Page, id: string) {
  return page.locator(`[data-task-id="${id}"]`);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(500);
});

test('batch bar appears for a multi-selection and one undo restores the whole assign', async ({
  page,
}) => {
  await injectFile(
    page,
    [makeTask('a', { order: 0 }), makeTask('b', { order: 1 }), makeTask('c', { order: 2 })],
    [{ id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' }],
  );

  await row(page, 'a').click();
  await row(page, 'b').click({ modifiers: [MOD] });

  // Bar shows the selection count and the assign entry point.
  const bar = page.locator('[data-batch-bar]');
  await expect(bar).toBeVisible();
  await expect(bar.getByText('已选 2 项')).toBeVisible();

  // Deselect back to one → the bar hides; reselect → it returns.
  await row(page, 'b').click({ modifiers: [MOD] });
  await expect(bar).not.toBeVisible();
  await row(page, 'b').click({ modifiers: [MOD] });
  await expect(bar).toBeVisible();
  await expect(bar.getByText('已选 2 项')).toBeVisible();

  // Open the popover and apply the assignment (r1 is preselected, load 100).
  const undoBefore = await readUndoStackLength(page);
  await bar.getByRole('button', { name: '分配负责人' }).click();
  await expect(page.getByRole('dialog', { name: '批量分配负责人' })).toBeVisible();
  await page.getByRole('button', { name: '应用', exact: true }).click();

  // Both selected leaves now carry the assignment.
  expect(await readAssignments(page, 'a')).toEqual([{ resourceId: 'r1', load: 100 }]);
  expect(await readAssignments(page, 'b')).toEqual([{ resourceId: 'r1', load: 100 }]);
  expect(await readAssignments(page, 'c')).toEqual([]);

  // Exactly ONE undo record was added (plan §4.6 验收 "一次撤销恢复整个批量操作").
  const undoAfter = await readUndoStackLength(page);
  expect(undoAfter).toBe(undoBefore + 1);

  // One undo restores every task.
  await page
    .locator('[data-editor-toolbar]')
    .getByRole('button', { name: '撤销', exact: true })
    .click();
  expect(await readAssignments(page, 'a')).toEqual([]);
  expect(await readAssignments(page, 'b')).toEqual([]);
});

test('summary tasks are excluded: parent+child selected assigns only the child', async ({
  page,
}) => {
  await injectFile(
    page,
    [
      makeTask('parent', { order: 0 }),
      makeTask('child', { parentId: 'parent', order: 0 }),
      makeTask('other', { order: 1 }),
    ],
    [{ id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' }],
  );

  await row(page, 'parent').click();
  await row(page, 'other').click({ modifiers: [MOD] });
  await expect(page.locator('[data-batch-bar]').getByText('已选 2 项')).toBeVisible();

  await page.locator('[data-batch-bar]').getByRole('button', { name: '分配负责人' }).click();
  await page.getByRole('button', { name: '应用', exact: true }).click();

  expect(await readAssignments(page, 'parent')).toEqual([]);
  expect(await readAssignments(page, 'other')).toEqual([{ resourceId: 'r1', load: 100 }]);
});

test('empty resources show a hint and no apply path', async ({ page }) => {
  await injectFile(
    page,
    [makeTask('a', { order: 0 }), makeTask('b', { order: 1 })],
    [], // no resources
  );

  await row(page, 'a').click();
  await row(page, 'b').click({ modifiers: [MOD] });
  await page.locator('[data-batch-bar]').getByRole('button', { name: '分配负责人' }).click();

  await expect(page.getByText('暂无资源，请先添加')).toBeVisible();
  await expect(page.getByRole('button', { name: '应用', exact: true })).not.toBeVisible();
});

test('Escape closes the popover; clearing the selection hides the bar', async ({ page }) => {
  await injectFile(
    page,
    [makeTask('a', { order: 0 }), makeTask('b', { order: 1 })],
    [{ id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' }],
  );

  await row(page, 'a').click();
  await row(page, 'b').click({ modifiers: [MOD] });
  const bar = page.locator('[data-batch-bar]');
  await expect(bar).toBeVisible();

  // Escape closes the popover but keeps the bar.
  await bar.getByRole('button', { name: '分配负责人' }).click();
  await expect(page.getByRole('dialog', { name: '批量分配负责人' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '批量分配负责人' })).not.toBeVisible();
  await expect(bar).toBeVisible();

  // Clearing the selection hides the bar.
  await bar.getByRole('button', { name: '取消选择' }).click();
  await expect(bar).not.toBeVisible();
});
