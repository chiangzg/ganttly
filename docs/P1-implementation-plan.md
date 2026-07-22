# ganttly P1 实施计划草案

| 字段     | 值                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 项目     | ganttly — 开源 Web 甘特图软件                                                                                                                                     |
| 版本     | v0.2 (P1)                                                                                                                                                         |
| 文档状态 | 经 grilling 定稿（资源/成本/约束三特性逐项裁决）                                                                                                                  |
| 创建日期 | 2026-07-22                                                                                                                                                        |
| 修订日期 | 2026-07-22（grilling Q1-Q15 锁定，成本特性瘦身为纯人天）                                                                                                          |
| 实现进度 | 2026-07-22：全部三特性已落地（基础设施 + 资源 + 人天 + 级联引擎 + 约束），232 unit + 46 e2e 全绿，含 C2.3/C2.4 可视化 + G14 load 检测 + K2.1 人天列 + R4 行内编辑 |
| 作者     | Chiang (产品/架构), AI 协作                                                                                                                                       |
| 适用范围 | P1 特性集                                                                                                                                                         |

---

## 概述

ganttly v0.1.0 MVP 已发布，PRD §7 九条验收标准全部通过。本计划基于 PRD §8 P1 路线图，结合 v0.1.0 实际代码结构，规划三项 P1 特性的实施。

**范围**：资源分配与负载图、人天计算（成本计算瘦身为纯人天，见 G9 修订）、任务约束

**暂缓特性**：基线对比（已 grilling 但用户选择暂缓）、自定义列、PDF/PNG 导出、节假日云端更新、iCalendar 导出、货币成本（grilling 后砍掉，见 G9 修订）

**实施顺序**：资源 → 人天 → 约束

> ⚠️ **review 后的关键修正**：原始草案排序为"约束 → 资源 → 成本"，理由是"约束最低风险、是排期引擎的自然延伸"。经逐文件代码核对（详见 `docs/P1-review.md` 致命-1），**仓库当前不存在依赖级联引擎**——`satisfyDependency`（`schedule.ts:142`）是零生产调用点的死代码，CPM 的 `earliestStart/latestEnd` 被 `assembly.ts:48-57` 丢弃只用 `criticalTaskIds` 上色，`computeCascadeRollup` 走 `parentId` 父子链与依赖无关。约束特性真实工作量约 4-6 会话（原估 2-3），且是三项里**风险最高**的（要动 store undo 契约）。因此重排为资源 → 成本 → 约束，让前两项先交付用户价值，把级联引擎作为约束特性的显式交付物集中处理。

**总估算**：12-17 个 AI 协作会话，约 4-6 周

---

## Grilling 决策记录

本节记录通过 grilling 流程锁定的设计决策，每条带理由。review 后的修正以 **[修订]** 标注。

### G1. 迁移策略：normalizeFile() 轻量方案

|          |                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | 不建完整迁移框架，只建 `normalizeFile()` 防御性归一化函数（~30 行）                                                                                 |
| **理由** | P1 变更全部是 additive（新增可选字段），旧 v1 文件天然合法。后端落地后 `RemoteRepository.load()` 返回的数据已由后端迁移，`normalizeFile()` 变 no-op |
| **备选** | (a) 建完整 `migrate(oldDoc, fromV, toV)` 框架；(b) 连 normalizeFile 都不要，靠 AJV 校验 + 报告缺失字段                                              |

> **[修订]** normalizeFile 估算从 ~20 行调至 ~30 行。两个必须额外处理的点（详见基础设施 F1）：
>
> 1. **时序约束**：`normalizeFile()` 必须在 AJV `validateGanttlyFile()` **之前**跑。旧文件的 `constraints: {}` 在类型改成 `{ type: ConstraintType; date?: string }` 后缺 `type` 字段，若先校验会直接失败。当前 `ImportMenu.handleJson`（`ImportMenu.tsx:28-47`）顺序是 `JSON.parse → validateGanttlyFile → setFile`，normalizeFile 要插在 parse 和 validate 之间。
> 2. **constraints schema 定义**：现状 `schema.json:141` 的 `constraints` 是裸 `{"type":"object"}`（无 `additionalProperties:false`），比 TS 的 `Record<string, never>` 宽松。P1 改造时必须新写 constraints 的 JSON schema 定义（含 `type` 枚举、`date` 条件必填）。

### G2. 实现顺序：资源 → 人天 → 约束

|          |                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | 资源分配与负载图 → 人天计算 → 任务约束                                                                                                                              |
| **理由** | 资源和人天不依赖级联引擎，可先交付用户价值；人天依赖资源的 `Resource.capacity` × `TaskAssignment`；约束特性真实风险最高（需从零建依赖级联引擎），放最后作为 P1 收尾 |
| **备选** | (a) 约束→资源→人天（原草案，基于"约束风险最低"的错误前提，已被 review 否决）；(b) 资源→约束→人天                                                                    |

> **[修订]** 原草案排序为"约束 → 资源 → 成本"，理由是"约束最低风险、不引入新 UI 面，是排期引擎的自然延伸"。review 致命-1 证明此前提不成立——仓库无级联引擎，约束是 greenfield 级联工作。详见特性三的风险说明。
>
> **[grilling Q7 修订]** 排序中间项由"成本计算"改为"人天计算"——货币维度砍掉后，特性二只剩人天。

### G3. 约束类型：5 种实用子集

|          |                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------- |
| **决策** | 支持 `none` / `startNoEarlierThan` (SNET) / `mustStartOn` (MSO) / `mustFinishOn` (MFO) / `finishNoLaterThan` (FNLT) 共 5 种 |
| **理由** | 覆盖 95% 场景，且都不需要与 CPM 反向传递深度耦合。ALAP（尽晚开始）需要 CPM 反向结果驱动，复杂度高，留 P2                    |
| **备选** | (a) 仅 PRD 提到的 2 种（SNET + MFO）；(b) 8 种全集（含 ALAP，完全对标 MS Project）                                          |

### G4. 约束冲突策略：约束优先 + 冲突警告

|          |                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------- |
| **决策** | 约束硬执行，依赖被违反时显示调度冲突警告（违反的依赖箭头变橙色）                                      |
| **理由** | 符合 MS Project / GanttProject 行业标准；约束是用户显式设置的硬意图，依赖是自动排期关系——硬意图应胜出 |
| **备选** | (a) 依赖优先，约束降级为"尽力而为"；(b) 自动调工期（冲突时缩短 duration，隐式改变工作范围，危险）     |

> `arrows.ts:30-34` 现有 `isCritical` 双色机制可直接扩展第三色（橙色冲突态）。

### G5. 约束可视化：标记图标 + hover 日期线

|          |                                                                                                                 |
| -------- | --------------------------------------------------------------------------------------------------------------- |
| **决策** | 任务条约束侧画小标记图标（锁/三角）+ hover 任务条时显示约束日期竖线（DOM 叠层） + 冲突依赖箭头变橙色            |
| **理由** | 标准 GanttProject 做法，空间占用小。约束侧（start 约束在左端，finish 约束在右端）画标记                         |
| **备选** | (a) 常驻约束日期线（多约束时混乱）；(b) 无可视化（仅 TaskDrawer 可见）；(c) 幽灵条（与基线 ghost bar 视觉冲突） |

