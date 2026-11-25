import { expect, test, type Page } from '@playwright/test';

/**
 * Priority marks in the task view (priority-matrix spec §3).
 *
 * Covers every place a priority is set or shown outside the matrix view:
 *  - §3.3 the task-tree P tag (leaf tasks only — never on summaries)
 *  - §3.1 the drawer's segmented control (draft semantics, priority-only save)
 *  - §3.2 the context menu's second page (set / show current / clear / no-op)
 *  - §3.5 the canvas hover tooltip row
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
  overtimeDates: string[];
  progress: number;
  isMilestone: boolean;
  priority?: number;
  dependencies: Array<{ targetId: string; type: 'FS' | 'SS' | 'FF' | 'SF'; lag: number }>;
  constraints: Record<string, unknown>;
  assignments: Array<{ resourceId: string; load: number }>;
  customFields: Record<string, unknown>;
}

interface StoreApi {
  getState: () => {
    file: {
      tasks: Array<TaskShape & Record<string, unknown>>;
      resources: Array<{ id: string; name: string }>;
      project: { startDate?: string };
      viewState: Record<string, unknown>;
    };
    undoStack: unknown[];
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}

function makeTask(id: string, overrides: Partial<TaskShape> = {}): TaskShape {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-02-02',
    end: '2026-02-06',
    duration: 5,
    overtimeDates: [],
    progress: 0,
    isMilestone: false,
    dependencies: [],
    constraints: { type: 'none' },
    assignments: [],
    customFields: {},
    ...overrides,
  };
}

async function inject(page: Page, tasks: TaskShape[]): Promise<void> {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate((injected) => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const f = s.getState().file;
    s.setState({
      file: {
        ...f,
        tasks: injected,
        resources: [],
        // Pin the chart origin so the canvas hover test can compute a bar point.
        project: { ...f.project, startDate: '2026-02-02' },
        viewState: {
          ...f.viewState,
          zoom: 'week',
          scrollLeft: 0,
          scrollTop: 0,
          selectedTaskId: null,
          showCriticalPath: false,
          collapsedTaskIds: [],
        },
      },
    });
  }, tasks);
  await page.waitForTimeout(150);
}

/**
 * The task's priority as the store holds it, plus whether the key exists in the
 * PERSISTED form. Clearing through a command leaves an in-memory
 * `priority: undefined` (same as clearing color/note); JSON drops that key, so
 * "is the key gone?" is asked of the serialised task — what a reload will see.
 */
function readPriority(
  page: Page,
  taskId: string,
): Promise<{ value: number | null; hasKey: boolean }> {
  return page.evaluate((id) => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const task = s.getState().file.tasks.find((t) => t.id === id)!;
    const persisted = JSON.parse(JSON.stringify(task)) as Record<string, unknown>;
    return {
      value: (persisted.priority as number | undefined) ?? null,
      hasKey: 'priority' in persisted,
    };
  }, taskId);
}

const undoCount = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().undoStack.length;
  });

const taskMenu = (page: Page) => page.locator('.fixed.z-30').last();

async function openMenuOnRow(page: Page, taskId: string) {
  await page.locator(`[data-task-id="${taskId}"]`).click({ button: 'right' });
  await expect(taskMenu(page)).toBeVisible({ timeout: 3000 });
  return taskMenu(page);
}

async function openDrawerViaMenu(page: Page, taskId: string) {
  const menu = await openMenuOnRow(page, taskId);
  await menu.getByRole('menuitem', { name: '编辑', exact: true }).click();
  await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 3000 });
  return page.locator('aside');
}

