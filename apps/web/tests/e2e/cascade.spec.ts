import { expect, test, type Page } from '@playwright/test';

/**
 * Dependency cascade E2E (P1 feature three — E1.5, G16/G15).
 *
 * Verifies the end-to-end cascade behavior:
 * 1. Dragging a predecessor task bar reschedules its FS successor automatically.
 * 2. Undo restores BOTH tasks atomically (the cascade patch + the drag).
 *
 * This is the user-visible proof that the cascade engine (cascadeSchedule) is
 * wired into the drag commit path (updateTaskWithRollupCommand) and that undo
 * captures the full successor set (G15: generalized applyPatchAndCapture).
 */

const HEADER_HEIGHT = 56;
const ROW_HEIGHT = 32;

/** Inject two tasks with an FS dependency: pred → succ. */
async function injectCascadeFixture(page: Page) {
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    // pred ends 1/9; succ (FS, lag 0) must start the next working day = 1/12.
    // Both placed at 1/5..1/9 initially so the dependency is "violated" until cascade.
    store.setState({
      file: {
        ...f,
        tasks: [
          {
            id: 'pred',
            name: '前置任务',
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
          },
          {
            id: 'succ',
            name: '后继任务',
            parentId: null,
            order: 1,
            start: '2026-01-12',
            end: '2026-01-16',
            duration: 5,
            progress: 0,
            isMilestone: false,
            // FS dependency on pred — already satisfied (succ.start 1/12 >= implied 1/12).
            dependencies: [{ targetId: 'pred', type: 'FS', lag: 0 }],
            constraints: { type: 'none' },
            assignments: [],
            customFields: {},
          },
        ],
        viewState: {
          zoom: 'week',
          scrollLeft: 0,
          scrollTop: 0,
          selectedTaskId: 'pred',
          showCriticalPath: false,
          collapsedTaskIds: [],
        },
      },
    });
  });
  await page.waitForTimeout(150);
}

/** Read a task's start from the store. */
async function readStart(page: Page, id: string): Promise<string | null> {
  return page.evaluate((taskId) => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => { file: { tasks: Array<{ id: string; start: string }> } };
    };
    const t = store.getState().file.tasks.find((x) => x.id === taskId);
    return t ? t.start : null;
  }, id);
}

/** Viewport-local x for a date in week zoom (origin = earliest task / 2026-01-05). */
async function dateToViewportX(page: Page, isoDate: string): Promise<number> {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const xLocal = await page.evaluate((date) => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => {
        file: {
          tasks: Array<{ start: string }>;
          project: { startDate?: string };
          viewState: { scrollLeft: number };
        };
      };
    };
    const f = store.getState().file;
    const fallback = f.project.startDate ?? '2026-01-05';
    const earliest = f.tasks.reduce((m, t) => (t.start < m ? t.start : m), f.tasks[0]!.start);
    const origin = earliest < fallback ? earliest : fallback;
    const dayDelta = (Date.parse(date) - Date.parse(origin)) / 86_400_000;
    return Math.round(dayDelta) * (140 / 7) - f.viewState.scrollLeft;
  }, isoDate);
  return box.x + xLocal;
}

test.describe('dependency cascade', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.waitForTimeout(300);
    await injectCascadeFixture(page);
  });

  test('dragging a predecessor reschedules its FS successor', async ({ page }) => {
    // Sanity: succ starts at 1/12 (dep satisfied).
    expect(await readStart(page, 'succ')).toBe('2026-01-12');

    // Drag the predecessor body ~2 weeks right (14 days × 20px/day = 280px).
    // pred was 1/5..1/9; after +14 days it lands ~1/19..1/23. succ must follow.
    const startX = await dateToViewportX(page, '2026-01-06');
    const y = HEADER_HEIGHT + ROW_HEIGHT / 2;
    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    const DX = 280; // 14 days in week zoom
    await page.mouse.move(startX, box.y + y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(startX + (DX * i) / 5, box.y + y, { steps: 1 });
      await page.waitForTimeout(20);
    }
    await page.mouse.up();

    // pred moved; succ must have cascaded to a LATER date than its original 1/12.
    const succAfter = await readStart(page, 'succ');
    expect(succAfter, 'successor must reschedule after predecessor drag').not.toBe('2026-01-12');
    // It should be strictly later (cascade pushes it forward).
    expect(succAfter! > '2026-01-12').toBe(true);
  });

  test('undo restores both predecessor and successor atomically', async ({ page }) => {
    const startX = await dateToViewportX(page, '2026-01-06');
    const y = HEADER_HEIGHT + ROW_HEIGHT / 2;
    const canvas = page.locator('canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas has no bounding box');
    const DX = 280;
    await page.mouse.move(startX, box.y + y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(startX + (DX * i) / 5, box.y + y, { steps: 1 });
      await page.waitForTimeout(20);
    }
    await page.mouse.up();

    // Confirm both moved.
    const predMoved = await readStart(page, 'pred');
    const succMoved = await readStart(page, 'succ');
    expect(predMoved).not.toBe('2026-01-05');
    expect(succMoved).not.toBe('2026-01-12');

    // Undo — both must restore together (G15 atomic rollback).
    await page.getByRole('button', { name: /撤销/ }).click();
    expect(await readStart(page, 'pred')).toBe('2026-01-05');
    expect(await readStart(page, 'succ')).toBe('2026-01-12');
  });
});