### G6. Resource 模型：+capacity + role + color

|          |                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| **决策** | `Resource` 加 `capacity?`（0-1，默认 1.0）、`role?`（角色筛选）、`color?`（负载图区分）                                    |
| **理由** | `capacity` 是负载图硬需求（没有它无法判断超负荷）；`role` 支持筛选；`color` 自动从资源名 hash 生成也可，但用户自定义更灵活 |
| **备选** | (a) 最小方案只加 `capacity?`；(b) 完整方案含独立日历（每资源不同排班，P2 级复杂度）                                        |

### G7. 负载图位置：视图切换（GanttProject 式）

|          |                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | Toolbar 切换"任务视图" ↔ "资源视图"。资源视图左侧 = ResourceList（人员列表），右侧 = ResourceLoadCanvas（负载图）               |
| **理由** | 用户明确要求 GanttProject 式体验。负载图显示人员负载百分比（如"人员 A 1号到10号 80%，10号到15号 120%"），绿色 ≤100%，红色 >100% |
| **备选** | (a) 底部可折叠面板（不侵入主图）；(b) Canvas 叠加（滚动上下文耦合）；(c) 分屏（实现复杂度最高）                                 |

### G8. 分配编辑 + 调度模型：TaskDrawer + 固定工期

|          |                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | 资源分配在 TaskDrawer 中编辑（新增"资源分配"区域）；资源 CRUD 在资源视图左侧面板；P1 用固定工期模型（分配不影响排期）           |
| **理由** | TaskDrawer 是所有任务字段编辑的统一入口；固定工期不改变现有排期逻辑，资源分配是"附加信息"；工时驱动模型需重写排期逻辑，复杂度高 |
| **备选** | (a) 工时驱动模型（更多资源=更短工期）；(b) 拖拽分配（从资源列表拖到任务条，交互复杂度高）                                       |

### G9. 成本模型：纯人天（grilling 推翻双维度）

|          |                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | **只做人天，砍掉货币成本维度。** `personDays = (load/100) × capacity × duration`。`Resource.rate` 保留在 schema 但标注 deprecated 不进入任何计算/UI；不加 `Task.fixedCost`；取消 `resolveCalendar` 透传 workingHours（人天公式不碰 workingHours，duration 已是工作日数）；`cost.ts` 只留 `computeTaskPersonDays`，删 `computeTaskCost`；RollupResult 只加 `personDays` 不加 `cost` |
| **理由** | 用户核心需求是人天管理（按人天管理项目投入）。grilling 确认货币成本（rate×personDays×hoursPerDay）引入 workingHours 解析、货币格式化、多货币扩展等连锁复杂度，而用户当下不需要。砍掉后特性二从 2.5-3.5 会话降至 1.5-2 会话                                                                                                                                                         |
| **备选** | (a) 双维度（原草案，grilling 否决——货币维度复杂度不值当前价值）；(b) 统一"成本"概念不区分人天和货币                                                                                                                                                                                                                                                                                |

> **[grilling Q5→Q7 连锁]** Q5 曾定"resolveCalendar 透传 workingHours 给 computeTaskCost"，Q7 砍货币后该决策**作废**——`computeTaskPersonDays` 不需要 workingHours。`ResolvedCalendar`（`calendar.ts:17-22`）保持现状不动。
>
> **[breaking 评估]** `Resource.rate`（`types.ts:170`，schema.json:170-175）是 v0.1.0 已发布 schema 的可选字段，删除会破坏 `additionalProperties:false` 校验（旧文件若写了 rate 会失败）。故保留字段但标注 deprecated，零消费方。

### G10. 人天显示：TaskTable 列 + StatusBar 汇总 + Drawer 拆解

|          |                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **决策** | 第一轮：TaskTable 加人天列（`useViewStore.showCostColumns` 控制显隐）+ StatusBar 加总人天。第二轮：TaskDrawer 人天拆解明细（按资源列出贡献）+ 资源视图柱条人天标注 |
| **理由** | TaskTable 列和 StatusBar 汇总是核心需求；TaskDrawer 明细和资源视图标注是增强体验，可后补                                                                           |
| **备选** | (a) 只做表格+状态栏；(b) 只做 Drawer 明细                                                                                                                          |

### G11. [新增·review 后] viewMode / showCostColumns 归属：ephemeral 层

|          |                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | `viewMode`（'task' \| 'resource'）和 `showCostColumns` 放 `useViewStore`（ephemeral UI 状态），不进 schema `ViewState`，不持久化                                                                                                                                                                                                                     |
| **理由** | 现有所有导航类视图状态（scroll/zoom）都走 `setState` 绕过 undo 栈（`GanttCanvas` 滚动、`Toolbar.jumpToToday`，均有注释 "navigation, not an undoable edit"）。若放持久化 `ViewState`，走 `setViewStateCommand` 会污染 undo 历史，走 `setState` 又与持久化目的矛盾。放 `useViewStore` 与 `drawer`/`contextMenu` 同层，重开文件默认回任务视图，符合直觉 |
| **备选** | (a) 放 schema `ViewState` 持久化（原草案方案，与现有导航语义冲突）；(b) 放 `ViewState` 但走 `setState`（持久化无意义）                                                                                                                                                                                                                               |

### G12. [新增·review 后] 约束日期落非工作日：snap 到最近工作日

|          |                                                                                                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | 约束日期若落在非工作日，应用前 snap 到**最近的后续工作日**（nextWorkingDay），并在 UI 标注"已从 X 调整到 Y"                                                                                                                                                      |
| **理由** | MSO/MFO 是硬锚点，但 CPM 和 `schedule` 全是工作日感知的（`isWorkingDay`、`endDateFromDuration` 已会 snap）。若 MFO=周六 不 snap，`start = end - duration` 反算会产生跨周末的混乱。snap 到后续工作日符合"不能晚于/必须完成于"的语义（后续工作日是最保守的合法解） |
| **备选** | (a) 不 snap，允许约束日期是非工作日（语义模糊）；(b) snap 到前一个工作日（对 FNLT 语义不安全）                                                                                                                                                                   |

### G13. [新增·review 后] 摘要任务人天短路 + UI 拦截

|          |                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | `computeTaskPersonDays` 对 summary 任务短路返回 rollup 汇总值（子任务的加法总和），不读 summary 自身的 `assignments`。**[grilling Q13]** TaskDrawer UI 层也拦截：打开任务时现场算 `tasks.some(t => t.parentId === task.id)`，有子则禁用分配区并提示"摘要任务不可分配资源" |
| **理由** | schema 的 `Task` 不区分 leaf/summary（`isSummary` 是渲染时 `computeAllRollups` 派生的）。若 `.gan` 导入或手改 JSON 给了摘要任务 assignments，人天 rollup 会双计。计算层短路兜底数据正确性，UI 层拦截避免用户白填分配（两层防御）                                          |
| **备选** | (a) 仅 UI 层拦截（绕过 UI 的数据会双计）；(b) schema 层区分 leaf/summary（改动大）                                                                                                                                                                                        |

