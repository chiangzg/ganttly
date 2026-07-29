import { expect, test, type Page } from '@playwright/test';

async function expectNoHorizontalToolbarOverflow(page: Page) {
  const metrics = await page.locator('[data-editor-toolbar]').evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

test.describe('modern editor navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  });

  test('desktop keeps complete command groups visible', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });

    await expect(page.locator('[data-project-header]')).toBeVisible();
    await expect(page.locator('[data-editor-toolbar]')).toBeVisible();
    await expect(page.getByRole('button', { name: '今天', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '放大', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '关键路径', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '任务视图', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '资源视图', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '人天列', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '重做', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
    await expectNoHorizontalToolbarOverflow(page);
  });

  test('medium viewport moves secondary toggles into More', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });

    await expect(page.getByRole('button', { name: '放大', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '关键路径', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '人天列', exact: true })).toBeHidden();

    await page.getByRole('button', { name: '更多操作' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: '关键路径' })).toBeVisible();
    await expect(page.getByRole('menuitemcheckbox', { name: '人天列' })).toBeVisible();
    await expectNoHorizontalToolbarOverflow(page);
  });

  test('narrow viewport keeps core actions and moves planning controls into More', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 768, height: 720 });

    await expect(page.getByRole('button', { name: '今天', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '任务视图', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '资源视图', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重做', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '放大', exact: true })).toBeHidden();
    await expect(page.getByRole('button', { name: '创建基线', exact: true })).toBeHidden();

    await page.getByRole('button', { name: '更多操作' }).click();
    await expect(page.getByRole('menuitem', { name: '放大' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '缩小' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '创建基线' })).toBeVisible();
    await expectNoHorizontalToolbarOverflow(page);
  });

  test('icon actions expose names and keyboard focus treatment', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const save = page.getByRole('button', { name: '保存', exact: true });

    await save.focus();
    await expect(save).toBeFocused();
    await expect
      .poll(() => save.evaluate((element) => getComputedStyle(element).boxShadow))
      .not.toBe('none');
    await expect(save).toHaveAttribute('title', /已保存|保存/);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveAttribute(
      'title',
      /撤销/,
    );
    await expect(page.getByRole('button', { name: '重做', exact: true })).toHaveAttribute(
      'title',
      /重做/,
    );
  });

  test('navigation hierarchy remains clear in light and dark themes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const navigation = page.locator('[data-editor-navigation]');

    await page.emulateMedia({ colorScheme: 'light' });
    await expect(navigation).toHaveScreenshot('editor-navigation-light.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(navigation).toHaveScreenshot('editor-navigation-dark.png', {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
  });
});
