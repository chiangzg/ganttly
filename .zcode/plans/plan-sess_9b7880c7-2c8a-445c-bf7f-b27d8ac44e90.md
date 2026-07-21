# 甘特图三个问题修复方案

## 问题 1：左侧任务明细挤在一起/错位

**根因**：`TaskTable.tsx`
- 表头行声明了 `gridTemplateColumns: '40px 1fr 80px 80px'`（line 167），但每个**数据行只有 `grid` 类名、没有 `gridTemplateColumns`**（line 208），列宽按每行内容自适应，导致 WBS/工期/进度列与表头对不齐，长任务名挤压。
- `TABLE_WIDTH = 360` 偏窄，长中文任务名（如"财务开票金额支持白名单配置"）会换行/截断（行高固定 `ROW_HEIGHT=32`，绝对定位，换行即被裁掉）。

**修复**（`apps/web/src/components/TaskTable.tsx`）：
1. 把列模板抽成常量 `GRID = '44px 1fr 72px 64px'`，表头（line 167）和数据行（line 208）共用，保证严格对齐。
2. `TABLE_WIDTH` 由 360 加宽到 **420**，给任务名列更多空间。
3. 任务名 cell 加 `min-w-0`（line 219），让 `truncate` 真正生效（flex/grid 子项需 `min-w-0` 才能 ellipsis 截断）。
4. 工期/进度列右对齐 + `tabular-nums`，视觉更整齐。

## 问题 2：图表区不支持触摸板/鼠标滚动，看不到可视区外任务

**根因**：`GanttCanvas.tsx`
- `onWheel`（line 201）在未按 Ctrl/Cmd 时**直接 return** → 普通滚轮/触摸板滚动什么都不做。
- canvas 带 `touch-none` 类、外层容器 `overflow-hidden` → 不支持触摸滚动。
- 空白处点击只清除选中（line 88-90）→ 不支持拖拽平移。
- 水平滚动唯一的入口是底部 12px 的 `ScrollShim`，且其 `contentWidth` **硬编码 4000**（line 229），与真实日期范围不符。
- canvas 侧**没有垂直滚动条**，垂直滚动必须滚左侧面板；且 `scrollRef` 未与 store 双向同步（store 变化时不会把左侧面板滚到对应位置）。

**修复**（`apps/web/src/components/GanttCanvas.tsx`，并小幅调整 store 的 setViewStateCommand 调用）：
1. **改写 `onWheel`**（line 201-208）：
   - 保留 `Ctrl/Cmd + 滚轮 = 缩放`。
   - 其它情况 `e.preventDefault()` 后做平移：
     - 触摸板（deltaX 非零或 `e.ctrlKey===false && |deltaY| 较小且 e.deltaMode===0`）→ `deltaX` 滚水平、`deltaY` 滚垂直。
     - 鼠标滚轮（仅 deltaY）→ 默认垂直滚动；按住 Shift → 水平滚动。
   - 平移更新 `scrollLeft/scrollTop`，走 `useProjectStore.setState(...)` 直接改 viewState（不走 dispatch，避免污染 undo 栈——与现有 ScrollShim 行为一致）。
2. **空白处拖拽平移（手型工具）**（改 `onPointerDown` line 88-90、`onPointerMove`、`onPointerUp`）：
   - 当 `hit.kind === 'empty'`：记录起点 `{ x, y, startScrollLeft, startScrollTop }`，进入 `dragRef = { kind: 'pan', ... }`，设置 `cursor: grabbing`。
   - `onPointerMove` 中若是 pan：`scrollLeft = startScrollLeft - (x - downX)`，`scrollTop = startScrollTop - (y - downY)`，直接 setState。
   - 区分"点击空白清除选中"与"拖拽平移"：移动距离 < 3px 视为点击，仍清除选中；否则进入平移并不清除选中。
3. **修正 `ScrollShim`**（line 226-246）：
   - `contentWidth` 改为根据真实日期范围动态计算：用 `dateRangeWidth(originDate, latestTaskEnd, zoom) + viewportWidth`（originDate 复用 `assembly.originDateFor`，需把该函数从 assembly.ts 导出，或抽到 layout 共享）。这样滚动条总宽度正确，能滚到最远任务。
   - 由于 wheel 已支持水平滚动，ScrollShim 主要作为可见的滚动条 UI 保留。
