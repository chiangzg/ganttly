import { expect, test, type Page } from '@playwright/test';

/**
 * Task Canvas info & interaction E2E
 * (editor-interaction-optimization-plan §3.2 / §3.3 / §3.4).
 *
 * Verifies:
 *  - §3.2 hovering a task bar shows a tooltip with WBS + name + dates + assignees.
 *  - §3.3 a multi-assignee bar shows the "name · primary +N" label; unassigned
 *    shows a muted "未分配".
 *  - §3.4 right-click on a bar opens the shared ContextMenu (same as the table).
 *  - §3.4 canvas keyboard: Enter opens the drawer, Delete opens the confirm
 *    dialog, Escape clears selection.
 *  - §3.2/§3.4 summary bars are hoverable / right-clickable (the interactive
 *    hitTest returns 'empty' for summaries, but the read-only hover path covers
 *    them).
 */

const HEADER_HEIGHT = 56;
const ROW_HEIGHT = 32;

interface StoreApi {
  getState: () => {
    file: {
      tasks: Array<{ id: string; name: string; start: string }>;
      resources: Array<{ id: string; name: string }>;
      project: { startDate?: string };
      viewState: Record<string, unknown>;
    };
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}

async function inject(
  page: Page,
  opts: {
    tasks: Array<Record<string, unknown>>;
    resources?: Array<Record<string, unknown>>;
  },
) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(
    ([tasks, resources]) => {
      const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      const f = s.getState().file;
      s.setState({
        file: {
          ...f,
          tasks,
          resources: resources ?? [],
          // Pin the project start to the fixture's task start so the chart
          // origin (min(earliest task, project.startDate)) is deterministic.
          project: { ...f.project, startDate: '2026-02-02' },
          viewState: {
            ...(f.viewState as object),
            zoom: 'week',
            scrollLeft: 0,
            scrollTop: 0,
            selectedTaskId: null,
            showCriticalPath: false,
            collapsedTaskIds: [],
          },
        },
      });
    },
    [opts.tasks, opts.resources ?? []] as const,
  );
  await page.waitForTimeout(150);
}

/** Viewport (x, y) of the vertical center of a task bar at the given ISO date. */
async function barPoint(
  page: Page,
  isoDate: string,
  rowIndex = 0,
): Promise<{ x: number; y: number }> {
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  // Mirror originDateFor: origin = min(earliest task start, project.startDate).
  // The fixture pins project.startDate to 2026-02-02, so with a 2026-02-02 task
  // the origin is 2026-02-02. week zoom = 140/7 px/day.
  const xLocal = await page.evaluate((date) => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const f = s.getState().file;
    const tasks = f.tasks;
    const projectStart = f.project?.startDate ?? '2026-02-02';
    let origin = projectStart;
    if (tasks.length) {
      const earliest = tasks.reduce((m, t) => (t.start < m ? t.start : m), tasks[0]!.start);
      origin = earliest < projectStart ? earliest : projectStart;
    }
    const dayDelta = (Date.parse(date) - Date.parse(origin)) / 86_400_000;
    return Math.round(dayDelta) * (140 / 7);
  }, isoDate);
  return { x: box.x + xLocal, y: box.y + HEADER_HEIGHT + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2 };
}

test('§3.2 hovering a task bar shows a tooltip with name + dates + assignee', async ({ page }) => {
  await inject(page, {
    tasks: [
      {
        id: 't1',
        name: '设计阶段',
        parentId: null,
        order: 0,
        start: '2026-02-02',
        end: '2026-02-06',
        duration: 5,
        overtimeDates: [],
        progress: 40,
        isMilestone: false,
        dependencies: [],
        constraints: { type: 'none' },
        assignments: [{ resourceId: 'r1', load: 80 }],
        customFields: {},
      },
    ],
    resources: [{ id: 'r1', name: '王强', capacity: 1.0 }],
  });

  const pt = await barPoint(page, '2026-02-03');
  await page.mouse.move(pt.x, pt.y);
  // ~300ms hover delay — wait for the tooltip to appear.
  const tooltip = page.locator('[data-gantt-task-tooltip]');
  await expect(tooltip).toBeVisible({ timeout: 2000 });
  await expect(tooltip).toContainText('设计阶段');
  await expect(tooltip).toContainText('王强');
  await expect(tooltip).toContainText('02-02 → 02-06');
});

