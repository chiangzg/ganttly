import { expect, test, type Page } from '@playwright/test';

/**
 * E2E tests for collapse/expand and summary task (rollup) behavior.
 *
 * These tests seed a parent/child task tree directly into the Zustand store
 * exposed on `window.__ganttlyStore` (see main.tsx), then assert real
 * behaviour — row counts on collapse/expand, summary-row styling, and rollup
 * values after editing a child. This replaces an earlier version whose
 * assertions were wrapped in `if (isVisible())` guards and never executed.
 */

interface TaskSeed {
  id: string;
  name?: string;
  parentId: string | null;
  order: number;
  start?: string;
  end?: string;
  duration?: number;
  progress?: number;
  isMilestone?: boolean;
}

interface FileState {
  tasks: Array<Record<string, unknown>>;
}

/** Seed the running app with the given task list (non-undoable). */
async function injectTree(page: Page, tasks: TaskSeed[]): Promise<void> {
  await page.evaluate((seed) => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as
      | {
          getState: () => { file: FileState };
          setState: (s: { file: FileState }) => void;
        }
      | undefined;
    if (!store) throw new Error('store not exposed');
    const file = store.getState().file;
    const full = seed.map((t) => ({
      id: t.id,
      name: t.name ?? t.id,
      parentId: t.parentId,
      order: t.order,
      start: t.start ?? '2026-01-05',
      end: t.end ?? '2026-01-09',
      duration: t.duration ?? 5,
      progress: t.progress ?? 0,
      isMilestone: t.isMilestone ?? false,
      dependencies: [],
      constraints: {},
      assignments: [],
      customFields: {},
    }));
    store.setState({ file: { ...file, tasks: full } });
  }, tasks);
}

/** Read a task's stored fields from the running store. */
async function readTask(page: Page, id: string): Promise<Record<string, unknown>> {
  return page.evaluate((taskId) => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as
      { getState: () => { file: FileState } } | undefined;
    if (!store) throw new Error('store not exposed');
    const t = store!.getState().file.tasks.find((x) => x.id === taskId);
    if (!t) throw new Error(`task ${taskId} not found`);
    return t;
  }, id);
}

async function waitForStoreReady(page: Page): Promise<void> {
  // Wait for the initial load/save cycle so it won't overwrite our injection.
  await expect(page.getByText('已保存').or(page.getByText('保存中'))).toBeVisible({
    timeout: 5000,
  });
}

test('collapse/expand sync — row count decreases and recovers', async ({ page }) => {
  await page.goto('/');
  await waitForStoreReady(page);

  // parent → [child1, child2]
  await injectTree(page, [
    { id: 'parent', name: 'Parent', parentId: null, order: 0 },
    { id: 'child1', name: 'Child 1', parentId: 'parent', order: 0 },
    { id: 'child2', name: 'Child 2', parentId: 'parent', order: 1 },
  ]);

  const rowsBefore = await page.locator('[role="row"]').count();
  expect(rowsBefore).toBe(3); // parent + 2 children

  // Collapse parent via its ▼ button.
  await page.locator('[role="row"]').first().locator('button').filter({ hasText: '▼' }).click();
  expect(await page.locator('[role="row"]').count()).toBe(1); // only parent remains

  // Expand via ▶.
  await page.locator('[role="row"]').first().locator('button').filter({ hasText: '▶' }).click();
  expect(await page.locator('[role="row"]').count()).toBe(3);
});

test('summary task row renders with font-semibold styling', async ({ page }) => {
  await page.goto('/');
  await waitForStoreReady(page);

  await injectTree(page, [
    { id: 'parent', name: 'Parent', parentId: null, order: 0 },
    { id: 'child1', name: 'Child 1', parentId: 'parent', order: 0 },
  ]);

  // First row is the parent (summary) — its name cell carries font-semibold.
  const firstRow = page.locator('[role="row"]').first();
  await expect(firstRow).toBeVisible();
  await expect(firstRow.locator('.font-semibold').first()).toBeVisible();

  // The child (second row) is a leaf — it should NOT have font-semibold on
  // its name cell, distinguishing it from the summary row.
  const secondRow = page.locator('[role="row"]').nth(1);
  await expect(secondRow).toBeVisible();
  // Leaf has no ▼ toggle either, confirming it's not a summary.
  await expect(secondRow.locator('button').filter({ hasText: '▼' })).toHaveCount(0);
});

test('editing child progress rolls up to the parent summary', async ({ page }) => {
  await page.goto('/');
  await waitForStoreReady(page);

  // parent with a single child at progress 0.
  await injectTree(page, [
    { id: 'parent', name: 'Parent', parentId: null, order: 0, duration: 5 },
    {
      id: 'child',
      name: 'Child',
      parentId: 'parent',
      order: 0,
      duration: 5,
      progress: 0,
    },
  ]);

  // Sanity: parent rollup is 0 before edit (assembly + command both converge).
  const parentBefore = await readTask(page, 'parent');
  expect(parentBefore.progress).toBe(0);

  // Open the child's drawer by double-clicking its row.
  await page.locator('[role="row"]').nth(1).dblclick();

  // The drawer exposes progress as a range slider. Drive it to 80.
  const progressSlider = page.locator('input[type="range"]').first();
  await progressSlider.waitFor({ state: 'visible' });
  await progressSlider.fill('80');

  // The drawer commits onChange via dispatch(updateTaskWithRollupCommand).
  // Verify the parent's stored progress has rolled up to 80 (single child).
  await expect
    .poll(async () => {
      const parent = await readTask(page, 'parent');
      return parent.progress;
    })
    .toBe(80);
});
