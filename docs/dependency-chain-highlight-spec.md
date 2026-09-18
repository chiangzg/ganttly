# ganttly 任务依赖链高亮（点击追踪向前/向后链路）

| 字段     | 值                                                         |
| -------- | ---------------------------------------------------------- |
| 文档状态 | Implemented                                                |
| 目标版本 | v0.12（建议）                                              |
| 适用范围 | 任务甘特视图 · 依赖链追踪与聚光灯高亮                      |
| 最后更新 | 2026-09-18                                                 |
| 目标读者 | 代码评审者、后续维护与扩展（批量分配、资源视图等）的实现者 |

本文是依赖链高亮特性的自包含交接文档。实现以本文的交互语义、视觉规格和边界行为为准。

---

## 1. 背景与目标

用户在复杂项目里点击一个任务时，只能看到它自己的信息（tooltip 里有前置/后置**计数**），看不出它在依赖网络中的位置：

- 它**被哪些任务依赖**（向后 = 未来要做什么，改了它会影响谁）；
- 它**依赖了哪些任务**（向前 = 之前完成了什么，动它之前要确认什么）。

本特性让单击一个任务即高亮其**完整传递依赖链**：向前是"已完成路径"，向后是"向下传递的未来"，配合聚光灯淡化无关内容，形成现代节点编辑器（React Flow / Blender Geometry Nodes）式的聚焦体验。

### 1.1 用户确认的决策

| 决策点     | 结论                                                                  |
| ---------- | --------------------------------------------------------------------- |
| 触发方式   | **单击即高亮**：跟随单选，点空白 / Esc / 改选即切换或消失，零学习成本 |
| 聚光灯强度 | **淡化无关任务 + 连线**：链路外任务条 ~45% 透明、无关箭头近乎隐去     |

## 2. 交互定义（§2）

- **触发**：`useViewStore.selectedTaskIds.size === 1` 时，唯一选中任务即链路 origin。画布单击、左侧树点选、键盘导航选中均生效（同一 store）。
- **多选**（Ctrl/Cmd/Shift）：`size > 1` 时**不显示**链路 —— 多选是批量操作上下文，亮出某一成员的链路是噪音。
- **清除/切换**：全部走现有选中流程（点空白 `clearSelection`、Esc、改选其他任务），本特性零新增交互代码。
- 双击开抽屉、拖拽、连线、右键菜单等手势不受影响（双击前的两次 click 会有瞬时链路闪烁，可接受）。
- 折叠隐藏的链上任务：箭头照现状不渲染，**不自动展开**祖先。
- 与关键路径开关、基线对比、搜索/过滤并存（见 §6）。

## 3. 视觉规范（§3）

### 3.1 向前 / 上游（前置 · 已完成路径，静止）

- 颜色：翡翠绿 `--color-dep-upstream`（亮 `#10b981` / 暗 `#34d399`）。
- 线型：实线 2px，圆角圆头；下面垫一条同色宽 5px、alpha 0.18 的**柔和底光** —— "已落地"的沉稳质感，无任何运动。
- 箭头：同色实心，尺寸 7（比常规 6 略大）。
- 链上任务条：2px 同色描边（里程碑画同色菱形环）。

### 3.2 向后 / 下游（后续 · 向下传递，脉冲）

- 颜色：青色 `--color-dep-downstream`（亮 `#06b6d4` / 暗 `#22d3ee`）。
- 基础线型：实线 2px + 同色箭头（尺寸 7）。
- **流动虚线**：白色（alpha 0.85）2.5px、dash `[1.5, 9]`，`lineDashOffset = -(now/45) mod 10.5`，沿 tail→head 方向流动。
- **游走脉冲点**：白色圆点 r=3.2、同色 shadowBlur 10，沿路由折线弧长匀速游走；单边周期 1600ms，按后继任务的 BFS 深度错峰 220ms/层，sin 包络在端点淡入淡出 —— 体现"从 origin 层层向下传递"。
- 链上任务条：2px 同色描边（里程碑同色菱形环）。

### 3.3 优先级表（每条边，从高到低）

| 优先级 | 样式                 | 透明度            |
| ------ | -------------------- | ----------------- |
| 1      | 冲突橙 `#f97316` 2px | 1（错误永不淡化） |
| 2      | 链路色（上游/下游）  | 1                 |
| 3      | 关键路径红 2px       | 链路激活时 0.35   |
| 4      | 常规灰 1px           | 链路激活时 0.15   |

### 3.4 任务条与 origin

- origin（被点击任务）：保留主色选中环 + **呼吸光晕**（主色外环，alpha 0.25↔0.55、周期 1600ms）—— "涟漪的源头"，用选中色而非链路色，读作"焦点"。
- 链上其余任务：方向色 2px 描边（取代非选中态的 1px darken 描边）。
- 关键路径开着时，链上任务的条色仍按关键路径红渲染（描边换成链路色）。

### 3.5 聚光灯

