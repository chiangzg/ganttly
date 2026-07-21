import { expect, test, type Page } from '@playwright/test';

/**
 * Clipboard + sibling-reorder E2E (PRD §3.10 — F.1/F.3).
 *
 * Verifies copy/paste (Ctrl+C / Ctrl+V) and Alt+Down sibling reorder through
 * the real TaskTable keyboard handler. Uses store injection for setup, then
 * drives the UI via keyboard events focused on the task row.
 */

/** Inject N tasks into the store, return the ids in order. */
async function injectTasks(page: Page, n: number) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  const tasks = Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    name: `Task ${i}`,
    parentId: null,
    order: i,
    start: '2026-02-02',
    end: '2026-02-06',
    duration: 5,
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: {},
    assignments: [],
    customFields: {},
  }));
  await page.evaluate((payload) => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    store.setState({
      file: {
        ...f,
        tasks: payload,
        viewState: {
          ...(f.viewState as object),
          selectedTaskId: 't0',
          collapsedTaskIds: [],
        },
      },
    });
  }, tasks);
  await page.waitForTimeout(200);
}

/** Read ordered list of top-level task ids from the store. */
async function topLevelOrder(page: Page) {
  return page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => {
        file: {
          tasks: Array<{ id: string; parentId: string | null; order: number; name: string }>;
        };
      };
    };
    return store
      .getState()
      .file.tasks.filter((t) => t.parentId === null)
      .sort((a, b) => a.order - b.order)
      .map((t) => ({ id: t.id, name: t.name }));
  });
}

test('Ctrl+C then Ctrl+V pastes a copy as the next sibling', async ({ page }) => {
  await injectTasks(page, 1);
  const row = page.locator('[role="row"]', { hasText: 'Task 0' }).first();
  await row.click();
  await row.focus();

  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await page.waitForTimeout(200);

  const order = await topLevelOrder(page);
  expect(order.length).toBe(2);
  expect(order[1]!.name).toContain('副本');
  expect(order[1]!.name).toContain('Task 0');
});

test('Alt+Down swaps a task with its next sibling', async ({ page }) => {
  await injectTasks(page, 3);
  // Select the first row.
  const row = page.locator('[role="row"]', { hasText: 'Task 0' }).first();
  await row.click();
  await row.focus();

  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForTimeout(150);

  const order = await topLevelOrder(page);
  // t0 should now be at order index 1 (swapped with t1).
  expect(order.map((x) => x.id)).toEqual(['t1', 't0', 't2']);
});

test('Alt+Up swaps a task with its previous sibling', async ({ page }) => {
  await injectTasks(page, 3);
  const row = page.locator('[role="row"]', { hasText: 'Task 1' }).first();
  await row.click();
  await row.focus();

  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForTimeout(150);

  const order = await topLevelOrder(page);
  expect(order.map((x) => x.id)).toEqual(['t1', 't0', 't2']);
});
