# ganttly P1 Grilling 决策记录

| 字段     | 值                                   |
| -------- | ------------------------------------ |
| 项目     | ganttly — 开源 Web 甘特图软件        |
| 日期     | 2026-07-22                           |
| 修订日期 | 2026-07-22（应用 P1-review.md 结论） |
| 参与者   | Chiang (产品/架构), AI 协作          |
| 方法论   | Grilling — 逐个问题深度访谈          |
| 输入文档 | `docs/PRD.md` §8 P1 路线图           |
| 代码基础 | v0.1.0 实际仓库结构                  |

---

## 背景

ganttly 已成功发布 v0.1.0 MVP 版本，PRD §7 九条验收标准全部通过。本次 grilling 基于 PRD §8 P1 路线图，结合 v0.1.0 实际代码结构，对 P1 阶段规划的三项特性进行逐个设计决策的深度访谈。

**分析范围**：资源分配与负载图、成本计算、任务约束

**排除范围**：自定义列、PDF/PNG 导出、节假日云端更新、iCalendar 导出

**暂缓特性**：基线对比（grilling 进行到一半时用户选择暂缓）

> **[修订说明]** 本文档记录 grilling 流程锁定的原始决策。review 审计（`docs/P1-review.md`）后发现部分决策基于对代码结构的事实性误判，已在本文件中以 **[修订]** 标注修正，并新增 G11-G13 三条补充决策。原 G1-G10 的决策方向（除 G2 排序外）均保留，但理由/工作量估算多处修正。

---

## 代码结构基础事实

> ⚠️ **本节经 review 逐文件核对修正**。原版多处事实性错误已标注。

### 数据模型现状

- `SCHEMA_VERSION = 1`（`types.ts:24`），无迁移框架（`migrate()` 仅在 `types.ts:15` 的注释里被提及，未实现）
- P1 预留字段已有结构定义：
  - `TaskConstraints = Record<string, never>`（`types.ts:154`）—— **CONFIRMED**
  - `TaskAssignment[]`（`types.ts:157-160`）已有 `resourceId` + `load(0-100)` 结构
  - `Resource { id, name, rate? }`（`types.ts:166-171`）—— **CONFIRMED `rate?` 已有**
  - `Baseline { id, name, capturedAt, tasks: BaselineTask[] }`（`types.ts:177-182`）已定义
  - `BaselineTask { id, start, end, duration, progress }`（`types.ts:184-190`）已定义
- **[修订]** JSON Schema 文件路径：`packages/schema/schema.json`（在 `src/` 上一层，`src/index.ts:9` 以 `'../schema.json'` 引入），**非**原写的 `packages/schema/src/schema.json`
- JSON Schema 对 Task 设了 `additionalProperties: false`（`schema.json:107`）—— **CONFIRMED**，新增字段必须同步改 `types.ts` + `schema.json`
- **[修订]** `constraints` 在 schema.json 里是裸 `{"type":"object"}`（`schema.json:141`），**无 `additionalProperties:false`**，比 TS 的 `Record<string, never>` 宽松——P1 改造时需新写 constraints 的 JSON schema 定义
- **[修订]** `Task.constraints`/`assignments`/`customFields` 在 schema 里是 **required**（`schema.json:108-122`），不是 optional。现存所有 v1 文件都带这些字段（空值）

### 引擎现状

