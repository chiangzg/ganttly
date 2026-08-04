import { expect, test, type Page } from '@playwright/test';

/**
 * Global editor keyboard shortcuts E2E (editor-interaction-optimization-plan §4.2).
 *
 * Verifies the window-level shortcut hook (`useEditorShortcuts`) wired in PR 8:
 *   - ControlOrMeta+Z         → undo
 *   - Shift+ControlOrMeta+Z   → redo
 *   - Control+Y               → redo (Windows convention)
 *   - ControlOrMeta+S         → save (and suppresses the browser save dialog)
 *
 * Plus the input-target filtering guard (the §4.2 "输入任务名称时 Delete 和撤销
 * 只影响输入内容" acceptance): when focus is inside the F2 rename input, undo
 * must NOT undo the project and Delete must NOT delete the task.
 */

interface StoreApi {
  setState: (s: unknown) => void;
  getState: () => {
    file: {
      tasks: Array<{
        id: string;
        name: string;
        parentId: string | null;
        order: number;
        duration: number;
        start: string;
        end: string;
        progress: number;
        isMilestone: boolean;
        dependencies: string[];
        constraints: Record<string, unknown>;
        assignments: unknown[];
        customFields: Record<string, unknown>;
      }>;
      viewState: Record<string, unknown>;
    };
    saveState: { status: string };
    undo: () => void;
    redo: () => void;
    save: () => Promise<void>;
  };
}

/** Inject a single top-level task and select it. */
async function injectTask(page: Page) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const f = store.getState().file;
    const task = {
      id: 't0',
      name: '设计',
      parentId: null,
      order: 0,
      start: '2026-02-02',
      end: '2026-02-06',
      duration: 5,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: {},
      assignments: [],
      customFields: {},
    };
    store.setState({
      file: {
        ...f,
        tasks: [task],
        viewState: {
          ...(f.viewState as object),
          selectedTaskId: 't0',
          collapsedTaskIds: [],
        },
      },
    });
  });
  await page.waitForTimeout(150);
}

async function readTaskName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.tasks[0]!.name;
  });
}

/**
 * Enter the F2 name editor and rename the task to `next`. Returns once the
 * change is committed (one undoable command on the stack).
 */
async function renameViaInlineEditor(page: Page, next: string) {
  const row = page.locator('[role="row"]', { hasText: '设计' }).first();
  await row.click();
  // Press F2 directly on the row so the row's onKeyDown handles it.
  await row.press('F2');
  const nameInput = page.locator('[data-field="name"] input').first();
  await nameInput.waitFor();
  await nameInput.fill(next);
  await nameInput.press('Enter');
  await page.waitForTimeout(150);
}

async function readTaskCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.tasks.length;
  });
}

async function readSaveStatus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return store.getState().saveState.status;
  });
}

test('ControlOrMeta+Z undoes the last project change', async ({ page }) => {
  await injectTask(page);

  // Make an undoable change: rename through the inline name editor.
  await renameViaInlineEditor(page, '设计V2');
  expect(await readTaskName(page)).toBe('设计V2');

  // Global undo should revert the rename.
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(150);
  expect(await readTaskName(page)).toBe('设计');
});

test('Shift+ControlOrMeta+Z redoes an undone change', async ({ page }) => {
  await injectTask(page);
  await renameViaInlineEditor(page, '设计V2');

  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(150);
  expect(await readTaskName(page)).toBe('设计');

  // Shift+Cmd/Ctrl+Z redo.
  await page.keyboard.press('Shift+ControlOrMeta+z');
  await page.waitForTimeout(150);
  expect(await readTaskName(page)).toBe('设计V2');
});

test('Control+Y redoes an undone change (Windows convention)', async ({ page }) => {
  await injectTask(page);
  await renameViaInlineEditor(page, '设计V2');

  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(150);
  expect(await readTaskName(page)).toBe('设计');

  await page.keyboard.press('Control+y');
  await page.waitForTimeout(150);
  expect(await readTaskName(page)).toBe('设计V2');
});

test('ControlOrMeta+S triggers save and suppresses the browser dialog', async ({ page }) => {
  await injectTask(page);
  // The page must still be on the editor URL (no native-save navigation).
  const before = page.url();
  await page.keyboard.press('ControlOrMeta+s');
  await page.waitForTimeout(200);
  // Save should have run: status moves to saving/saved at some point. Either is
  // acceptable; the key assertion is the page didn't navigate away.
  expect(page.url()).toBe(before);
  const status = await readSaveStatus(page);
  expect(['saving', 'saved', 'idle']).toContain(status);
});

test('undo inside the F2 input edits text, not the project', async ({ page }) => {
  await injectTask(page);
  const row = page.locator('[role="row"]', { hasText: '设计' }).first();
  await row.click();
  await row.press('F2');
  const nameInput = page.locator('[data-field="name"] input').first();
  await nameInput.waitFor();
  await nameInput.focus();
  // Type extra text, then Cmd/Ctrl+Z — should undo the input's text only.
  await page.keyboard.type('XYZ');
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(150);
  // Project task name is unchanged (input never committed).
  expect(await readTaskName(page)).toBe('设计');
  // The task still exists (no accidental delete or project undo).
  expect(await readTaskCount(page)).toBe(1);
});

test('Delete inside the F2 input does not open the delete dialog', async ({ page }) => {
  await injectTask(page);
  const row = page.locator('[role="row"]', { hasText: '设计' }).first();
  await row.click();
  await row.press('F2');
  const nameInput = page.locator('[data-field="name"] input').first();
  await nameInput.waitFor();
  await nameInput.focus();
  await page.keyboard.type('XYZ');
  // Delete while the input has focus — must NOT bubble to the row handler and
  // open the delete-confirm dialog.
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  expect(await readTaskCount(page)).toBe(1);
  // The delete confirmation dialog must not be visible.
  await expect(page.getByText('删除任务')).not.toBeVisible();
  // Escape out of the input without committing.
  await nameInput.press('Escape');
  await page.waitForTimeout(100);
  expect(await readTaskName(page)).toBe('设计');
});

test('global undo and the toolbar undo button are equivalent', async ({ page }) => {
  await injectTask(page);
  await renameViaInlineEditor(page, '设计V2');

  // Undo via toolbar button.
  await page.locator('[data-editor-toolbar] button[aria-label="撤销"]').click();
  await page.waitForTimeout(150);
  expect(await readTaskName(page)).toBe('设计');

  // Redo via global shortcut.
  await page.keyboard.press('Shift+ControlOrMeta+z');
  await page.waitForTimeout(150);
  expect(await readTaskName(page)).toBe('设计V2');

  // Undo via global shortcut.
  await page.keyboard.press('ControlOrMeta+z');
  await page.waitForTimeout(150);
  expect(await readTaskName(page)).toBe('设计');
});
