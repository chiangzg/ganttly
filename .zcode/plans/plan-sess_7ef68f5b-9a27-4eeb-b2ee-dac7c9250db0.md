# 修复任务折叠联动与自动聚合的所有问题

基于上一轮 review 识别的 9 个问题，按优先级实施。所有改动都贴合代码库现有约定（Command 模式、纯函数 rollup、Zustand store 在 `window.__ganttlyStore` 暴露给 E2E）。

---

## P0 必修：正确性 Bug

### Fix 1 — 嵌套 summary 进度计算错误（`apps/web/src/lib/summary.ts`）

**问题**：`computeRollup` 对 summary 子节点用陈旧的 `child.progress`，而非 `rollupMap[child.id].progress`，导致多级嵌套根节点进度恒为 0。

**改法**：在 `computeRollup`（第 47-88 行）的循环里，对 summary 子节点用 rolled-up progress：
```ts
const childRollup = rollupMap?.get(child.id);
const weight = childRollup ? childRollup.duration : child.duration;
const progress = childRollup ? childRollup.progress : child.progress; // 新增
...
weightedProgressSum += progress * weight;
if (progress < 100) allComplete = false;
```

**同时修正错误期望的测试**（`apps/web/tests/unit/lib/summary.test.ts:95`）：
- 当前 `expect(patches[1]!.patch.progress).toBe(0)` 把 bug 钉死了
- 修正为 `toBe(80)`（孙节点 80% → 父 80% → 根 80%）

并新增一个**多层非对称嵌套**测试用例，确保根进度正确冒泡（不是 0）：
```
root
├─ mid (summary)
│   └─ leaf1 (duration=4, progress=50)
└─ leaf2 (duration=6, progress=100)
→ mid.progress = 50, mid.duration = 4
→ root: weight(mid)=4, weight(leaf2)=6
       (50*4 + 100*6) / (4+6) = 800/10 = 80
expect root.progress === 80  ← 当前实现会得到错误结果
```

### Fix 2 — `moveTaskWithRollupCommand` 漏算父级自身（`apps/web/src/store/useProjectStore.ts`）

**问题**：`computeCascadeRollup(tasks, oldParentId)` 只重算 `oldParentId` 的**祖先**，漏掉 `oldParentId` 自己；new parent 链同理。拖动任务离开父级后，父级自身的日期/进度不会收缩。

**改法**：在 `summary.ts` 新增导出函数 `recomputeSelfAndAncestors(tasks, taskId)`，先重算 `taskId` 自身（如果它是 summary），再冒泡祖先。需要把现有 `computeCascadeRollup` 的内部实现重构为 `computeCascadeRollupWithMap(tasks, taskId, initialMap)`（接收预填的 rollupMap），原 `computeCascadeRollup` 变成薄包装。`GanttCanvas.tsx` 拖拽路径保持用 `computeCascadeRollup`（被拖的是叶子，不需要重算自身）。

`moveTaskWithRollupCommand` 中两处 `computeCascadeRollup(tasks, oldParentId/newParentId)` 替换为 `recomputeSelfAndAncestors(...)`。旧/新父级在 `=== null` 时跳过；taskId 自身的移动 patch 已单独捕获。

**补单测**（新建 `apps/web/tests/unit/store/move-rollup.test.ts`）：
- 拖动 `child` 从 `parent`（原本只有 child 一个子任务）出到顶层 → `parent` 变为叶子，progress 不再被 rollup 覆盖
- 拖动 `child` 从 `parent`（还有 sibling）出到顶层 → `parent` 的 progress 从加权平均重算（不含 child）

---

## P1 应修

### Fix 3 — E2E 测试重写为真正断言（`apps/web/tests/e2e/collapse-rollup.spec.ts`）

**问题**：collapse 测试的断言包在 `if (isVisible())` 里默认空转；font-semibold 测试只验证叶子没有 summary 样式。

