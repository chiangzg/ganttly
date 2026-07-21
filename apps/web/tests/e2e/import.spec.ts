import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

  // Capture the task via the exposed store for later comparison.
  const originalName = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => { file: { tasks: Array<{ name: string }> } };
    };
    return store.getState().file.tasks[0]!.name;
  });

  // Trigger JSON export and intercept the download.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '导出 JSON' }).click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();

  // Read the downloaded JSON back, inject it via the store directly
  // (simulating an import round-trip).
  const json = readFileSync(downloadPath!, 'utf-8');
  await page.evaluate((payload) => {
    const data = JSON.parse(payload);
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      setState: (s: unknown) => void;
      getState: () => { file: unknown };
    };
    store.setState({ file: data });
  }, json);

  // Verify the row is still there with the same name.
  const restoredName = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => { file: { tasks: Array<{ name: string }> } };
    };
    return store.getState().file.tasks[0]!.name;
  });
  expect(restoredName).toBe(originalName);
});

test('import .gan populates the task table', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[role="row"]')).toHaveCount(0);

  // Drive the import through the real UI: set the file on the hidden <input>.
  // Playwright's setInputFiles handles the file picker path automatically.
  await page.locator('input[type="file"][accept*=".gan"]').setInputFiles(GAN_FIXTURE);

  // Several rows should now be present (the sample has many tasks).
  await expect(page.locator('[role="row"]')).not.toHaveCount(0, { timeout: 5000 });
});