- **[修订]** `assembleScene`（`assembly.ts:28-87`）是引擎唯一入口，**纯函数无副作用**——不写 `file`，所有派生只进返回的 `Scene`。渲染顺序为 grid → todayLine → bars → arrows
- `Scene`/`TaskRow`/`ThemeColors` 接口在 `render/types.ts`（`TaskRow:33-45`、`Scene:62-82`、`ThemeColors:16-30`），扩展需修改这里
- `schedule.ts` 有依赖排期逻辑（`satisfyDependency:142`、`computeImpliedStart:39`、`computeImpliedEnd:78`、`isDependencySatisfied:112`、`wouldCreateCycle:183`）
- `cpm.ts` 有 CPM 算法（`computeCriticalPath:58`，正向传递 `:79-123` + 反向传递 `:140-199` + 关键路径提取）
- `summary.ts` 有摘要汇总（`computeAllRollups:227`、`computeCascadeRollup:116`、`computeRollup:49`）
- `calendar.ts` 有工作日计算（`isWorkingDay:75`、`endDateFromDuration:125`、`iterateWorkingDays:164`）
- **[修订]** `RollupResult` 定义在 `apps/web/src/lib/summary.ts:27-36`，**是 web-app-local 类型，不在 schema 包**。现含 `start/end/duration/progress`，无 personDays/cost

### Store 现状

- **[修订]** Command 模式已实现 **11 个**工厂函数（原误记为 10）：`addTaskCommand:195`、`updateTaskCommand:210`、`deleteTaskCommand:238`、`addDependencyCommand:263`、`deleteDependencyCommand:288`、`moveTaskCommand:303`（dead code，UI 用 `*WithRollup` 变体）、`setViewStateCommand:333`、`swapSiblingOrderCommand:349`、`pasteTaskCommand:385`、`updateTaskWithRollupCommand:452`、`moveTaskWithRollupCommand:485`
- `dispatch`（`:107-123`）后自动 500ms 防抖保存 —— **CONFIRMED**
- 拖拽用 `setState` 直接更新（绕过 undo 栈），pointer-up（`GanttCanvas.tsx:303-328`）时回滚到快照再 dispatch Command

### 调度引擎现状（review 新增的关键事实）

> **本节是 review 审计的最重要发现，原 grilling 完全未覆盖。**

- **仓库当前不存在依赖级联引擎。** `satisfyDependency`（`schedule.ts:142`）是**死代码**——零个生产调用点，仅在单测（`schedule.test.ts:126,134`）里被调用。`schedule.ts` 头部注释自己承认 "The caller decides whether to write the computed dates back via a Command"——但那个 caller 从未被写出来
- **`schedule.ts` 唯一被生产代码 import 的符号是 `wouldCreateCycle`**（`GanttCanvas.tsx:283`、`TaskDrawer.tsx:204`）。`satisfyDependency`/`computeImpliedStart`/`computeImpliedEnd`/`isDependencySatisfied`/`makeScheduler` 全部无人调用
- **CPM 结果被丢弃。** `computeCriticalPath` 返回的 `earliestStart/latestEnd/latestStart/totalFloat/projectDurationDays`（`cpm.ts:219-227`）被 `assembly.ts:48-57` 调用后**只取 `criticalTaskIds` 上色**，其余全丢弃
- **`computeCascadeRollup` 走 `parentId` 父子链**（`summary.ts:116`），与依赖边（`dep.targetId`）无关——它只做摘要任务的 min-start/max-end/加权进度汇总
- **数据流实测**：今天拖动任务 A（前置）改了开始日期，依赖 A 的任务 B（FS）**不会自动顺移**。B 留在原地，箭头指向错位，仅此而已。`isDependencySatisfied` 能检测违约但无调用点
- **含义**：约束特性不是"给现有引擎加分支"，而是**先从零搭建级联引擎**。详见 G2 修订与 `docs/P1-review.md` 致命-1

### 已知技术债

- **[修订]** `pxPerDay` 实际重复 **5+ 处**（原记 4 处）：`layout.ts:45-47`（canonical）、`assembly.ts:201-206`、`drag.ts:111-115`、`GanttCanvas.tsx:460-464`，且 GanttCanvas 还额外重复 `dateToPixelLocal`（`:453`）和 `durationOf`（`:466`），drag.ts 重复 `dayDelta`（`:117`）
- `deleteTaskCommand` 的 `invert`（`:259`）是 best-effort（`invert: (file) => file`，无法恢复级联删除的后代）
- **[修订]** `TaskDrawer` 日历硬编码为 `zh-CN`（`TaskDrawer.tsx:25`，模块作用域），**且** `useProjectStore.ts:70-77`（`withCalendar`）**和** `ImportMenu.tsx:39-41,55` 也硬编码
- `holidaysInRange` 是空实现（未做范围过滤）

