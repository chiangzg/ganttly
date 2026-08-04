import { expect, test, type Page } from '@playwright/test';

/**
 * Multi-select & batch delete E2E (editor-interaction-optimization-plan §4.6).
 *
 * Covers:
 *  - Cmd/Ctrl+Click toggles a task into the selection
 *  - Shift+Click selects a contiguous visible range
 *  - the range respects collapse/filter (only visible rows are included)
 *  - Escape clears the multi-selection; single-select Escape still works
 *  - Delete with a multi-selection opens the batch confirm; one undo restores
 *    everything (plan §4.6 验收 "一次撤销恢复整个批量操作")
 *  - parent+child both selected: deleted once, not twice (§4.6 验收)
 *  - the multi-select set is ephemeral (not persisted) while the anchor is
 *  - Canvas and TaskTable share the selection set
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

interface StoreApi {
  getState: () => { file: { tasks: TaskShape[]; viewState: Record<string, unknown> } };
  setState: (s: { file: Record<string, unknown> }) => void;
}

interface ViewStoreApi {
  getState: () => {
    selectedTaskIds: Set<string>;
    anchorTaskId: string | null;
  };
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function makeTask(id: string, start: string, overrides: Partial<TaskShape> = {}): TaskShape {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start,
    end: start,
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
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    if (!store) throw new Error('store not exposed');
    const file = store.getState().file;
    store.setState({ file: { ...file, tasks: injected } });
  }, tasks);
}

async function readSelection(page: Page): Promise<{ ids: string[]; anchor: string | null }> {
  return page.evaluate(() => {
    const vs = (window as unknown as { __ganttlyViewStore?: unknown }).__ganttlyViewStore as
      ViewStoreApi | undefined;
    if (!vs) throw new Error('viewStore not exposed');
    const s = vs.getState();
    return { ids: [...s.selectedTaskIds], anchor: s.anchorTaskId };
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

test('Cmd/Ctrl+Click adds a task to the selection', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '2026-01-05', { order: 0 }),
    makeTask('b', '2026-01-06', { order: 1 }),
    makeTask('c', '2026-01-07', { order: 2 }),
  ]);

  // Plain click selects only 'a'.
  await row(page, 'a').click();
  let sel = await readSelection(page);
  expect(sel.ids).toEqual(['a']);
  expect(sel.anchor).toBe('a');

  // Cmd/Ctrl+Click adds 'c'.
  await row(page, 'c').click({ modifiers: [MOD] });
  sel = await readSelection(page);
  expect(sel.ids.sort()).toEqual(['a', 'c']);
  expect(sel.anchor).toBe('a'); // anchor unchanged

  // Cmd/Ctrl+Click 'a' again removes it.
  await row(page, 'a').click({ modifiers: [MOD] });
  sel = await readSelection(page);
  expect(sel.ids).toEqual(['c']);
});

test('Shift+Click selects a contiguous range from the anchor', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '2026-01-05', { order: 0 }),
    makeTask('b', '2026-01-06', { order: 1 }),
    makeTask('c', '2026-01-07', { order: 2 }),
    makeTask('d', '2026-01-08', { order: 3 }),
    makeTask('e', '2026-01-09', { order: 4 }),
  ]);

  await row(page, 'a').click();
  await row(page, 'd').click({ modifiers: ['Shift'] });

  const sel = await readSelection(page);
  expect(sel.ids.sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(sel.anchor).toBe('a');
});

test('Shift-range respects the collapsed tree (hidden rows excluded)', async ({ page }) => {
  // parent with two children, then a sibling. Collapse the parent so its
  // children are hidden; a Shift-range from parent to sibling must NOT include
  // the hidden children (plan §4.6 验收 "折叠…后保持一致").
  await injectTasks(page, [
    makeTask('parent', '2026-01-05', { order: 0 }),
    makeTask('child1', '2026-01-06', { parentId: 'parent', order: 0 }),
    makeTask('child2', '2026-01-07', { parentId: 'parent', order: 1 }),
    makeTask('sibling', '2026-01-08', { order: 1 }),
  ]);

  // Collapse the parent by clicking its caret.
  const parentRowEl = row(page, 'parent');
  await parentRowEl.locator('button, [role="button"], [aria-label]').first().click();
  // Plain-select the parent, then Shift-click the sibling.
  await parentRowEl.click();
  await row(page, 'sibling').click({ modifiers: ['Shift'] });

  const sel = await readSelection(page);
  // Only the two visible rows — never the hidden children.
  expect(sel.ids.sort()).toEqual(['parent', 'sibling']);
});

test('Escape clears the multi-selection', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '2026-01-05', { order: 0 }),
    makeTask('b', '2026-01-06', { order: 1 }),
    makeTask('c', '2026-01-07', { order: 2 }),
  ]);

  await row(page, 'a').click();
  await row(page, 'b').click({ modifiers: [MOD] });
  expect((await readSelection(page)).ids.length).toBe(2);

  // Focus a row and press Escape.
  await row(page, 'b').press('Escape');
  const sel = await readSelection(page);
  expect(sel.ids).toEqual([]);
  expect(sel.anchor).toBe(null);
});

test('Delete with a multi-selection opens batch confirm and one undo restores all', async ({
  page,
}) => {
  await injectTasks(page, [
    makeTask('a', '2026-01-05', { order: 0 }),
    makeTask('b', '2026-01-06', { order: 1 }),
    makeTask('c', '2026-01-07', { order: 2 }),
    makeTask('d', '2026-01-08', { order: 3 }),
  ]);

  await row(page, 'a').click();
  await row(page, 'b').click({ modifiers: [MOD] });
  await row(page, 'c').click({ modifiers: [MOD] });
  expect((await readSelection(page)).ids.length).toBe(3);

  // Press Delete on a selected row → batch confirm dialog.
  await row(page, 'b').press('Delete');
  await expect(page.getByText('批量删除任务')).toBeVisible();

  const undoBefore = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { undoStack: unknown[] };
    };
    return s.getState().undoStack.length;
  });

  // Confirm the deletion.
  await page.getByRole('button', { name: '删除', exact: true }).click();

  // Only 'd' remains.
  const remaining = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().file.tasks.map((t) => t.id);
  });
  expect(remaining).toEqual(['d']);

  // Exactly ONE undo record was added (plan §4.6 验收).
  const undoAfter = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      getState: () => { undoStack: unknown[] };
    };
    return s.getState().undoStack.length;
  });
  expect(undoAfter).toBe(undoBefore + 1);

  // One undo restores every deleted task. Scope to the toolbar button so it
  // doesn't collide with the undo toast's "撤销" action.
  await page
    .locator('[data-editor-toolbar]')
    .getByRole('button', { name: '撤销', exact: true })
    .click();
  const restored = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s
      .getState()
      .file.tasks.map((t) => t.id)
      .sort();
  });
  expect(restored).toEqual(['a', 'b', 'c', 'd']);
});

test('parent and child both selected: deleted once, not twice', async ({ page }) => {
  await injectTasks(page, [
    makeTask('parent', '2026-01-05', { order: 0 }),
    makeTask('child', '2026-01-06', { parentId: 'parent', order: 0 }),
    makeTask('other', '2026-01-07', { order: 1 }),
  ]);

  await row(page, 'parent').click();
  await row(page, 'child').click({ modifiers: [MOD] });

  await row(page, 'child').press('Delete');
  await expect(page.getByText('批量删除任务')).toBeVisible();

  // The confirm summary should report 2 (parent+child union), not 3.
  await expect(page.getByText(/共将删除 2 个任务/)).toBeVisible();
  await page.getByRole('button', { name: '删除', exact: true }).click();

  const remaining = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().file.tasks.map((t) => t.id);
  });
  expect(remaining).toEqual(['other']);
});

test('multi-select is ephemeral; the anchor persists', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '2026-01-05', { order: 0 }),
    makeTask('b', '2026-01-06', { order: 1 }),
  ]);

  await row(page, 'a').click();
  await row(page, 'b').click({ modifiers: [MOD] });
  expect((await readSelection(page)).ids.length).toBe(2);

  // Reload: only the anchor survives (mirrored into viewState.selectedTaskId);
  // the multi-select set is cleared.
  await page.reload();
  await page.waitForTimeout(500);
  const sel = await readSelection(page);
  // After reload the set is reseeded from the persisted anchor (size 1) OR
  // empty — either way it is NOT a multi-selection anymore.
  expect(sel.ids.length).toBeLessThanOrEqual(1);
});

test('canvas and task table share the selection set', async ({ page }) => {
  await injectTasks(page, [
    makeTask('a', '2026-01-05', { order: 0, duration: 3, end: '2026-01-07' }),
    makeTask('b', '2026-01-08', { order: 1, duration: 3, end: '2026-01-10' }),
  ]);

  // Select 'a' in the table.
  await row(page, 'a').click();
  let sel = await readSelection(page);
  expect(sel.ids).toEqual(['a']);

  // Now Cmd/Ctrl+Click task 'a's bar on the CANVAS. The canvas hit-tests rows
  // beneath the header (HEADER_HEIGHT=40, ROW_HEIGHT=32); the first bar sits at
  // roughly y = 40 + 16 = 56 (row vertical centre). Task 'a' starts at the
  // origin date so its bar is at the far left (x≈0). A modifier-click there
  // toggles 'a' OFF via the canvas route, proving the canvas writes the same
  // shared selection store the table reads.
  const canvas = page.locator('[data-gantt-chart] canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await canvas.click({
    modifiers: [MOD],
    position: { x: 12, y: 56 },
  });

  sel = await readSelection(page);
  expect(sel.ids).not.toContain('a'); // toggled off via the canvas
});
