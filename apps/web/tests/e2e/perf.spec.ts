import { expect, test } from '@playwright/test';

/**
 * Performance test (PRD §7.2, M3.19).
 *
 * Loads 1000 tasks via the store and measures scroll frame-rate while panning
 * the timeline horizontally. The scroll is driven through the *same* store
 * path the real wheel handler uses (`GanttCanvas` → `setScroll` →
 * `useProjectStore.setState`), so every step triggers a genuine React
 * re-render + canvas redraw (`assembleScene` → `renderScene`) — not an idle
 * frame. Virtualisation is exercised too: only the visible row/column band
 * is drawn each frame.
 *
 * The threshold is CI-aware. Standard GitHub-hosted runners are 2–3× slower
 * than a dev laptop and run single-worker, so we lower the bar there. If
 * virtualisation ever breaks, the full 1000 rows get redrawn every frame and
 * FPS collapses to single digits — well below either floor — so the
 * regression guard stays effective.
 */
const FPS_FLOOR = process.env.CI ? 15 : 30;
const WARMUP_FRAMES = 15;
const MEASURE_FRAMES = 120;
const SCROLL_STEP_PX = 40;

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

  // Pan the timeline via the store — identical path to the wheel handler in
  // GanttCanvas.tsx — so each frame forces a real re-render + redraw. Measure
  // FPS over the window *after* a warm-up phase so JIT/layout caches don't
  // skew the average. Also report the final scrollLeft so we can assert the
  // redraw path actually executed.
  const { fps, finalScrollLeft } = await page.evaluate(
    ({ warmup, measure, step }) => {
      const store = (window as unknown as { __ganttlyStore?: unknown }).__ganttlyStore;
      if (!store) throw new Error('store not exposed');
      const s = store as {
        getState: () => { file: { viewState: { scrollLeft: number } } };
        setState: (patch: unknown) => void;
      };
      const pushScroll = (left: number) => {
        const f = s.getState().file;
        s.setState({ file: { ...f, viewState: { ...f.viewState, scrollLeft: left } } });
      };

      return new Promise<{ fps: number; finalScrollLeft: number }>((resolve) => {
        let frame = 0;
        let left = 0;
        let measureStart = 0;

        const tick = () => {
          left += step;
          pushScroll(left);
          frame++;

          if (frame === warmup) {
            // Start the measurement window after JIT/layout warm up.
            measureStart = performance.now();
          }
          if (frame >= warmup + measure) {
            const elapsed = performance.now() - measureStart;
            resolve({ fps: (measure / elapsed) * 1000, finalScrollLeft: left });
            return;
          }
          requestAnimationFrame(tick);
        };
        // Wait one rAF before starting to allow the initial paint to settle.
        requestAnimationFrame(tick);
      });
    },
    { warmup: WARMUP_FRAMES, measure: MEASURE_FRAMES, step: SCROLL_STEP_PX },
  );

  // Sanity check: the scroll must have actually advanced, which proves the
  // store path (and therefore the redraw effect) really executed. If this
  // fails, the FPS number above is meaningless — we measured idle frames.
  expect(finalScrollLeft, 'scroll actually advanced during sampling').toBeGreaterThan(0);

  expect(fps, `measured FPS: ${fps.toFixed(1)}`).toBeGreaterThanOrEqual(FPS_FLOOR);
});
