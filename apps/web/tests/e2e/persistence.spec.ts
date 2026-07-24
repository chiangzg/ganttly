import { expect, test } from '@playwright/test';

/**
 * Data-persistence test (PRD §7.6).
 *
 * Verifies that creating a task, reloading the page, still shows the task.
 * IndexedDB-backed persistence must survive a full reload.
 */

test('task survives a page reload (IndexedDB persistence)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '新建任务' })).toBeVisible();

  // Clean IndexedDB to start fresh.
  await page.evaluate(async () => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
      getState: () => {
        repo: {
          listProjects: (options: { includeDeleted: boolean }) => Promise<Array<{ id: string }>>;
          deleteProjectPermanently: (id: string) => Promise<void>;
          saveNavigationState: (state: unknown) => Promise<void>;
        };
      };
    };
    const repo = store.getState().repo;
    for (const project of await repo.listProjects({ includeDeleted: true })) {
      await repo.deleteProjectPermanently(project.id);
    }
    await repo.saveNavigationState({
      lastActiveProjectId: null,
      openTabs: [],
      favoriteProjectIds: [],
      recentProjects: [],
    });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '新建任务' })).toBeVisible();

  // Add a uniquely-named task.
  const marker = `PERSIST-MARKER-${Date.now()}`;
  await page.getByRole('button', { name: '新建任务' }).click();
  await page.locator('input[type="text"], input:not([type])').first().waitFor({ state: 'visible' });
  await page.locator('input[type="text"], input:not([type])').first().fill(marker);
  await page.locator('input[type="text"], input:not([type])').first().press('Tab');
  await page.getByRole('button', { name: '取消' }).click();

  // Wait for autosave (500ms debounce + IO).
  await page.waitForTimeout(1500);

  // Reload — the task should reappear.
  await page.reload();
  await page.waitForTimeout(500);

  await expect(page.getByText(marker)).toBeVisible({ timeout: 5000 });
});
