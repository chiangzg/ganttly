import { expect, test, type Page } from '@playwright/test';

/**
 * Context-menu shortcut hints E2E (editor-interaction-optimization-plan §4.2).
 *
 * Verifies the right-click menu now shows accelerator hints next to the
 * copy/cut/paste/delete items (added in PR 8), and that the modifier symbol
 * matches the running platform (⌘ on macOS, Ctrl elsewhere).
 */

async function injectTask(page: Page) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: Record<string, unknown> };
    };
    const f = store.getState().file;
    store.setState({
      file: {
        ...f,
        tasks: [
          {
            id: 't0',
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
            assignments: [],
            customFields: {},
          },
        ],
        viewState: {
          ...(f.viewState as object),
          selectedTaskId: 't0',
          collapsedTaskIds: [],
        },
      },
    });
  });
  await page.waitForTimeout(150);
}

test.describe('context menu shortcut hints', () => {
  test('copy/cut/paste/delete items show a modifier hint', async ({ page }) => {
    await injectTask(page);
    const row = page.locator('[role="row"]', { hasText: '设计' }).first();
    await row.click({ button: 'right' });

    // The menu container.
    const menu = page.locator('.fixed.z-30').last();
    await expect(menu).toBeVisible({ timeout: 3000 });

    // Determine the expected modifier on this platform.
    const expectedMod = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? '⌘' : 'Ctrl',
    );

    // Each labelled item should carry its shortcut hint.
    await expect(menu.locator('button', { hasText: '重命名' })).toContainText('F2');
    await expect(menu.locator('button', { hasText: '复制' })).toContainText(expectedMod);
    await expect(menu.locator('button', { hasText: '复制' })).toContainText('C');
    await expect(menu.locator('button', { hasText: '剪切' })).toContainText('X');
    await expect(menu.locator('button', { hasText: '粘贴' })).toContainText('V');
    await expect(menu.locator('button', { hasText: '删除' })).toContainText('Delete');

    // Dismiss.
    await page.keyboard.press('Escape');
  });

  test('the edit item has no shortcut hint', async ({ page }) => {
    await injectTask(page);
    const row = page.locator('[role="row"]', { hasText: '设计' }).first();
    await row.click({ button: 'right' });
    const menu = page.locator('.fixed.z-30').last();
    await expect(menu).toBeVisible({ timeout: 3000 });
    const editBtn = menu.locator('button', { hasText: '编辑' }).first();
    // No modifier symbol and no standalone accelerator on the edit item.
    const text = (await editBtn.textContent()) ?? '';
    expect(text).not.toContain('⌘');
    expect(text).not.toContain('Ctrl');
  });
});
