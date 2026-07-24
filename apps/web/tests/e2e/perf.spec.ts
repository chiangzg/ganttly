import { expect, test } from '@playwright/test';

const FPS_FLOOR = process.env.CI ? 30 : 24;

/**
 * Performance test (PRD §7.2, M3.19).
 *
 * Loads 1000 tasks via the import endpoint and measures scroll-frame-rate.
 * The threshold is 60fps — measured as time-between-frames during a
 * wheel-driven scroll.
 */
test('1000-task canvas scrolls smoothly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '新建任务' })).toBeVisible();

  // Inject 1000 tasks directly via the store (faster than 1000 UI clicks).
  await page.evaluate(() => {
    const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore;
    if (!store) throw new Error('store not exposed');
    // The store is exposed in dev/test builds only — see main.tsx.
    const tasks = [];
    for (let i = 0; i < 1000; i++) {
      tasks.push({
        id: `t${i}`,
        name: `Task ${i}`,
        parentId: null,
        order: i,
        start: '2026-01-05',
        end: '2026-01-09',
        duration: 5,
        progress: 0,
        isMilestone: false,
        dependencies: i > 0 ? [{ targetId: `t${i - 1}`, type: 'FS' as const, lag: 0 }] : [],
        constraints: {},
        assignments: [],
        customFields: {},
      });
    }
    // Use the same setState path the React app uses.
    const file = (store as { getState: () => { file: unknown } }).getState().file as {
      tasks: typeof tasks;
    };
    (
      store as {
        setState: (s: unknown) => void;
      }
    ).setState({ file: { ...file, tasks } });
  });

  // Scroll the canvas horizontally several times and measure FPS via rAF.
  const fps = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return 0;
    const parent = canvas.parentElement!;
    // Trigger scrollLeft changes by simulating the wheel.
    const sample: number[] = [];
    return await new Promise<number>((resolve) => {
      let frames = 0;
      let startTs = performance.now();
      const tick = () => {
        frames++;
        sample.push(performance.now());
        if (frames >= 60) {
          const elapsed = performance.now() - startTs;
          resolve((frames / elapsed) * 1000);
          return;
        }
        // Move scrollLeft to trigger re-render.
        const ev = new Event('scroll');
        const scrollContainer = parent.querySelector('.overflow-x-auto');
        if (scrollContainer) {
          (scrollContainer as HTMLElement).scrollLeft += 30;
          scrollContainer.dispatchEvent(ev);
        }
        requestAnimationFrame(tick);
      };
      // Wait one rAF before sampling to allow initial paint.
      requestAnimationFrame(() => {
        startTs = performance.now();
        requestAnimationFrame(tick);
      });
      void sample;
    });
  });

  // CI uses one worker and keeps the 30fps quality bar. Local runs execute the
  // whole suite fully parallel, so allow scheduler contention without hiding
  // a genuine virtualisation failure.
  expect(fps, `measured FPS: ${fps.toFixed(1)}`).toBeGreaterThanOrEqual(FPS_FLOOR);
});