---

## Grilling 决策

### G1. 迁移策略：normalizeFile() 轻量方案

**问题**：P1 的第一个任务是否应该是构建 Schema 迁移框架（migrate.ts + IndexedDBRepository.load 中调用），即使大部分变更是 additive 的？

**用户反馈**：提出疑问——未来数据要存后端数据库，还需要 migrate 框架吗？

**分析**：P1 的四项特性在数据模型层面全部是 additive 变更（新增可选字段，不修改已有字段）。旧 v1 文件在新代码中天然合法，不需要 step-by-step 的 `migrate(oldDoc, fromV, toV)` 框架。但文件导入路径有硬需求——当用户导入旧版 `.ganttly.json` 时需确保新可选字段有默认值。后端落地后 `RemoteRepository.load()` 返回已迁移数据，`normalizeFile()` 变 no-op。

|          |                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------ |
| **决策** | 不建完整迁移框架，只建 `normalizeFile()` 防御性归一化函数（~30 行）                                    |
| **理由** | P1 变更全部 additive，旧 v1 文件合法。后端落地后 normalizeFile() 变 no-op，不成为技术债                |
| **备选** | (a) 建完整 `migrate(oldDoc, fromV, toV)` 框架；(b) 连 normalizeFile 都不要，靠 AJV 校验 + 报告缺失字段 |

> **[修订]** 行数 ~20 → ~30。两个必须额外处理的点：
>
> 1. **时序约束**：`normalizeFile()` 必须在 AJV `validateGanttlyFile()` **之前**跑。旧文件 `constraints: {}` 在类型改成 `{ type: ConstraintType; date?: string }` 后缺 `type` 字段，若先校验直接失败。当前 `ImportMenu.handleJson`（`ImportMenu.tsx:28-47`）顺序是 `JSON.parse → validateGanttlyFile → setFile`，normalizeFile 插在 parse 和 validate 之间
> 2. **constraints schema 定义**：`schema.json:141` 的 `constraints` 是裸 `{"type":"object"}` 无 `additionalProperties:false`，P1 改造时必须新写 constraints 的 JSON schema 定义（含 `type` 枚举、`date` 条件必填）

---

### G2. 实现顺序：资源 → 成本 → 约束

**问题**：你是否同意推荐排序"约束→资源→基线→成本"？

**用户反馈**：同意推荐排序（后调整为去掉基线，变为例→资源→成本）

**原分析**：依赖关系图——Cost 依赖 Resource 的 `rate` × `TaskAssignment`。约束和资源互相独立。基线也独立但用户选择暂缓。

|          |                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **决策** | 资源分配与负载图 → 成本计算 → 任务约束                                                                                               |
| **理由** | 资源和成本不依赖级联引擎，可先交付用户价值；成本依赖资源的 `Resource.rate`；约束真实风险最高（需从零建级联引擎），放最后作为 P1 收尾 |
| **备选** | (a) 约束→资源→成本（原草案，基于"约束风险最低"的错误前提，已被 review 否决）；(b) 资源→约束→成本                                     |

> **[修订·关键]** 原决策为"约束 → 资源 → 成本"，理由是"约束最低风险、不引入新 UI 面，是排期引擎的自然延伸"。review 致命-1 经逐文件核对证明**此前提不成立**——仓库无级联引擎（`satisfyDependency` 是死代码，CPM 结果被丢弃，`computeCascadeRollup` 走 `parentId` 与依赖无关）。约束特性真实工作量 2-3 → 4-6 会话，且是三项里**风险最高**的（要动 store undo 契约）。因此重排为资源 → 成本 → 约束。

