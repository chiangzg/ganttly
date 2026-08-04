import { expect, test, type Page } from '@playwright/test';

/**
 * Inline cell editing E2E (editor-interaction-optimization-plan §4.3).
 *
 * Verifies double-click on the name/duration/progress cells enters inline edit,
 * Enter commits, Escape cancels, Tab moves to the next editable cell, and the
 * summary/milestone read-only rules are honoured. Also verifies the §4.3 double-
 * click semantics: double-clicking a data cell edits in place, while double-
 * clicking the WBS/effort area still opens the drawer.
 */

interface Task {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  start: string;
  end: string;
  duration: number;
  progress: number;
  isMilestone: boolean;
  dependencies: string[];
  constraints: Record<string, unknown>;
  assignments: unknown[];
  customFields: Record<string, unknown>;
}

interface StoreApi {
  setState: (s: unknown) => void;
  getState: () => {
    file: { tasks: Task[]; viewState: Record<string, unknown> };
    undo: () => void;
  };
}

async function inject(page: Page, tasks: Task[]) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate((payload) => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const f = s.getState().file;
    s.setState({
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
  await page.waitForTimeout(150);
}

function leafTask(over: Partial<Task> & { id: string }): Task {
  return {
    name: over.id,
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
    ...over,
  };
}

async function readTask(page: Page, id: string): Promise<Task> {
  return page.evaluate((taskId) => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().file.tasks.find((t) => t.id === taskId)!;
  }, id);
}

test.describe('inline cell editing', () => {
  test('double-click name cell edits and Enter commits', async ({ page }) => {
    await inject(page, [leafTask({ id: 't0', name: '设计' })]);
    await page.locator('[role="row"]', { hasText: '设计' }).first().click();
    // Double-click directly on the name cell.
    await page.locator('[data-task-id="t0"] [data-field="name"]').dblclick();
    const input = page.locator('[data-field="name"] input').first();
    await input.waitFor();
    await input.fill('设计V2');
    await input.press('Enter');
    await page.waitForTimeout(150);
    expect((await readTask(page, 't0')).name).toBe('设计V2');
  });

  test('one undo reverts the name edit', async ({ page }) => {
    await inject(page, [leafTask({ id: 't0', name: '设计' })]);
    await page.locator('[role="row"]', { hasText: '设计' }).first().click();
    await page.locator('[data-task-id="t0"] [data-field="name"]').dblclick();
    const input = page.locator('[data-field="name"] input').first();
    await input.fill('设计V2');
    await input.press('Enter');
    await page.waitForTimeout(150);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(150);
    expect((await readTask(page, 't0')).name).toBe('设计');
  });

  test('double-click duration cell edits, recomputes end, Enter commits', async ({ page }) => {
    await inject(page, [
      leafTask({ id: 't0', name: '设计', duration: 5, start: '2026-02-02', end: '2026-02-06' }),
    ]);
    await page.locator('[role="row"]', { hasText: '设计' }).first().click();
    await page.locator('[data-task-id="t0"] [data-field="duration"]').dblclick();
    const input = page.locator('[data-field="duration"] input').first();
    await input.waitFor();
    await input.fill('3');
    await input.press('Enter');
    await page.waitForTimeout(150);
    const after = await readTask(page, 't0');
    expect(after.duration).toBe(3);
    // end must be recomputed via endDateFromDuration (2026-02-02 + 3 working days).
    expect(after.end).not.toBe('2026-02-06');
  });

  test('one undo reverts both duration and end together', async ({ page }) => {
    await inject(page, [
      leafTask({ id: 't0', name: '设计', duration: 5, start: '2026-02-02', end: '2026-02-06' }),
    ]);
    await page.locator('[role="row"]', { hasText: '设计' }).first().click();
    await page.locator('[data-task-id="t0"] [data-field="duration"]').dblclick();
    const input = page.locator('[data-field="duration"] input').first();
    await input.fill('3');
    await input.press('Enter');
    await page.waitForTimeout(150);
    await page.keyboard.press('ControlOrMeta+z');
    await page.waitForTimeout(150);
    const after = await readTask(page, 't0');
    expect(after.duration).toBe(5);
    expect(after.end).toBe('2026-02-06');
  });

  test('double-click progress cell edits and Enter commits (clamped)', async ({ page }) => {
    await inject(page, [leafTask({ id: 't0', name: '设计', progress: 0 })]);
    await page.locator('[role="row"]', { hasText: '设计' }).first().click();
    await page.locator('[data-task-id="t0"] [data-field="progress"]').dblclick();
    const input = page.locator('[data-field="progress"] input').first();
    await input.waitFor();
    await input.fill('60');
    await input.press('Enter');
    await page.waitForTimeout(150);
    expect((await readTask(page, 't0')).progress).toBe(60);
  });

  test('Escape cancels without modifying data', async ({ page }) => {
    await inject(page, [leafTask({ id: 't0', name: '设计', progress: 0 })]);
    await page.locator('[role="row"]', { hasText: '设计' }).first().click();
    await page.locator('[data-task-id="t0"] [data-field="progress"]').dblclick();
    const input = page.locator('[data-field="progress"] input').first();
    await input.fill('80');
    await input.press('Escape');
    await page.waitForTimeout(150);
    expect((await readTask(page, 't0')).progress).toBe(0);
  });

  test('Tab commits and moves to the next editable cell (duration → progress)', async ({
    page,
  }) => {
    await inject(page, [leafTask({ id: 't0', name: '设计', duration: 5, progress: 0 })]);
    await page.locator('[role="row"]', { hasText: '设计' }).first().click();
    await page.locator('[data-task-id="t0"] [data-field="duration"]').dblclick();
    const durInput = page.locator('[data-field="duration"] input').first();
    await durInput.waitFor();
    await durInput.fill('3');
    await durInput.press('Tab');
    await page.waitForTimeout(150);
    // duration committed…
    expect((await readTask(page, 't0')).duration).toBe(3);
    // …and the progress cell is now editing.
    await expect(page.locator('[data-field="progress"] input')).toBeVisible();
  });

  test('summary task duration cell is read-only', async ({ page }) => {
    const parent = leafTask({ id: 't0', name: '父任务', duration: 5 });
    const child = leafTask({ id: 't1', name: '子任务', parentId: 't0', order: 0 });
    await inject(page, [parent, child]);
    await page.locator('[role="row"]', { hasText: '父任务' }).first().click();
    await page.locator('[data-task-id="t0"] [data-field="duration"]').dblclick();
    await page.waitForTimeout(150);
    // No input appears for a summary task's duration cell.
    await expect(page.locator('[data-field="duration"] input')).toHaveCount(0);
  });

  test('milestone duration cell is read-only', async ({ page }) => {
    await inject(page, [leafTask({ id: 't0', name: '里程碑', isMilestone: true, duration: 0 })]);
    await page.locator('[role="row"]', { hasText: '里程碑' }).first().click();
    await page.locator('[data-task-id="t0"] [data-field="duration"]').dblclick();
    await page.waitForTimeout(150);
    await expect(page.locator('[data-field="duration"] input')).toHaveCount(0);
  });

  test('double-click name edits in place; double-click WBS opens the drawer', async ({ page }) => {
    await inject(page, [leafTask({ id: 't0', name: '设计' })]);
    await page.locator('[role="row"]', { hasText: '设计' }).first().click();

    // Double-click the name cell → inline editor, NOT the drawer.
    await page.locator('[data-task-id="t0"] [data-field="name"]').dblclick();
    await page.waitForTimeout(150);
    await expect(page.locator('[data-field="name"] input')).toBeVisible();
    await expect(page.getByText('编辑任务')).toHaveCount(0);
    // Cancel out.
    await page.locator('[data-field="name"] input').press('Escape');
    await page.waitForTimeout(100);

    // Double-click the WBS cell → opens the drawer.
    await page.locator('[data-task-id="t0"] [data-field="wbs"]').first().dblclick();
    await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 3000 });
  });
});