test.describe('priority marks (priority-matrix spec §3)', () => {
  test('§3.3 the task tree shows a P tag on triaged leaf tasks only', async ({ page }) => {
    await inject(page, [
      // A stale priority on a summary is tolerated in the data but never shown.
      makeTask('parent', { name: '汇总父任务', order: 0, priority: 1 }),
      makeTask('leaf', { name: '已分级任务', parentId: 'parent', order: 0, priority: 2 }),
      makeTask('plain', { name: '未分级任务', parentId: 'parent', order: 1 }),
    ]);

    await expect(page.locator('[data-task-id="leaf"]').getByTestId('priority-tag')).toHaveText(
      'P2',
    );
    await expect(page.locator('[data-task-id="plain"]').getByTestId('priority-tag')).toHaveCount(0);
    await expect(page.locator('[data-task-id="parent"]').getByTestId('priority-tag')).toHaveCount(
      0,
    );
  });

  test('§3.1 a priority-only drawer edit enables Save, commits once, and reopens checked', async ({
    page,
  }) => {
    await inject(page, [makeTask('t1', { name: '原始任务' })]);
    const drawer = await openDrawerViaMenu(page, 't1');
    const group = drawer.getByRole('radiogroup', { name: '优先级' });
    const save = drawer.getByRole('button', { name: '保存' });

    await expect(group.getByRole('radio', { name: '未分级' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(save).toBeDisabled();

    await group.getByRole('radio', { name: 'P2', exact: true }).click();
    await expect(drawer.getByText('P2 · 重要不紧急 — 计划做')).toBeVisible();
    await expect(save).toBeEnabled();
    // Still a draft: nothing has reached the store.
    expect(await readPriority(page, 't1')).toEqual({ value: null, hasKey: false });

    await save.click();
    await expect(page.locator('[data-task-id="t1"]').getByTestId('priority-tag')).toHaveText('P2');
    expect(await readPriority(page, 't1')).toEqual({ value: 2, hasKey: true });
    expect(await undoCount(page)).toBe(1);

    const reopened = await openDrawerViaMenu(page, 't1');
    await expect(
      reopened
        .getByRole('radiogroup', { name: '优先级' })
        .getByRole('radio', { name: 'P2', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('§3.1 cancel discards a priority draft; summaries get a hint instead of the control', async ({
    page,
  }) => {
    await inject(page, [
      makeTask('parent', { name: '汇总父任务', order: 0 }),
      makeTask('child', { name: '子任务', parentId: 'parent', order: 0, priority: 3 }),
    ]);

    const summaryDrawer = await openDrawerViaMenu(page, 'parent');
    await expect(summaryDrawer.getByText('摘要任务不设优先级，请给具体子任务分级')).toBeVisible();
    await expect(summaryDrawer.getByRole('radiogroup', { name: '优先级' })).toHaveCount(0);
    await summaryDrawer.getByRole('button', { name: '取消', exact: true }).click();
    await expect(summaryDrawer).toBeHidden();

    const drawer = await openDrawerViaMenu(page, 'child');
    await drawer
      .getByRole('radiogroup', { name: '优先级' })
      .getByRole('radio', { name: 'P1', exact: true })
      .click();
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改' }).click();
    await page.waitForTimeout(200);

    expect(await readPriority(page, 'child')).toEqual({ value: 3, hasKey: true });
    await expect(page.locator('[data-task-id="child"]').getByTestId('priority-tag')).toHaveText(
      'P3',
    );
  });

  test('§3.2 the context menu page sets a priority, ignores a re-pick, and 未分级 clears it', async ({
    page,
  }) => {
    await inject(page, [makeTask('t1', { name: '目标任务' })]);

    let menu = await openMenuOnRow(page, 't1');
    const entry = menu.getByRole('menuitem', { name: /优先级/ });
    // The entry previews the current value.
    await expect(entry).toContainText('未分级');
    await entry.click();
    // Anchor on the tag: "不紧急不重要" (P4) contains "紧急不重要" (P3) as a substring.
    await menu.getByRole('menuitem', { name: /^P3 / }).click();

    await expect(page.locator('[data-task-id="t1"]').getByTestId('priority-tag')).toHaveText('P3');
    expect(await readPriority(page, 't1')).toEqual({ value: 3, hasKey: true });
    expect(await undoCount(page)).toBe(1);

    // Re-open: the entry shows the new value and the page check-marks it.
    menu = await openMenuOnRow(page, 't1');
    await expect(entry).toContainText('P3');
    await entry.click();
    const current = menu.getByRole('menuitem', { name: /^P3 / });
    await expect(current.locator('svg')).toHaveCount(1);
    await current.click();
    await expect(menu).toBeHidden();
    // Picking the value it already had is not a change: no extra undo record.
    expect(await undoCount(page)).toBe(1);

    menu = await openMenuOnRow(page, 't1');
    await entry.click();
    await menu.getByRole('menuitem', { name: /未分级/ }).click();
    await expect(page.locator('[data-task-id="t1"]').getByTestId('priority-tag')).toHaveCount(0);
    // "Cleared" stores no sentinel: the persisted task has no priority key.
    expect(await readPriority(page, 't1')).toEqual({ value: null, hasKey: false });
    expect(await undoCount(page)).toBe(2);
  });

  test('§3.2 the entry is disabled for summaries; → opens the page and ← returns', async ({
    page,
  }) => {
    await inject(page, [
      makeTask('parent', { name: '汇总父任务', order: 0 }),
      makeTask('child', { name: '子任务', parentId: 'parent', order: 0 }),
    ]);

    // Summary: visibly disabled, never a silent no-op.
    let menu = await openMenuOnRow(page, 'parent');
    const entry = menu.getByRole('menuitem', { name: /优先级/ });
    await expect(entry).toBeDisabled();
    await expect(entry).toHaveAttribute('title', '摘要任务不设优先级，请给具体子任务分级');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    menu = await openMenuOnRow(page, 'child');
    await entry.focus();
    await page.keyboard.press('ArrowRight');
    await expect(menu.getByRole('menuitem', { name: /^P1 / })).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(menu.getByRole('menuitem', { name: '重命名' })).toBeVisible();
  });

  test('§3.5 the canvas hover tooltip lists the priority once a task is triaged', async ({
    page,
  }) => {
    await inject(page, [
      makeTask('t1', { name: '已分级任务', order: 0, priority: 1 }),
      makeTask('t2', { name: '未分级任务', order: 1 }),
    ]);

    // week zoom = 140/7 px per day; the fixture pins the origin to 2026-02-02.
    const canvas = page.locator('canvas').first();
    const box = (await canvas.boundingBox())!;
    const barX = box.x + 1.5 * (140 / 7);
    const rowY = (index: number) => box.y + 56 + index * 32 + 16;
    const tooltip = page.locator('[data-gantt-task-tooltip]');

    await page.mouse.move(barX, rowY(0));
    await expect(tooltip).toBeVisible({ timeout: 2000 });
    await expect(tooltip).toContainText('已分级任务');
    await expect(tooltip).toContainText('优先级');
    await expect(tooltip).toContainText('P1 紧急且重要');

    await page.mouse.move(box.x + 5, rowY(1) + 60); // leave → tooltip hides
    await expect(tooltip).toBeHidden({ timeout: 2000 });
    await page.mouse.move(barX, rowY(1));
    await expect(tooltip).toBeVisible({ timeout: 2000 });
    await expect(tooltip).toContainText('未分级任务');
    // Not triaged → no priority row at all (not an empty one).
    await expect(tooltip).not.toContainText('优先级');
  });
});
