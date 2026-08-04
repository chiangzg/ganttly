import { expect, test, type Page } from '@playwright/test';

/**
 * Context-menu keyboard & accessibility E2E (editor-interaction-optimization-plan §5.4).
 *
 * Covers:
 *  - Escape closes the menu (was previously impossible — only overlay clicks)
 *  - ArrowUp/ArrowDown move focus between items; Enter activates the focused item
 *  - inapplicable actions are visibly disabled: a lone root task cannot move
 *    up/down, indent, or outdent (§5.4: no silent no-ops)
 *  - the menu is clamped inside the viewport when opened near the right/bottom
 *    edge (§5.4: 右下角任务打开菜单时不越出屏幕)
 *  - the menu's indent/outdent uses the rollup-aware command, so a menu-driven
 *    demote recomputes the parent summary (fixes the divergent command bug)
 *  - focus returns to the triggering row after the menu closes (§5.4)
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
  progress: number;
  isMilestone: boolean;
  dependencies: Array<{ targetId: string; type: 'FS' | 'SS' | 'FF' | 'SF'; lag: number }>;
  constraints: Record<string, unknown>;
  assignments: Array<{ resourceId: string; load: number }>;
  customFields: Record<string, unknown>;
}

interface StoreApi {
  getState: () => {
    file: {
      tasks: TaskShape[];
      viewState: { selectedTaskId: string | null; collapsedTaskIds: string[] };
    };
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}

function makeTask(id: string, overrides: Partial<TaskShape> = {}): TaskShape {
  return {
    id,
    name: id,
    parentId: null,
    order: 0,
    start: '2026-01-05',
    end: '2026-01-06',
    duration: 2,
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

async function openMenuOnRow(page: Page, taskId: string): Promise<void> {
  const row = page.locator(`[data-task-id="${taskId}"]`);
  await row.click({ button: 'right' });
  const menu = page.locator('.fixed.z-30').last();
  await expect(menu).toBeVisible({ timeout: 3000 });
}

test.describe('§5.4 context menu keyboard & accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.waitForTimeout(400);
  });

  test('Escape closes the menu', async ({ page }) => {
    await injectTasks(page, [makeTask('a')]);
    await openMenuOnRow(page, 'a');

    await page.keyboard.press('Escape');
    await expect(page.locator('.fixed.z-30').last()).toHaveCount(0);
  });

  test('arrow keys navigate and Enter activates the focused item', async ({ page }) => {
    await injectTasks(page, [makeTask('a')]);
    await openMenuOnRow(page, 'a');
    const menu = page.locator('.fixed.z-30').last();

    // Opening focuses the first item (编辑). ArrowDown → 复制, Enter → copy.
    await page.keyboard.press('ArrowDown');
    const focusedText = await page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? '',
    );
    // Shortcut hint format is `${mod}+C` (⌘+C on macOS, Ctrl+C elsewhere).
    expect(focusedText).toContain('复制');
    expect(focusedText).toContain('+C');

    await page.keyboard.press('Enter');
    await expect(menu).toHaveCount(0); // copy closes the menu
    const clipHas = await page.evaluate(() => {
      // Clipboard is module state; the paste item's disabled state reflects it.
      const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      return store.getState().file.tasks.length;
    });
    expect(clipHas).toBe(1); // copy is non-destructive
  });

  test('inapplicable actions are disabled (lone root: no move/indent/outdent)', async ({
    page,
  }) => {
    await injectTasks(page, [makeTask('a')]);
    await openMenuOnRow(page, 'a');
    const menu = page.locator('.fixed.z-30').last();

    await expect(menu.locator('button', { hasText: '上移' })).toBeDisabled();
    await expect(menu.locator('button', { hasText: '下移' })).toBeDisabled();
    await expect(menu.locator('button', { hasText: '降级' })).toBeDisabled();
    await expect(menu.locator('button', { hasText: '升级' })).toBeDisabled();
    // Applicable actions stay enabled.
    await expect(menu.locator('button', { hasText: '编辑' }).first()).toBeEnabled();
    await expect(menu.locator('button', { hasText: '删除' })).toBeEnabled();
  });

  test('middle sibling: move up/down enabled, outdent disabled', async ({ page }) => {
    await injectTasks(page, [
      makeTask('a', { order: 0 }),
      makeTask('b', { order: 1 }),
      makeTask('c', { order: 2 }),
    ]);
    await openMenuOnRow(page, 'b');
    const menu = page.locator('.fixed.z-30').last();

    await expect(menu.locator('button', { hasText: '上移' })).toBeEnabled();
    await expect(menu.locator('button', { hasText: '下移' })).toBeEnabled();
    // b is a root — promote (升级) is still impossible.
    await expect(menu.locator('button', { hasText: '升级' })).toBeDisabled();
    // b has a previous sibling → demote (降级) is possible.
    await expect(menu.locator('button', { hasText: '降级' })).toBeEnabled();
  });

  test('menu does not overflow the viewport near the right/bottom edge', async ({ page }) => {
    // A short viewport + many tasks puts the LAST row's bar near the canvas
    // bottom edge. Right-clicking it opens the menu at a Y that would overflow
    // the window; the §5.4 clamp must pull it back inside.
    await page.setViewportSize({ width: 1280, height: 500 });
    await page.goto('/');
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.waitForTimeout(400);

    const N = 11;
    await injectTasks(
      page,
      Array.from({ length: N }, (_, i) => makeTask(`t${i}`, { order: i, start: '2026-01-05' })),
    );

    const canvas = page.locator('[data-gantt-chart] canvas').first();
    const box = (await canvas.boundingBox())!;
    // Click the SECOND-TO-LAST row (the last row's center falls under the
    // 12px bottom horizontal-scroll shim). Row center y (canvas-relative):
    // HEADER_HEIGHT(40) + (N-2)*ROW_HEIGHT(32) + 16 ≈ 344, still ~39px above
    // the canvas bottom yet low enough that the raw menu position (opened at
    // clientY ≈ 92 + 344 = 436, menu ≈ 320px tall) overflows the 500px window.
    const rowCenterY = 40 + (N - 2) * 32 + 16;
    expect(rowCenterY).toBeGreaterThan(0);
    expect(rowCenterY + 16).toBeLessThan(box.height - 12); // clear of the shim
    await canvas.click({
      button: 'right',
      position: { x: 12, y: rowCenterY },
    });

    const menu = page.locator('.fixed.z-30').last();
    await expect(menu).toBeVisible({ timeout: 3000 });

    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(1280);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(500);
  });

  test('menu demote recomputes the parent summary (rollup-aware command)', async ({ page }) => {
    // parent p has two leaves a (40%) and b (80%). Demoting b via the menu
    // makes it a child of a. a becomes a summary (rollup = 80 from b), and p's
    // summary must be recomputed to a's rolled-up value (80), NOT left stale.
    await injectTasks(page, [
      makeTask('p', { order: 0, progress: 0 }),
      makeTask('a', { parentId: 'p', order: 0, progress: 40 }),
      makeTask('b', { parentId: 'p', order: 1, progress: 80 }),
    ]);
    await openMenuOnRow(page, 'b');
    const menu = page.locator('.fixed.z-30').last();

    await menu.locator('button', { hasText: '降级' }).click();

    const pProgress = await page.evaluate(() => {
      const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      const t = store.getState().file.tasks.find((x) => x.id === 'p');
      return t?.progress;
    });
    // b became a child of a → p's only child is a (summary, 80 from b).
    expect(pProgress).toBe(80);

    const bParent = await page.evaluate(() => {
      const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      const t = store.getState().file.tasks.find((x) => x.id === 'b');
      return t?.parentId;
    });
    expect(bParent).toBe('a');
  });

  test('focus returns to the triggering row after close', async ({ page }) => {
    await injectTasks(page, [makeTask('a')]);
    const row = page.locator('[data-task-id="a"]');
    await row.click({ button: 'right' });
    await expect(page.locator('.fixed.z-30').last()).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');

    const activeId = await page.evaluate(
      () => document.activeElement?.getAttribute('data-task-id') ?? null,
    );
    expect(activeId).toBe('a');
  });
});
