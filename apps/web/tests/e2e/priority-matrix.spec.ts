import { expect, test, type Page } from '@playwright/test';

/**
 * Priority matrix view E2E (priority-matrix spec §4).
 *
 * Covers:
 *  - §4.1 the view switch keeps the task tree and swaps only the right pane;
 *        date navigation is hidden while the matrix is on screen
 *  - §2.3 / §4.3 the tray and quadrants hold the right tasks (never summaries)
 *  - §4.5 drag to triage: set, clear, no-op on the same bucket, one card per drag
 *  - §4.4 selection is shared with the task tree, in both directions
 *  - §4.6 double-click / Enter open the drawer, arrows walk the cards
 *  - §4.8 an open drawer follows a change made from the matrix
 *  - §4.2 assignee filter, "show completed" and the shared search box
 *  - the task tree and the matrix are not drop targets for each other's drags
 *
 * Playwright's `mouse` API fires MouseEvents only — it does NOT synthesise the
 * `dragstart` / `dragover` / `drop` events, so they are dispatched by hand with
 * a real `DataTransfer` (same technique as `task-row-drag.spec.ts`). Every drop
 * re-renders the lists, so elements are re-queried inside each `evaluate`.
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
  dependencies: unknown[];
  constraints: Record<string, unknown>;
  assignments: Array<{ resourceId: string; load: number }>;
  customFields: Record<string, unknown>;
}

interface StoreApi {
  getState: () => {
    file: {
      tasks: Array<Partial<TaskShape> & { id: string }>;
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

const LEAF = { parentId: 'parent', start: '2026-02-02', end: '2026-02-06', duration: 5 } as const;

/** One summary with five leaves (one per interesting case) plus a lone root task. */
const TASKS: TaskShape[] = [
  makeTask('parent', { name: '汇总', order: 0 }),
  makeTask('p1', { name: '紧急任务', ...LEAF, order: 0, priority: 1 }),
  makeTask('p2', { name: '计划任务', ...LEAF, order: 1, priority: 2 }),
  makeTask('p3', { name: '授权任务', ...LEAF, order: 2, priority: 3 }),
  makeTask('wang', {
    name: '王的任务',
    ...LEAF,
    order: 3,
    assignments: [{ resourceId: 'wang', load: 50 }],
  }),
  makeTask('done', { name: '已完成任务', ...LEAF, order: 4, progress: 100 }),
  makeTask('lone', { name: '独立任务', order: 1 }),
];

async function openMatrix(page: Page, options: { collapsed?: string[]; tasks?: TaskShape[] } = {}) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(
    ([tasks, collapsed]) => {
      const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      const f = s.getState().file;
      s.setState({
        file: {
          ...f,
          tasks,
          resources: [{ id: 'wang', name: '王强', role: '前端' }],
          viewState: {
            ...f.viewState,
            zoom: 'week',
            scrollLeft: 0,
            scrollTop: 0,
            selectedTaskId: null,
            showCriticalPath: false,
            collapsedTaskIds: collapsed,
          },
        },
      });
    },
    [options.tasks ?? TASKS, options.collapsed ?? []] as const,
  );
  await page.getByRole('button', { name: '四象限', exact: true }).click();
  await expect(page.locator('[data-priority-matrix]')).toBeVisible();
}

const card = (page: Page, taskId: string) => page.locator(`[data-matrix-task-id="${taskId}"]`);
const bucket = (page: Page, name: string) => page.locator(`[data-matrix-bucket="${name}"]`);
const row = (page: Page, taskId: string) => page.locator(`[data-task-id="${taskId}"]`);
const cards = (page: Page) => page.locator('[data-priority-matrix] [role="option"]');
const selectedCards = (page: Page) =>
  page.locator('[data-priority-matrix] [role="option"][aria-selected="true"]');

