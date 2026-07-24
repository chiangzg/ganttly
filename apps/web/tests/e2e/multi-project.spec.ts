import { expect, test } from '@playwright/test';

test('creates and switches between independent project URLs', async ({ page }) => {
  await page.goto('/projects');

  const header = page.getByRole('banner');
  const headerCreate = header.getByRole('button', { name: '新建项目', exact: true });
  await expect(headerCreate).toHaveCount(1);
  await headerCreate.click();
  await page.getByLabel('项目名称', { exact: true }).fill('项目 A');
  await page.getByRole('button', { name: '创建并打开', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/prj_/);

  const projectATab = page.getByRole('banner').getByRole('button', { name: '项目 A', exact: true });
  await expect(projectATab).toHaveCount(2);

  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('项目 B');
  await page.getByRole('button', { name: '创建并打开', exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/prj_/);
  await expect(
    page.getByRole('banner').getByRole('button', { name: '项目 B', exact: true }),
  ).toHaveCount(2);

  const projectATabAfter = page
    .getByRole('banner')
    .getByRole('button', { name: '项目 A', exact: true });
  await expect(projectATabAfter).toHaveCount(1);
  await projectATabAfter.click();
  await expect(page).toHaveURL(/\/projects\/prj_/);
  await expect(
    page.getByRole('banner').getByRole('button', { name: '项目 A', exact: true }),
  ).toHaveCount(2);
});

test('project center supports favorites and recycle bin', async ({ page }) => {
  await page.goto('/projects');
  const createButtons = page.getByRole('button', { name: '新建项目', exact: true });
  await expect(createButtons).toHaveCount(2);
  await createButtons.nth(1).click();
  await page.getByLabel('项目名称', { exact: true }).fill('回收站测试');
  await page.getByRole('button', { name: '创建并打开', exact: true }).click();
  await page.getByRole('button', { name: 'G', exact: true }).click();

  const card = page.locator('article').filter({ hasText: '回收站测试' });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: '收藏项目', exact: true }).click();
  await page.getByRole('button', { name: '收藏', exact: true }).click();
  await expect(page.getByRole('heading', { name: '回收站测试', exact: true })).toHaveCount(1);

  await page.getByRole('button', { name: '全部', exact: true }).click();
  await card.getByRole('button', { name: '项目操作 回收站测试', exact: true }).click();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  await page.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('button', { name: '回收站', exact: true }).click();
  await expect(page.getByRole('heading', { name: '回收站测试', exact: true })).toHaveCount(1);
});
