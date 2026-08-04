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

  // Add a uniquely-named task. The toolbar "新建任务" creates + selects it and
  // opens the drawer. Rename it and Save (transactional draft semantics —
  // editor-interaction plan §2.2: only Save commits; Cancel would discard).
  const marker = `PERSIST-MARKER-${Date.now()}`;
  await page.getByRole('button', { name: '新建任务' }).click();
  // The §4.4 task-table search bar also renders an input[type="text"]; scope
  // to the drawer (aside) so we target the task-name field, not the search box.
  const drawer = page.locator('aside');
  await drawer
    .locator('input[type="text"], input:not([type])')
    .first()
    .waitFor({ state: 'visible' });
  await drawer.locator('input[type="text"], input:not([type])').first().fill(marker);
  await drawer.getByRole('button', { name: '保存' }).click();

  // Wait for autosave (500ms debounce + IO).
  await page.waitForTimeout(1500);

  // Reload — the task should reappear.
  await page.reload();
  await page.waitForTimeout(500);

  await expect(page.getByText(marker)).toBeVisible({ timeout: 5000 });
});