/** Which bucket (tray | 1–4) renders the card for `taskId`; null when none does. */
function bucketOf(page: Page, taskId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-matrix-task-id="${id}"]`);
    return el?.closest('[data-matrix-bucket]')?.getAttribute('data-matrix-bucket') ?? null;
  }, taskId);
}

/**
 * Read state inside the page. `page.evaluate` callbacks run in the BROWSER, so
 * the store lookup is spelled out there instead of calling a Node-side helper.
 */
function readTask(page: Page, taskId: string): Promise<{ priority: number | null }> {
  return page.evaluate((id) => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const task = s.getState().file.tasks.find((t) => t.id === id)!;
    return { priority: (task.priority as number | undefined) ?? null };
  }, taskId);
}

function undoCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().undoStack.length;
  });
}

/** Drag `taskId`'s card onto the `target` bucket via synthetic HTML5 DragEvents. */
async function dragCardTo(page: Page, taskId: string, target: string): Promise<void> {
  await page.evaluate(
    ([id, to]) => {
      const source = document.querySelector(`[data-matrix-task-id="${id}"]`);
      const zone = document.querySelector(`[data-matrix-bucket="${to}"]`);
      if (!(source instanceof HTMLElement) || !(zone instanceof HTMLElement)) {
        throw new Error(`drag source "${id}" or target "${to}" not found`);
      }
      const dt = new DataTransfer();
      const fire = (type: string, el: HTMLElement) =>
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      fire('dragstart', source);
      fire('dragover', zone);
      fire('drop', zone);
      fire('dragend', source);
    },
    [taskId, target] as const,
  );
}

test.describe('priority matrix view (priority-matrix spec §4)', () => {
  test('§4.1 the view switch keeps the task tree and swaps only the right pane', async ({
    page,
  }) => {
    await openMatrix(page);

    // Same shape as the task/resource views: tree on the left, content on the right.
    await expect(page.locator('[data-task-table]')).toBeVisible();
    await expect(page.locator('[data-priority-matrix]')).toBeVisible();
    await expect(page.locator('[data-gantt-chart]')).toHaveCount(0); // no chart here
    await expect(page.getByRole('button', { name: '四象限', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Date navigation only drives the chart, so it is not offered.
    await expect(page.getByRole('button', { name: '今天', exact: true })).toBeHidden();

    // §2.3 leaves only — the summary row exists in the tree but has no card.
    await expect(card(page, 'parent')).toHaveCount(0);
    await expect(row(page, 'parent')).toBeVisible();

    // §4.3 buckets: P1–P3 hold one card each, the tray the rest (completed
    // tasks are hidden by default).
    await expect(bucket(page, 'tray').locator('[role="option"]')).toHaveCount(2);
    await expect(bucket(page, '1').locator('[role="option"]')).toHaveCount(1);
    await expect(bucket(page, '2').locator('[role="option"]')).toHaveCount(1);
    await expect(page.getByTestId('matrix-summary')).toHaveText('已分级 3 · 待分级 2');

    // Back to the task view: the chart and its date navigation return.
    await page.getByRole('button', { name: '任务视图', exact: true }).click();
    await expect(page.locator('[data-priority-matrix]')).toHaveCount(0);
    await expect(page.locator('[data-gantt-chart]')).toBeVisible();
    await expect(page.getByRole('button', { name: '今天', exact: true })).toBeVisible();
  });

  test('§4.5 dragging a card into a quadrant triages it; one undo puts it back', async ({
    page,
  }) => {
    await openMatrix(page);
    const before = await undoCount(page);

    await dragCardTo(page, 'lone', '1');

    expect(await bucketOf(page, 'lone')).toBe('1');
    expect(await readTask(page, 'lone')).toEqual({ priority: 1 });
    expect(await undoCount(page)).toBe(before + 1);
    // The task tree shows the mark without leaving the view.
    await expect(row(page, 'lone').getByTestId('priority-tag')).toHaveText('P1');
    await expect(page.getByTestId('matrix-summary')).toHaveText('已分级 4 · 待分级 1');
    await expect(bucket(page, '1').getByTestId('quadrant-count')).toHaveText('2');

    await page.getByRole('button', { name: '撤销', exact: true }).click();
    expect(await bucketOf(page, 'lone')).toBe('tray');
    expect(await readTask(page, 'lone')).toEqual({ priority: null });
    await expect(row(page, 'lone').getByTestId('priority-tag')).toHaveCount(0);
  });

  test('§4.5 dragging back to the tray clears the priority; a same-bucket drop does nothing', async ({
    page,
  }) => {
    await openMatrix(page);
    const before = await undoCount(page);

    // Already in P3 → dropping on P3 is not a change: no command, no undo record.
    await dragCardTo(page, 'p3', '3');
    expect(await bucketOf(page, 'p3')).toBe('3');
    expect(await readTask(page, 'p3')).toEqual({ priority: 3 });
    expect(await undoCount(page)).toBe(before);

    await dragCardTo(page, 'p3', 'tray');
    expect(await bucketOf(page, 'p3')).toBe('tray');
    expect(await readTask(page, 'p3')).toEqual({ priority: null });
    await expect(row(page, 'p3').getByTestId('priority-tag')).toHaveCount(0);
    expect(await undoCount(page)).toBe(before + 1);
  });

  test('§4.5 a drag moves exactly the dragged card, even inside a multi-selection', async ({
    page,
  }) => {
    await openMatrix(page);
    await card(page, 'wang').click();
    await card(page, 'lone').click({ modifiers: ['Meta'] });
    await expect(selectedCards(page)).toHaveCount(2);

    await dragCardTo(page, 'wang', '2');

    expect(await bucketOf(page, 'wang')).toBe('2');
    expect(await bucketOf(page, 'lone')).toBe('tray');
    // The selection collapsed to the dragged card, so tree and matrix agree.
    await expect(selectedCards(page)).toHaveCount(1);
    await expect(card(page, 'wang')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'wang')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'lone')).toHaveAttribute('aria-selected', 'false');
  });

  test('§4.4 selection is shared with the task tree in both directions', async ({ page }) => {
    // The summary starts collapsed, so no leaf row is on screen in the tree.
    await openMatrix(page, { collapsed: ['parent'] });
    await expect(row(page, 'p2')).toHaveCount(0);

    // Tree → card: the card is marked selected.
    await row(page, 'lone').click();
    await expect(card(page, 'lone')).toHaveAttribute('aria-selected', 'true');
    await expect(card(page, 'p1')).toHaveAttribute('aria-selected', 'false');

    // Card → tree: collapsed ancestors open and the matching row is selected.
    await card(page, 'p2').click();
    await expect(row(page, 'p2')).toBeVisible();
    await expect(row(page, 'p2')).toHaveAttribute('aria-selected', 'true');
    await expect(row(page, 'parent')).toHaveAttribute('aria-expanded', 'true');
    await expect(card(page, 'lone')).toHaveAttribute('aria-selected', 'false');

    // Shift-click ranges over the cards in reading order: tray first, then
    // P1 → P4. From `wang` (tray) up to `p1` (P1) that is wang, lone, p1.
    await card(page, 'wang').click();
    await card(page, 'p1').click({ modifiers: ['Shift'] });
    expect(
      await selectedCards(page).evaluateAll((els) =>
        els.map((el) => el.getAttribute('data-matrix-task-id')),
      ),
    ).toEqual(['wang', 'lone', 'p1']);

    // A press on a bucket's empty area (P4 has no cards) clears the selection.
    await bucket(page, '4')
      .locator('[role="listbox"]')
      .click({ position: { x: 60, y: 60 } });
    await expect(selectedCards(page)).toHaveCount(0);
  });

  test('§4.6 double-click and Enter open the drawer; arrows walk the cards; Escape clears', async ({
    page,
  }) => {
    await openMatrix(page);
    const drawer = page.locator('aside');

    await card(page, 'p1').dblclick();
    await expect(drawer.getByText('编辑任务')).toBeVisible();
    await expect(drawer.locator('input').first()).toHaveValue('紧急任务');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    // Reading order is tray → P1 → P2 …: the card after `p1` is `p2`.
    await card(page, 'p1').focus();
    await page.keyboard.press('ArrowDown');
    await expect(card(page, 'p2')).toBeFocused();
    await expect(card(page, 'p2')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('input').first()).toHaveValue('计划任务');
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    await card(page, 'p2').focus();
    await page.keyboard.press('Escape');
    await expect(selectedCards(page)).toHaveCount(0);
  });

  test('§4.8 an open drawer follows a priority change made from the matrix', async ({ page }) => {
    await openMatrix(page);
    await card(page, 'p3').dblclick();
    const drawer = page.locator('aside');
    const group = drawer.getByRole('radiogroup', { name: '优先级' });
    await expect(group.getByRole('radio', { name: 'P3', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Same task, other entry point: the context menu on its card.
    await card(page, 'p3').click({ button: 'right' });
    const menu = page.locator('.fixed.z-30').last();
    await menu.getByRole('menuitem', { name: /优先级/ }).click();
    await menu.getByRole('menuitem', { name: /^P4 / }).click();

    // The control shows the new value…
    await expect(group.getByRole('radio', { name: 'P4', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(await bucketOf(page, 'p3')).toBe('4');
    // …and the re-based draft is clean: Save stays disabled and cannot revert it.
    await expect(drawer.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  test('§4.2 the assignee filter, "show completed" and the shared search box narrow the matrix', async ({
    page,
  }) => {
    await openMatrix(page);
    const assignee = page.getByRole('combobox', { name: '按负责人筛选' });

    await assignee.selectOption({ label: '王强' });
    await expect(cards(page)).toHaveCount(1);
    await expect(card(page, 'wang')).toBeVisible();
    // Six leaves in total; "show completed" is not counted as a filter.
    await expect(page.getByTestId('matrix-summary')).toHaveText('筛选后 1 / 6 个任务');
    // An emptied quadrant says so, without the "drop here" invitation.
    await expect(bucket(page, '1').getByText('没有匹配的任务')).toBeVisible();

    await assignee.selectOption({ label: '全部负责人' });
    await expect(page.getByTestId('matrix-summary')).toHaveText('已分级 3 · 待分级 2');
    await expect(card(page, 'done')).toHaveCount(0);

    await page.getByRole('button', { name: '显示已完成' }).click();
    await expect(card(page, 'done')).toBeVisible();
    await expect(card(page, 'done')).toContainText('已完成任务');
    await page.getByRole('button', { name: '显示已完成' }).click();
    await expect(card(page, 'done')).toHaveCount(0);

    // The search box lives in the task tree and filters the matrix too (§2.3).
    await page.getByPlaceholder('搜索任务名或 WBS…').fill('授权');
    await expect(cards(page)).toHaveCount(1);
    await expect(card(page, 'p3')).toBeVisible();
  });

  test('the tray collapses, and an emptied tray still accepts a drop', async ({ page }) => {
    await openMatrix(page);

    await page.getByRole('button', { name: '折叠待分级' }).click();
    await expect(page.getByRole('button', { name: '展开待分级' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(bucket(page, 'tray').locator('[role="option"]')).toHaveCount(0);
    await page.getByRole('button', { name: '展开待分级' }).click();
    await expect(card(page, 'lone')).toBeVisible();

    for (const id of ['wang', 'lone']) await dragCardTo(page, id, '2');
    await expect(bucket(page, 'tray')).toContainText('全部已分级');
    await expect(bucket(page, 'tray').locator('[role="option"]')).toHaveCount(0);

    await dragCardTo(page, 'p1', 'tray');
    expect(await bucketOf(page, 'p1')).toBe('tray');
    await expect(card(page, 'p1')).toBeVisible();
  });

  test('the task tree and the matrix are not drop targets for each other', async ({ page }) => {
    await openMatrix(page);
    const before = await undoCount(page);

    // (a) A tree grip drag passing over a quadrant: no highlight, no priority change.
    const gripSide = await page.evaluate(async () => {
      const grip = document.querySelector('[data-task-id="lone"] [data-testid="row-drag-handle"]');
      const zone = document.querySelector('[data-matrix-bucket="4"]') as HTMLElement;
      if (!(grip instanceof HTMLElement)) throw new Error('grip not found');
      const dt = new DataTransfer();
      const fire = (type: string, el: HTMLElement) =>
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      fire('dragstart', grip);
      fire('dragover', zone);
      // Let React flush in case the quadrant (wrongly) became a drop target.
      await new Promise((resolve) => setTimeout(resolve, 80));
      const highlighted = zone.style.boxShadow !== '';
      fire('drop', zone);
      fire('dragend', grip);
      const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
      const task = s.getState().file.tasks.find((t) => t.id === 'lone');
      return { highlighted, priority: (task?.priority as number | undefined) ?? null };
    });
    expect(gripSide).toEqual({ highlighted: false, priority: null });

    // (b) A matrix card dropped on a tree row: the task keeps its priority and place.
    await page.evaluate(() => {
      const source = document.querySelector('[data-matrix-task-id="lone"]');
      const target = document.querySelector('[data-task-id="p2"]');
      if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        throw new Error('card or row not found');
      }
      const dt = new DataTransfer();
      const fire = (type: string, el: HTMLElement) =>
        el.dispatchEvent(
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
        );
      fire('dragstart', source);
      fire('dragover', target);
      fire('drop', target);
      fire('dragend', source);
    });
    expect(await readTask(page, 'lone')).toEqual({ priority: null });
    expect(await bucketOf(page, 'lone')).toBe('tray');
    await expect(row(page, 'lone')).toBeVisible();
    expect(await undoCount(page)).toBe(before);
  });

  test('a triaged task survives a reload (IndexedDB persistence)', async ({ page }) => {
    await openMatrix(page);
    await dragCardTo(page, 'lone', '2');
    expect(await bucketOf(page, 'lone')).toBe('2');
    // Let autosave (500ms debounce + IO) settle, as persistence.spec.ts does.
    await page.waitForTimeout(1500);

    await page.reload();
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.getByRole('button', { name: '四象限', exact: true }).click();
    await expect(card(page, 'lone')).toBeVisible();
    expect(await bucketOf(page, 'lone')).toBe('2');
  });

  test('§4.3 each quadrant sorts on its own through its header menu', async ({ page }) => {
    await openMatrix(page, {
      tasks: [
        makeTask('lateStart', {
          name: '晚开始',
          order: 0,
          priority: 1,
          start: '2026-02-10',
          end: '2026-02-12',
          duration: 3,
        }),
        makeTask('earlyStart', {
          name: '早开始',
          order: 1,
          priority: 1,
          start: '2026-02-02',
          end: '2026-02-20',
          duration: 15,
        }),
        makeTask('other', {
          name: '另一象限',
          order: 2,
          priority: 2,
          start: '2026-02-02',
          end: '2026-02-03',
          duration: 2,
        }),
      ],
    });
    const order = () =>
      bucket(page, '1')
        .locator('[role="option"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-matrix-task-id')));
    const sortMenu = (name: string) => bucket(page, name).getByRole('button', { name: /排序方式/ });

    // Default: by end date — the short task comes first.
    expect(await order()).toEqual(['lateStart', 'earlyStart']);

    await sortMenu('1').click();
    await page.getByRole('menuitemradio', { name: '按开始日期' }).click();
    expect(await order()).toEqual(['earlyStart', 'lateStart']);

    // The menu marks the active sort, and only for the quadrant that was changed.
    await sortMenu('1').click();
    await expect(page.getByRole('menuitemradio', { name: '按开始日期' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByRole('menuitemradio', { name: '默认（逾期优先）' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await page.keyboard.press('Escape');
    await sortMenu('2').click();
    await expect(page.getByRole('menuitemradio', { name: '默认（逾期优先）' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('§4.5 a bucket highlights while a card is dragged over it; Escape cancels for good', async ({
    page,
  }) => {
    await openMatrix(page);
    const highlight = () => bucket(page, '2').evaluate((el) => (el as HTMLElement).style.boxShadow);
    const fireOnZone = (type: string) =>
      page.evaluate((eventType) => {
        const zone = document.querySelector('[data-matrix-bucket="2"]') as HTMLElement;
        const dt = new DataTransfer();
        const fire = (t: string, el: HTMLElement) =>
          el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
        if (eventType === 'drop') fire('drop', zone);
        else fire('dragover', zone);
      }, type);

    await page.evaluate(() => {
      const source = document.querySelector('[data-matrix-task-id="lone"]') as HTMLElement;
      const dt = new DataTransfer();
      source.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    });
    await fireOnZone('dragover');
    await expect.poll(highlight).toContain('inset');
    // The source card is dimmed for the duration of the drag.
    await expect(card(page, 'lone')).toHaveCSS('opacity', '0.4');

    await page.keyboard.press('Escape');
    await expect.poll(highlight).toBe('');

    // A drop that still arrives after the cancel must be ignored…
    await fireOnZone('drop');
    expect(await readTask(page, 'lone')).toEqual({ priority: null });
    expect(await bucketOf(page, 'lone')).toBe('tray');
    // …and nothing is left in the "dragging" look.
    await expect(card(page, 'lone')).toHaveCSS('opacity', '1');
  });

  test('§4.1 the third view button never makes the toolbar overflow', async ({ page }) => {
    await openMatrix(page);
    for (const width of [768, 1024]) {
      await page.setViewportSize({ width, height: 720 });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => {
        const toolbar = document.querySelector('[data-editor-toolbar]')!;
        return toolbar.scrollWidth > toolbar.clientWidth;
      });
      expect(overflow, `toolbar overflows at ${width}px`).toBe(false);
    }
    // Below `lg` the label is dropped, but the button keeps its accessible name.
    await expect(page.getByRole('button', { name: '四象限', exact: true })).toBeVisible();
  });
});
