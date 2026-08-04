import { expect, test, type Page } from '@playwright/test';

/**
 * Resource Canvas info & interaction E2E
 * (editor-interaction-optimization-plan §3.5 / §3.6 / §5.3).
 *
 * Verifies:
 *  - §3.5 hovering a daily load bar shows a tooltip with load %, capacity %
 *    and overload status (with an explicit number, not color only).
 *  - §3.5 hovering a drilled-down task lane shows the task name + load %.
 *  - §3.6 clicking a load bar selects the resource; clicking a task lane
 *    selects the lane; clicking empty space clears selection.
 *  - §3.6 double-clicking a task lane opens the task drawer.
 *  - §5.3 the legend (within-capacity / overload / capacity line) renders.
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

interface ViewStoreApi {
  getState: () => {
    selectedResourceId: string | null;
    selectedTaskIdInResource: string | null;
  };
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
          // Pin project start to the task start for a deterministic chart origin.
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
  // Switch to the resource view.
  await page.getByRole('button', { name: '资源视图' }).click();
  await page.waitForTimeout(150);
}

/**
 * Viewport (x, y) over a daily load bar for `resourceRowIndex` at `isoDate`.
 * Mirrors the renderer: origin = min(earliest task, project.startDate); week
 * zoom = 140/7 px/day. The resource row pitch matches the canvas layout.
 */
async function dayBarPoint(
  page: Page,
  isoDate: string,
  resourceRowIndex = 0,
): Promise<{ x: number; y: number }> {
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
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
    // Center of the day column (week zoom = 20px/day).
    return Math.round(dayDelta) * (140 / 7) + 10;
  }, isoDate);
  return {
    x: box.x + xLocal,
    y: box.y + HEADER_HEIGHT + resourceRowIndex * ROW_HEIGHT + ROW_HEIGHT / 2,
  };
}

/**
 * Viewport (x, y) over a drilled-down task lane at a given ISO date. The lane
 * sits below its resource row + a task-header row, so its yIndex =
 * resourceIndex + 1 (header) + laneOffset.
 */
async function lanePoint(
  page: Page,
  isoDate: string,
  resourceIndex: number,
  laneOffset: number,
): Promise<{ x: number; y: number }> {
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
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
    return Math.round(dayDelta) * (140 / 7) + 10;
  }, isoDate);
  // yIndex layout under an expanded resource at resourceIndex:
  //   resourceIndex          → the resource row itself
  //   resourceIndex + 1      → the local task-header row
  //   resourceIndex + 2 + i  → the i-th task lane (laneOffset)
  const yIndex = resourceIndex + 2 + laneOffset;
  return {
    x: box.x + xLocal,
    y: box.y + HEADER_HEIGHT + yIndex * ROW_HEIGHT + ROW_HEIGHT / 2,
  };
}

async function readResourceSelection(page: Page) {
  return page.evaluate(() => {
    const v = (window as unknown as { __ganttlyViewStore?: unknown })
      .__ganttlyViewStore as ViewStoreApi;
    return v.getState();
  });
}

