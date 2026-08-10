import { expect, test, type Page } from '@playwright/test';

interface TaskSeed {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  assignments?: Array<{ resourceId: string; load: number }>;
}

async function seedEditor(
  page: Page,
  tasks: TaskSeed[],
  resources: Array<{ id: string; name: string; capacity: number; role: string }> = [],
) {
  await page.goto('/');
  await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
  await page.evaluate(
    ({ seededTasks, seededResources }) => {
      const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
        setState: (state: unknown) => void;
        getState: () => { file: Record<string, unknown> };
      };
      const file = store.getState().file;
      store.setState({
        file: {
          ...file,
          tasks: seededTasks.map((task) => ({
            ...task,
            start: '2026-02-02',
            end: '2026-02-06',
            duration: 5,
            progress: 0,
            isMilestone: false,
            dependencies: [],
            constraints: {},
            assignments: task.assignments ?? [],
            customFields: {},
          })),
          resources: seededResources,
          viewState: {
            ...(file.viewState as Record<string, unknown>),
            collapsedTaskIds: [],
            selectedTaskId: null,
          },
        },
      });
    },
    { seededTasks: tasks, seededResources: resources },
  );
}

async function taskSelection(page: Page) {
  return page.evaluate(() => {
    const store = (window as unknown as { __ganttlyViewStore: unknown }).__ganttlyViewStore as {
      getState: () => { anchorTaskId: string | null };
    };
    return store.getState().anchorTaskId;
  });
}

test('task rows support continuous arrow navigation through nested summaries', async ({ page }) => {
  await seedEditor(page, [
    { id: 'parent', name: 'Parent', parentId: null, order: 0 },
    { id: 'child', name: 'Child', parentId: 'parent', order: 0 },
    { id: 'grandchild', name: 'Grandchild', parentId: 'child', order: 0 },
    { id: 'sibling', name: 'Sibling', parentId: null, order: 1 },
  ]);

  const parent = page.locator('[data-task-id="parent"]');
  const child = page.locator('[data-task-id="child"]');
  const grandchild = page.locator('[data-task-id="grandchild"]');
  await parent.click();
  await parent.press('ArrowDown');
  await expect.poll(() => taskSelection(page)).toBe('child');
  await expect(child).toBeFocused();

  await child.press('ArrowDown');
  await expect.poll(() => taskSelection(page)).toBe('grandchild');
  await expect(grandchild).toBeFocused();
  await grandchild.press('ArrowDown');
  await expect.poll(() => taskSelection(page)).toBe('sibling');
  await expect(page.locator('[data-task-id="sibling"]')).toBeFocused();
  await page.locator('[data-task-id="sibling"]').press('ArrowUp');
  await expect.poll(() => taskSelection(page)).toBe('grandchild');

  // Left first collapses the current summary, then climbs to its parent and
  // collapses that parent. Right reverses it by expanding the nearest collapsed
  // node at/after the focus: expand parent, then expand child. Focus stays on
  // whichever row was just expanded.
  await child.focus();
  await child.press('ArrowLeft');
  await expect(grandchild).toHaveCount(0);
  await child.press('ArrowLeft');
  await expect(parent).toBeFocused();
  await parent.press('ArrowLeft');
  await expect(child).toHaveCount(0);

  await parent.press('ArrowRight');
  await expect(child).toBeVisible();
  await expect.poll(() => taskSelection(page)).toBe('parent');
  // parent now expanded; next → finds the still-collapsed child and expands it.
  await parent.press('ArrowRight');
  await expect(grandchild).toBeVisible();
  await expect.poll(() => taskSelection(page)).toBe('child');
  await expect(child).toBeFocused();
});