> **[grilling Q13 修正]** 原 G13 只定计算层短路，Q13 补 UI 层拦截（现场算 hasChildren）。

### G14. [新增·grilling] 级联引擎上线：历史依赖违反数据检测+弹窗

|          |                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | load 文件后，跑 `checkConstraintConflict`/级联检测统计"依赖违反"数（successor 日期早于 predecessor 暗示值）。>0 则弹窗"检测到 N 处依赖违反，是否自动顺移？"，用户确认后才执行 `cascadeSchedule` 修复；拒绝则保持原样靠箭头标红提示                                                 |
| **理由** | 审计证实 `addDependencyCommand`（`useProjectStore.ts:263-286`）建依赖后**从不重排 successor**——历史数据里大量"沉睡的依赖违反"级联引擎上线后会浮出。静默修复会悄悄改用户数据（违反告知），保持原样+标红则用户长期无视。检测后弹窗让用户知情决策，是 MS Project 打开旧文件的标准做法 |
| **备选** | (a) load 时静默自动修复（悄悄改数据）；(b) 历史违反不动只标红（实现最简但体验割裂）                                                                                                                                                                                                |

> **[grilling Q1]** `normalizeFile` 只做字段补全（constraints/capacity/holidays），**不**集成级联修复——级联修复是 load 后独立的可交互步骤。

### G15. [新增·grilling] 级联 undo 契约：泛化 applyPatchAndCapture 为多任务版

|          |                                                                                                                                                                                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | 泛化 `applyPatchAndCapture`（`useProjectStore.ts:419-438`）签名为接受 `entries: Array<{id, patch}>`，内部循环写入同一 `captured` Map（现有并集语义 `{...old, ...existing}` 天然支持多 id）。`cascadeSchedule` 返回 `Array<{id, patch}>` 后逐条喂入同一张表。`restoreCaptured`（`:441-446`）不改，查表覆盖逻辑天然支持多任务 |
| **理由** | 级联一次动多个 successor（A 改 → B/C/D 顺移），现有 capture 只捕获单任务+祖先。顺着现有 undo 并集语义走改动最小、语义自洽；新建并行栈等于维护两套 undo 语义，长期是债                                                                                                                                                       |
| **备选** | (a) cascadeSchedule 自带 forward/inverse 两份列表（维护两套语义）；(b) 并行存第二张 capturedSuccessors 表（双写易漏）                                                                                                                                                                                                       |

> **[grilling Q2]** 审计证实现有捕获集 = 目标 + 祖先（`computeCascadeRollup` 走 parentId，`useProjectStore.ts:419-446`），不含 dependents。

### G16. [新增·grilling] 级联触发时机：拖拽预览一级 / commit 算全图

|          |                                                                                                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | 拖拽过程中实时预览**直接后继**（一级 successor）给直觉反馈，pointer-up commit 时才走完整 `cascadeSchedule` 保证全图一致                                                                                                           |
| **理由** | 审计显示拖拽分两阶段：拖拽中 setState 改预览态（`GanttCanvas.tsx:253`），pointer-up 才 commit（`:303-328`）。拖拽中遍历全图对 50+ 任务项目掉帧；只预览一级让用户看到"动了 A，B 让开"，commit 时才 O(V+E) 全图。与 MS Project 一致 |
| **备选** | (a) 拖拽中实时级联全图（掉帧）；(b) 拖拽完全不级联只 commit 算（拖拽中 successor 留原地、箭头错位）                                                                                                                               |

> **[grilling Q3]** 审计证实拖拽两阶段机制：`GanttCanvas.tsx:253`（拖拽中预览）、`:303-328/:318`（commit 回滚预览态后 dispatch）。

### G17. [新增·grilling] cascadeSchedule 遍历防护：拓扑序 + 环检测断言

|          |                                                                                                                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | `cascadeSchedule` 内部用 **Kahn 算法拓扑排序**遍历依赖 DAG，排序前断言无环（复用 `wouldCreateCycle` `schedule.ts:183-214` 逻辑或检测入度队列残留）。拓扑序保证每节点只处理一次、复杂度 O(V+E)、确定性终止。检测到环则报错或 fallback 到不级联 |
| **理由** | `wouldCreateCycle` 活跃守卫 `addDependencyCommand`，但导入的 `.gan`/手改 JSON 数据未经过它，环数据会让级联无限循环冻死 UI。拓扑序天然保证单次处理且确定终止，比递归+深度计数器干净                                                            |
| **备选** | (a) 递归+深度计数器兜底（栈溢出风险、环数据跑满 1000 次才停）；(b) 不防护依赖建环时已拦（导入数据未拦）                                                                                                                                       |

> **[grilling Q8]** `wouldCreateCycle` 的调用点：`GanttCanvas.tsx:283`、`TaskDrawer.tsx:204`、测试。生产守卫只覆盖 UI 建依赖路径。

### G18. [新增·grilling] 约束与级联执行序：硬锚点覆盖 / 软约束取 max

|          |                                                                                                                                                                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | MSO/MFO 硬锚点：`earliestStart = constraintDate`（**无条件覆盖**依赖暗示值，不取 max），随后检测 `constraintDate < dependencyImplied` 则标橙色冲突（符合 G4 约束优先）。SNET 软约束：`earliestStart = max(depImplied, snetDate)`。FNLT 反向传递：硬锚点无条件覆盖 latestEnd；软约束取 min |
| **理由** | 草案 C1.2 原写法 `earliestStart = max(依赖隐含start, SNET约束日期)` 在 MSO/MFO 硬锚点下**违背 G4**——依赖暗示值更大时 `max` 会让硬锚点失效，用户钉死的日期被依赖摆布。硬锚点必须无条件胜出才能兑现 G4                                                                                      |
| **备选** | (a) 统一取 max（草案原写法，硬锚点被吞）；(b) 依赖优先约束仅标记（直接违背 G4）                                                                                                                                                                                                           |

> **[grilling Q15]** 修正草案 C1.2 算法描述的 max 写法 bug。

### G19. [新增·grilling] 资源视图滚动/选中态：独立 ephemeral 字段

|          |                                                                                                                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | `useViewStore` 新增 `resourceScrollTop`（独立于 `file.viewState.scrollTop`）和 `selectedResourceId`（独立于 `file.viewState.selectedTaskId`）。资源视图照搬主图双角色同步机制（ResourceList 写 scrollTop、ResourceLoadCanvas 读它做偏移，共享 `ROW_HEIGHT=32`/`HEADER_HEIGHT=56`）。视图切换时**互不清除**对方选中态（留在各自 store，切回自然恢复） |
| **理由** | 任务行数(N)≠资源行数(M)，复用 `file.viewState.scrollTop` 会导致切换后位置错位。主图同步机制（TaskTable.tsx:69-85 onScroll 写、GanttCanvas.tsx:133-152 读、localScrolling ref 防反馈环）成熟可复用。选中态互不清除避免丢失编辑上下文                                                                                                                  |
| **备选** | (a) 复用 file.viewState.scrollTop（行数不同必错位）；(b) 切换时互斥清除（丢失上下文）                                                                                                                                                                                                                                                                |

