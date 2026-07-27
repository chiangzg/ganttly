import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

/**
 * Round-trip + .gan import E2E (PRD §3.9, M4.7-M4.8).
 *
 * Verifies:
 * 1. Export → Import keeps the data intact (round-trip)
 * 2. Importing a real `.gan` file populates the task table
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

  // Open the "more actions" dropdown. Export/Import items live inside a Radix
  // DropdownMenu and now render with role="menuitem".
  await page.getByRole('button', { name: '更多操作' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: '导出 JSON' }).click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();

  // Importing creates a new project instead of overwriting the current one.
  // Drive the REAL click path (button → native file picker) rather than
  // shoving the file straight onto the <input>: that bypassed the bug where
  // the dropdown unmounted and the picker never opened.
  const originalUrl = page.url();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: '导入 ganttly JSON' }).click(),
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
  await page.goto('/');
  await expect(page.locator('[role="row"]')).toHaveCount(0);

  // Drive the import through the real UI: click the menu item and let the
  // native file picker open, then hand the file to the chooser. This exercises
  // the exact path a user takes (regression guard for the dropdown-unmount bug).
  await page.getByRole('button', { name: '更多操作' }).click();
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('menuitem', { name: '导入 GanttProject (.gan)' }).click(),
  ]);
  await fileChooser.setFiles(GAN_FIXTURE);

  // Several rows should now be present (the sample has many tasks).
  await expect(page.locator('[role="row"]')).not.toHaveCount(0, { timeout: 5000 });
});