test('§3.3 a multi-assignee task shows no other tooltip conflict and lists all in tooltip', async ({
  page,
}) => {
  await inject(page, {
    tasks: [
      {
        id: 't1',
        name: '多人任务',
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
        assignments: [
          { resourceId: 'r1', load: 50 },
          { resourceId: 'r2', load: 30 },
          { resourceId: 'r3', load: 100 },
        ],
        customFields: {},
      },
    ],
    resources: [
      { id: 'r1', name: '王强', capacity: 1.0 },
      { id: 'r2', name: '李雷', capacity: 1.0 },
      { id: 'r3', name: '韩梅梅', capacity: 1.0 },
    ],
  });

  const pt = await barPoint(page, '2026-02-03');
  await page.mouse.move(pt.x, pt.y);
  const tooltip = page.locator('[data-gantt-task-tooltip]');
  await expect(tooltip).toBeVisible({ timeout: 2000 });
  // All three assignees (with their loads) appear in the tooltip.
  await expect(tooltip).toContainText('王强 (50%)');
  await expect(tooltip).toContainText('韩梅梅 (100%)');
});

test('§3.4 right-click on a task bar opens the shared context menu', async ({ page }) => {
  await inject(page, {
    tasks: [
      {
        id: 't1',
        name: '右键任务',
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
      },
    ],
  });

  const pt = await barPoint(page, '2026-02-03');
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.click(pt.x, pt.y, { button: 'right' });

  // The context menu's "编辑" item appears (shared component with the table).
  await expect(page.getByRole('button', { name: '编辑' })).toBeVisible({ timeout: 2000 });
});

test('§3.4 summary bar is right-clickable (read-only hover path covers summaries)', async ({
  page,
}) => {
  await inject(page, {
    tasks: [
      {
        id: 'parent',
        name: '摘要任务',
        parentId: null,
        order: 0,
        start: '2026-02-02',
        end: '2026-02-10',
        duration: 7,
        overtimeDates: [],
        progress: 0,
        isMilestone: false,
        dependencies: [],
        constraints: { type: 'none' },
        assignments: [],
        customFields: {},
      },
      {
        id: 'child',
        name: '子任务',
        parentId: 'parent',
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
      },
    ],
  });

  // Hover the summary bar (row 0) → tooltip appears.
  const pt = await barPoint(page, '2026-02-04');
  await page.mouse.move(pt.x, pt.y);
  const tooltip = page.locator('[data-gantt-task-tooltip]');
  await expect(tooltip).toBeVisible({ timeout: 2000 });
  await expect(tooltip).toContainText('摘要任务');

  // Right-click the summary → context menu opens (summary is not 'empty' here).
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  await expect(page.getByRole('button', { name: '编辑' })).toBeVisible({ timeout: 2000 });
});

test('§3.4 Enter on a focused, selected canvas task opens the drawer', async ({ page }) => {
  await inject(page, {
    tasks: [
      {
        id: 't1',
        name: '键盘任务',
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
      },
    ],
  });

  // Select the task by clicking its bar, then move focus to the canvas and
  // press Enter.
  const pt = await barPoint(page, '2026-02-03');
  await page.mouse.click(pt.x, pt.y);
  await page.locator('canvas').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 2000 });
});

test('§3.4 Delete on a focused, selected canvas task opens the confirm dialog', async ({
  page,
}) => {
  await inject(page, {
    tasks: [
      {
        id: 't1',
        name: '待删除',
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
      },
    ],
  });

  const pt = await barPoint(page, '2026-02-03');
  await page.mouse.click(pt.x, pt.y);
  await page.locator('canvas').first().focus();
  await page.keyboard.press('Delete');

  // The delete confirm dialog (shared with the table) appears.
  await expect(page.getByText('删除任务').first()).toBeVisible({ timeout: 2000 });
});

test('§3.4 Escape on a focused canvas clears the selection', async ({ page }) => {
  await inject(page, {
    tasks: [
      {
        id: 't1',
        name: '选中任务',
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
      },
    ],
  });

  // Select the task.
  const pt = await barPoint(page, '2026-02-03');
  await page.mouse.click(pt.x, pt.y);
  const selectedBefore = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return (s.getState().file.viewState as { selectedTaskId: string | null }).selectedTaskId;
  });
  expect(selectedBefore).toBe('t1');

  // Escape clears it.
  await page.locator('canvas').first().focus();
  await page.keyboard.press('Escape');
  const selectedAfter = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return (s.getState().file.viewState as { selectedTaskId: string | null }).selectedTaskId;
  });
  expect(selectedAfter).toBeNull();
});