> **[grilling Q9/Q12]** 审计证实主图同步：`ROW_HEIGHT=32`（`layout.ts:24`）、`scrollTop` 存 `file.viewState`、`TaskTable.tsx:56-85` 双角色同步、`GanttCanvas` 无垂直滚动 DOM 靠 store 偏移渲染。

---

## 基础设施（前置，0.5-1 会话）

| 任务 | 文件                                                                                             | 内容                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1   | `packages/schema/src/normalize.ts`（新建）                                                       | `normalizeFile(file): GanttlyFile` — 检查 schemaVersion，补全缺失的可选字段默认值（如 `constraints: {}` → `{ type: 'none' }`、`resource.capacity` 缺失 → 1.0）。**必须在 AJV 校验前调用**。~30 行 |
| F2   | `apps/web/src/data/indexeddb.ts` 的 `load()` + `ImportMenu.handleJson`（`ImportMenu.tsx:28-47`） | 在 `JSON.parse` 之后、`validateGanttlyFile` 之前调用 `normalizeFile()`。IndexedDB `load()`（`indexeddb.ts:42-53`）返回后同样调用                                                                  |

> **[修订]** F1 行数从 ~20 调至 ~30（需处理 constraints 缺 `type` 的补全 + capacity 默认值）。F2 路径修正：原草案写"JSON 导入路径"，实际是 `ImportMenu.tsx` 的 `handleJson`，不在 Repository 层。
>
> **[grilling Q10]** normalizeFile **吸收** `ImportMenu.tsx:39-41` 现有的 zh-CN holidays 内联补齐逻辑（那段本质就是 normalizeFile 的雏形），ImportMenu 内联删除。三条路径（JSON 导入 `handleJson` / `.gan` 导入 `handleGan` / IndexedDB `load`）**统一**调 normalizeFile，holidays 补齐覆盖更全（当前 `.gan`/load 路径不补 holidays，统一后一致）。

### 技术债清理（0.5-1 会话）

| 任务 | 文件                                                                      | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | `engine/layout/layout.ts` + `assembly.ts` + `drag.ts` + `GanttCanvas.tsx` | 消除 `pxPerDay` 重复。实际是 **5+ 处**：`layout.ts:45-47`（canonical）、`assembly.ts:201-206`、`drag.ts:111-115`、`GanttCanvas.tsx:460-464`，且 GanttCanvas 还额外重复 `dateToPixelLocal`（`:453`）和 `durationOf`（`:466`），drag.ts 重复 `dayDelta`（`:117`）。统一引用 `layout.ts` 的 `pixelsPerDay`/`dateToPixel`/`dayDiff`。**注意**：每处都注释 "avoid circular import"，清理时要确认 import cycle 真的被打破（可能要把 `layout.ts` 提升到不依赖 Scene 的位置） |

> **[修订]** T1 重复处数从 4 改为 5+（含 dateToPixel/durationOf/dayDelta），估算 0.5 → 0.5-1。**T1 必须在特性一 R3.3（ResourceLoadCanvas）之前完成**，否则资源负载图会成为第 6/7/8 处复制点。

---

## 特性一：资源分配与负载图（4-5 会话）

> 排在第一位。不依赖级联引擎，风险最低，用户价值直接。

### 数据模型变更

```typescript
// Resource 扩展（packages/schema/src/types.ts:166-171）
interface Resource {
  id: string;
  name: string;
  rate?: number; // 时薪，已有字段。grilling Q7：保留 schema 但标 deprecated，不进 P1 计算/UI（货币维度砍掉）
  capacity?: number; // 0-1，默认 1.0 = 全职，新增
  role?: string; // 角色筛选，新增
  color?: string; // 负载图视觉区分，新增
}

// useViewStore 扩展（apps/web/src/store/useViewStore.ts:16-25，ephemeral 层，不进 schema）
interface ViewStoreState {
  // ... 现有 drawer/contextMenu 字段 ...
  viewMode: 'task' | 'resource'; // 新增，默认 'task'，不持久化（G11）
  setViewMode(mode: 'task' | 'resource'): void;
}
```

`TaskAssignment` 不加新字段，`{ resourceId, load }`（`types.ts:157-160`）已够用。

### 负载计算算法

```typescript
// 对每个资源，遍历所有分配到它的任务
// 在任务的工作日范围内，每天累加 load
function computeResourceLoad(tasks, resources, calendar) {
  const loadMap = new Map<string, Map<string, number>>(); // resourceId → date → totalLoad
  for (const task of tasks) {
    for (const assignment of task.assignments) {
      const days = iterateWorkingDays(task.start, task.end, calendar);
      for (const date of days) {
        const dayLoad = loadMap.get(assignment.resourceId)?.get(date) ?? 0;
        setDayLoad(assignment.resourceId, date, dayLoad + assignment.load);
      }
    }
  }
  return loadMap;
}
```

**并行分配场景**（同一项目内一人多任务）：

- 人员 A 分配到任务 X（load=30%，1/1-1/15）+ 任务 Y（load=70%，1/1-1/15）
- 负载图显示：1/1-1/15 总负载 = 30% + 70% = 100%（不超负荷）
- 任务 X 人天 = 0.3 × 1.0 × 11工作日 = 3.3 人天
- 任务 Y 人天 = 0.7 × 1.0 × 11工作日 = 7.7 人天
- 人员 A 总投入 = 11 人天

### 技术依赖

