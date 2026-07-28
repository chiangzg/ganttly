# ganttly v0.4.0 — 基线对比

> 让 ganttly 从「排计划工具」进入「计划控制工具」：保存不可变的计划基线，在画布、任务表、任务详情和状态栏中按项目工作日查看当前计划相对基线的完成偏差。

🎨 **在线 demo**:https://chiangzg.github.io/ganttly/

---

## 主要特性

### 基线对比（核心特性）

一个项目可保存多个命名、不可变的基线快照，一次启用一条与当前计划比较。

| 能力                        | 说明                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| **多基线 + 不可变性**       | 一个项目允许多条基线；快照创建后不可修改，只允许重命名和删除（无「更新快照」入口）            |
| **一次只比较一条**          | 工具栏基线入口以 radio 菜单选择活动基线；`null` 表示不比较。切换不进入撤销栈                  |
| **按项目工作日计算偏差**    | 开始 / 完成 / 工期偏差复用 `isWorkingDay()`，自动包含周末、法定节假日与调休补班               |
| **画布双层任务条**          | 比较模式中每行分当前计划条（上层）+ 基线参照轨道（下层中性灰蓝），摘要/里程碑各有对应双层几何 |
| **四处一致的偏差展示**      | TaskTable 偏差列、TaskDrawer 偏差区块、StatusBar 汇总、Canvas tooltip 共用同一纯函数口径      |
| **创建/重命名/删除可撤销**  | 三个 command 进入现有 undo/redo 栈与自动保存流程；删除活动基线时先退出比较                    |
| **新增 / 已删除任务语义**   | 当前有、基线无 → `新增`；当前无、基线有 → 计入已删除统计（不创建虚拟行）                      |
| **切换基线保持视口中心**    | 切换更早基线导致 origin 左移时，按视口中心日期重新锚定 `scrollLeft`，日期不整体跳动           |
| **图表范围自动扩展**        | 活动基线的日期范围纳入 `originDateFor` / `chartEndDate`，基线轨道不被裁剪                     |
| **刷新 / 项目切换关闭比较** | 活动基线属于临时 UI 状态（`useViewStore`），不写入项目文件；stale ID 自动清空                 |
| **JSON 导入导出保留基线**   | 基线是 `GanttlyFile` 顶层字段，round-trip 自动保留；项目复制（structured clone）同样保留      |

### 偏差计算规则

- `finishDelta > 0` 为延期（danger），`< 0` 为提前（success），`=== 0` 为按计划（muted）。
- 状态以**完成日期**为准：开始或工期变化但完成日期不变仍属按计划，详情中展示其他偏差。
- 项目级「延期任务数」和「最大延期」只统计当前**叶子**任务，避免摘要与子任务重复计数。

## 视觉设计

- 新增 `--color-baseline` 中性灰蓝 token（亮色 `100 116 139` / 暗色 `148 163 184`），基线始终中性，红/绿仅用于当前偏差结果。
- 普通任务条：`yTop+4`、高 16px；基线轨道：`yTop+24`、高 4px、alpha 0.55，不使用虚线。
- 里程碑：当前为上层较大实心菱形，基线为底部较小空心菱形。
- 关键路径仍用 critical 红色，约束标记 / 选中环只作用于当前任务条。

## 技术实现

| 模块                           | 说明                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`lib/baseline.ts`**          | 新增纯函数模块：`createBaselineSnapshot` / `signedWorkingDayDelta` / `compareTaskToBaseline` / `summarizeBaselineVariance` / `findActiveBaseline` / `buildEffectiveValues`，全部 O(n) |
| **`useProjectStore` commands** | 新增 `createBaselineCommand` / `renameBaselineCommand` / `deleteBaselineCommand`，遵循现有 capture-undo 模式                                                                          |
| **`useViewStore`**             | 新增 `activeBaselineId`（临时 UI 状态），`resetForProjectSwitch()` 清空                                                                                                               |
| **Scene 装配**                 | `AssembleOptions.activeBaseline`、`TaskRow.baseline` / `baselineVariance`、`originDateFor` / `chartEndDate` 扩展                                                                      |
| **Canvas 渲染**                | `bars.ts` 双层渲染（基线轨道先绘，当前条在上）；`ThemeColors.baseline`                                                                                                                |
| **`useBaselineHover`**         | 新增 hover tooltip hook，与 `useHolidayHover` 共享优先级（任务/基线命中优先）                                                                                                         |
| **React 组件**                 | `BaselineControl`（工具栏入口 + radio 菜单 + 摘要）、`BaselineDialogs`（创建/管理/重命名/删除）、`BaselineVariance`（共享展示）                                                       |
| **i18n**                       | `zh-CN` / `en` 补齐 `baseline.*` 与 `toolbar.baseline*` 文案                                                                                                                          |

## 不变项

- `GanttlyFile` 数据 schema **仍为 v1**：`Baseline` / `BaselineTask` 类型与 `schema.json` 在 MVP 即已预留，本期不新增字段、不提升 `schemaVersion`。
- 活动基线**不写入**项目文件或 Repository preferences。
- Renderer 不直接读取 Zustand，只消费 Scene。
- 服务端 API 与实时协同仍不在本期范围。

## 明确不做（首版非目标）

恢复到基线、覆盖已有基线快照、两条基线互比、自动版本历史、进度偏差 / 挣值分析 / S 曲线、偏差排序 / 筛选 / 分析侧栏、基线协作 / 权限 / 服务端同步。

## 测试

- **单元测试**：新增 `unit/lib/baseline.test.ts`（31 例，覆盖捕获 / 有符号工作日偏差 / 跨节假日与调休 / 匹配 / 汇总去重 / 1000 任务线性性能）与 `unit/store/baseline-commands.test.ts`（11 例，覆盖 create/rename/delete 的 apply/invert、dispatch、undo/redo、dirty）。
- **E2E**：新增 `baseline-comparison.spec.ts` 覆盖创建首条基线、多基线切换、停止比较、表格/详情/状态栏一致性、新增任务语义、JSON round-trip、亮/暗截图。
- **性能**：扩充 `perf.spec.ts`，新增 1000 任务 + 1000 BaselineTask 活动基线下的滚动 FPS 用例。
- 全套 `pnpm typecheck` / `lint` / `test` / `pnpm build` 通过。

## License

MIT © Chiang