---

### G3. 约束类型：5 种实用子集

**问题**：任务约束支持哪些类型？PRD 只明确提到"最早开始"和"必须完成于"两种，但项目管理标准有 8 种。

**用户反馈**：选择 5 种实用子集

**分析**：

| 类型                        | 含义             | 与依赖的关系                            | 实现复杂度            |
| --------------------------- | ---------------- | --------------------------------------- | --------------------- |
| `none` (ASAP)               | 无约束，尽早开始 | 默认行为，已有                          | 无                    |
| `startNoEarlierThan` (SNET) | 不能早于 X 开始  | start = max(依赖隐含start, X)           | 低                    |
| `mustFinishOn` (MFO)        | 必须在 X 完成    | end = X，start = end - duration         | 中（需反算 start）    |
| `mustStartOn` (MSO)         | 必须在 X 开始    | start = X，end = start + duration       | 中                    |
| `finishNoLaterThan` (FNLT)  | 不能晚于 X 完成  | end = min(依赖隐含end, X)，再反算 start | 中高                  |
| ALAP                        | 尽晚开始         | 需 CPM 反向传递结果驱动                 | 高（与 CPM 深度耦合） |

|          |                                                                                    |
| -------- | ---------------------------------------------------------------------------------- |
| **决策** | 支持 `none` / SNET / MSO / MFO / FNLT 共 5 种                                      |
| **理由** | 覆盖 95% 场景，且都不需要与 CPM 反向传递深度耦合。ALAP 留 P2                       |
| **备选** | (a) 仅 PRD 提到的 2 种（SNET + MFO）；(b) 8 种全集（含 ALAP，完全对标 MS Project） |

> **[修订]** 上表"实现复杂度"原隐含假设约束是加在**已有级联引擎**之上的分支。实际级联引擎本身是 greenfield（见 G2 修订），故每种类型的真实复杂度都需叠加"先建级联"的基础成本。

---

### G4. 约束冲突策略：约束优先 + 冲突警告

**问题**：当任务约束与依赖产生冲突时（例如 MFO 要求 1/15 完成但依赖的前置任务 1/20 才完成），应该采用哪种策略？

**用户反馈**：选择约束优先 + 冲突警告

**分析**：三种策略对比——约束优先（MS Project 标准，硬意图胜出）、依赖优先（约束形同虚设）、自动调工期（隐式改变工作范围，危险）。

|          |                                                                                         |
| -------- | --------------------------------------------------------------------------------------- |
| **决策** | 约束硬执行，依赖被违反时显示调度冲突警告（违反的依赖箭头变橙色）                        |
| **理由** | 符合 MS Project / GanttProject 行业标准；约束是用户显式设置的硬意图，依赖是自动排期关系 |
| **备选** | (a) 依赖优先，约束降级为"尽力而为"；(b) 自动调工期（冲突时缩短 duration，隐式且危险）   |

> **[修订]** 此决策方向正确且保留。技术落点已核对：`arrows.ts:30-34` 现有 `isCritical` 双色机制（critical 红 / 普通 fgMuted）可直接扩展第三色（橙色冲突态）。但"约束硬执行"的前提是约束真的能改变 task.start——这依赖级联引擎存在（G2 修订），否则约束只是装饰性的。

---

### G5. 约束可视化：标记图标 + hover 日期线

**问题**：约束在甘特图上如何可视化？

**用户反馈**：选择标记图标 + hover 日期线

**分析**：四种方案对比——标记图标（GanttProject 标准，空间小）、常驻日期线（多约束混乱）、无可视化（用户看不到）、幽灵条（与基线冲突）。

|          |                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------- |
| **决策** | 任务条约束侧画小标记图标 + hover 任务条时显示约束日期竖线 + 冲突依赖箭头变橙色                  |
| **理由** | 标准 GanttProject 做法，空间占用小。约束侧（start 约束在左端，finish 约束在右端）画标记         |
| **备选** | (a) 常驻约束日期线；(b) 无可视化（仅 TaskDrawer 可见）；(c) 幽灵条（与基线 ghost bar 视觉冲突） |