| 层     | 文件                                                                                             | 改动                                                                                                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema | `packages/schema/src/types.ts:166-171` + `packages/schema/schema.json`（注意：在 `src/` 上一层） | `Resource` 加 `capacity?`、`role?`、`color?`；schema.json 的 resource `$def`（`:168-177`）同步加字段                                                                                                                                 |
| Lib    | `apps/web/src/lib/resourceLoad.ts`（新建）                                                       | `computeResourceLoad(tasks, resources, calendar): ResourceLoadMap` — 遍历所有 TaskAssignment，按 resourceId 聚合，按日期累加 load                                                                                                    |
| Engine | `apps/web/src/engine/render/types.ts:33-45`                                                      | 新增 `ResourceRow` 接口 + `ResourceScene` 接口                                                                                                                                                                                       |
| Engine | `apps/web/src/engine/render/resourceLoad.ts`（新建）                                             | `renderResourceLoad(ctx, scene, theme)` — 绿色柱 ≤100%，红色柱 >100%，柱高 = load%                                                                                                                                                   |
| Engine | `apps/web/src/engine/scene/assembly.ts:28-87`                                                    | 新增 `assembleResourceScene(file, opts)` 或在 `assembleScene` 中加 viewMode 分支                                                                                                                                                     |
| Store  | `apps/web/src/store/useViewStore.ts:16-25`                                                       | 加 `viewMode: 'task' \| 'resource'` + `setViewMode()`（**ephemeral，不进 schema ViewState**，G11）。**[G19]** 加 `resourceScrollTop`（独立于 file.viewState.scrollTop，因行数不同）+ `selectedResourceId`（切视图互不清除）          |
| Store  | `apps/web/src/store/useProjectStore.ts`                                                          | 新增 `addResourceCommand` / `updateResourceCommand` / `deleteResourceCommand` / `assignResourceCommand(taskId, assignment)` / `unassignResourceCommand(taskId, resourceId)`（现仓库有 11 个 command 工厂函数，非原草案笔误的 10 个） |
| UI     | `apps/web/src/components/ResourceList.tsx`（新建）                                               | 左侧面板，复用 TaskTable 行布局（`ROW_HEIGHT=32`/`HEADER_HEIGHT=56`，`layout.ts:24,27`）+ 双角色同步机制（`onScroll` 写 `useViewStore.resourceScrollTop`），显示 name/role/capacity，支持增删改                                      |
| UI     | `apps/web/src/components/ResourceLoadCanvas.tsx`（新建）                                         | 右侧 Canvas，**[Q4]** 共享主图 ZoomLevel + `layout.pixelsPerDay`/`dateToPixel`（零新复制点），读 `useViewStore.resourceScrollTop` 做渲染偏移，调用 `renderResourceLoad`                                                              |
| UI     | `apps/web/src/components/TaskDrawer.tsx:70-216`                                                  | 新增"资源分配"区域：列出已有分配 + 下拉选资源 + load 滑块。沿用 `DependencyAdder`（`:271-333`）的复合编辑器模式                                                                                                                      |
| UI     | `apps/web/src/components/Toolbar.tsx:124-134`                                                    | 新增视图切换按钮（任务视图 ↔ 资源视图）。zoom 簇后、critical-path toggle 前，复用 `pressed` toggle 先例                                                                                                                              |
| UI     | `apps/web/src/components/GanttView.tsx:38-49`                                                    | 根据 `viewMode` 切换渲染 TaskTable+GanttCanvas 或 ResourceList+ResourceLoadCanvas（注意：真实布局组件是 `GanttView.tsx`，非 `App.tsx`——`App.tsx` 只是 14 行的 trivial wrapper）                                                      |

### 任务分解

| ID   | 任务                                         | 会话 |
| ---- | -------------------------------------------- | ---- |
| R1.1 | Resource 接口扩展 + schema.json              | S1   |
| R1.2 | 资源 CRUD + 分配 commands                    | S1   |
| R1.3 | `computeResourceLoad()` + 单测               | S1   |
| R2.1 | `viewMode` 加入 viewStore + Toolbar 切换按钮 | S2   |
| R2.2 | ResourceList 组件                            | S2   |
| R2.3 | TaskDrawer 分配编辑区域                      | S2   |
| R3.1 | ResourceRow/ResourceScene 类型               | S3   |
| R3.2 | `renderResourceLoad()` 渲染器                | S3   |
| R3.3 | ResourceLoadCanvas 组件 + 时间轴同步         | S3   |
| R4.1 | 超负荷红色高亮 + 负载百分比文本              | S4   |
| R4.2 | 资源列表 CRUD UI 完整交互                    | S4   |
| R4.3 | 截图测试 + E2E                               | S4   |
| R5.1 | 边界处理 + 性能优化（100+ 资源）             | S5   |

### 风险

1. **pxPerDay 四处重复**：已知技术债（实际 5+ 处，见基础设施 T1）。资源负载图会是新的复制点。**T1 必须在 R3.3 之前完成**（统一引用 `layout.ts` 的 `pixelsPerDay`/`dateToPixel`），约 0.5-1 会话。**[Q4 已决策]** ResourceLoadCanvas 共享主图 ZoomLevel/layout，零新复制点
2. **视图切换状态保持**：**[G19 已决策]** task ↔ resource 切换时 scrollLeft/zoom/originDate 保持一致（在 `file.viewState`），但 scrollTop 各自独立（`useViewStore.resourceScrollTop`，因行数不同），选中态互不清除（`selectedResourceId` 独立 ephemeral）
3. **负载计算性能**：O(tasks × assignments × days)，100 任务 × 5 分配 × 30 天 = 15,000 次迭代，需确保在场景组装时预算而非每次渲染时重算
4. **摘要任务的 assignments**：**[G13/Q13 已决策]** UI 层现场算 `tasks.some(t=>t.parentId===task.id)` 拦截（禁用分配区），计算层 `computeTaskPersonDays` 对 summary 短路返回 rollup 值。两层防御

---

## 特性二：人天计算（1.5-2 会话，grilling 瘦身）

> 排在第二位。依赖特性一的 `Resource.capacity` × `TaskAssignment`。
>
> **[grilling Q6/Q7 重大修订]** 原草案为"成本计算（2.5-3.5 会话）"含人天+货币双维度。grilling 确认砍掉货币维度：`Resource.rate` 保留 schema 但标 deprecated 不用、不加 `Task.fixedCost`、取消 `resolveCalendar` 透传 workingHours（K0.1 删除）、`cost.ts` 只留 `computeTaskPersonDays`、RollupResult 只加 `personDays`。特性从 2.5-3.5 会话降至 1.5-2 会话。

### 数据模型变更

```typescript
// Task 不变（不加 fixedCost，grilling Q7 砍掉）
// Resource.rate 保留但 deprecated 不用（grilling Q7）

// RollupResult 扩展（apps/web/src/lib/summary.ts:27-36，web-app-local 类型，不在 schema 包）
interface RollupResult {
  start: string;
  end: string;
  duration: number;
  progress: number;
  personDays: number; // 新增：Σ(子任务人天)，加法汇总。不加 cost
}

// useViewStore 扩展（ephemeral，不进 schema，G11）
interface ViewStoreState {
  // ... viewMode / resourceScrollTop / selectedResourceId ...
  showCostColumns: boolean; // 新增：控制 TaskTable 人天列显隐，默认 false
  setShowCostColumns(v: boolean): void;
}
```

### 人天计算公式

```
personDays = (load/100) × capacity × duration

其中：
  load = TaskAssignment.load（0-100，资源投入百分比）
  capacity = Resource.capacity（0-1，资源容量，缺失默认 1.0）
  duration = Task.duration（工作日数）
```

> **不碰** `Resource.rate`、`workingHours`、`hoursPerDay`（grilling Q7 砍货币后这些无需）。`ResolvedCalendar` 保持现状（`calendar.ts:17-22` 不改，Q5 决策作废）。

**示例**：

- 人员 A（capacity=1.0 全职）分配到任务 X，load=50%，duration=10 工作日
  - 人天 = 0.5 × 1.0 × 10 = 5 人天
- 并行分配：人员 A 在任务 X（load=30%）+ 任务 Y（load=70%），各 11 工作日
  - X 人天 = 0.3 × 1.0 × 11 = 3.3，Y 人天 = 0.7 × 1.0 × 11 = 7.7，A 总投入 = 11 人天

