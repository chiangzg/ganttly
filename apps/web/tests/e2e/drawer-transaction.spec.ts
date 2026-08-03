import { expect, test, type Page } from '@playwright/test';

/**
 * TaskDrawer transactional draft semantics E2E
 * (editor-interaction-optimization-plan §2.2).
 *
 * Acceptance criteria verified here:
 *  1. Editing a field then clicking "取消" leaves the data unchanged.
 *  2. Editing several fields (name + duration + progress) then "保存" applies
 *     them all in one commit.
 *  3. After Save, a single undo restores every changed field.
 *  4. Typing into the name field continuously does NOT create one undo record
 *     per keystroke (one save == one undo).
 *
 * The drawer's draft is the local source of truth during editing; the store
 * is touched exactly once, on Save, via updateTaskFromDraftCommand.
 */

interface FileState {
  tasks: Array<{
    id: string;
    name: string;
    start: string;
    end: string;
    duration: number;
    progress: number;
  }>;
  viewState: Record<string, unknown>;
}

interface StoreApi {
  getState: () => { file: FileState; undoStack: Array<{ label: string }> };
  setState: (s: { file: Record<string, unknown> }) => void;
}

async function injectSingleTask(page: Page) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const f = s.getState().file;
    s.setState({
      file: {
        ...f,
        tasks: [
          {
            id: 't1',
            name: '原始任务',
            parentId: null,
            order: 0,
            start: '2026-02-02',
            end: '2026-02-06',
            duration: 5,
            overtimeDates: [],
            progress: 10,
            isMilestone: false,
            dependencies: [],
            constraints: { type: 'none' },
            assignments: [],
            customFields: {},
          },
        ],
        viewState: {
          ...f.viewState,
          zoom: 'week',
          scrollLeft: 0,
          scrollTop: 0,
          selectedTaskId: null,
          showCriticalPath: false,
          collapsedTaskIds: [],
        },
      },
    });
  });
}

async function openDrawer(page: Page) {
  // Open via right-click → "编辑". Double-clicking a data cell now enters
  // inline edit (PR 8, plan §4.3), so the drawer is opened through the menu.
  const row = page.locator('[role="row"]', { hasText: '原始任务' }).first();
  await row.click({ button: 'right' });
  await page.locator('.fixed.z-30 button', { hasText: '编辑' }).first().click();
  await expect(page.getByText('编辑任务')).toBeVisible({ timeout: 3000 });
  return page.locator('aside');
}

test('修改名称后点击取消，任务名称保持原值', async ({ page }) => {
  await injectSingleTask(page);
  const drawer = await openDrawer(page);

  // Type a new name into the draft.
  const nameInput = drawer.locator('input').first();
  await nameInput.fill('被取消的修改');

  // Before clicking cancel, the store must still hold the original name (draft
  // is local; nothing dispatched).
  const storeNameBefore = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().file.tasks[0]!.name;
  });
  expect(storeNameBefore).toBe('原始任务');

  // The drawer shows the dirty-guard confirm because the draft changed.
  // Target the footer Cancel button by its visible text — the ✕ close button
  // also carries aria-label "取消", so role+name match is ambiguous. The
  // discard confirm is a Radix portal whose title AND description both contain
  // the unsaved-changes text, so scope to the heading to avoid a strict-mode
  // ambiguity.
  await page.getByText('取消', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '当前任务有未保存的修改，是否放弃？' }),
  ).toBeVisible({ timeout: 3000 });
  // Confirm discard.
  await page.getByRole('button', { name: '放弃修改' }).click();
  await page.waitForTimeout(200);

  // Store name is unchanged.
  const storeNameAfter = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().file.tasks[0]!.name;
  });
  expect(storeNameAfter).toBe('原始任务');
});

test('同时修改名称、工期、进度后保存，一次全部生效', async ({ page }) => {
  await injectSingleTask(page);
  const drawer = await openDrawer(page);

  // Name
  await drawer.locator('input').first().fill('已保存任务');
  // Duration (number input). The dependency adder also has a number input
  // (lag), so scope to the Field labelled 工期 via its preceding label text.
  const durationField = drawer.locator('label', { hasText: '工期' });
  await durationField.locator('input[type="number"]').fill('10');
  // Progress (range input)
  await drawer.locator('input[type="range"]').first().fill('80');

  await drawer.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(200);

  const t = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const x = s.getState().file.tasks[0]!;
    return { name: x.name, duration: x.duration, progress: x.progress };
  });
  expect(t.name).toBe('已保存任务');
  expect(t.duration).toBe(10);
  expect(t.progress).toBe(80);
});