test.describe('resource canvas info & interaction', () => {
  test('§5.3 the legend renders with capacity/overload labels', async ({ page }) => {
    await inject(page, {
      tasks: [],
      resources: [{ id: 'r1', name: 'Alice', capacity: 1.0 }],
    });
    // The legend is an element with role="note" and the legend aria-label.
    const legend = page.getByRole('note', { name: '负载图例' });
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('容量内');
    await expect(legend).toContainText('超载');
    await expect(legend).toContainText('容量线');
  });

  test('§3.5 hovering a load bar shows load %, capacity % and within-capacity status', async ({
    page,
  }) => {
    await inject(page, {
      tasks: [
        {
          id: 't1',
          name: '设计',
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
          assignments: [{ resourceId: 'r1', load: 80 }],
          customFields: {},
        },
      ],
      resources: [{ id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' }],
    });
    const pt = await dayBarPoint(page, '2026-02-03', 0);
    await page.mouse.move(pt.x, pt.y);
    const tooltip = page.locator('[data-gantt-resource-tooltip]');
    await expect(tooltip).toBeVisible({ timeout: 2000 });
    await expect(tooltip).toContainText('Alice');
    await expect(tooltip).toContainText('80%'); // load
    await expect(tooltip).toContainText('100%'); // capacity
    await expect(tooltip).toContainText('容量内'); // within-capacity status
    // Contributing task is listed.
    await expect(tooltip).toContainText('设计');
  });

  test('§3.5 an overloaded day shows the overload status with an excess number', async ({
    page,
  }) => {
    // Two tasks each at 80% on the same day → 160% load, capacity 100% → overload +60%.
    await inject(page, {
      tasks: [
        {
          id: 't1',
          name: '任务一',
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
          assignments: [{ resourceId: 'r1', load: 80 }],
          customFields: {},
        },
        {
          id: 't2',
          name: '任务二',
          parentId: null,
          order: 1,
          start: '2026-02-02',
          end: '2026-02-06',
          duration: 5,
          overtimeDates: [],
          progress: 0,
          isMilestone: false,
          dependencies: [],
          constraints: { type: 'none' },
          assignments: [{ resourceId: 'r1', load: 80 }],
          customFields: {},
        },
      ],
      resources: [{ id: 'r1', name: 'Alice', capacity: 1.0 }],
    });
    const pt = await dayBarPoint(page, '2026-02-03', 0);
    await page.mouse.move(pt.x, pt.y);
    const tooltip = page.locator('[data-gantt-resource-tooltip]');
    await expect(tooltip).toBeVisible({ timeout: 2000 });
    await expect(tooltip).toContainText('160%'); // combined load
    // Overload status with an explicit excess (+60%).
    await expect(tooltip).toContainText('超载 +60%');
  });

  test('§3.6 clicking a load bar selects the resource', async ({ page }) => {
    await inject(page, {
      tasks: [
        {
          id: 't1',
          name: '设计',
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
          assignments: [{ resourceId: 'r1', load: 80 }],
          customFields: {},
        },
      ],
      resources: [
        { id: 'r1', name: 'Alice', capacity: 1.0 },
        { id: 'r2', name: 'Bob', capacity: 1.0 },
      ],
    });
    const pt = await dayBarPoint(page, '2026-02-03', 0);
    await page.mouse.click(pt.x, pt.y);
    await expect
      .poll(() => readResourceSelection(page).then((s) => s.selectedResourceId))
      .toBe('r1');
  });

  test('§3.6 clicking empty space clears the selection', async ({ page }) => {
    await inject(page, {
      tasks: [
        {
          id: 't1',
          name: '设计',
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
          assignments: [{ resourceId: 'r1', load: 80 }],
          customFields: {},
        },
      ],
      resources: [{ id: 'r1', name: 'Alice', capacity: 1.0 }],
    });
    // First select the resource via a load bar click.
    const pt = await dayBarPoint(page, '2026-02-03', 0);
    await page.mouse.click(pt.x, pt.y);
    await expect
      .poll(() => readResourceSelection(page).then((s) => s.selectedResourceId))
      .toBe('r1');
    // Now click far to the right of any bar (empty date column, same row).
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    await page.mouse.click(box!.x + box!.width - 20, box!.y + HEADER_HEIGHT + ROW_HEIGHT / 2);
    await expect
      .poll(() => readResourceSelection(page).then((s) => s.selectedResourceId))
      .toBeNull();
  });

  test('§3.6 clicking a drilled-down task lane selects the lane', async ({ page }) => {
    await inject(page, {
      tasks: [
        {
          id: 't1',
          name: '设计',
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
          assignments: [{ resourceId: 'r1', load: 80 }],
          customFields: {},
        },
      ],
      resources: [{ id: 'r1', name: 'Alice', capacity: 1.0 }],
    });
    // Expand Alice to reveal the task lane.
    const aliceRow = page
      .locator('[role="row"]')
      .filter({ has: page.locator('input[value="Alice"]') });
    await aliceRow.locator('button', { hasText: '▶' }).click();
    await page.waitForTimeout(100);
    // Lane sits at resourceIndex 0 + header(1) + laneOffset 0.
    const pt = await lanePoint(page, '2026-02-04', 0, 0);
    await page.mouse.click(pt.x, pt.y);
    await expect
      .poll(() => readResourceSelection(page).then((s) => s.selectedTaskIdInResource))
      .toBe('t1');
  });

  test('§3.6 double-clicking a task lane opens the drawer', async ({ page }) => {
    await inject(page, {
      tasks: [
        {
          id: 't1',
          name: '设计',
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
          assignments: [{ resourceId: 'r1', load: 80 }],
          customFields: {},
        },
      ],
      resources: [{ id: 'r1', name: 'Alice', capacity: 1.0 }],
    });
    const aliceRow = page
      .locator('[role="row"]')
      .filter({ has: page.locator('input[value="Alice"]') });
    await aliceRow.locator('button', { hasText: '▶' }).click();
    await page.waitForTimeout(100);
    const pt = await lanePoint(page, '2026-02-04', 0, 0);
    await page.mouse.click(pt.x, pt.y, { clickCount: 2 });
    // The drawer header reads "编辑任务".
    await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 2000 });
  });

  test('§3.5 hovering a drilled-down task lane shows the task name + load', async ({ page }) => {
    await inject(page, {
      tasks: [
        {
          id: 't1',
          name: '设计',
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
      resources: [{ id: 'r1', name: 'Alice', capacity: 1.0 }],
    });
    const aliceRow = page
      .locator('[role="row"]')
      .filter({ has: page.locator('input[value="Alice"]') });
    await aliceRow.locator('button', { hasText: '▶' }).click();
    await page.waitForTimeout(100);
    const pt = await lanePoint(page, '2026-02-04', 0, 0);
    await page.mouse.move(pt.x, pt.y);
    const tooltip = page.locator('[data-gantt-resource-tooltip]');
    await expect(tooltip).toBeVisible({ timeout: 2000 });
    await expect(tooltip).toContainText('设计');
    await expect(tooltip).toContainText('80%'); // load
    await expect(tooltip).toContainText('40%'); // progress
  });
});