### 技术依赖

| 层     | 文件                                                           | 改动                                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lib    | `apps/web/src/lib/cost.ts`（新建）                             | `computeTaskPersonDays(task, resources): number` — Σ(assignment: (load/100) × capacity × duration)；**对 summary 任务短路返回 rollup 值**（G13）                                                                              |
| Lib    | `apps/web/src/lib/summary.ts:27-36,49-95`                      | `RollupResult` 加 `personDays: number`（不加 cost）；`computeRollup` 中加法汇总子任务 personDays。**注意**：`progress` 走加权平均（含全完成短路 `:85-86` 和零权重回退 `:87-89`），`personDays` 走纯加法，两套规则不能互相干扰 |
| Engine | `apps/web/src/engine/scene/assembly.ts:37`                     | `computeAllRollups`（在此行调用）返回值含 personDays；场景组装时预算人天                                                                                                                                                      |
| Store  | `apps/web/src/store/useProjectStore.ts`                        | `updateTaskWithRollupCommand`（`:452-476`）触发人天 rollup 重算（复用现有 `computeCascadeRollup` 扩展）                                                                                                                       |
| UI     | `apps/web/src/components/TaskTable.tsx:37,273-281,317,326-387` | 新增"人天"列（`useViewStore.showCostColumns` 控制显隐）。**注意 GRID_TEMPLATE 是脆弱的 4-track 字符串**（`:37`），加列要改常量 + header + row cell 三处，header 与 row 必须共享模板                                           |
| UI     | `apps/web/src/components/StatusBar.tsx:21-27`                  | 显示项目总人天。`useMemo` 聚合 `file.tasks`                                                                                                                                                                                   |
| UI     | `apps/web/src/components/TaskDrawer.tsx`                       | 分配区域下方加人天拆解（按资源列出贡献）                                                                                                                                                                                      |
| UI     | `apps/web/src/components/ResourceLoadCanvas.tsx`               | 柱条上标注人天数                                                                                                                                                                                                              |

### 任务分解

| ID   | 任务                                                                             | 会话 |
| ---- | -------------------------------------------------------------------------------- | ---- |
| K1.2 | `computeTaskPersonDays()`（含 summary 短路）                                     | S1   |
| K1.3 | RollupResult 扩展 personDays + computeRollup 加法汇总（注意进度/人天双规则隔离） | S1   |
| K1.4 | 单测：人天计算 + rollup + summary 短路                                           | S1   |
| K2.1 | TaskTable 人天列（可切换）                                                       | S2   |
| K2.2 | StatusBar 总人天                                                                 | S2   |
| K2.3 | assembleScene 中预算人天 rollup                                                  | S2   |
| K3.1 | TaskDrawer 人天拆解明细                                                          | S3   |
| K3.2 | 资源视图柱条人天标注                                                             | S3   |
| K3.3 | E2E + 截图测试                                                                   | S3   |

> **删除的任务**（grilling Q7 砍货币）：K0.1（resolveCalendar 透传 workingHours）、K1.1（Task.fixedCost）、`computeTaskCost`、货币显示相关。

### 风险

1. **人天 rollup 与进度 rollup 混合**：`computeRollup`（`summary.ts:49-95`）目前做加权平均进度，加 personDays 后需确保两种聚合方式（加权平均 vs 加法）不互相干扰。具体：`progress` 的全完成短路（`:85-86`）和零权重回退算术平均（`:87-89`）不能波及 personDays
2. **摘要任务 assignments 双计**：G13 已决策——在 `computeTaskPersonDays` 对 summary 短路返回 rollup 值，且 UI 层也拦截（Q13）

---

## 特性三：任务约束（4-6 会话）

> ⚠️ **排在最后，风险最高。** 原草案基于"约束是排期引擎的自然延伸"估算 2-3 会话、判为最低风险——review 致命-1 证明此前提不成立。仓库**当前不存在依赖级联引擎**（`satisfyDependency` 是死代码），本特性的核心工作之一是从零搭建级联引擎。

### 为什么工作量从 2-3 跃升到 4-6

逐文件核对确认（详见 `docs/P1-review.md` 致命-1）：

| 调度能力                                 | 实际状态                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| 依赖环检测 `wouldCreateCycle`            | ✅ 已实现（`schedule.ts` 唯一被生产代码 import 的符号）                   |
| 依赖箭头渲染 `computeArrows`             | ✅ 已实现（只读）                                                         |
| 关键路径着色 `computeCriticalPath`       | ✅ 已实现（只读，`earliestStart/latestEnd` 被丢弃只用 `criticalTaskIds`） |
| 摘要 rollup `computeCascadeRollup`       | ✅ 已实现（走 `parentId` 父子链，与依赖无关）                             |
| **依赖驱动日期重排 `satisfyDependency`** | ❌ **死代码**（`schedule.ts:142`，零生产调用点）                          |
| **CPM 结果回写 task 日期**               | ❌ 不存在                                                                 |
| **约束执行**                             | ❌ 不存在                                                                 |

**数据流实测**：今天拖动任务 A（前置）改开始日期，依赖 A 的任务 B（FS）**不会自动顺移**。B 留在原地，箭头指向错位，仅此而已。

### 数据模型变更

```typescript
// packages/schema/src/types.ts:154
// TaskConstraints 从空 Record 改为具体接口
type ConstraintType =
  | 'none'
  | 'startNoEarlierThan' // 不能早于 X 开始（SNET）
  | 'mustStartOn' // 必须在 X 开始（MSO）
  | 'mustFinishOn' // 必须在 X 完成（MFO）
  | 'finishNoLaterThan'; // 不能晚于 X 完成（FNLT）

interface TaskConstraints {
  type: ConstraintType; // 默认 'none'，normalizeFile 补全
  date?: string; // ISO date，type !== 'none' 时必填
}
```

### 级联引擎与约束集成算法

```
正向传递（earliestStart）—— 依据 G18 硬锚点覆盖 / 软约束取 max：
  depImplied = computeImpliedStart(predecessor, dep, cal)   // 依赖隐含 start
  switch 约束 type:
    case 'none' / FNLT:  earliestStart = depImplied
    case SNET:           earliestStart = max(depImplied, constraintDate)   // 软约束
    case MSO:            earliestStart = constraintDate                    // 硬锚点，无条件覆盖
    case MFO:            earliestStart = constraintDate - duration         // 硬锚点反算 start

反向传递（latestEnd）—— G18 同理：
  depImpliedEnd = computeImpliedEnd(predecessor, dep, cal)
  switch 约束 type:
    case 'none' / SNET / MSO:  latestEnd = depImpliedEnd
    case FNLT:                 latestEnd = min(depImpliedEnd, constraintDate)   // 软约束
    case MFO:                  latestEnd = constraintDate                       // 硬锚点

冲突检测（G4 约束优先，依赖被违反标橙）：
  if MSO and constraintDate < depImplied:    标记冲突（约束赢，依赖箭头变橙）
  if MFO and (constraintDate - duration) < depImplied:  标记冲突
  if MFO and constraintDate < depImpliedEnd:  标记冲突

约束日期 snap（G12）：
  约束日期落非工作日 → snap 到最近后续工作日（nextWorkingDay）
  UI 标注"已从 X 调整到 Y"（G11/Q11：Drawer 常驻 + hover tooltip）

遍历防护（G17）：
  cascadeSchedule 用 Kahn 拓扑序遍历依赖 DAG，排序前断言无环
  拓扑序保证每节点只处理一次、O(V+E) 确定终止
```

