import { expect, test, type Page } from '@playwright/test';

/**
 * Resource-list interaction regressions (modernized panel).
 *
 * Locks in the patterns ported from the task tree:
 *  - zero layout shift on hover (grip fades in inside its reserved slot)
 *  - F2/Tab/Enter/Escape inline editing — ONE updateResourceCommand per
 *    committed edit (the old always-on inputs polluted undo per keystroke)
 *  - double-click row = expand/collapse drill-down; collapsed rows carry a
 *    task-count chip
 *  - context menu (重命名 F2 / 展开收起 / 新增 / 删除) and the Delete key
 *  - grip-only drag reorder — a single moveResourceCommand, one undo entry
 *  - header expand-all / collapse-all + treegrid aria
 */

interface StoreApi {
  getState: () => {
    file: {
      resources: Array<{ id: string; name: string; role: string | null; capacity: number }>;
    };
    undoStack: Array<{ label: string }>;
    undo: () => void;
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}

const ROW_HEIGHT = 32;

/** Three resources; Alice owns two leaf tasks, Bob one, Carol none. */
async function inject(page: Page) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as StoreApi;
    const f = store.getState().file;
    const task = (id: string, name: string, resourceId: string, order: number) => ({
      id,
      name,
      parentId: null,
      order,
      start: '2026-02-02',
      end: '2026-02-06',
      duration: 5,
      progress: 0,
      isMilestone: false,
      dependencies: [],
      constraints: { type: 'none' },
      assignments: [{ resourceId, load: 50 }],
      customFields: {},
    });
    store.setState({
      file: {
        ...f,
        tasks: [
          task('t1', '设计', 'r1', 0),
          task('t2', '开发', 'r1', 1),
          task('t3', '测试', 'r2', 2),
        ],
        resources: [
          { id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' },
          { id: 'r2', name: 'Bob', capacity: 0.8, role: '产品' },
          { id: 'r3', name: 'Carol', capacity: 1.0, role: null },
        ],
      },
    });
  });
  await page.getByRole('button', { name: '资源视图' }).click();
}

async function readResources(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().file.resources.map((r) => r.id);
  });
}

async function readUndoDepth(page: Page) {
  return page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().undoStack.length;
  });
}

