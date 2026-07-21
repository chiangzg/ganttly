import { expect, test } from '@playwright/test';

/**
 * Dark mode screenshot test (PRD §2.9, §5.5).
 *
 * The app follows `prefers-color-scheme` via CSS @media (no manual toggle).
 * This test forces the browser color scheme to dark and screenshots a single
 * task to verify the dark palette actually applies to the Canvas (which reads
 * CSS variables via theme.ts).
 */

test('canvas renders in dark mode when system prefers dark', async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.getByText('已保存').or(page.getByText('保存中')).waitFor();
    await page.waitForTimeout(400);

    await page.evaluate(() => {
      const store = (window as unknown as { __ganttlyStore: unknown }).__ganttlyStore as {
        setState: (s: unknown) => void;
        getState: () => { file: Record<string, unknown> };
      };
      const f = store.getState().file;
      const task = {
        id: 'dark-t1',
        name: 'Dark task',
        parentId: null,
        order: 0,
        start: '2026-02-02',
        end: '2026-02-06',
        duration: 5,
        progress: 50,
        isMilestone: false,
        dependencies: [],
        constraints: {},
        assignments: [],
        customFields: {},
      };
      store.setState({
        file: {
          ...f,
          tasks: [task],
          viewState: {
            ...(f.viewState as object),
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
    await page.waitForTimeout(250);

    await expect(page.locator('canvas')).toHaveScreenshot('canvas-dark-mode.png', {
      maxDiffPixelRatio: 0.01,
    });
  } finally {
    await context.close();
  }
});