> **[grilling G18 关键修正]** 原草案写法 `earliestStart = max(依赖隐含start, SNET约束日期)` 对 MSO/MFO 硬锚点**错误**——依赖暗示值更大时 max 会让硬锚点失效，违背 G4「约束优先」。硬锚点必须无条件覆盖依赖暗示值，随后检测冲突标橙。SNET/FNLT 软约束才取 max/min。

### 技术依赖

#### 第一部分：级联引擎（greenfield，核心工作量）

| 层        | 文件                                                            | 改动                                                                                                                                                                                                                                               |
| --------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lib       | `apps/web/src/lib/schedule.ts:142`（现死代码）+ 新建级联驱动器  | 新建 `cascadeSchedule(tasks, changedTaskId, calendar): Array<{id, patch}>` —— **Kahn 拓扑序**遍历依赖 DAG（G17），排序前断言无环，逐 successor 调用 `satisfyDependency`（现仅单测调用），返回需重排的任务 patch 列表。**这是当前完全不存在的函数** |
| Store     | `apps/web/src/store/useProjectStore.ts:452-476,485-535,263-286` | `updateTaskWithRollupCommand`、`moveTaskWithRollupCommand`、`addDependencyCommand` 接入级联——目前这些只做 `parentId` rollup，不触碰 dependents                                                                                                     |
| Store     | `apps/web/src/store/useProjectStore.ts:419-446`                 | **[G15]** 泛化 `applyPatchAndCapture` 签名为接受 `entries: Array<{id, patch}>`，内部循环写入同一 `captured` Map（现有并集语义 `{...old,...existing}` 天然支持多 id）。`restoreCaptured` 不改。undo 整体回滚多 successor                            |
| UI        | `apps/web/src/components/GanttCanvas.tsx:303-328`               | **[G16]** 拖拽 pointer-up 的 commit 路径接入完整级联；拖拽中（`:253` 预览态）只预览一级 successor 给直觉反馈                                                                                                                                       |
| Lib/Store | load 路径（`indexeddb.ts:42-53` + `ImportMenu`）                | **[G14]** load 文件后跑依赖违反检测，>0 弹窗询问是否自动顺移，用户确认后才 cascadeSchedule。normalizeFile **不**集成级联修复                                                                                                                       |

#### 第二部分：约束语义层（建立在级联引擎之上）

| 层     | 文件                                                                   | 改动                                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema | `packages/schema/src/types.ts:154` + `packages/schema/schema.json:141` | `TaskConstraints` 改为具体接口；新增 `ConstraintType` 联合类型；**新写 constraints 的 JSON schema 定义**（现状是裸 `{"type":"object"}` 无 `additionalProperties:false`，见 G1 修订） |
| Lib    | `apps/web/src/lib/schedule.ts`                                         | 新增 `satisfyConstraint(task, constraint, cal): ScheduleResult` — 在依赖满足后应用约束，取 max/min，含 G12 的非工作日 snap                                                           |
| Lib    | `apps/web/src/lib/schedule.ts`                                         | 新增 `checkConstraintConflict(tasks, calendar): Conflict[]` — 检测约束与依赖冲突                                                                                                     |
| Lib    | `apps/web/src/lib/cpm.ts:58,79-123,140-199`                            | 正向传递：SNET 作 earliestStart 地板值，MFO/MSO 作硬锚点；反向传递：FNLT 作 latestEnd 天花板，MFO 作硬锚点                                                                           |
| Engine | `apps/web/src/engine/render/types.ts:33-45`                            | `TaskRow` 加 `constraint?: { type: ConstraintType; date: string }`                                                                                                                   |
| Engine | `apps/web/src/engine/render/bars.ts:50-115`                            | `drawRow` 中新增约束标记图标绘制分支                                                                                                                                                 |
| Engine | `apps/web/src/engine/scene/assembly.ts:89-112`                         | `toTaskRow` 中从 `task.constraints` 映射到 `TaskRow.constraint`                                                                                                                      |
| Engine | `apps/web/src/engine/render/arrows.ts:30-34`                           | 冲突箭头颜色：`isConflict` 标记 → 橙色（扩展现有 `isCritical` 双色机制）                                                                                                             |
| Store  | `apps/web/src/store/useProjectStore.ts`                                | 新增 `updateConstraintCommand(taskId, constraint)`                                                                                                                                   |
| UI     | `apps/web/src/components/TaskDrawer.tsx:70-216`                        | 新增"约束"编辑区域：类型下拉 + 日期选择器                                                                                                                                            |
| UI     | `apps/web/src/components/GanttCanvas.tsx:211,338-352`                  | hover 任务条时，若有约束则显示约束日期竖线（DOM 叠层）。可复用现有 holiday hover tooltip 机制（`pixelToDate` round-trip `:341`）                                                     |
| Import | `packages/gan-parser/src/index.ts:187`                                 | **[降级为 stretch]** 映射 `thirdDate-constraint` 数值 → `ConstraintType` 枚举。当前 parser 硬编码 `constraints: {}`，从未读取 thirdDate，且枚举语义需调研，建议三项做完后再做        |

### 任务分解

| ID                       | 任务                                                                                            | 会话 |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ---- |
| **第一部分：级联引擎**   |                                                                                                 |      |
| E1.1                     | 实现 `cascadeSchedule()` 级联驱动器（Kahn 拓扑序 + 环断言，G17）+ 单测                          | S1   |
| E1.2                     | 接入 `updateTaskWithRollupCommand` + `moveTaskWithRollupCommand`                                | S2   |
| E1.3                     | 接入 `addDependencyCommand` + GanttCanvas 拖拽路径（G16：拖拽预览一级/commit 全图）             | S2   |
| E1.4                     | 泛化 `applyPatchAndCapture` 为多任务版（G15）+ undo 整体回滚                                    | S2   |
| E1.5                     | E2E：拖动前置任务，successor 自动顺移 + undo 整体回滚                                           | S3   |
| E1.6                     | **[G14 新增]** load 路径依赖违反检测 + 弹窗询问修复                                             | S3   |
| **第二部分：约束语义层** |                                                                                                 |      |
| C1.1                     | 更新 `TaskConstraints` 接口 + `ConstraintType` 类型 + schema.json（含 constraints schema 定义） | S3   |
| C1.2                     | 实现 `satisfyConstraint()`（含 G12 snap + G18 硬锚点覆盖逻辑）+ `checkConstraintConflict()`     | S4   |
| C1.3                     | CPM 正反传递加约束分支（G18：硬锚点无条件覆盖/软约束取 max）                                    | S4   |
| C1.4                     | 单测：约束逻辑 + CPM 集成 + 非工作日 snap + 硬锚点冲突                                          | S4   |
| C2.1                     | `updateConstraintCommand` + store 集成                                                          | S5   |
| C2.2                     | TaskDrawer 约束编辑器（含 Q11 snap 反馈常驻标注）                                               | S5   |
| C2.3                     | bars.ts 约束标记渲染 + assembly 映射                                                            | S5   |
| C2.4                     | hover 约束日期线（含 Q11 snap tooltip）+ 冲突箭头橙色                                           | S6   |
| C3.1                     | **[stretch]** `.gan` 约束类型映射（需先调研 thirdDate-constraint 枚举语义）                     | S6+  |
| C3.2                     | E2E + 截图测试                                                                                  | S6   |