> **[修订]** hover 机制已核对可复用：`GanttCanvas.tsx:338-352` 的 holiday hover tooltip 已实现 `pixelToDate` round-trip（`:341`），约束日期线可镜像此模式。

---

### G6. Resource 模型：+capacity + role + color

**问题**：Resource 数据模型需要扩展哪些字段？

**用户反馈**：选择中等方案（+capacity + role + color）

**分析**：`capacity` 是负载图硬需求（没有它无法判断超负荷）。`role` 支持筛选。`color` 支持视觉区分。独立日历（每资源不同排班）是 P2 级复杂度。

|          |                                                                   |
| -------- | ----------------------------------------------------------------- |
| **决策** | `Resource` 加 `capacity?`（0-1，默认 1.0）、`role?`、`color?`     |
| **理由** | capacity 是负载图硬需求；role 支持筛选；color 支持视觉区分        |
| **备选** | (a) 最小方案只加 capacity?；(b) 完整方案含独立日历（P2 级复杂度） |

> **[修订]** schema 落点已核对：`Resource` 现含 `id/name/rate?`（`types.ts:166-171`），`schema.json` 的 resource `$def`（`:168-177`）有 `additionalProperties:false`（`:170`），`required` 只有 `["id","name"]`（`:172`）。加三个 optional 字段需同步改 `types.ts` + `schema.json`。

---

### G7. 负载图位置：视图切换（GanttProject 式）

**问题**：资源负载图放在哪里？

**用户反馈**：要 GanttProject 式的视图切换——切换到资源视图时左侧变人员列表、右侧变负载图。负载图显示人员负载百分比，如"人员 A 1号到10号 80%，10号到15号 120%"。

**分析**：四种方案对比——底部可折叠面板（不侵入主图）、视图切换（全宽但无法同时看任务和资源）、Canvas 叠加（滚动耦合）、分屏（体验最佳但实现最复杂）。用户明确要求 GanttProject 式体验。

|          |                                                                                             |
| -------- | ------------------------------------------------------------------------------------------- |
| **决策** | Toolbar 切换"任务视图" ↔ "资源视图"。资源视图左侧 = ResourceList，右侧 = ResourceLoadCanvas |
| **理由** | 用户明确要求 GanttProject 式体验。负载图显示百分比，绿色 ≤100%，红色 >100%                  |
| **备选** | (a) 底部可折叠面板；(b) Canvas 叠加；(c) 分屏                                               |

> **[修订]** `viewMode` 的归属层见 G11（新增决策）——不放持久化 `ViewState`，放 ephemeral `useViewStore`。

---

### G8. 分配编辑 + 调度模型：TaskDrawer + 固定工期

**问题**：资源分配在哪里编辑，以及用哪种调度模型？

**用户反馈**：选择 TaskDrawer + 固定工期

**分析**：固定工期模型（分配不影响排期）vs 工时驱动模型（更多资源=更短工期，需重写排期逻辑）。TaskDrawer 是所有任务字段编辑的统一入口。拖拽分配交互复杂度高。

|          |                                                                                     |
| -------- | ----------------------------------------------------------------------------------- |
| **决策** | 资源分配在 TaskDrawer 中编辑；资源 CRUD 在资源视图左侧面板；P1 用固定工期模型       |
| **理由** | TaskDrawer 是统一编辑入口；固定工期不改变现有排期逻辑；工时驱动需重写排期，复杂度高 |
| **备选** | (a) 工时驱动模型；(b) 拖拽分配（从资源列表拖到任务条）                              |

