import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dogfooding test (PRD §1.5, §7.9 — hard acceptance criterion).
 *
 * The ganttly repo's own `docs/roadmap.json` (describing M0-M4 + v0.1.0 release)
 * must be openable and editable in ganttly itself.
 */
const ROADMAP = resolve(process.cwd(), '../../docs/roadmap.json');

test('ganttly can open and edit its own roadmap.json', async ({ page }) => {
  await page.goto('/');
  // Wait for the app's initial IndexedDB load to finish (which would otherwise
  // overwrite our injection).
  await expect(page.getByText('已保存').or(page.getByText('保存中'))).toBeVisible();
  await page.waitForTimeout(500);

  // Load the roadmap.json by injecting it via the store.
  const json = readFileSync(ROADMAP, 'utf-8');
  const loaded = await page.evaluate((payload) => {
    try {
      const data = JSON.parse(payload);
      const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as
        | { setState: (s: unknown) => void; getState: () => { file: { tasks: unknown[] } } }
        | undefined;
      if (!store) return { ok: false, reason: 'store missing' };
      store.setState({ file: data });
      return { ok: true, count: store.getState().file.tasks.length };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }, json);
  expect(loaded.ok, JSON.stringify(loaded)).toBe(true);

  // The roadmap has 5 milestones + several task groups — rows should appear.
  await expect(page.locator('[role="row"]')).not.toHaveCount(0);

  // Verify some milestone names render.
  await expect(page.getByText('M0 — 工程地基')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('◆v0.1.0 发布')).toBeVisible();

  // Verify a task can be edited: open the drawer and change the name.
  const m1Row = page.locator('[role="row"]', { hasText: 'M1 —' }).first();
  await m1Row.dblclick();
  await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 5000 });

  // The drawer's name field is the visible text input (not the hidden file inputs).
  const nameField = page.locator('input[type="text"], input:not([type])').first();
  await nameField.waitFor({ state: 'visible' });
  await nameField.fill('M1 — 数据 + 引擎核心(已完成)');
  await nameField.press('Tab'); // commit via blur

  // Verify the rename landed in the table.
  await expect(page.getByText(/已完成/)).toBeVisible();
});