### 风险

1. **级联引擎是 greenfield**：`satisfyDependency` 虽存在且有单测，但从无驱动器遍历依赖图调用它。E1.1-E1.6 是本特性最大不确定性来源
2. **undo 正确性**：一次级联动多个 successor，现有 `applyPatchAndCapture`/`restoreCaptured` 只捕获单任务 + 祖先。**[G15 已决策]** 泛化为多任务版，复用并集语义。审计证实捕获集逻辑（`useProjectStore.ts:419-446`）天然支持 Map 多 id，改动可控
3. **历史依赖违反数据**：**[G14 已决策]** `addDependencyCommand`（`:263-286`）从不重排 successor，旧文件里大量沉睡的依赖违反。load 时检测+弹窗询问，而非静默修复
4. **MFO 反算 start 可能早于依赖隐含值**：**[G18 已决策]** 硬锚点无条件覆盖依赖暗示值，`checkConstraintConflict` 检测 `constraintDate < depImplied` 标橙色冲突
5. **约束日期落非工作日**：**[G12/Q11 已决策]** snap 到最近后续工作日，Drawer 常驻 + hover tooltip 标注"已从 X 调整到 Y"
6. **`.gan` 约束数值映射**：需验证 GanttProject 的 `thirdDate-constraint` 具体数值含义（0-7 对应关系）。**已降级为 stretch**，不在关键路径
7. **CPM 性能**：约束分支在正反传递中增加条件判断，但复杂度仍为 O(V+E)，不影响
8. **环数据冻死 UI**：**[G17 已决策]** Kahn 拓扑序 + 环检测断言保证确定终止，导入的 .gan/手改 JSON 环数据不会无限循环

---

## 数据模型变更汇总

所有变更均为 additive（新增可选字段），不破坏 v1 文件兼容性：

| 接口                                       | 变更                                                                                                     | 影响特性         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------- |
| `TaskConstraints`                          | `Record<string, never>` → `{ type: ConstraintType; date?: string }`                                      | 约束             |
| `ConstraintType`                           | 新增联合类型：`'none' \| 'startNoEarlierThan' \| 'mustStartOn' \| 'mustFinishOn' \| 'finishNoLaterThan'` | 约束             |
| `Resource`                                 | 加 `capacity?: number`、`role?: string`、`color?: string`                                                | 资源             |
| `Resource.rate`                            | 保留 schema 不变，标注 deprecated（grilling Q7 不使用）                                                  | 资源（货币砍掉） |
| `RollupResult`（web-app-local，非 schema） | 加 `personDays: number`（不加 cost，grilling Q7）                                                        | 人天             |
| `useViewStore`（ephemeral，非 schema）     | 加 `viewMode`、`showCostColumns`、`resourceScrollTop`（G19）、`selectedResourceId`（G19）                | 资源/人天        |

`schemaVersion` 保持 1 不变。`normalizeFile()` 在 load/import 时、**AJV 校验前**补全缺失字段默认值（G1 修订），并吸收 zh-CN holidays 补齐（Q10）。

> `viewMode`/`showCostColumns`/`resourceScrollTop`/`selectedResourceId` 不进 schema `ViewState`，放 ephemeral `useViewStore`，不持久化（G11/G19）。
>
> **[grilling Q5/Q7 作废]** 原 RollupResult 加 `cost`、Task 加 `fixedCost`、ResolvedCalendar 透传 `workingHours` 三项**全部取消**——货币维度砍掉后无意义。

---

## 总工作量与时间线

| 阶段     | 内容                                                                         | 会话数      | 周次           |
| -------- | ---------------------------------------------------------------------------- | ----------- | -------------- |
| 基础     | normalizeFile()（含 AJV 时序 + constraints schema + 吸收 holidays 补齐 Q10） | 0.5-1       | W1             |
| 技术债   | 消除 pxPerDay 重复（实际 5+ 处，须在 R3.3 前）                               | 0.5-1       | W1             |
| 资源     | 模型 + 负载图 + CRUD + 测试                                                  | 4-5         | W1-W3          |
| 人天     | 人天计算 + rollup + 显示（grilling 砍货币，2.5-3.5→1.5-2）                   | 1.5-2       | W3-W4          |
| 约束     | **级联引擎（greenfield）+** 约束语义层 + 可视化 + load 违反检测（G14）       | 4.5-6.5     | W4-W6          |
| **合计** |                                                                              | **11-15.5** | **3.5-5.5 周** |

> **[grilling 修订]** 总估算从 review 后的 12-17 调至 11-15.5。变更：成本特性 2.5-3.5 → 1.5-2（砍货币：删 workingHours 透传/fixedCost/computeTaskCost/货币显示）；约束特性 4-6 → 4.5-6.5（+G14 load 违反检测 E1.6 约 0.5 会话）。净降 1-1.5 会话。

---

## 后续 P1 候选（本次未规划）

| 特性                                 | 状态                             | 备注                                                                                                                                                                                           |
| ------------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 货币成本（rate×人天×工时+fixedCost） | 已 grilling，本次砍掉（G9 修订） | grilling Q6/Q7 确认只留人天。`Resource.rate` 已保留 schema 待用。恢复需：resolveCalendar 透传 workingHours + computeTaskCost + 货币格式化（Intl.NumberFormat + file.currency）+ Task.fixedCost |
| 基线对比                             | 已 grilling，用户选择暂缓        | 数据结构 `Baseline`/`BaselineTask`（`types.ts:177-190`）已就绪，ghost bar 方案已设计                                                                                                           |
| 自定义列                             | 未规划                           | PRD §8 P1 路线图。`Task.customFields: Record<string, unknown>`（`types.ts:134`）已预留                                                                                                         |
| PDF / PNG 导出                       | 未规划                           | PRD §8 P1 路线图                                                                                                                                                                               |
| 节假日云端更新                       | 未规划                           | PRD §8 P1 路线图，需后端                                                                                                                                                                       |
| iCalendar (.ics) 导出                | 未规划                           | PRD §8 P1 路线图                                                                                                                                                                               |

这些可在上述三项完成后根据优先级再排期。