test.describe('resource list interactions', () => {
  test.beforeEach(async ({ page }) => {
    await inject(page);
  });

  test('hover reveals the grip with zero layout shift', async ({ page }) => {
    const row = page.locator('[data-resource-id="r1"]');
    const name = row.locator('[data-testid="resource-name"]');
    const gripIcon = row.locator('[data-testid="row-drag-handle"] svg');

    const before = await name.boundingBox();
    expect(
      await gripIcon.evaluate((el) => getComputedStyle(el).opacity),
      'grip hidden before hover',
    ).toBe('0');

    await row.hover();
    await expect.poll(() => gripIcon.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');

    // Zero-shift contract: hover affordances only animate opacity, never move
    // the row content.
    const after = await name.boundingBox();
    expect(after!.x).toBe(before!.x);
    expect(after!.y).toBe(before!.y);
  });

  test('F2 renames a resource — one command, one undo', async ({ page }) => {
    const row = page.locator('[data-resource-id="r1"]');
    await row.click();
    await row.press('F2');
    const input = page.locator('[data-testid="resource-name-input"]');
    await expect(input).toBeFocused();
    await input.fill('王芳');
    await input.press('Enter');

    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: '王芳' }),
    ).toBeVisible();
    expect(await readUndoDepth(page), 'single committed command').toBe(1);

    // A single undo reverts the whole rename.
    await page.evaluate(() => {
      const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      s.getState().undo();
    });
    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: 'Alice' }),
    ).toBeVisible();
  });

  test('Tab hops name → role → capacity; Escape cancels without dispatching', async ({ page }) => {
    const row = page.locator('[data-resource-id="r1"]');
    await row.click();
    await row.press('F2');
    await expect(page.locator('[data-testid="resource-name-input"]')).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(page.locator('[data-testid="resource-role-input"]')).toBeFocused();
    await page.keyboard.press('Tab');
    const capInput = page.locator('[data-testid="resource-capacity-input"]');
    await expect(capInput).toBeFocused();
    await expect(page.locator('[data-resource-id="r1"] input')).toHaveCount(1);

    await capInput.fill('50');
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-resource-id="r1"] input')).toHaveCount(0);
    await expect(
      page.locator('[data-resource-id="r1"] [data-testid="resource-capacity"]'),
    ).toHaveText('100%');
    expect(await readUndoDepth(page), 'Escape never dispatches').toBe(0);
  });

  test('committed role and capacity edits each land as one command', async ({ page }) => {
    const row = page.locator('[data-resource-id="r1"]');
    await row.click();
    await row.press('F2');
    await page.keyboard.press('Tab');
    const roleInput = page.locator('[data-testid="resource-role-input"]');
    await roleInput.fill('测试');
    await roleInput.press('Enter');
    await expect(page.locator('[data-resource-id="r1"] [data-testid="resource-role"]')).toHaveText(
      '测试',
    );
    expect(await readUndoDepth(page)).toBe(1);

    await row.click();
    await row.press('F2');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const capInput = page.locator('[data-testid="resource-capacity-input"]');
    await capInput.fill('50');
    await capInput.press('Enter');
    await expect(
      page.locator('[data-resource-id="r1"] [data-testid="resource-capacity"]'),
    ).toHaveText('50%');
    expect(await readUndoDepth(page)).toBe(2);
  });

  test('double-click toggles drill-down and the collapsed count chip', async ({ page }) => {
    const row = page.locator('[data-resource-id="r1"]');
    await expect(row.locator('[data-testid="task-count"]')).toHaveText('2 项');
    await expect(page.getByText('设计')).toHaveCount(0);

    await row.dblclick();
    await expect(page.getByText('设计')).toBeVisible();
    await expect(row.locator('[data-testid="task-count"]')).toHaveCount(0);

    await row.dblclick();
    await expect(page.getByText('设计')).toHaveCount(0);
    await expect(row.locator('[data-testid="task-count"]')).toHaveText('2 项');
  });

  test('context menu renames (F2 hint) and deletes via the confirm dialog', async ({ page }) => {
    const row = page.locator('[data-resource-id="r1"]');
    await row.click({ button: 'right' });
    const menu = page.locator('[role="menu"]');
    const renameItem = menu.locator('button').filter({ hasText: '重命名' });
    await expect(renameItem).toBeVisible();
    await expect(renameItem).toContainText('F2');
    await renameItem.click();

    const input = page.locator('[data-testid="resource-name-input"]');
    await expect(input).toBeFocused();
    await input.fill('李四');
    await input.press('Enter');
    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: '李四' }),
    ).toBeVisible();

    // The delete entry routes through the confirmation dialog.
    await page.locator('[data-resource-id="r2"]').click({ button: 'right' });
    await menu.locator('button').filter({ hasText: '删除资源' }).click();
    await expect(page.getByText('确认删除此资源？')).toBeVisible();
    await page.getByRole('button', { name: '取消' }).click();
    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: 'Bob' }),
    ).toBeVisible();
  });

  test('Delete key opens the delete confirmation', async ({ page }) => {
    const row = page.locator('[data-resource-id="r1"]');
    await row.click();
    await row.press('Delete');
    await expect(page.getByText('确认删除此资源？')).toBeVisible();
    await page.getByRole('button', { name: '取消' }).click();
    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: 'Alice' }),
    ).toBeVisible();
  });

  test('grip-only drag reorders resources as one undoable command', async ({ page }) => {
    const aliceRow = page.locator('[data-resource-id="r1"]');
    // Only the grip is draggable — the row body never starts a drag.
    expect(await aliceRow.getAttribute('draggable')).toBeNull();
    expect(
      await aliceRow.locator('[data-testid="row-drag-handle"]').getAttribute('draggable'),
    ).toBe('true');

    // Drag Alice (row 0) onto the BOTTOM band of Bob (row 1) → after Bob.
    const from = await aliceRow.boundingBox();
    const bobRow = page.locator('[data-resource-id="r2"]');
    const to = await bobRow.boundingBox();
    if (!from || !to) throw new Error('row not found');
    const dropY = to.y + to.height - ROW_HEIGHT * 0.1;

    await page.evaluate(
      async ({ fromX, fromY, toX, toY }) => {
        const fromEl = document.elementFromPoint(fromX, fromY) as HTMLElement | null;
        const toEl = document.elementFromPoint(toX, toY) as HTMLElement | null;
        if (!fromEl || !toEl) throw new Error('drag source/target element not found');
        const sourceRow = fromEl.closest('[role="row"]') as HTMLElement | null;
        const target = toEl.closest('[role="row"]') as HTMLElement | null;
        if (!sourceRow || !target) throw new Error('row not found under pointer');
        const source = sourceRow.querySelector<HTMLElement>('[data-testid="row-drag-handle"]');
        if (!source) throw new Error('drag grip not found in source row');

        const dt = new DataTransfer();
        const fire = (
          type: string,
          el: HTMLElement,
          x: number,
          y: number,
          dataTransfer: DataTransfer,
        ) => {
          const rect = el.getBoundingClientRect();
          const ev = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: rect.left + (x - rect.left),
            clientY: rect.top + (y - rect.top),
          });
          el.dispatchEvent(ev);
        };

        fire('dragstart', source, fromX, fromY, dt);
        for (let i = 1; i <= 3; i++) {
          await new Promise((r) => setTimeout(r, 10));
          fire('dragover', target, toX, toY, dt);
        }
        fire('drop', target, toX, toY, dt);
        fire('dragend', source, fromX, fromY, dt);
      },
      {
        fromX: from.x + from.width / 2,
        fromY: from.y + from.height / 2,
        toX: to.x + to.width / 2,
        toY: dropY,
      },
    );

    expect(await readResources(page)).toEqual(['r2', 'r1', 'r3']);
    expect(await readUndoDepth(page), 'one moveResourceCommand').toBe(1);

    await page.evaluate(() => {
      const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      s.getState().undo();
    });
    expect(await readResources(page)).toEqual(['r1', 'r2', 'r3']);
  });

  test('header expand-all / collapse-all drive every drill-down', async ({ page }) => {
    const rows = page.locator('[data-resource-list] [role="row"]');
    await expect(rows).toHaveCount(3);

    await page.locator('[data-testid="expand-all-resources"]').click();
    // Alice(1) + header + 2 lanes + Bob(1) + header + 1 lane + Carol(1) = 8.
    await expect(rows).toHaveCount(8);
    await expect(
      page.locator('[data-resource-id="r1"] [data-testid="expand-toggle"]'),
    ).toHaveAttribute('aria-expanded', 'true');
    // Carol has no tasks — no toggle, and she stays a single row.
    await expect(page.locator('[data-resource-id="r3"] [data-testid="expand-toggle"]')).toHaveCount(
      0,
    );
    await expect(page.locator('[data-resource-id="r3"]')).toHaveCount(1);

    await page.locator('[data-testid="collapse-all-resources"]').click();
    await expect(rows).toHaveCount(3);
  });

  test('treegrid aria: levels and expanded state', async ({ page }) => {
    await expect(page.locator('[data-resource-list] [role="treegrid"]')).toBeVisible();
    const aliceRow = page.locator('[data-resource-id="r1"]');
    await expect(aliceRow).toHaveAttribute('aria-level', '1');
    await expect(aliceRow).toHaveAttribute('aria-expanded', 'false');

    await aliceRow.locator('[data-testid="expand-toggle"]').click();
    await expect(aliceRow).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('[data-resource-task-id="t1"]')).toHaveAttribute('aria-level', '2');
  });
});
