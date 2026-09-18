import { expect, test, type Page } from '@playwright/test';

/**
 * Dependency-chain highlight E2E (dependency-chain spec §2/§7).
 *
 * Seeds a 3-task chain A → B → C plus an unrelated island X → Y, clicks B's
 * bar with the real mouse (canvas hit-test → selectSingle → chain), and
 * asserts:
 *  - the legend pill appears with the right counts;
 *  - the canvas exposes data-dep-pulse="on" while downstream pulses run, and
 *    "off" under prefers-reduced-motion (static dashes, no rAF loop);
 *  - clicking empty canvas clears the highlight; ctrl-multi-select hides it.
 *
 * The screenshot baseline runs under emulateMedia({ reducedMotion: 'reduce' })
 * so the render is fully deterministic (no dash offset, no traveling pulse).
 */
const HEADER_HEIGHT = 56;
const ROW_HEIGHT = 32;

async function injectChain(page: Page) {
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    const base = {
      parentId: null,
      progress: 0,
      isMilestone: false,
      constraints: { type: 'none' },
      assignments: [],
      customFields: {},
    };
    const tasks = [
      {
        ...base,
        id: 'A',
        name: '前置 A',
        order: 0,
        start: '2026-01-05',
        end: '2026-01-09',
        duration: 5,
        dependencies: [],
      },
      {
        ...base,
        id: 'B',
        name: '链路源 B',
        order: 1,
        start: '2026-01-12',
        end: '2026-01-16',
        duration: 5,
        dependencies: [{ targetId: 'A', type: 'FS', lag: 0 }],
      },
      {
        ...base,
        id: 'C',
        name: '后续 C',
        order: 2,
        start: '2026-01-19',
        end: '2026-01-23',
        duration: 5,
        dependencies: [{ targetId: 'B', type: 'FS', lag: 0 }],
      },
      {
        ...base,
        id: 'X',
        name: '无关 X',
        order: 3,
        start: '2026-01-05',
        end: '2026-01-09',
        duration: 5,
        dependencies: [],
      },
      {
        ...base,
        id: 'Y',
        name: '无关 Y',
        order: 4,
        start: '2026-01-12',
        end: '2026-01-16',
        duration: 5,
        dependencies: [{ targetId: 'X', type: 'FS', lag: 0 }],
      },
    ];
    store.setState({
      file: {
        ...f,
        tasks,
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
  });
  await page.waitForTimeout(150);
}

/** Canvas-local X of a date (week zoom), mirroring originDateFor + dateToPixel. */
async function dateToLocalX(page: Page, isoDate: string): Promise<number> {
  return page.evaluate((date) => {
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
    const earliest = f.tasks.length
      ? f.tasks.reduce((m, t) => (t.start < m ? t.start : m), f.tasks[0]!.start)
      : fallback;
    const origin = earliest < fallback ? earliest : fallback;
    const dayDelta = (Date.parse(date) - Date.parse(origin)) / 86_400_000;
    return Math.round(dayDelta) * (140 / 7) - f.viewState.scrollLeft;
  }, isoDate);
}

/** Viewport point of a date at the vertical center of `row` (week zoom). */
async function pointAt(
  page: Page,
  isoDate: string,
  row: number,
): Promise<{ x: number; y: number }> {
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const xLocal = await dateToLocalX(page, isoDate);
  return { x: box.x + xLocal, y: box.y + HEADER_HEIGHT + (row + 0.5) * ROW_HEIGHT };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(300);
  await injectChain(page);
});

test('clicking a task highlights the dependency chain (static, reduced motion)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // Click B's bar (row 1, mid-bar date).
  const b = await pointAt(page, '2026-01-13', 1);
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(300);

  // Legend pill with upstream/downstream counts (zh locale).
  await expect(page.getByTestId('dep-chain-legend')).toBeVisible();
  await expect(page.getByTestId('dep-chain-legend')).toContainText('1 个前置 · 1 个后续');
  // Reduced motion → no rAF pulse loop.
  await expect(page.locator('canvas')).toHaveAttribute('data-dep-pulse', 'off');

  // Move the pointer off the bars so the hover tooltip doesn't enter the shot.
  await page.mouse.move(700, 420);
  await page.waitForTimeout(450);
  await expect(page.locator('canvas')).toHaveScreenshot('canvas-dep-chain-static.png', {
    maxDiffPixelRatio: 0.01,
  });
});

test('pulse loop runs without reduced motion; empty click and multi-select clear it', async ({
  page,
}) => {
  const b = await pointAt(page, '2026-01-13', 1);
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(300);

  await expect(page.getByTestId('dep-chain-legend')).toBeVisible();
  await expect(page.locator('canvas')).toHaveAttribute('data-dep-pulse', 'on');

  // ⌘/Ctrl-click C → multi-select (2 ids) → chain hidden, pulse stops. Done on
  // the left table row (same select() store path as the canvas modifier
  // branch). NOTE: must use Meta, not Control — on macOS Chromium synthesizes a
  // contextmenu event from Ctrl+click (onContextMenu → selectSingle), so the
  // multi-select branch never runs. The canvas modifier-gesture itself is
  // covered by multi-select.spec.ts.
  await page.locator('[data-task-id="C"]').click({ modifiers: ['Meta'] });
  await page.waitForTimeout(300);
  await expect(page.getByTestId('dep-chain-legend')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveAttribute('data-dep-pulse', 'off');

  // Back to single selection, then click empty canvas → selection cleared.
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(200);
  await expect(page.getByTestId('dep-chain-legend')).toBeVisible();
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box!.x + 700, box!.y + 420); // empty area below rows
  await page.waitForTimeout(300);
  await expect(page.getByTestId('dep-chain-legend')).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-dep-pulse', 'off');
});
