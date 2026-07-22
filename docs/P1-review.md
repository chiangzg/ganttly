# ganttly P1 实施计划草案 Review 报告

| 字段     | 值                                                                 |
| -------- | ------------------------------------------------------------------ |
| 评审对象 | `docs/P1-implementation-plan.md` + `docs/P1-grilling-decisions.md` |
| 评审基础 | v0.1.0 实际仓库代码（逐文件核对）                                  |
| 评审日期 | 2026-07-22                                                         |
| 评审者   | AI 协作                                                            |
| 状态     | 完成——待作者决策                                                   |

---

## 执行摘要

草案整体结构扎实，10 条 grilling 决策里有 6 条（G4/G6/G7/G8/G9/G10）经代码核对后成立且值得保留。但存在**一个致命的架构判断失误**：

> **仓库当前不存在依赖级联引擎。** `satisfyDependency`（`apps/web/src/lib/schedule.ts:142`）是**死代码**——零个生产调用点，仅在单测中被调用。CPM 的 `earliestStart/latestEnd/totalFloat` 被 `assembly.ts:48-57` 调用后**丢弃**，只取 `criticalTaskIds` 上色。`computeCascadeRollup` 走的是 `parentId` 父子链，与依赖边无关。

草案 G2/特性一据此断言约束"最低风险、不引入新 UI 面、是排期引擎的自然延伸"，并给出 2-3 会话估算——**这个前提不成立**。约束特性今天要做的不是"给现有引擎加分支"，而是**先从零搭建级联引擎**。真实工作量约 4-6 会话，且是三项特性里风险最高的（要动 store 的 undo 契约）。

建议将排序调整为 **资源 → 成本 → 约束**，让前两项先交付用户价值，把级联引擎作为约束特性的显式交付物集中处理。

---

## 🔴 致命问题（1 项）

### 致命-1. 约束特性的工作量与风险评估严重失实

**草案原判断**（plan L46, L201-202）："约束最低风险、不引入新 UI 面，是排期引擎的自然延伸……CPM 性能：约束分支在正反传递中增加条件判断，但复杂度仍为 O(V+E)，不影响。"

**实际代码核对结论**：仓库里**没有排期引擎**。

#### 完整证据链

| 调度能力                   | 实际状态          | 证据                                                                                                                                                                                                       |
| -------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 依赖环检测                 | ✅ 已实现         | `wouldCreateCycle`（`schedule.ts:183`）是 `schedule.ts` **唯一**被生产代码 import 的符号（`GanttCanvas.tsx:283`、`TaskDrawer.tsx:204`）                                                                    |
| 依赖箭头渲染               | ✅ 已实现（只读） | `computeArrows`（`assembly.ts:132-179`）                                                                                                                                                                   |
| 关键路径着色               | ✅ 已实现（只读） | `computeCriticalPath`（`cpm.ts:58`）的 `earliestStart/latestEnd/totalFloat` **被 `assembly.ts:48-57` 丢弃**，只取 `criticalTaskIds` 上色                                                                   |
| 摘要任务汇总               | ✅ 已实现         | `computeCascadeRollup`（`summary.ts:116`）—— 但走 **`parentId` 父子链**，与依赖边无关                                                                                                                      |
| **依赖驱动的日期重排**     | ❌ **完全不存在** | `satisfyDependency`（`schedule.ts:142`）是死代码，零个生产调用点。`schedule.ts` 头部注释自己都承认 "The caller decides whether to write the computed dates back via a Command"——但那个 caller 从未被写出来 |
| **CPM 结果回写 task 日期** | ❌ 不存在         | `cpm.ts:219` 返回的 maps 没有消费者                                                                                                                                                                        |
| **约束执行**               | ❌ 不存在         | —                                                                                                                                                                                                          |

**数据流实测**：今天拖动任务 A（前置）改了开始日期，依赖 A 的任务 B（FS）**不会自动顺移**。B 留在原地，箭头指向错位，仅此而已。`isDependencySatisfied` 能检测违约，但没有任何地方调用它。

#### 对草案的冲击

草案"特性一·技术依赖"表（L169-182）描述的 `satisfyConstraint()`、CPM 正反传递加约束分支、`checkConstraintConflict()`，**全都假设约束只是在一套已有的依赖级联之上加判断分支。这套级联不存在。**

