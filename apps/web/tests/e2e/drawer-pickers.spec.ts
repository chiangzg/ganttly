import { expect, test, type Page } from '@playwright/test';

/**
 * TaskDrawer pickers E2E (2026-09 interaction redesign).
 *
 * Covers the three redesigned interactions:
 *  - Resource assignment: searchable Combobox with pinyin-initial matching
 *    ("jzg" → 蒋志国); selecting an option commits the assignment
 *    immediately (no separate "+" step).
 *  - Color: preset swatch grid; clicking a swatch sets task.color, the
 *    "默认" cell clears it back to auto, and the hidden native picker
 *    (custom tile) accepts an arbitrary hex.
 */

interface StoreApi {
  getState: () => {
    file: {
      tasks: Array<Record<string, unknown>>;
      resources: Array<Record<string, unknown>>;
    };
  };
  setState: (s: { file: Record<string, unknown> }) => void;
}

async function injectFixture(page: Page) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as StoreApi;
    const f = store.getState().file;
    store.setState({
      file: {
        ...f,
        tasks: [
          {
            id: 't1',
            name: '开发',
            parentId: null,
            order: 0,
            start: '2026-02-02',
            end: '2026-02-06',
            duration: 5,
            overtimeDates: [],
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: { type: 'none' },
            assignments: [],
            customFields: {},
          },
        ],
        resources: [
          { id: 'r1', name: '蒋志国', capacity: 1.0, role: '前端' },
          { id: 'r2', name: 'Alice', capacity: 1.0, role: '后端' },
        ],
      },
    });
  });
  await page.waitForTimeout(250);
}

async function openDrawer(page: Page) {
  const row = page.locator('[role="row"]', { hasText: '开发' }).first();
  await row.click({ button: 'right' });
  await page.locator('.fixed.z-30 button', { hasText: '编辑' }).first().click();
  await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 3000 });
  return page.locator('aside');
}

test('resource picker matches pinyin initials and selecting commits the assignment', async ({
  page,
}) => {
  await injectFixture(page);
  const drawer = await openDrawer(page);

  const resourceSection = drawer.locator('section', { hasText: '资源分配' });
  await resourceSection.getByRole('button', { name: '添加资源' }).click();

  // Pinyin initials "jzg" match 蒋志国 but not Alice.
  const search = page.getByPlaceholder('输入名称或拼音首字母…');
  await search.fill('jzg');
  await expect(page.getByRole('option', { name: /蒋志国/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Alice/ })).toHaveCount(0);

  // Selecting commits immediately with the default 50% load — the picker
  // stays open for consecutive adds.
  await page.getByRole('option', { name: /蒋志国/ }).click();
  const row = drawer.getByTestId('assignment-row').filter({ hasText: '蒋志国' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('50%');
  await expect(page.getByPlaceholder('输入名称或拼音首字母…')).toHaveValue('');

  // Full-name search still works for the remaining candidate.
  await search.fill('Alice');
  await expect(page.getByRole('option', { name: /Alice/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Draft semantics: the store is only written on explicit Save.
  await drawer.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(150);
  const saved = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.tasks[0]!.assignments;
  });
  expect(saved).toEqual([{ resourceId: 'r1', load: 50 }]);
});

test('color swatches commit on click, 默认 clears, custom picker accepts hex', async ({ page }) => {
  await injectFixture(page);
  const drawer = await openDrawer(page);

  // Preset swatch: one click applies it.
  await drawer.getByRole('button', { name: '#fbbf24', exact: true }).click();
  await drawer.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(150);
  let color = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.tasks[0]!.color;
  });
  expect(color).toBe('#fbbf24');

  // Reopen: the custom tile (hidden native picker) accepts an arbitrary hex.
  await openDrawer(page);
  await drawer.locator('input[type="color"]').fill('#123456');
  await drawer.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(150);
  color = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.tasks[0]!.color;
  });
  expect(color).toBe('#123456');

  // Reopen: 默认 clears the override back to auto (undefined).
  await openDrawer(page);
  await drawer.getByRole('button', { name: '默认', exact: true }).click();
  await drawer.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(150);
  color = await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as StoreApi;
    return store.getState().file.tasks[0]!.color;
  });
  expect(color).toBeUndefined();
});