- 链路外的叶子任务条 + 画布标签：整体 alpha 0.45（经 `DrawCtx.baseAlpha` 贯穿传播，含基线轨道等内层 alpha 写入）。
- 链路成员的**祖先摘要条**保持全亮（WBS 上下文可读），其余摘要条淡化。
- 网格、今日线不变。

### 3.6 图例

画布右下角玻璃拟态 pill（`DependencyChainLegend.tsx`，DOM）：
绿点 + "前置链路 · 已完成路径"、青点（CSS ping）+ "后续链路 · 向下传递"、分隔线后计数 "N 个前置 · M 个后续"。链路激活且非空时显示；`pointer-events-none` 不挡交互。

### 3.7 可访问性（prefers-reduced-motion）

- 不启动 RAF 循环；下游画**静态**白色虚线 `[3, 5]` alpha 0.5（仍与上游的实线+底光区分）。
- origin 光晕静止在中间值；图例青点的 CSS ping 用 Tailwind `motion-reduce:animate-none` 停止。

## 4. 数据与遍历（§4）

`packages/domain/src/dependencyGraph.ts`：

```ts
computeDependencyClosure(tasks, originId): {
  originId: string;
  upstream: Map<taskId, depth>;   // 传递前置，直接前置 depth=1
  downstream: Map<taskId, depth>; // 传递后继，直接后继 depth=1
} | null   // originId 不在任务表中时返回 null
```

- **原始图语义**：与 `computeArrows` 渲染的边一致，不是 CPM 的叶子图 —— 存量数据里指向摘要的边也要能高亮。
- 双向 BFS：**最短深度**（无论边序），深度供脉冲错峰；visited 集天然容忍成环存量数据；缺失 `targetId` 与自环跳过。
- `origin` 永远不出现在两个 map 里。

## 5. 渲染集成（§5）

### 5.1 Scene 组装（`assembly.ts`）

- origin 判定：`selectedTaskIds.size === 1` 时取集合唯一元素（即锚点；**不读**持久化的 `viewState.selectedTaskId`，它跨刷新存活而临时选中不是）。
- `Scene.depChain = { originId, upstream, downstream, relatedSummaryIds }`；`relatedSummaryIds` 由链成员沿 `parentId` 上溯标记（防父环）。
- 每条箭头按**诱导子图**标注 `chainRole`：边 pred→succ 属下游 ⟺ (pred===origin ∨ downstream.has(pred)) ∧ downstream.has(successor)；上游对称。成环数据里可能双身份，**下游优先**。
- 闭包每次组装算一次，O(V+E)，与 CPM 同量级（<1ms/数百任务）。

### 5.2 箭头渲染（`arrows.ts`）

`renderArrows(ctx, scene, theme, animation?)`：路由折线算一次复用（描边/底光/虚线/脉冲点）；样式按 §3.3 优先级表；脉冲点用折线累积弧长线性定位。

### 5.3 动画循环（`GanttCanvas.tsx`）

- 渲染 effect 组装后推导 `pulseActive = depChain.downstream.size > 0`（函数式 setState 防滚动期无谓重渲）。
- 独立 `useEffect`：`pulseActive` 且非 reduced-motion 时启动 rAF，每帧以缓存 `sceneRef` + `animation.now` 重跑 `renderScene`（成本≈一次滚动 tick 的全量重绘，现状本就逐 tick 全量重绘）。清理时 cancel。
- 静态路径（无 animation 参数）：上游底光照画、下游画静态虚线、光晕取中间值 —— 供 reduced-motion、单测、截图基线共用。

## 6. 边界情形（§6）

| 情形                    | 行为                                               |
| ----------------------- | -------------------------------------------------- |
| 折叠/过滤隐藏链上任务   | 箭头与淡化照常，隐藏者不渲染（与现状箭头行为一致） |
| 成环存量数据            | visited 集合有限；脉冲循环播放；双身份边下游优先   |
| 多选                    | 不显示链路                                         |
| 关键路径开关开着        | 链路边用链路色；非链关键边红 0.35（§3.3）          |
| 冲突边（G4）            | 永远橙色、永远全透明度                             |
| 基线对比开着            | 淡化传播到基线轨道（baseAlpha 贯穿）               |
| 刷新后残留持久化选中 id | 临时 selectedTaskIds 为空 → 无链路（§5.1）         |
| 资源视图画布            | 不受影响                                           |

## 7. 测试（§7）

- **domain 单测** `packages/domain/tests/dependencyGraph.test.ts`：方向/传递/深度（菱形取最短）、缺引用、自环、成环、摘要参与、origin 不入 map。
- **web 单测** `apps/web/tests/unit/engine/dep-chain-scene.test.ts`：组装出的 depChain（单选激活/多选不激活/origin 缺失）与箭头 chainRole 标注（上/下游/无关）。
- **e2e** `apps/web/tests/e2e/dependency-highlight.spec.ts`：store 注入造数 + 真实鼠标点击；`page.emulateMedia({ reducedMotion: 'reduce' })` 冻结动画保证截图确定性；断言图例 DOM、`data-dep-pulse` 标记、截图基线（含上游/下游/聚光灯）。