要让 SNET/MFO/MSO/FNLT 真正执行，必须先从零搭建：

1. **依赖级联驱动器** —— 拓扑遍历依赖 DAG，逐 successor 调用 `satisfyDependency`。当前没有任何函数遍历依赖图改日期。
2. **写入路径集成** —— `updateTaskWithRollupCommand`、`addDependencyCommand`、`moveTaskWithRollupCommand`、`GanttCanvas` 拖拽 pointer-up（`GanttCanvas.tsx:303-328`）都要接入级联；目前这些都只做 `parentId` rollup。
3. **undo 正确性** —— 现有 `applyPatchAndCapture`/`restoreCaptured`（`useProjectStore.ts:419-446`）只捕获单任务 + 祖先；一次级联会动多个 successor，需要扩展捕获并集。**这是隐藏的复杂度大头。**
4. 才轮到草案写的约束语义层（SNET/MFO/MSO/FNLT 本身）。

**好消息**：纯算法积木（`computeImpliedStart/End`、`satisfyDependency`、完整 CPM 正反传递 + 日历感知）都已存在且有单测。工作主要是"缺失的驱动器 + 写入路径接线 + schema"，不是从零设计算法。

#### 修正

- 估算：约束 **2-3 会话 → 4-6 会话**
- 风险等级：**最低 → 最高**
- 排序建议：**资源 → 成本 → 约束**（把级联引擎作为约束特性的核心交付物，而非在"低风险"特性里意外踩坑）

---

## 🟠 较大问题（6 项）

### 较大-1. 草案多处文件路径错误