test('编辑草稿期间发生实时日期更新，保存不会覆盖最新日期', async ({ page }) => {
  await injectSingleTask(page);
  const drawer = await openDrawer(page);

  await drawer.locator('input').first().fill('草稿名称');
  await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const f = s.getState().file;
    s.setState({
      file: {
        ...f,
        tasks: f.tasks.map((task) =>
          task.id === 't1' ? { ...task, start: '2026-03-02', end: '2026-03-06' } : task,
        ),
      },
    });
  });

  await drawer.getByRole('button', { name: '保存' }).click();
  const saved = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const task = s.getState().file.tasks.find((candidate) => candidate.id === 't1')!;
    return { name: task.name, start: task.start, end: task.end };
  });
  expect(saved).toEqual({
    name: '草稿名称',
    start: '2026-03-02',
    end: '2026-03-06',
  });

  await page.getByRole('button', { name: /撤销/ }).click();
  const restored = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const task = s.getState().file.tasks.find((candidate) => candidate.id === 't1')!;
    return { name: task.name, start: task.start, end: task.end };
  });
  expect(restored).toEqual({
    name: '原始任务',
    start: '2026-03-02',
    end: '2026-03-06',
  });
});

test('保存后按一次撤销，所有字段一起恢复', async ({ page }) => {
  await injectSingleTask(page);
  const drawer = await openDrawer(page);

  await drawer.locator('input').first().fill('临时名');
  const durationField = drawer.locator('label', { hasText: '工期' });
  await durationField.locator('input[type="number"]').fill('10');
  await drawer.locator('input[type="range"]').first().fill('80');
  await drawer.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(200);

  // One undo (toolbar button) must restore name + duration + progress together.
  await page.getByRole('button', { name: /撤销/ }).click();
  await page.waitForTimeout(200);

  const t = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const x = s.getState().file.tasks[0]!;
    return { name: x.name, duration: x.duration, progress: x.progress };
  });
  expect(t.name).toBe('原始任务');
  expect(t.duration).toBe(5);
  expect(t.progress).toBe(10);
});

test('连续输入任务名称不会为每个字符产生独立撤销记录', async ({ page }) => {
  await injectSingleTask(page);
  const drawer = await openDrawer(page);

  const depthBefore = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().undoStack.length;
  });

  // Type the name one character at a time (simulates a human typing fast).
  const nameInput = drawer.locator('input').first();
  for (const ch of 'ABCDEFGHIJ') {
    await nameInput.type(ch, { delay: 5 });
  }

  // While typing, NO undo records should be created (draft is local only).
  const depthWhileTyping = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().undoStack.length;
  });
  expect(depthWhileTyping - depthBefore).toBe(0);

  // Saving produces exactly ONE undo record for the whole edit.
  await drawer.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(200);
  const depthAfterSave = await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    return s.getState().undoStack.length;
  });
  expect(depthAfterSave - depthBefore).toBe(1);
});

test('有未保存修改时切换任务会先要求确认', async ({ page }) => {
  await injectSingleTask(page);
  await page.evaluate(() => {
    const s = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore as StoreApi;
    const f = s.getState().file;
    s.setState({
      file: {
        ...f,
        tasks: [
          ...f.tasks,
          {
            id: 't2',
            name: '第二个任务',
            parentId: null,
            order: 1,
            start: '2026-02-09',
            end: '2026-02-13',
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
      },
    });
  });

  const drawer = await openDrawer(page);
  await drawer.locator('input').first().fill('尚未保存');
  // Switch to the second task by opening its drawer via the WBS cell (double-
  // clicking a data cell would enter inline edit instead — PR 8 §4.3).
  await page
    .locator('[role="row"]')
    .filter({ hasText: '第二个任务' })
    .locator('[data-field="wbs"]')
    .dblclick();

  await expect(
    page.getByRole('heading', { name: '当前任务有未保存的修改，是否放弃？' }),
  ).toBeVisible();
  await expect(drawer.locator('input').first()).toHaveValue('尚未保存');

  await page.getByRole('button', { name: '放弃并切换' }).click();
  await expect(drawer.locator('input').first()).toHaveValue('第二个任务');
});
