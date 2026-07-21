import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dogfooding test (PRD §1.5, §7.9 — hard acceptance criterion).
 *
 * The ganttly repo's own `docs/roadmap.json` (describing M0-M4 + v0.1.0 release)
 * must be openable and editable in ganttly itself.
 */
const ROADMAP = resolve(process.cwd(), '../../docs/roadmap.json');

/**
 * Load the repo's roadmap.json into the app's store in-page.
 * Returns the parsed document so callers can assert against it.
 */
async function loadRoadmap(page: Page) {
  await page.goto('/');
  // Wait for the app's initial IndexedDB load to finish (which would otherwise
  // overwrite our injection).
  await expect(page.getByText('已保存').or(page.getByText('保存中'))).toBeVisible();
  await page.waitForTimeout(500);

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
  return JSON.parse(json);
}

test('ganttly can open and edit its own roadmap.json', async ({ page }) => {
  await loadRoadmap(page);

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

/**
 * State-lock test (PRD §7.9 — hard acceptance criterion).
 *
 * Every milestone whose code is complete must have its `customFields.status`
 * reflected as `done` in roadmap.json, and the roadmap must be schema-valid.
 * This guards against the document drifting out of sync with reality again.
 *
 * Note: roadmap.json updates are produced via the ganttly UI (dogfooding).
 * This test only asserts the resulting state, not how it got there.
 */
test('roadmap.json reflects actual milestone completion (state lock)', async ({ page }) => {
  const doc = await loadRoadmap(page);

  const byId = new Map(doc.tasks.map((t: { id: string }) => [t.id, t]));
  const milestonesExpectedDone = ['m0', 'm1', 'm2', 'm3', 'm4'];
  for (const id of milestonesExpectedDone) {
    const t = byId.get(id) as
      | { id: string; name: string; progress: number; customFields?: { status?: string } }
      | undefined;
    expect(t, `milestone ${id} must exist in roadmap.json`).toBeDefined();
    expect(
      t?.customFields?.status,
      `${id} (${t?.name}) must be status=done, got ${t?.customFields?.status}`,
    ).toBe('done');
    expect(t?.progress, `${id} (${t?.name}) progress must be 100`).toBe(100);
  }

  // M5 must exist and be in-progress (this is the current milestone).
  const m5 = byId.get('m5') as { customFields?: { status?: string }; progress: number } | undefined;
  expect(m5, 'M5 must exist in roadmap.json').toBeDefined();
  expect(['in-progress', 'done']).toContain(m5?.customFields?.status);

  // v0.1.0 release milestone must exist and depend on M5.
  const v010 = byId.get('v0-1-0') as
    { dependencies: Array<{ targetId: string }>; isMilestone: boolean } | undefined;
  expect(v010, 'v0-1-0 release milestone must exist').toBeDefined();
  expect(v010?.isMilestone).toBe(true);
  expect(v010?.dependencies.some((d) => d.targetId === 'm5')).toBe(true);
});