test('arrow right on a leaf expands the next collapsed task instead of sticking', async ({
  page,
}) => {
  // 布局：root1 (展开) → leaf (叶子，无子) → root2 (有子，初始折叠)
  //         0            1                    2(折叠，child-2 不可见)
  // 在 leaf 上按 →：叶子无可展开内容，应顺方向跳到 root2 并展开它。
  await seedEditor(page, [
    { id: 'root1', name: 'Root1', parentId: null, order: 0 },
    { id: 'leaf', name: 'Leaf', parentId: 'root1', order: 0 },
    { id: 'root2', name: 'Root2', parentId: null, order: 1 },
    { id: 'child2', name: 'Child2', parentId: 'root2', order: 0 },
  ]);
  // 折叠 root2，使它成为"下一个需要展开"的目标。
  await page.locator('[data-task-id="root2"]').click();
  await page.locator('[data-task-id="root2"]').press('ArrowLeft');
  await expect(page.locator('[data-task-id="child2"]')).toHaveCount(0);

  const leaf = page.locator('[data-task-id="leaf"]');
  await leaf.click();
  // 在叶子上按 →：不应卡住，应跳到 root2 并展开它，焦点停 root2。
  await leaf.press('ArrowRight');
  await expect.poll(() => taskSelection(page)).toBe('root2');
  await expect(page.locator('[data-task-id="root2"]')).toBeFocused();
  await expect(page.locator('[data-task-id="child2"]')).toBeVisible();

  // 再按一次 →：root2 已展开、其下没有折叠节点，应什么都不做。
  await page.locator('[data-task-id="root2"]').press('ArrowRight');
  await expect.poll(() => taskSelection(page)).toBe('root2');
});

test('arrow left on an already-collapsed summary collapses the nearest expanded ancestor', async ({
  page,
}) => {
  // 布局：root (展开) → group (展开) → leaf (叶子)
  // 把焦点停在 leaf 上：leaf 无可收起子树。按 ← 应向上跳到最近一个
  // "还展开着"的祖先 group 并收起它，而不是停在 leaf 不动。
  await seedEditor(page, [
    { id: 'root', name: 'Root', parentId: null, order: 0 },
    { id: 'group', name: 'Group', parentId: 'root', order: 0 },
    { id: 'leaf', name: 'Leaf', parentId: 'group', order: 0 },
  ]);
  const leaf = page.locator('[data-task-id="leaf"]');
  await leaf.click();
  await leaf.press('ArrowLeft');
  // group 被收起 → leaf 不再可见，焦点停在 group 上。
  await expect(leaf).toHaveCount(0);
  await expect.poll(() => taskSelection(page)).toBe('group');
  await expect(page.locator('[data-task-id="group"]')).toBeFocused();
});

test('resource rows navigate selectable rows and use arrows to drill into tasks', async ({
  page,
}) => {
  await seedEditor(
    page,
    [
      {
        id: 'task-a',
        name: 'Task A',
        parentId: null,
        order: 0,
        assignments: [{ resourceId: 'resource-a', load: 100 }],
      },
    ],
    [
      { id: 'resource-a', name: 'Alice', capacity: 1, role: 'Design' },
      { id: 'resource-b', name: 'Bob', capacity: 1, role: 'Engineering' },
    ],
  );
  await page.getByRole('button', { name: '资源视图' }).click();

  const alice = page.locator('[data-resource-id="resource-a"]');
  const bob = page.locator('[data-resource-id="resource-b"]');
  await alice.focus();
  await alice.press('ArrowRight');
  const task = page.locator('[data-resource-task-id="task-a"]');
  await expect(task).toBeVisible();

  await alice.press('ArrowDown');
  await expect(task).toBeFocused();
  await expect(task).toHaveAttribute('aria-selected', 'true');

  // A task lane climbs back to its resource; the next Left collapses it.
  await task.press('ArrowLeft');
  await expect(alice).toBeFocused();
  await expect(task).toBeVisible();
  await alice.press('ArrowLeft');
  await expect(task).toHaveCount(0);

  // Repeated Right expands the resource and then enters its first task lane.
  await alice.press('ArrowRight');
  await expect(task).toBeVisible();
  await alice.press('ArrowRight');
  await expect(task).toBeFocused();

  await task.press('ArrowDown');
  await expect(bob).toBeFocused();
  await expect(bob).toHaveAttribute('aria-selected', 'true');
  await bob.press('ArrowUp');
  await expect(task).toBeFocused();
});