4. **左侧面板 ↔ canvas 垂直滚动双向同步**（`TaskTable.tsx`）：
   - 增加 `useEffect` 监听 `file.viewState.scrollTop`，当它与 `scrollRef.current.scrollTop` 不一致时（且不是当前面板自身触发的滚动），用 `scrollRef.current.scrollTo({ top })` 把左侧面板滚到对应位置。这样在 canvas 上滚轮垂直滚动时，左侧任务表会跟着同步。

## 问题 3：点击"今天"按钮定位不到今天

**根因**：`Toolbar.tsx:42-46` 的 `jumpToToday`：
```ts
const px = dateToPixel(today, file.tasks[0]?.start ?? today, file.viewState.zoom);
dispatch(setViewStateCommand({ scrollLeft: Math.max(0, px - 200) }));
```
- 用 `file.tasks[0]?.start ?? today` 当原点，但渲染器（`assembly.ts:186-195` 的 `originDateFor`）实际用 `min(最早任务 start, project.startDate ?? '2026-01-05')`。**两个原点不一致** → 算出的"今天"像素位置错位 → 视口停在了 2 月而不是 7 月。
- 红色"今天"竖线（`overlay.ts:15`）由渲染器按真实 originDate 绘制，所以线和按钮目标对不上。
- 固定 `-200px` 偏移没考虑视口宽度。

**修复**（`Toolbar.tsx` + `assembly.ts`）：
1. 把 `originDateFor` 从 `assembly.ts` 导出（当前是私有函数），在 `jumpToToday` 中**用同一个 `originDateFor(file)` 作为原点**算 px，保证与渲染器一致（今天线落在视口正中）。
2. 偏移量改为 `px - viewportWidth/2`，让今天居中。视口宽度从 `useProjectStore` 外部取不到，可在 Toolbar 用一个 ref/state 拿 chart 容器宽度；或更简单：在 GanttCanvas 计算并写入 store（新增 `viewportWidth` 到 viewState）——评估后采用**更轻量方案**：Toolbar 通过 `document.querySelector` 读取 canvas 容器宽度（仅在该 handler 内一次性读取，不引入新状态）。
3. `jumpToToday` 也顺带把 `scrollTop` 调整到第一个今天及之后的任务（可选，先只做水平；如用户反馈再加垂直）。
4. 走 `useProjectStore.setState` 而非 `dispatch`，避免"今天"点击污染 undo 栈（与滚动同源，本就不该进 undo）。

## 涉及文件
| 文件 | 改动 |
|---|---|
| `apps/web/src/components/TaskTable.tsx` | 列模板常量化、加宽、min-w-0、scrollTop 双向同步 |
| `apps/web/src/components/GanttCanvas.tsx` | onWheel 平移、空白拖拽平移、ScrollShim 动态宽度 |
| `apps/web/src/components/Toolbar.tsx` | jumpToToday 用真实 originDate + 居中、改 setState |
| `apps/web/src/engine/scene/assembly.ts` | 导出 `originDateFor`（供 Toolbar 复用） |

## 测试与验证
- 运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`（单元 140 个）确保不回归。
- 跑 `pnpm test:e2e`（含 render / smoke / perf），重点看 render 快照与 perf 是否仍绿；如 render 快照因列宽变化而 diff，更新快照（`pnpm exec playwright test --update-snapshots`）。
- 新增/补充 e2e：`tests/e2e/today.spec.ts`（点"今天"后断言视口中心日期 ≈ 今天，通过读取 store 的 scrollLeft + 真实 originDate 反算）、滚动交互冒烟（wheel 改 scrollLeft）。
- 手动验证：`pnpm dev` 打开，逐项核对三个问题的修复效果（左侧列对齐、长任务名截断、触摸板/滚轮/拖拽平移、今天按钮定位到今天竖线居中）。

## 注意事项
- 旧实现把滚动走了 `dispatch(setViewStateCommand(...))`，会污染 undo 栈（每滚一格就多一条"视图变更"）。本次把滚动/平移统一改为 `setState` 直改，**顺手修掉这个隐藏问题**；若你希望保留滚动可撤销，告知我改回去。
- `originDateFor` 导出后会多一个公开 API，保持其签名不变。
- 拖拽平移与"在空白处点击清除选中"需做位移阈值判断（3px），避免误触发。