**改法**：用项目已建立的 `window.__ganttlyStore` 注入模式（参考 `today.spec.ts:33-64`、`perf.spec.ts:14-45`）注入真实父子结构，再做有意义的断言。重写整个文件，文件内抽一个 `injectTree(page, tasks)` helper 减少重复。三个测试：
1. 注入 parent→[child1,child2]，断言行数 3→点折叠→1→点展开→3
2. 第一行 parent 的 name 单元格含 `font-semibold`
3. 编辑 child progress 到 80，通过 `page.evaluate` 读 store 断言 parent.progress === 80

### Fix 4 — CPM 喂入 rollup 后的 summary 日期（`apps/web/src/engine/scene/assembly.ts`）

**问题**：`assembly.ts:37-45` 的 `.map` 只展开 `...t` 不做变换，注释说「下面替换」但下面没有，CPM 用 summary 陈旧的 start/duration。

**改法**：把 `allRollups` 的计算提到 cpm 之前，用 rollup 的 start/duration 覆盖 summary 任务后喂给 `computeCriticalPath`。确认过 `computeCriticalPath` 只读 `start` + `duration`（不读 end），所以只覆盖这两项。删除那段「we replace ... below」的误导性注释。

---

## P2 建议：风格/健壮性

### Fix 5 — `ROLLUP_FIELDS` 提到模块顶层（`apps/web/src/components/TaskDrawer.tsx`）
移出组件函数体放到模块顶层，避免每次渲染重建。

### Fix 6 — Command 捕获逻辑抽 helper（`apps/web/src/store/useProjectStore.ts`）
抽一个内部 helper `applyPatchAndCapture(tasks, id, patch, captured)`，在 `updateTaskWithRollupCommand` 和 `moveTaskWithRollupCommand` 的三处重复块里调用。减少 ~30 行重复代码，避免未来 drift。

### Fix 7 — `GanttCanvas.tsx` 拖拽 IIFE 抽 helper
抽 `applyDragWithRollup(tasks, draggedId, next, durationOf)`，内部用单次 `.map` + `Map<id, patch>` 合并所有祖先 patch（O(n) 而非 O(patches × n)）。调用处从 IIFE 变成一行。

### Fix 8 — `drag.ts` summary 命中加注释（`apps/web/src/engine/interaction/drag.ts`）
第 35 行 `if (row.isSummary)` 上面补注释，说明这是禁拖（非禁选中）的临时实现，未来右键菜单/选中若需要可在该处分支。

### Fix 9 — `assembly.ts` `hasChildren` 基于 file.tasks（`apps/web/src/engine/scene/assembly.ts`）
预计算 `summaryIds: Set<string>`（基于完整 `file.tasks`，与 Fix 4 的遍历合并）传入 `toTaskRow`，避免折叠时 summary 因子节点不在 visible 而退化成普通 bar。删掉 `hasChildren` 函数。

---

## 测试与验证

1. 单元测试：`cd apps/web && pnpm vitest run tests/unit/lib/summary.test.ts tests/unit/store/history.test.ts tests/unit/store/move-rollup.test.ts`
2. E2E：`cd apps/web && pnpm playwright test collapse-rollup`
3. 类型检查：`pnpm -F @ganttly/web typecheck`（或 tsc --noEmit）
4. **不更新截图基线**——本批改动不涉及 summary bar 视觉变化（bars.ts 在上一轮已改），重写 E2E 也不改外观

## 风险

- **Fix 4 的副作用**：CPM 改用 rollup 的 start/duration 后，关键路径结果可能变化。这是正确行为（summary 本就应反映子任务时间）。理论上不应影响叶子任务的高亮集（叶子 ES/EF 不依赖 summary 自填值——除非显式依赖 summary）。先跑一次看 diff，若只影响 summary 行高亮属预期。
- **Fix 2 的 invert 正确性**：`recomputeSelfAndAncestors` 返回的 patch 列表里，自身 + 祖先的旧值都进 `capturedOldValues`；invert 逻辑不变。taskId 自身的移动 patch（改 parentId/order）与 rollup patch（改 start/end/duration/progress）字段不重叠，合并捕获无冲突。
- **E2E 稳定性**：依赖 `已保存/保存中` 文案判定 store 就绪；注入用 `(window as any)` 简化类型（与项目其它 E2E 一致）。