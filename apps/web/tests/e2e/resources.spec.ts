import { expect, test, type Page } from '@playwright/test';

/**
 * Resource view E2E (P1 feature one — G7/G19).
 *
 * Verifies:
 * - Toolbar switches between task ↔ resource view
 * - ResourceList renders and supports add/remove
 * - TaskDrawer assignment editing flows into the load chart
 * - Switching views preserves scroll independence (G19)
 */

async function injectFixture(page: Page) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    store.setState({
      file: {
        ...f,
        tasks: [
          {
            id: 't1',
            name: '设计',
            parentId: null,
            order: 0,
            start: '2026-02-02',
            end: '2026-02-06',
            duration: 5,
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: {},
            assignments: [{ resourceId: 'r1', load: 50 }],
            customFields: {},
          },
        ],
        resources: [{ id: 'r1', name: 'Alice', capacity: 1.0, role: '前端' }],
      },
    });
  });
}

test.describe('resource view', () => {
  test.beforeEach(async ({ page }) => {
    await injectFixture(page);
  });

  test('switches to resource view and shows the resource list', async ({ page }) => {
    // Default is task view — TaskTable header "WBS" should be visible.
    await expect(page.getByText('WBS').first()).toBeVisible();
    // Switch to resource view.
    await page.getByRole('button', { name: '资源视图' }).click();
    // ResourceList header "资源名称" should now be visible, Alice listed.
    await expect(page.getByText('资源名称').first()).toBeVisible();
    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: 'Alice' }),
    ).toBeVisible();
  });

  test('keeps task-only toolbar controls in place and disables them in resource view', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    const criticalPath = page.getByRole('button', { name: '关键路径', exact: true });
    const baseline = page.getByRole('button', { name: '创建基线', exact: true });
    const taskView = page.getByRole('button', { name: '任务视图', exact: true });
    const resourceView = page.getByRole('button', { name: '资源视图', exact: true });

    await expect(criticalPath).toBeEnabled();
    await expect(baseline).toBeEnabled();
    const taskViewX = await taskView.evaluate((element) => element.getBoundingClientRect().x);

    await criticalPath.click();
    await resourceView.click();

    await expect(criticalPath).toBeVisible();
    await expect(criticalPath).toBeDisabled();
    await expect(criticalPath).toHaveAttribute('aria-pressed', 'true');
    await expect(criticalPath).toHaveAttribute('title', '仅在任务视图中可用');
    await expect(baseline).toBeVisible();
    await expect(baseline).toBeDisabled();
    await expect(baseline).toHaveAttribute('title', '仅在任务视图中可用');
    await expect
      .poll(() => taskView.evaluate((element) => element.getBoundingClientRect().x))
      .toBe(taskViewX);

    await taskView.click();
    await expect(criticalPath).toBeEnabled();
    await expect(criticalPath).toHaveAttribute('aria-pressed', 'true');
    await expect(baseline).toBeEnabled();

    await page.setViewportSize({ width: 768, height: 720 });
    await resourceView.click();
    await page.getByRole('button', { name: '更多操作' }).click();
    await expect(page.getByRole('menuitem', { name: '创建基线' })).toBeDisabled();
    await expect(page.getByRole('menuitemcheckbox', { name: '关键路径' })).toBeDisabled();
  });

  test('adds a resource via the list footer button', async ({ page }) => {
    await page.getByRole('button', { name: '资源视图' }).click();
    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: 'Alice' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '新增资源' }).click();
    // Two resources now: Alice + the new placeholder (its name cell starts in
    // the F2-style inline editor).
    await expect(page.locator('[data-resource-id]')).toHaveCount(2);
    await expect(page.locator('[data-testid="resource-name-input"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: 'Alice' }),
    ).toBeVisible();
  });

  test('removes a resource via the row × button', async ({ page }) => {
    await page.getByRole('button', { name: '资源视图' }).click();
    const aliceName = page.locator('[data-testid="resource-name"]').filter({ hasText: 'Alice' });
    await expect(aliceName).toBeVisible();
    // Click the × button inside Alice's row.
    const aliceRow = page.locator('[data-resource-id="r1"]');
    await aliceRow.locator('[data-testid="resource-delete"]').click();
    // Confirm deletion in the in-app dialog.
    await page.getByRole('button', { name: '删除资源' }).click();
    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: 'Alice' }),
    ).toHaveCount(0);
  });

  test('load chart canvas renders in resource view', async ({ page }) => {
    await page.getByRole('button', { name: '资源视图' }).click();
    // The canvas element should be present in the resource view.
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    // Canvas should have a non-zero size (rendered, not zero-sized).
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
  });

  test('switching back to task view restores the task table', async ({ page }) => {
    await page.getByRole('button', { name: '资源视图' }).click();
    await expect(
      page.locator('[data-testid="resource-name"]').filter({ hasText: 'Alice' }),
    ).toBeVisible();
    await page.getByRole('button', { name: '任务视图' }).click();
    // Task view header returns.
    await expect(page.getByText('WBS').first()).toBeVisible();
    // The injected task "设计" should be visible again.
    await expect(page.getByText('设计')).toBeVisible();
  });

  test('wheel-pan over the right pane scrolls vertically and horizontally', async ({ page }) => {
    // Add enough resources that the list overflows the viewport, so vertical
    // wheel-pan has room to scroll (scrollTop is clamped to [0, contentH-vh];
    // with one row it would be 0 and the assertion below would be vacuous).
    await page.evaluate(() => {
      const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
        setState: (s: unknown) => void;
        getState: () => { file: Record<string, unknown> };
      };
      const f = store.getState().file as { resources: unknown[] };
      const extra = Array.from({ length: 30 }, (_, i) => ({
        id: `extra-${i}`,
        name: `R${i}`,
        capacity: 1.0,
        role: 'dev',
      }));
      store.setState({ file: { ...f, resources: [...f.resources, ...extra] } });
    });
    // Switch to resource view and wait for the load canvas to mount.
    await page.getByRole('button', { name: '资源视图' }).click();
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();

    const readScroll = () =>
      page.evaluate(() => {
        // resourceScrollTop lives in the view store (G19: independent of the
        // file's viewState.scrollTop); scrollLeft lives in the file store.
        const fileStore = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
          getState: () => { file: { viewState: { scrollLeft: number } } };
        };
        const viewStore = (window as unknown as { __ganttlyViewStore?: unknown })
          .__ganttlyViewStore as {
          getState: () => { resourceScrollTop: number };
        };
        return {
          scrollTop: viewStore.getState().resourceScrollTop,
          scrollLeft: fileStore.getState().file.viewState.scrollLeft,
        };
      });

    const before = await readScroll();

    // Center over the canvas and emit a wheel with both deltaY (vertical) and
    // deltaX (horizontal trackpad gesture) — this is what GanttCanvas handles
    // for the task view and ResourceLoadCanvas must now mirror.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(40, 60);
    await page.waitForTimeout(150);

    const after = await readScroll();
    // Vertical pan wrote to resourceScrollTop (G19: resource-view scroll store).
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
    // Horizontal pan wrote to file.viewState.scrollLeft (shared time axis).
    expect(after.scrollLeft).toBeGreaterThan(before.scrollLeft);
  });

  test('drilling down a resource reveals its task lanes and selects on click', async ({ page }) => {
    // The fixture injects one task "设计" assigned to Alice (r1) at 50% load,
    // so Alice's row should have an expand chevron once in resource view.
    await page.getByRole('button', { name: '资源视图' }).click();
    const aliceName = page.locator('[data-testid="resource-name"]').filter({ hasText: 'Alice' });
    await expect(aliceName).toBeVisible();

    // Initially: only the resource row exists (1 row), and the task "设计" is
    // NOT visible in the resource list yet. The collapsed row quantifies its
    // hidden tasks with a count chip.
    await expect(page.getByText('设计')).toHaveCount(0);
    const aliceRow = page.locator('[data-resource-id="r1"]');
    await expect(aliceRow.locator('[data-testid="task-count"]')).toHaveText('1 项');

    // Click the expand chevron inside Alice's row.
    const toggle = aliceRow.locator('[data-testid="expand-toggle"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();

    // The task lane "设计" now appears beneath Alice's row.
    await expect(page.getByText('设计')).toBeVisible();
    // The chevron flipped to expanded.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    // Expanded rows don't repeat the count chip.
    await expect(aliceRow.locator('[data-testid="task-count"]')).toHaveCount(0);

    // Clicking the task lane selects it (G19: writes selectedTaskIdInResource).
    await page.getByText('设计').click();
    const selectedLane = await page.evaluate(() => {
      const viewStore = (window as unknown as { __ganttlyViewStore?: unknown })
        .__ganttlyViewStore as {
        getState: () => { selectedTaskIdInResource: string | null };
      };
      return viewStore.getState().selectedTaskIdInResource;
    });
    expect(selectedLane).toBe('t1');

    // Collapsing hides the task lane again.
    await toggle.click();
    await expect(page.getByText('设计')).toHaveCount(0);
  });
});
