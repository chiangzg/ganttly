import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

/**
 * Round-trip + .gan import E2E (PRD §3.9, M4.7-M4.8).
 *
 * Verifies:
 * 1. Export → Import keeps the data intact (round-trip)
 * 2. Project-center import uses a stable native file input
 * 3. Importing a real `.gan` file populates the task table
 */

const GAN_FIXTURE = resolve(
  process.cwd(),
  '../../packages/gan-parser/tests/fixtures/HouseBuildingSample.gan.xml',
);

test('export JSON then re-import restores the task', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.locator('[role="row"]')).toHaveCount(1);

  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: { tasks: Array<Record<string, unknown>> } & Record<string, unknown> };
    };
    const file = store.getState().file;
    store.setState({
      file: {
        ...file,
        tasks: file.tasks.map((task) => ({
          ...task,
          start: '2026-01-05',
          end: '2026-01-12',
          duration: 6,
          overtimeDates: ['2026-01-10'],
        })),
      },
    });
  });

  // Capture the task via the exposed store for later comparison.
  const originalTask = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => { file: { tasks: Array<{ name: string; overtimeDates?: string[] }> } };
    };
    return store.getState().file.tasks[0]!;
  });

  // The editor menu is now scoped to exporting the current project.
  await page.getByRole('button', { name: '更多操作' }).click();
  await expect(page.getByRole('menuitem', { name: '导入 ganttly JSON' })).toHaveCount(0);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: '导出 JSON' }).click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  await page.getByRole('menuitem', { name: '导出 JSON' }).press('Escape');

  // Importing from the project center creates a new project instead of
  // overwriting the current one. Drive the real input → file chooser path.
  const originalUrl = page.url();
  await page.getByRole('button', { name: 'G', exact: true }).click();
  await page.getByRole('banner').getByRole('button', { name: '新建项目', exact: true }).click();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByLabel('导入 ganttly JSON', { exact: true }).click(),
  ]);
  await fileChooser.setFiles(downloadPath!);
  await expect(page).not.toHaveURL(originalUrl);

  // Verify the row is still there with the same name.
  const restoredTask = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => { file: { tasks: Array<{ name: string; overtimeDates?: string[] }> } };
    };
    return store.getState().file.tasks[0]!;
  });
  expect(restoredTask.name).toBe(originalTask.name);
  expect(restoredTask.overtimeDates).toEqual(['2026-01-10']);
});

test('CSV export includes explicit overtime dates', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.getByRole('button', { name: '取消' }).click();
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: { tasks: Array<Record<string, unknown>> } & Record<string, unknown> };
    };
    const file = store.getState().file;
    store.setState({
      file: {
        ...file,
        tasks: file.tasks.map((task) => ({
          ...task,
          overtimeDates: ['2026-01-11', '2026-01-10'],
        })),
      },
    });
  });

  await page.getByRole('button', { name: '更多操作' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: '导出 CSV' }).click(),
  ]);
  const path = await download.path();
  expect(path).toBeTruthy();
  const csv = await readFile(path!, 'utf8');
  expect(csv).toContain('Color,OvertimeDates');
  expect(csv).toContain('2026-01-10;2026-01-11');
});

test('import .gan populates the task table', async ({ page }) => {
  await page.goto('/projects');
  await page.getByRole('banner').getByRole('button', { name: '新建项目', exact: true }).click();

  // The input is mounted in the creation dialog for the whole picker lifecycle.
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByLabel('导入 GanttProject (.gan)', { exact: true }).click(),
  ]);
  await fileChooser.setFiles(GAN_FIXTURE);

  // Several rows should now be present (the sample has many tasks).
  await expect(page.locator('[role="row"]')).not.toHaveCount(0, { timeout: 5000 });
});

test('invalid JSON stays in the create dialog and the same file can be selected again', async ({
  page,
}) => {
  await page.goto('/projects');
  await page.getByRole('banner').getByRole('button', { name: '新建项目', exact: true }).click();

  const invalidFile = {
    name: '损坏项目.ganttly.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{'),
  };
  const input = page.getByLabel('导入 ganttly JSON', { exact: true });
  const [firstChooser] = await Promise.all([page.waitForEvent('filechooser'), input.click()]);
  await firstChooser.setFiles(invalidFile);
  await expect(page.getByRole('alert')).toContainText('JSON 解析失败');
  await expect(page.getByRole('heading', { name: '新建项目', exact: true })).toBeVisible();

  // Change the visible error, then select the exact same file. The import
  // handler should run again because the native input value was reset.
  await page.getByRole('button', { name: '创建并打开', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('项目名称不能为空');
  const [secondChooser] = await Promise.all([page.waitForEvent('filechooser'), input.click()]);
  await secondChooser.setFiles(invalidFile);
  await expect(page.getByRole('alert')).toContainText('JSON 解析失败');
  await expect(page).toHaveURL(/\/projects$/);
});