> **[修订]** 此决策是 grilling 中最关键的正确决策，review 后完全保留。选工时驱动意味着要重写排期，在当前**连依赖级联都不存在**的情况下是灾难。固定工期让资源分配是"附加信息"，把资源特性风险压到最低。TaskDrawer 的扩展点已核对：`:70-216` 是 `<Field>` 块序列，`:271-333` 的 `DependencyAdder` 是复合编辑器先例，资源分配区域可镜像。

---

### G9. 成本模型：双维度（人天 + 货币成本）

**问题**：成本模型支持哪些类型？以及日工时如何确定？

**用户反馈**：选择双维度模型。补充说明——核心需求是人天管理（按人天管理项目投入），时薪保留但次要。强调同一项目内一人多任务并行场景很重要。

**分析**：用户核心需求是人天（每个人在每个任务中投入多少时间），不是单纯的货币成本。人天 = `(load/100) × capacity × duration`，纯计算不存储。货币成本 = `rate × personDays × hoursPerDay + fixedCost`。日工时用 Calendar 工作时长简单相减（不建模午休）。

**并行分配场景**（用户明确强调）：同一项目内一人负责多个并行任务——人员 A 同时投入任务 X（30%）和任务 Y（70%），负载图按日期累加 load，天然支持。

|          |                                                                                                                       |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| **决策** | 人天（primary）= (load/100) × capacity × duration；货币成本（secondary）= rate × personDays × hoursPerDay + fixedCost |
| **理由** | 用户核心需求是人天管理；时薪作为货币化能力保留；二者不冲突；日工时简单相减够用                                        |
| **备选** | (a) 先只做人天不做货币成本；(b) 统一"成本"概念不区分                                                                  |

> **[修订]** `hoursPerDay` 取值路径需额外处理：`workingHours` 虽在 schema `Calendar`（`types.ts:80,98-101`）里，但 **`resolveCalendar()`（`calendar.ts:25`）把它丢弃了**——`ResolvedCalendar`（`calendar.ts:17-22`）只有 `weekStart`/`weekends`/`holidays`。成本特性必须先改 `resolveCalendar` 让 `workingHours` 透传（或让 `computeTaskCost` 直接吃原始 `Calendar`）。已计入成本特性工作量（+0.5 会话，K0.1 任务）。

---

### G10. 成本显示：四都做，分两轮

**问题**：人天/成本显示放在哪里？

**用户反馈**：选择四都做，分两轮

**分析**：四个显示位置——TaskTable 列（核心）、StatusBar 汇总（核心）、TaskDrawer 明细（增强）、资源视图标注（增强）。分两轮实现。

|          |                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------- |
| **决策** | 第一轮：TaskTable 人天/成本列 + StatusBar 总人天/总成本。第二轮：TaskDrawer 明细 + 资源视图标注 |
| **理由** | 表格列和状态栏汇总是核心需求；Drawer 明细和资源标注是增强体验，可后补                           |
| **备选** | (a) 只做表格+状态栏；(b) 只做 Drawer 明细                                                       |

> **[修订]** TaskTable 扩展点已核对但需注意脆弱性：`GRID_TEMPLATE`（`TaskTable.tsx:37`）是 4-track 字符串 `'44px minmax(0, 1fr) 72px 64px'`，header（`:273-281`）与 row（`:317`）共享此模板，注释（`:33-37`）明确"必须共享否则列错位"。加列要改常量 + header + row cell 三处。StatusBar（`:21-27`）扩展简单，`useMemo` 聚合 `file.tasks` 即可。

---

### G11. [新增·review 后] viewMode / showCostColumns 归属：ephemeral 层

**问题**（review 发现）：草案把 `viewMode` 放进 schema `ViewState` 持久化，但这与现有"导航状态走 setState 绕过 undo"的约定冲突。

**分析**：store 探查表明所有导航类视图状态（scroll/zoom）当前都走 `setState` 绕过 undo 栈（`GanttCanvas` 滚动 `useProjectStore.ts:71-83`、`Toolbar.jumpToToday` `Toolbar.tsx:58-63`，均有注释 "navigation, not an undoable edit"）。`viewMode` 放 `ViewState` 面临两难：走 `setViewStateCommand` 会污染 undo 历史，走 `setState` 又与持久化目的矛盾。