| 草案写的路径                        | 实际路径                                                                                       | 核对证据                                                                                |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/schema/src/schema.json`   | `packages/schema/schema.json`（在 `src/` 上一层，`src/index.ts:9` 以 `'../schema.json'` 引入） | `packages/schema/src/` 下只有 `types.ts`/`validate.ts`/`factory.ts`/`index.ts` 四个文件 |
| `packages/gan-parser/src/parser.ts` | `packages/gan-parser/src/index.ts`（单文件，无 parser.ts）                                     | —                                                                                       |

新建文件（`ResourceList.tsx`/`ResourceLoadCanvas.tsx`/`lib/resourceLoad.ts`/`lib/cost.ts`）路径无碍。

### 较大-2. `normalizeFile()` 与 AJV 校验的时序约束未交代 + constraints schema 陷阱

草案 G1/F1 说 `normalizeFile()` ~20 行补默认值。两个未说清的点：

**（a）`Task.constraints` 在 schema 里是 required，不是 optional。** `types.ts:130` 和 `schema.json:108-122` 的 `required` 数组都含 `constraints`。现存所有 v1 文件都带 `constraints: {}`。当 TS 类型从 `Record<string, never>` 改成 `{ type: ConstraintType; date?: string }` 后，旧文件的 `constraints: {}` **缺 `type` 字段**，AJV 校验会直接失败。

**（b）`normalizeFile()` 必须在 AJV 校验之前跑。** 当前 `ImportMenu.handleJson`（`ImportMenu.tsx:28-47`）的顺序是 `JSON.parse → validateGanttlyFile → setFile`，`normalizeFile` 要插在 parse 和 validate **之间**。草案 F2 只说"在 load() 和导入逻辑中调用"，没强调这个时序约束。

**（c）需新写 constraints 的 JSON schema 定义。** 现状 `schema.json:141` 的 `constraints` 是裸 `{"type":"object"}`，**没有 `additionalProperties:false`**，比 TS 的 `Record<string, never>` 宽松（运行时 AJV 会接受 `{ "foo": 1 }`，但 TS 编译期不允许）。P1 改造时必须新写 `constraints` 的 JSON schema 定义（含 `type` 枚举、`date` 条件必填），草案 C1.1 提了"schema.json"但没点出这层。

### 较大-3. 成本公式的 `hoursPerDay` 取不到值

草案成本公式（L344）：`hoursPerDay = Calendar.workingHours 简单相减（如 09:00-18:00 = 9 小时）`。

但 `workingHours` 虽在 schema `Calendar` 里（`types.ts:80,98-101`，`{start:"HH:mm", end:"HH:mm"}`），**`resolveCalendar()` 把它丢弃了**——`ResolvedCalendar`（`calendar.ts:17-22`）只有 `weekStart`/`weekends`/`holidays`，没有 `workingHours`。引擎层和 lib 层拿不到日工时。

成本特性（K1.2）必须先改 `resolveCalendar` 让 `workingHours` 透传，或让 `computeTaskCost` 直接吃原始 `Calendar` 而非 `ResolvedCalendar`。草案技术依赖表（L359-368）完全没提这层。**工作量需 +0.5 会话。**

### 较大-4. `.gan` 约束映射是 greenfield，且枚举语义需调研

草案 C3.1（L196）"`.gan` 约束类型映射"写得像顺手就做。实际：

- `gan-parser/src/index.ts` **从未读取 `thirdDate`/`thirdDate-constraint`**，`flattenTask` 在 `:187` 硬编码 `constraints: {}`；
- `GanTaskNode` 接口（`:124-141`）没声明这两个属性；
- 它们也不在 `skipped` 报告里（`:95-100`），是被静默丢弃。

所以这是从零读写。更麻烦的是 GanttProject `thirdDate-constraint` 的 0-7 数值语义需要调研验证（草案 L203 自己也列为风险），`HouseBuildingSample.gan.xml:56,125` 能看到 `thirdDate-constraint="0"`，但完整映射表要查 GanttProject 源码/文档。

**建议**：把 C3.1 降级为"可选/stretch"或挪到三项做完之后，不要放在约束特性的关键路径上。

### 较大-5. `viewMode` 放持久化 `ViewState` 与既有导航语义冲突

草案（L224-227）把 `viewMode` 放进 schema `ViewState`。但 store 探查表明：**所有导航类视图状态（scroll/zoom）当前都走 `setState` 绕过 undo 栈**——`GanttCanvas` 滚动、`Toolbar.jumpToToday`，均有明确注释 "navigation, not an undoable edit"（`useProjectStore.ts:71-83`、`Toolbar.tsx:58-63`）。

`viewMode` 放 `ViewState` 后面临两难：

- 走 `setViewStateCommand` → 每次切换任务视图↔资源视图都进 undo 栈，污染历史；
- 走 `setState` → 那放持久化 `ViewState` 就没意义了。

**更干净的方案**：放 `useViewStore`（与 `drawer`/`contextMenu` 同层的 ephemeral UI 状态，`useViewStore.ts:16-25`），不持久化——用户重开文件默认回任务视图，符合直觉。同样 `showCostColumns` 也面临此问题，建议同处理。

### 较大-6. command 数量笔误

grilling-decisions L52 说"Command 模式已实现 10 个工厂函数"。实际是 **11 个**（`useProjectStore.ts:195/210/238/263/288/303/333/349/385/452/485`），其中 `moveTaskCommand`(`:303`) 是 dead code（UI 用 `*WithRollup` 变体）。不影响规划，但事实应修正。

---

## 🟡 中等问题（4 项，实施时处理）

### 中等-1. 约束日期落在非工作日 —— 草案完全未讨论

MSO/MFO 是"硬锚点"，但 CPM 和 `schedule` 全是工作日感知的（`isWorkingDay`、`endDateFromDuration` 会 snap 到下一个工作日）。若用户设 MFO = 周六，`start = end - duration` 反算后 `end` 是不是也要 snap？snap 后还算"必须完成于周六"吗？草案 G3 的算法描述（L151-165）没覆盖此情况。**需补一条 grilling 决策。**

### 中等-2. 摘要任务的 `fixedCost` / `assignments` 仅靠 UI 拦截不够

草案风险点（L298、L387）提到摘要任务不应有 assignments/fixedCost，方案是"UI 层拦截"。但当前 `Task` 在 schema 层**不区分 leaf/summary**——`isSummary` 是渲染时 `computeAllRollups` 派生的，不在 schema。若 `.gan` 导入或手改 JSON 给了摘要任务 assignments，成本 rollup 会双计（子任务已汇总 + 摘要自身分配再算一遍）。

**建议**：在 `computeTaskPersonDays`/`computeTaskCost` 里对 summary 任务短路返回 rollup 值，而非只靠 UI 拦截。

### 中等-3. 成本 rollup 与进度 rollup 混合的实现注意点

草案风险 1（L386）判断准确：`computeRollup`（`summary.ts:49-95`）现做**按 duration 加权的进度平均**。加 `personDays`/`cost` 要用**纯加法**汇总。实现上要在同一个 `computeRollup` 里并行维护两套聚合规则：

- `progress` 的"全完成短路到 100"（`:69`）和"零权重回退算术平均"（`:89`）分支**不能波及 cost**；
- `cost`/`personDays` 只走纯加法，无短路、无加权。

建议复核实现时确保两种聚合方式不互相干扰。

### 中等-4. `pxPerDay` 技术债实际 5+ 处，且 T1 必须在 R3.3 前完成

草案把消除 `pxPerDay` 四处重复放在"基础设施"（W1，0.5 会话）。但探查确认实际是**五处**，且 GanttCanvas 还额外重复了别的函数：

| 文件                                 | 重复内容                            |
| ------------------------------------ | ----------------------------------- |
| `engine/layout/layout.ts:45-47`      | ✅ canonical `pixelsPerDay`（源头） |
| `engine/scene/assembly.ts:201-206`   | `pxPerDay`（私有）                  |
| `engine/interaction/drag.ts:111-115` | `pxPerDay`（私有）                  |
| `components/GanttCanvas.tsx:460-464` | `pxPerDayLocal`（私有）             |
| `components/GanttCanvas.tsx:453-458` | **额外**重复 `dateToPixelLocal`     |
| `components/GanttCanvas.tsx:466-471` | **额外**重复 `durationOf`           |
| `engine/interaction/drag.ts:117-122` | **额外**重复 `dayDelta`             |

资源负载图（`ResourceLoadCanvas`）会是新的复制点。**建议**：T1 必须在 R3.3（ResourceLoadCanvas）之前完成，并在计划里建立显式依赖。每处都注释 "avoid circular import"，清理时要确认 import cycle 真的被打破（可能要把 `layout.ts` 提升到不依赖 Scene 的位置）。

---

## ✅ 草案亮点（值得保留）

经代码核对后，以下 6 条 grilling 决策成立：

| 决策                               | 核对结论                                                                                                                                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G8 固定工期模型**                | ✅ 最关键的正确决策。`TaskTable`/`Toolbar` 创建任务时已 emit `assignments: []`/`constraints: {}`（`TaskTable.tsx:226-227`、`Toolbar.tsx:97-98`），数据管线就绪。选工时驱动意味着要重写排期，在当前没有级联引擎的情况下是灾难。固定工期让资源分配是"附加信息"，把资源特性风险压到最低。 |
| **G4 约束优先 + 冲突警告**         | ✅ 符合 MS Project 行业标准，决策正确（前提是约束真的执行，见致命-1）。`arrows.ts:30-34` 现有 `isCritical` 双色机制可直接扩展第三色（橙色）。                                                                                                                                          |
| **G7 视图切换（GanttProject 式）** | ✅ 与现有 `GanttView` 单层布局（`GanttView.tsx:38-49`）契合，`Toolbar` 已有 `pressed` toggle 先例（critical-path button `:125-133`），接入点清晰。                                                                                                                                     |
| **G10 分两轮做成本显示**           | ✅ `TaskTable` 的 `GRID_TEMPLATE`（`:37`）虽是脆弱的字符串模板，但改两处（header + 常量）即可加列；`StatusBar`（`:21-27`）`useMemo` 加总成本低。增量交付合理。                                                                                                                         |
| **数据模型变更全部 additive**      | ✅ `SCHEMA_VERSION = 1`（`types.ts:24`）保持不变可行。`Resource.rate?`（`:170`）已存在，`TaskAssignment`（`:157-160`）已有 `resourceId`+`load`，`Baseline`/`BaselineTask`（`:177-190`）已定义。                                                                                        |
| **G9 双维度成本**                  | ✅ 人天为主、货币为辅，公式清晰（见较大-3 关于 `workingHours` 的修正）。                                                                                                                                                                                                               |

---

## 修正后工作量重估

| 阶段                  | 草案估算     | 修正估算  | 差异来源                                                 |
| --------------------- | ------------ | --------- | -------------------------------------------------------- |
| 基础（normalizeFile） | 0.5          | 0.5-1     | 需处理 AJV 时序（较大-2）+ constraints schema 定义       |
| 技术债（pxPerDay）    | 0.5          | 0.5-1     | 实际 5+ 处，含 dateToPixel/durationOf/dayDelta（中等-4） |
| **约束**              | **2-3**      | **4-6**   | **需先建依赖级联引擎（致命-1）+ undo 捕获扩展**          |
| 资源                  | 4-5          | 4-5       | 基本准确                                                 |
| 成本                  | 2-3          | 2.5-3.5   | +resolveCalendar 透传 workingHours（较大-3）             |
| **合计**              | **9.5-12.5** | **12-17** | **主要增量来自约束特性**                                 |

**排序建议**：资源 → 成本 → 约束。理由：资源/成本不依赖级联引擎，可先交付用户价值；约束作为 P1 收尾，把级联引擎作为它的核心交付物集中建设。

---

## 关键决策待作者拍板

### 决策-1. 约束特性执行力度（决定是否要先建级联引擎）

| 选项                                  | 工作量    | 代价                                                                       |
| ------------------------------------- | --------- | -------------------------------------------------------------------------- |
| **A. 存储+可视化，不执行**            | ~2-3 会话 | 约束是"装饰性"的——设了 MFO 但任务不移到那天，可能不符预期                  |
| **B. 约束本身执行，不级联依赖**       | ~3-4 会话 | 设了 MFO 该任务会移过去，但 successor 不自动顺移；半自动状态可能让用户困惑 |
| **C. 约束+依赖级联全执行**            | ~5-7 会话 | 真正的项目管理体验，但要动 store undo 契约，风险最高                       |
| **D. 暂缓约束，重排为资源→成本→约束** | —         | P1 前期就出用户价值，约束作为 P1 收尾                                      |

**我的推荐**：**D**。因为草案"约束风险最低"的前提已被证伪，而资源/成本特性风险确实较低且不依赖级联引擎。把约束放最后，无论最终选 A/B/C，都不会阻塞前两项的交付。

### 决策-2. `viewMode` / `showCostColumns` 归属层

| 选项         | 位置                        | 持久化 | 代价                                                                                        |
| ------------ | --------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| **草案方案** | schema `ViewState`          | ✅     | 切换进 undo 栈污染历史（若走 `setViewStateCommand`），或与持久化目的矛盾（若走 `setState`） |
| **推荐方案** | `useViewStore`（ephemeral） | ❌     | 重开文件默认回任务视图；符合"导航状态不进 undo"的现有约定                                   |

**我的推荐**：放 `useViewStore`。与 `drawer`/`contextMenu` 同层，符合既有导航语义。

---

## 附：核对中发现的额外事实（供后续实施参考）

- `assembleScene`（`assembly.ts:28-87`）是**纯函数**，无副作用——它不写 `file`，所有派生只进返回的 `Scene`。摘要任务的渲染日期（`toTaskRow:89-112` 用 rollup 覆盖）与文件里的日期可能不同，但文件本身不被 assembly 触碰。
- `ImportMenu.handleJson`/`handleGan` 用 `setFile`（直接 setter，`useProjectStore.ts:103-105`）而非 Command——**导入不可 undo，且不清空 undoStack/redoStack**。导入后用户按 undo 会得到混乱结果。这是 P0 就存在的问题，但 P1 若加 normalizeFile 会再次触及这条路径，建议顺带修。
- `TaskDrawer` 的 `commit`（`:47-53`）按 patch 字段选 `updateTaskWithRollupCommand`（命中 `ROLLUP_FIELDS = {progress,start,end,duration}`）或 `updateTaskCommand`。约束/资源分配 patch 需决策走哪条——约束改了可能要级联（若选决策-1 的 C），资源分配改了不触发 rollup。
- `Command.invert` 对 `deleteTaskCommand`（`:259`）/`deleteDependencyCommand`（`:299`）是 best-effort stub（`invert: (file) => file`），真实 inverse 在 dispatch 点捕获。级联引擎若要接入 undo，需沿用这个捕获-并集模式。
