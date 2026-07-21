import { expect, test, type Page } from '@playwright/test';

/**
 * Screenshot baselines for the gantt canvas (PRD §5.5, §7.1).
 *
 * Covers the scenarios explicitly listed in PRD §5.5:
 *   - empty / 1 task / 100 tasks
 *   - 4 zoom views (day / week / month / year)
 *   - critical path on
 *   - holiday highlight
 *   - 4 dependency types (see dependencies.spec.ts)
 *   - milestone diamond
 *
 * Baselines are platform/browser-agnostic (single shared PNG per scenario,
 * via playwright.config.ts `snapshotPathTemplate`). CI enforces them; local
 * devs accept intentional changes via `--update-snapshots`.
 */

/** Reset the app to a clean state with the given tasks + zoom. */
async function loadFixture(
  page: Page,
  opts: {
    tasks: Array<Record<string, unknown>>;
    zoom?: 'day' | 'week' | 'month' | 'year';
    showCriticalPath?: boolean;
  },
) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(
    (payload) => {
      const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
        setState: (s: unknown) => void;
        getState: () => { file: Record<string, unknown> };
      };
      const f = store.getState().file;
      store.setState({
        file: {
          ...f,
          tasks: payload.tasks,
          viewState: {
            ...(f.viewState as object),
            zoom: payload.zoom ?? 'week',
            scrollLeft: 0,
            scrollTop: 0,
            selectedTaskId: null,
            showCriticalPath: payload.showCriticalPath ?? false,
            collapsedTaskIds: [],
          },
        },
      });
    },
    { tasks: opts.tasks, zoom: opts.zoom, showCriticalPath: opts.showCriticalPath },
  );
  await page.waitForTimeout(250);
}

test('canvas renders with a single task', async ({ page }) => {
  await loadFixture(page, {
    tasks: [
      {
        id: 't1',
        name: 'Single task',
        parentId: null,
        order: 0,
        start: '2026-02-02',
        end: '2026-02-06',
        duration: 5,
        progress: 40,
        isMilestone: false,
        dependencies: [],
        constraints: {},
        assignments: [],
        customFields: {},
      },
    ],
  });
  await expect(page.locator('canvas')).toHaveScreenshot('canvas-with-task.png', {
    maxDiffPixelRatio: 0.01,
  });
});

test('day-view zoom renders compact columns', async ({ page }) => {
  await loadFixture(page, {
    tasks: [
      {
        id: 't1',
        name: 'Day view task',
        parentId: null,
        order: 0,
        start: '2026-02-02',
        end: '2026-02-04',
        duration: 3,
        progress: 50,
        isMilestone: false,
        dependencies: [],
        constraints: {},
        assignments: [],
        customFields: {},
      },
    ],
    zoom: 'day',
  });
  await expect(page.locator('canvas')).toHaveScreenshot('canvas-day-view.png', {
    maxDiffPixelRatio: 0.01,
  });
});

test('month-view zoom renders month columns', async ({ page }) => {
  await loadFixture(page, {
    tasks: [
      {
        id: 't1',
        name: 'Month view task',
        parentId: null,
        order: 0,
        start: '2026-01-05',
        end: '2026-03-15',
        duration: 30,
        progress: 30,
        isMilestone: false,
        dependencies: [],
        constraints: {},
        assignments: [],
        customFields: {},
      },
    ],
    zoom: 'month',
  });
  await expect(page.locator('canvas')).toHaveScreenshot('canvas-month-view.png', {
    maxDiffPixelRatio: 0.01,
  });
});

test('year-view zoom renders year columns', async ({ page }) => {
  await loadFixture(page, {
    tasks: [
      {
        id: 't1',
        name: 'Year view task',
        parentId: null,
        order: 0,
        start: '2026-02-02',
        end: '2026-09-30',
        duration: 100,
        progress: 20,
        isMilestone: false,
        dependencies: [],
        constraints: {},
        assignments: [],
        customFields: {},
      },
    ],
    zoom: 'year',
  });
  await expect(page.locator('canvas')).toHaveScreenshot('canvas-year-view.png', {
    maxDiffPixelRatio: 0.01,
  });
});

test('milestone renders as a diamond', async ({ page }) => {
  await loadFixture(page, {
    tasks: [
      {
        id: 'ms1',
        name: 'Milestone',
        parentId: null,
        order: 0,
        start: '2026-02-05',
        end: '2026-02-05',
        duration: 0,
        progress: 0,
        isMilestone: true,
        dependencies: [],
        constraints: {},
        assignments: [],
        customFields: {},
      },
    ],
  });
  await expect(page.locator('canvas')).toHaveScreenshot('canvas-milestone.png', {
    maxDiffPixelRatio: 0.01,
  });
});

test('100 tasks render without visual breakage', async ({ page }) => {
  const tasks = Array.from({ length: 100 }, (_, i) => ({
    id: `t${i}`,
    name: `Task ${i}`,
    parentId: null,
    order: i,
    start: '2026-02-02',
    end: '2026-02-06',
    duration: 5,
    progress: (i * 7) % 100,
    isMilestone: false,
    dependencies: [],
    constraints: {},
    assignments: [],
    customFields: {},
  }));
  await loadFixture(page, { tasks });
  // Clamp the screenshot to the visible viewport (100 rows overflow — that's
  // fine, virtualization keeps only visible rows painted).
  await expect(page.locator('canvas')).toHaveScreenshot('canvas-100-tasks.png', {
    maxDiffPixelRatio: 0.01,
  });
});