|          |                                                                                                                                  |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | `viewMode`（'task' \| 'resource'）和 `showCostColumns` 放 `useViewStore`（ephemeral UI 状态），不进 schema `ViewState`，不持久化 |
| **理由** | 与 `drawer`/`contextMenu` 同层（`useViewStore.ts:16-25`），符合既有导航语义。重开文件默认回任务视图，符合直觉                    |
| **备选** | (a) 放 schema `ViewState` 持久化（原草案方案，与现有导航语义冲突）；(b) 放 `ViewState` 但走 `setState`（持久化无意义）           |

---

### G12. [新增·review 后] 约束日期落非工作日：snap 到最近工作日

**问题**（review 发现）：原 grilling 完全未讨论约束日期落在非工作日时怎么处理。MSO/MFO 是硬锚点，但 CPM 和 `schedule` 全是工作日感知的。

**分析**：若用户设 MFO = 周六，`start = end - duration` 反算后 `end` 要不要 snap？snap 后还算"必须完成于周六"吗？`isWorkingDay`/`endDateFromDuration` 已会 snap 非工作日，约束逻辑需与之对齐。

|          |                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | 约束日期若落在非工作日，应用前 snap 到**最近的后续工作日**（`nextWorkingDay`，`calendar.ts:98`），并在 UI 标注"已从 X 调整到 Y"          |
| **理由** | snap 到后续工作日符合"不能晚于/必须完成于"的语义（后续工作日是最保守的合法解）。对 SNET/MSO（开始约束）和 MFO/FNLT（完成约束）都语义安全 |
| **备选** | (a) 不 snap，允许约束日期是非工作日（语义模糊）；(b) snap 到前一个工作日（对 FNLT"不能晚于"语义不安全）                                  |

---

### G13. [新增·review 后] 摘要任务成本短路

**问题**（review 发现）：草案风险点提到摘要任务不应有 assignments/fixedCost，方案是"UI 层拦截"。但当前 `Task` 在 schema 层不区分 leaf/summary（`isSummary` 是渲染时 `computeAllRollups` 派生的），绕过 UI 的数据（如 `.gan` 导入或手改 JSON）会导致成本双计。

**分析**：若摘要任务有 assignments，成本 rollup 会双计（子任务已汇总 + 摘要自身分配再算一遍）。schema 层区分 leaf/summary 改动大且破坏 additive 兼容性。

|          |                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | `computeTaskPersonDays`/`computeTaskCost` 对 summary 任务短路返回 rollup 汇总值（子任务的加法总和），不读 summary 自身的 `assignments`/`fixedCost` |
| **理由** | 在计算函数短路比只靠 UI 拦截更稳健，能防御绕过 UI 的数据。与 `computeAllRollups`（`summary.ts:227-260`）判断 summary 的逻辑对齐                    |
| **备选** | (a) 仅 UI 层拦截（原草案方案，绕过 UI 的数据会双计）；(b) schema 层区分 leaf/summary（改动大，破坏 additive 兼容性）                               |

---

## 基线对比（暂缓）

基线对比特性在 grilling 进行到一半时用户选择暂缓（"先跳过基线对比这个特性，先不做"）。已设计但未最终确认的方案：

- **活跃基线**：viewStore 加 `activeBaselineId`，Toolbar 加基线下拉框
- **ghost bar**：轮廓方案——在 bars.ts 的 drawRow 中画淡色虚线矩形
- **捕获范围**：全量快照所有任务
- **捕获字段**：仅 start/end/duration/progress

数据结构 `Baseline`（`types.ts:177-182`）/ `BaselineTask`（`types.ts:184-190`）已就绪，后续恢复时可直接实施。
