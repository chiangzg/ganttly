# ganttly 基线对比产品与技术方案

| 字段     | 值                                    |
| -------- | ------------------------------------- |
| 文档状态 | Implementation Ready                  |
| 目标版本 | v0.4（建议）                          |
| 适用范围 | 基线对比完整轻量版                    |
| 最后更新 | 2026-07-28                            |
| 目标读者 | 实现本特性的 coding agent、代码评审者 |

本文是基线对比特性的自包含交接文档。实现者应以本文的产品语义、视觉规格、接口约束和验收标准为准，不需要依赖此前的讨论记录。

---

## 1. 背景与目标

ganttly 已具备 WBS、依赖排期、关键路径、资源负载、工期约束和多项目管理，但目前只能表达“当前计划”。用户每次调整任务日期都会覆盖此前的计划，无法回答以下项目管理问题：

- 当前计划相对最初承诺延期了多少？
- 哪些任务按计划、提前或延期？
- 项目最大完成延期是多少？
- 新增了哪些任务，原计划中的哪些任务已被删除？

基线对比的目标是让用户保存一个明确的计划参照，并在后续调整时快速看出日期与工期偏差，使 ganttly 从“排计划工具”进入“计划控制工具”。

### 1.1 产品目标

1. 一个项目可保存多个命名、不可变的基线快照。
2. 一次启用一个基线，与当前计划比较。
3. 在不破坏现有高密度布局的前提下，让用户扫描任务延期情况。
4. 复用现有本地持久化、撤销/重做、导入导出和 Canvas 引擎。
5. 保持纯前端、本地优先，不引入服务端依赖。

### 1.2 成功标准

- 用户可在 3 次操作内保存并启用一条基线。
- 修改任务日期后，画布、任务表、任务抽屉和状态栏显示一致的偏差结果。
- 偏差计算遵守项目工作日、法定节假日和调休规则。
- 1000 个任务、多个已保存基线下，比较装配保持 O(n)，现有性能测试无明显退化。
- 亮色和暗色主题下，当前任务与基线均清晰可辨，且不会与关键路径、约束标记混淆。
- JSON 导出再导入后，全部基线数据完整保留。

### 1.3 明确非目标

首版不实现：

- 将项目恢复到某条基线。
- 覆盖或“更新”已有基线的快照内容。
- 两条基线之间互相比较。
- 自动版本历史、自动定时基线或备份恢复。
- 进度偏差、挣值分析、状态日期或 S 曲线。
- 偏差排序、偏差筛选、独立分析页或常驻分析侧栏。
- 基线协作、权限或服务端同步。

---

## 2. 核心产品模型

### 2.1 多基线与不可变性

- 一个项目允许保存多个基线。
- 基线创建后，其任务快照不可修改；只允许重命名和删除。
- 一次最多启用一个基线；`null` 表示不比较。
- 基线列表按 `capturedAt` 倒序显示，最新基线在最上方。
- 不设置基线数量硬上限。常见项目只会保存少量基线，IndexedDB 足以承载；实现不得预设任意上限。

不可变性是产品语义，不只是 UI 限制。代码中不要提供 `updateBaselineSnapshot` 一类入口。用户需要新的参照时，应创建新基线。

### 2.2 基线名称规则

- 创建弹窗默认名称为 `计划基线 N`，`N` 取项目内第一个未使用的正整数。
- 去除名称首尾空格后不能为空。
- UI 输入最大 40 个字符。
- 同一项目内名称不可重复；比较时忽略大小写，中文按原值比较。
- 外部导入文件可能包含更长名称，读取时不要因 UI 限制拒绝已有合法 schema 数据；展示处使用截断和 tooltip。

### 2.3 捕获范围

基线捕获当前项目的全部任务：

- 叶子任务。
- 摘要任务。
- 里程碑。

每个快照继续使用现有 `BaselineTask` 字段：

```ts
interface BaselineTask {
  id: string;
  start: string;
  end: string;
  duration: number;
  progress: number;
}
```

摘要任务必须使用捕获时重新计算的 rollup 值，不能直接信任 `Task` 中可能短暂陈旧的汇总字段。复用 `computeAllRollups()`，用其 `start/end/duration/progress` 覆盖摘要任务的对应值。

`progress` 继续捕获，以保持现有 schema 契约并为未来扩展保留数据，但首版不展示或统计进度偏差。没有状态日期时，直接比较两个进度百分比没有可靠的项目管理含义。

### 2.4 任务匹配与结构变化

当前任务与基线任务仅通过稳定的 `task.id` 匹配：

| 当前任务 | 基线任务 | 结果                               |
| -------- | -------- | ---------------------------------- |
| 存在     | 存在     | 计算开始、完成、工期偏差           |
| 存在     | 不存在   | 标记为“新增”                       |
| 不存在   | 存在     | 计入“已删除”汇总，不创建虚拟任务行 |

任务重命名、移动层级或调整顺序不会影响匹配。复制/粘贴任务会产生新 ID，因此视为新增任务。

### 2.5 摘要任务与统计去重

- 摘要任务在画布和任务表中可以显示自身基线轨道与完成偏差。
- 项目级“延期任务数”和“最大延期”只统计当前叶子任务，避免摘要任务与子任务重复计数。
- “新增任务数”同样只统计当前叶子任务。
- 由于现有 `BaselineTask` 不保存 `parentId`，无法可靠判断已经删除的基线任务当时是否为摘要任务；首版“已删除”统计按所有未匹配基线记录计数，并在文案中称为“原任务已删除”，不称为“叶子任务”。

---

## 3. 偏差计算规则

### 3.1 偏差字段

匹配成功的任务产生：

```ts
type BaselineVarianceStatus = 'on-track' | 'early' | 'late' | 'added';

interface TaskBaselineVariance {
  taskId: string;
  startDelta: number;
  finishDelta: number;
  durationDelta: number;
  status: BaselineVarianceStatus;
}
```

- `startDelta = 当前开始 - 基线开始`。
- `finishDelta = 当前完成 - 基线完成`。
- `durationDelta = 当前工期 - 基线工期`。
- 日期偏差单位为项目工作日。
- 工期偏差直接使用已有工作日工期字段相减。
- `finishDelta > 0` 为延期，`finishDelta < 0` 为提前，`finishDelta === 0` 为按计划。
- 没有对应基线记录的当前任务返回 `status: 'added'`，日期偏差使用 `null` 或不提供；不要伪造为 0。

如果实现者希望避免 `added` 状态携带无意义数字，可采用判别联合：

```ts
type TaskBaselineVariance =
  | {
      status: 'on-track' | 'early' | 'late';
      taskId: string;
      startDelta: number;
      finishDelta: number;
      durationDelta: number;
    }
  | { status: 'added'; taskId: string };
```

推荐判别联合，避免调用方误用空偏差值。

### 3.2 有符号工作日偏差

新增纯函数：

```ts
function signedWorkingDayDelta(
  baselineDate: string,
  currentDate: string,
  calendar: ResolvedCalendar,
): number;
```

精确定义：

- 日期相同返回 `0`。
- 当前日期晚于基线日期时，统计区间 `(baselineDate, currentDate]` 内的工作日，返回正数。
- 当前日期早于基线日期时，统计区间 `(currentDate, baselineDate]` 内的工作日，返回负数。
- 工作日判定必须复用 `isWorkingDay()`，因此自动包含周末、法定节假日与调休补班规则。
- 两个不同日期之间若没有跨过任何工作日，允许返回 `0`。
- 不把任务的 `overtimeDates` 纳入日期偏差口径；它们是任务投入规则，不是项目日历规则。

示例：

| 基线日期       | 当前日期       | 日历情况   | 结果 |
| -------------- | -------------- | ---------- | ---- |
| 周一           | 周二           | 均为工作日 | `+1` |
| 周五           | 下周一         | 周末休息   | `+1` |
| 周二           | 周一           | 均为工作日 | `-1` |
| 节前最后工作日 | 节后首个工作日 | 中间全休   | `+1` |
| 周六           | 周日           | 均非工作日 | `0`  |

### 3.3 项目级汇总

```ts
interface BaselineVarianceSummary {
  matchedLeafCount: number;
  onTrackLeafCount: number;
  earlyLeafCount: number;
  lateLeafCount: number;
  addedLeafCount: number;
  deletedTaskCount: number;
  maxFinishDelay: number;
}
```

- `maxFinishDelay` 仅从正的 `finishDelta` 中取最大值，无延期时为 `0`。
- “按计划”以完成日期为准；开始日期或工期有变化但完成日期相同，仍属于按计划，但详情中必须展示其他偏差。
- 汇总函数必须一次构建当前任务 ID Set、摘要任务 ID Set 和基线 Map，整体 O(n)。禁止在任务循环内对基线数组反复 `find()`。

---

## 4. 用户流程

### 4.1 首次创建基线

1. 用户在任务视图点击工具栏“创建基线”。
2. 弹窗显示默认名称、当前任务数和说明“保存后基线内容不会随计划修改”。
3. 用户确认创建。
4. 应用捕获所有任务的有效日期快照，通过 Project Store command 写入 `file.baselines`。
5. 新基线自动成为当前活动基线，进入比较模式。
6. 初始偏差均为 0，状态栏显示“无完成延期”。

空项目不允许创建基线。创建入口保持可见但 disabled，tooltip 为“至少添加一个任务后才能创建基线”。

### 4.2 选择和停止比较

- 基线菜单以 radio list 展示所有基线。
- 选择其他基线立即切换比较目标，不修改项目数据、不进入撤销栈。
- 选择“不比较”退出比较模式。
- 活动基线只保存在 `useViewStore`：页面刷新、项目切换后默认为关闭比较。
- 如果撤销创建、删除基线或导入状态变化导致活动 ID 已不存在，立即清空活动 ID，不显示错误。

### 4.3 重命名

- 从管理弹窗进入重命名。
- 使用与创建相同的名称校验。
- 重命名只改变 `Baseline.name`，不改变 `capturedAt` 和任务快照。
- 重命名通过 command 执行，可撤销/重做并自动保存。

### 4.4 删除

- 删除前必须确认，文案明确“只删除基线，不修改当前任务”。
- 删除活动基线时先退出比较，再执行删除 command。
- 撤销删除会恢复基线数据，但不会自动重新启用它；活动基线属于临时 UI 状态，不属于撤销语义。

---

## 5. UI 与视觉设计

### 5.1 总体原则

遵循现有 ganttly 的安静、高密度、工作型 UI：

- 不增加常驻侧栏或页面级大卡片。
- 不使用渐变、装饰性图形或大面积风险色。
- 基线本身是参照，不代表好坏，始终使用中性灰蓝。
- 红、绿仅用于表达延期与提前的文字/数字。
- 保持现有 44px 工具栏、32px 任务行、CSS token、Radix 交互和 Lucide 图标语言。

### 5.2 工具栏入口

位置：关键路径按钮之后、任务/资源视图切换之前。

建议使用 Lucide `Layers3` 图标，配合文字：

| 状态           | 按钮文案     | pressed |
| -------------- | ------------ | ------- |
| 无基线         | 创建基线     | false   |
| 有基线、未比较 | 基线         | false   |
| 正在比较       | 基线：{名称} | true    |

- 活动名称最大显示宽度约 120px，超出省略，完整名称放在 tooltip。
- 按钮仅在 `viewMode === 'task'` 时显示；切换到资源视图不会删除活动 ID，切回任务视图继续显示同一比较。
- 工具栏已有横向滚动，不为基线入口改变整体高度。

### 5.3 基线下拉菜单

使用 Radix DropdownMenu，延续现有“更多操作”菜单视觉：

- 宽度约 280px。
- 标题“基线对比”。
- 顶部展示当前比较摘要，例如“4 项延期 · 最大 +6 工作日”。
- RadioGroup 第一项为“不比较”。
- 每条基线显示名称、捕获日期和选中图标；名称单行省略。
- 分隔线下方提供“保存当前计划为基线…”和“管理基线…”。
- 不将每个基线做成独立卡片，使用 36–44px 高的平面菜单行。

### 5.4 创建弹窗

- 宽约 440px，复用现有 Dialog 的遮罩、圆角、边框和按钮样式。
- 标题：“保存计划基线”。
- 描述：“基线用于对比后续计划变化，创建后快照内容不可更新。”
- 单一名称输入框，预填 `计划基线 N`。
- 辅助信息：“将保存 {N} 个任务的开始、完成、工期和进度。”
- 主按钮：“保存并比较”。
- 无效名称时就地显示错误，保留输入内容。

### 5.5 管理弹窗

- 宽约 560px，最大高度不超过 `calc(100vh - 64px)`，列表区域可滚动。
- 标题：“管理基线”。
- 使用表头 + 分隔线列表，列为名称、捕获时间、任务数、操作。
- 当前活动基线显示小型“比较中”文本标记，不使用大色块 pill。
- 操作使用图标按钮：启用/查看、重命名、删除；提供 tooltip 和 `aria-label`。
- 删除按钮使用 danger 色，但整行保持中性。
- 空状态只显示一句“尚未保存基线”和一个“创建基线”按钮。

### 5.6 TaskTable 偏差列

基线活动时自动增加一个 68–72px 的“偏差”列，显示完成偏差摘要：

| 结果   | 显示    | 颜色            |
| ------ | ------- | --------------- |
| 延期   | `+3 天` | `text-danger`   |
| 提前   | `−2 天` | `text-success`  |
| 按计划 | `—`     | `text-fg-muted` |
| 新增   | `新增`  | `text-primary`  |

- 数字使用 tabular nums 和中等字重，禁止使用实心红/绿 badge，以免整表产生视觉噪声。
- hover 或键盘 focus 时显示 Radix Tooltip，列出开始、完成、工期三项偏差。
- 开启人天列与基线列时，表格宽度按现有常量扩展；表头与行必须共享同一个 grid template，防止错列。
- 无活动基线时完全恢复当前列宽和 grid template，现有截图不应变化。

### 5.7 TaskDrawer 偏差区块

活动基线存在时，在任务日期/工期编辑区域之后加入只读区块：

- 标题：“相对「{基线名称}」”。
- 三列显示：开始偏差、完成偏差、工期偏差。
- 每列上方是 11–12px muted 标签，下方是偏差值。
- 下方显示基线范围，例如“计划：2026-02-02 → 2026-02-06”。
- 延期值使用 danger，提前值使用 success，0 使用 muted。
- 新增任务显示：“此任务创建于该基线之后。”
- 不提供任何基线编辑按钮，保持任务编辑与基线管理职责分离。

### 5.8 StatusBar 汇总

活动基线存在时，在任务数/人天之后追加：

- 无延期：`· 基线「初始计划」 · 无完成延期`
- 有延期：`· 基线「初始计划」 · 延期 4 项 · 最大 +6 工作日`

只有延期数字使用 danger 色。新增/已删除数量不常驻状态栏，放在基线菜单摘要和管理弹窗中，避免窄屏拥挤。

### 5.9 Canvas 双层任务条

#### 普通模式

未启用基线时保持现有几何完全不变：普通条、摘要条、里程碑、标签和截图基线不应发生变化。

#### 基线比较模式

每个 32px 任务行分为当前计划和基线参照两层：

- 当前普通任务条：`yTop + 4`，高度约 `16px`，圆角 `3px`。
- 基线普通轨道：`yTop + 24`，高度 `4px`，圆角 `2px`。
- 两层间至少保留 3px 空隙。
- 当前任务标签仍位于行垂直中心附近，保持与左表格文字对齐。
- 基线轨道采用主题 `baseline` 色，填充 alpha 约 0.55，可加 1px 低对比轮廓。
- 不使用虚线：月/年视图的短任务条会让虚线产生碎片噪声。

摘要任务：

- 当前摘要条继续使用较深实色和端点帽，但在比较模式中适当上移。
- 基线摘要使用 3–4px 细轨道和小端点帽。

里程碑：

- 当前里程碑使用上层较大的实心菱形。
- 基线里程碑使用底部较小的空心菱形。

组合状态：

- 当前关键路径仍使用 critical 红色；基线保持中性。
- 约束标记、选中环只作用于当前任务条。
- 新增任务只绘制当前条，不伪造基线轨道。
- 已删除任务没有当前行，不在画布绘制。
- 不绘制基线到当前条之间的连接线，避免密集任务下形成视觉杂讯。

### 5.10 Canvas Tooltip

hover 当前条或基线轨道时显示 DOM tooltip：

```text
基线：初始计划
计划   02/02 → 02/06
当前   02/04 → 02/10
完成偏差   +2 工作日
```

- Tooltip 使用现有 elevated 背景、边框和阴影。
- 鼠标拖拽、缩放或平移期间隐藏。
- Tooltip 需限制在 chart viewport 内。
- 任务 tooltip 优先于同位置的节假日 tooltip；离开任务条后恢复节假日 hover 行为。
- Canvas 信息必须同时在 TaskTable/Drawer 中可访问，不能让颜色和 hover 成为唯一信息来源。

### 5.11 主题颜色

在现有 CSS token 和 `ThemeColors` 增加：

```css
:root {
  --color-baseline: 100 116 139;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-baseline: 148 163 184;
  }
}
```

Canvas 通过 `resolveThemeColors()` 读取，不得在 renderer 中写只适配单一主题的灰色。最终颜色可在截图验证时微调，但必须保持中性、低于当前任务条的视觉权重。

---

## 6. 技术设计

### 6.1 数据模型与兼容性

现有 `GanttlyFile.baselines`、`Baseline` 和 `BaselineTask` 已满足首版需求，不修改字段，不提升 `schemaVersion`。

```ts
interface Baseline {
  id: string;
  name: string;
  capturedAt: string;
  tasks: BaselineTask[];
}
```

活动基线不是项目内容，不新增到 `GanttlyFile.viewState`。它进入 `useViewStore`：

```ts
interface ViewStoreState {
  activeBaselineId: string | null;
  setActiveBaselineId(id: string | null): void;
}
```

`resetForProjectSwitch()` 必须把它恢复为 `null`。页面刷新后 Zustand 内存状态重建，也自然恢复为 `null`。

### 6.2 纯函数模块

新增 `apps/web/src/lib/baseline.ts`，建议公开：

```ts
export function createBaselineSnapshot(
  file: GanttlyFile,
  input: { id: string; name: string; capturedAt: string },
): Baseline;

export function signedWorkingDayDelta(
  baselineDate: string,
  currentDate: string,
  cal: ResolvedCalendar,
): number;

export function compareTaskToBaseline(
  current: Pick<Task, 'id' | 'start' | 'end' | 'duration'>,
  baseline: BaselineTask | undefined,
  cal: ResolvedCalendar,
): TaskBaselineVariance;

export function summarizeBaselineVariance(
  file: GanttlyFile,
  baseline: Baseline,
  cal: ResolvedCalendar,
): BaselineVarianceSummary;

export function findActiveBaseline(
  baselines: ReadonlyArray<Baseline>,
  activeId: string | null,
): Baseline | null;
```

`createBaselineSnapshot()` 内部流程：

1. `computeAllRollups(file.tasks, file.resources, resolveCalendar(file.calendar))`。
2. 为所有任务建立摘要 ID Set 或通过 rollup Map 判断摘要。
3. 摘要任务使用 rollup 结果，叶子任务使用自身字段。
4. 返回全新对象，不持有原任务引用。

为 UI 和 Scene 提供一个当前有效任务值 helper 也可以，但不要在 TaskTable、Drawer、Scene 各自复制摘要解析逻辑。

### 6.3 Project Store 命令

在现有 command 模式中新增：

```ts
createBaselineCommand(baseline: Baseline): Command;
renameBaselineCommand(baselineId: string, name: string): Command;
deleteBaselineCommand(baselineId: string): Command;
```

行为：

- Create：将快照加入 `file.baselines`，undo 按 ID 删除，redo 恢复同一快照。
- Rename：首次 apply 捕获旧名称，undo 恢复。
- Delete：首次 apply 捕获完整基线及原数组位置，undo 恢复原位置。
- Command 不直接调用 `useViewStore`，保持项目数据命令为纯函数。
- UI 在创建成功后设置活动 ID；删除活动基线前清空活动 ID。
- 在 GanttView 或专用 hook 中监听 `file.baselines` 与活动 ID。如果 ID 不再存在，清空活动 ID。这覆盖 undo-create、项目数据替换等 stale 状态。

所有基线数据变更沿用现有 `dispatch()`，自然进入 dirty、500ms 自动保存和 revision 流程。

### 6.4 Scene 装配

扩展 `AssembleOptions`，由 GanttCanvas 传入活动基线：

```ts
interface AssembleOptions {
  viewportWidth: number;
  viewportHeight: number;
  today: string;
  criticalTaskIds?: ReadonlySet<string>;
  activeBaseline?: Baseline | null;
}
```

扩展 `TaskRow`：

```ts
interface TaskRow {
  // existing fields...
  baseline?: BaselineTask;
  baselineVariance?: TaskBaselineVariance;
}
```

装配流程：

1. 活动基线存在时构建一次 `Map<string, BaselineTask>`。
2. `toTaskRow()` 使用 task ID O(1) 查找快照。
3. 当前摘要任务继续使用现有 rollup 值，再与捕获时摘要快照比较。
4. 无活动基线时不要构建 Map，也不要计算偏差。
5. Renderer 只消费 Scene，不直接访问 Zustand 或 `GanttlyFile.baselines`。

### 6.5 图表日期范围

活动基线可能早于当前最早任务或晚于当前最晚任务。必须扩展当前 `originDateFor()` 和 `chartEndDate()` 的语义：

```ts
originDateFor(file, { activeBaseline })
  = min(project fallback, current task starts, active baseline starts)

chartEndDate(file, today, activeBaseline)
  = max(today, current task ends, active baseline ends)
```

只考虑活动基线，不考虑所有未启用基线，避免无关历史快照永久扩大滚动范围。

`ScrollShim`、Toolbar 的“今天”、Scene assembly 和实际 renderer 必须使用完全相同的 origin/range 输入，不能各自计算不同的时间原点。

### 6.6 切换基线时保持视口日期不跳动

如果新基线比当前计划更早，origin 会向左移动。直接保留旧 `scrollLeft` 会导致用户当前看到的日期整体跳动。

切换前后按视口中心日期重新锚定：

```ts
const oldOrigin = originDateFor(file, { activeBaseline: oldBaseline });
const anchorPixel = file.viewState.scrollLeft + viewportWidth / 2;
const anchorDate = pixelToDate(anchorPixel, oldOrigin, file.viewState.zoom);

const newOrigin = originDateFor(file, { activeBaseline: newBaseline });
const nextScrollLeft = Math.max(
  0,
  dateToPixel(anchorDate, newOrigin, file.viewState.zoom) - viewportWidth / 2,
);
```

随后在同一交互事件中：

1. 直接更新 `file.viewState.scrollLeft`，保持现有滚动操作不进入 undo 的语义。
2. 更新 `useViewStore.activeBaselineId`。

如果 chart 容器尚未测量，使用当前 Toolbar 已采用的 800px fallback。最终 `ScrollShim` 会限制实际可滚动范围。

### 6.7 Canvas 渲染与命中

- `ThemeColors` 增加 `baseline`。
- `renderBars()` 根据 `row.baseline` 选择普通几何或比较几何。
- 基线轨道必须在当前条之前绘制，当前条和选中状态始终处于更高视觉层。
- 现有 `hitTest()` 主要按行和 X 范围命中当前条，不应让基线轨道可拖拽或 resize。
- Baseline tooltip 可单独实现只读命中：判断 pointer 是否位于当前条或基线轨道的 X 范围与相应 Y 区域，不能复用为编辑命中。
- 不改变 drag 操作修改的对象，任何拖动都只修改当前任务。

建议新增 `useBaselineHover`，结构参考现有 `useHolidayHover`，但需与 holiday hover 共享优先级：任务/基线命中优先，空白时间列才显示节假日 tooltip。

### 6.8 React 组件组织

建议新增：

- `BaselineControl.tsx`：Toolbar trigger、基线 radio menu、摘要信息。
- `BaselineDialogs.tsx`：创建、管理、重命名和删除确认。
- `BaselineVariance.tsx`：偏差文字格式化、表格 tooltip、Drawer 只读区块等小型可复用展示。

组件状态：

- 弹窗开关和表单草稿留在组件局部 state。
- `activeBaselineId` 只在 `useViewStore`。
- 基线项目数据只在 `useProjectStore.file.baselines`。
- 不增加新的全局 store。

### 6.9 导入、导出与项目复制

- JSON 导出已经序列化完整 `file`，无需单独添加字段，但必须加 round-trip 测试。
- JSON 导入通过现有 schema 校验和 normalize，保留合法基线。
- `.gan` 导入继续报告基线为 skipped，不在本特性范围解析 GanttProject 历史快照。
- 复制项目通过 structured clone 保留全部基线；活动基线不复制，因为它不在文件内。
- 切换到复制后的项目时 `resetForProjectSwitch()` 关闭比较。

### 6.10 国际化与无障碍

- 所有新增文案同时补 `zh-CN` 与 `en`。
- 菜单使用 radio 语义；弹窗有 Title/Description。
- 图标按钮必须有 `aria-label` 和 tooltip。
- 偏差不能只依赖红绿颜色，必须同时显示 `+/-`、数字或“新增”。
- Canvas 比较信息在表格和 Drawer 中有等价文本表达。
- 使用真正的 Unicode minus `−` 展示负数可以改善视觉，但测试和计算值仍使用普通数字；如项目坚持 ASCII 文案，则统一使用 `-`，不要混用。

---

## 7. 边界与失败行为

| 场景                     | 预期行为                                                 |
| ------------------------ | -------------------------------------------------------- |
| 空项目创建基线           | 禁止，入口 disabled                                      |
| 名称为空/重复/过长       | 弹窗就地报错，不关闭                                     |
| 活动基线被删除           | 先退出比较，再删除                                       |
| Undo 撤销刚创建基线      | stale ID 自动清空                                        |
| Undo 恢复已删除基线      | 恢复数据，但不自动启用                                   |
| 当前任务在基线后新增     | 显示“新增”，不画基线轨道                                 |
| 基线任务已从当前项目删除 | 仅进入已删除统计                                         |
| 任务改名或换层级         | 按 ID 正常匹配                                           |
| 摘要任务子项变化         | 当前使用实时 rollup，与捕获时 rollup 比较                |
| 里程碑移动               | 计算开始/完成偏差，画双菱形                              |
| 基线日期超出当前范围     | 扩大 active chart range                                  |
| 基线切换导致 origin 变化 | 保持视口中心日期不变                                     |
| 暗色模式                 | 使用暗色 baseline token，无硬编码浅灰                    |
| 基线数据异常缺失任务     | 按新增/已删除规则处理，不抛错                            |
| 保存失败                 | 沿用现有 SaveState 错误提示，内存数据与其他 command 一致 |

外部 JSON 中 Baseline 名称重复不应导致整个文件无法加载，因为现有 schema 允许；UI 应仍能按 ID 选择，并在用户下次重命名时执行唯一性校验。

---

## 8. 实施阶段

### 阶段 1：纯函数与命令

实现：

- 基线捕获。
- 有符号工作日偏差。
- 单任务比较与项目汇总。
- Create/Rename/Delete commands。
- `useViewStore.activeBaselineId` 及 stale 清理。

完成标准：纯函数和 command 单测全绿，能够通过 store 创建并持久化基线。

### 阶段 2：选择器与管理 UI

实现：

- Toolbar 基线入口与 radio menu。
- 创建、管理、重命名、删除流程。
- 空状态、校验、国际化和无障碍。

完成标准：用户可以完整管理多个基线；项目切换和刷新后比较关闭，基线数据仍存在。

### 阶段 3：Scene 与 Canvas

实现：

- Scene 传递 baseline/variance。
- Active chart range。
- 视口中心日期锚定。
- 普通任务、摘要、里程碑双层渲染。
- Tooltip 与 holiday hover 仲裁。

完成标准：所有 zoom、滚动、虚拟化、关键路径和约束组合状态显示正确。

### 阶段 4：表格、Drawer 与状态栏

实现：

- 单一完成偏差列。
- 偏差 tooltip。
- Drawer 三项偏差详情。
- StatusBar 项目摘要。

完成标准：四个展示位置使用同一纯函数结果，无口径漂移。

### 阶段 5：回归、视觉与文档

实现：

- E2E、截图、暗色和性能覆盖。
- README/PRD 路线图状态更新。
- 必要的 release notes。

完成标准：全部质量门禁通过，截图经人工确认，现有非比较模式截图无意外变化。

---

## 9. 测试方案

### 9.1 单元测试

`lib/baseline`：

- 捕获叶子任务字段。
- 捕获摘要任务时使用新计算的 rollup。
- 捕获里程碑 duration 0。
- 输入文件不被修改。
- 同日偏差 0。
- 向后/向前的正负偏差。
- 跨周末、春节/国庆假期、调休补班。
- 两个非工作日不同但偏差为 0。
- 匹配、按计划、提前、延期、新增、已删除。
- 汇总只统计叶子任务，不重复统计摘要。
- 1000 任务比较无嵌套线性查找。

Store commands：

- Create → undo → redo。
- Rename → undo → redo。
- Delete 保留原数组位置并可 undo。
- 新 command 清空 redo 栈。
- 创建/删除后触发 dirty 和自动保存。
- 撤销创建导致活动 ID 自动清空。

Scene/Renderer：

- 活动基线按 ID 映射到正确 TaskRow。
- 无活动基线不包含比较字段。
- Summary 使用当前 rollup 与基线 rollup。
- 基线轨道遵守 `scrollTop`、global `yIndex` 和虚拟化。
- 关键路径/约束/选择与基线轨道绘制顺序正确。

### 9.2 E2E

新增 `baseline-comparison.spec.ts`，至少覆盖：

1. 创建第一条基线并自动进入比较。
2. 创建第二条基线并在两者间切换。
3. 停止比较。
4. 重命名和删除。
5. 修改任务开始/完成后，表格、Drawer、StatusBar 结果一致。
6. 新增任务显示“新增”。
7. 删除原任务后管理摘要显示已删除。
8. 刷新后基线仍存在、比较关闭。
9. 项目切换后比较关闭且不会串用另一项目的 baseline ID。
10. JSON round-trip 保留多个基线。
11. 视口处于中间日期时切换更早基线，中心日期基本不变。

### 9.3 截图回归

新增截图：

- 普通任务：当前晚于基线。
- 摘要任务 + 子任务基线。
- 当前与基线里程碑。
- 基线 + 关键路径 + 约束标记。
- 基线比较暗色模式。
- TaskTable 偏差列 + Drawer 偏差区块。

保留现有无基线截图；未启用比较时 Canvas 几何必须不变。

### 9.4 性能

- 扩充现有 1000-task 性能用例，附带一条包含 1000 个 BaselineTask 的活动基线。
- Scene assembly、TaskTable memo 和 StatusBar summary 均应复用 Map/Set 或 memoized 结果。
- 不要求基线计算进入 Web Worker；当前规模下纯函数 O(n) 应足够。
- 不在 Canvas 每帧或每行内重复 `computeAllRollups()`。

---

## 10. 最终验收清单

### 产品

- [ ] 支持多个命名且不可变的基线。
- [ ] 一次只比较一条基线。
- [ ] 创建、重命名、删除可撤销/重做。
- [ ] 活动基线刷新和项目切换后关闭。
- [ ] 新增/删除任务语义正确。
- [ ] 偏差按项目工作日计算。
- [ ] 不展示误导性的进度偏差。

### UI

- [ ] 工具栏入口紧凑，不改变 44px 高度。
- [ ] TaskTable 只增加一个偏差摘要列。
- [ ] Canvas 当前条与基线轨道在 32px 行内无重叠。
- [ ] 关键路径、约束、选择和基线层级清楚。
- [ ] 亮暗主题均清晰，基线视觉权重低于当前任务。
- [ ] Tooltip 不越界、不阻断拖拽。
- [ ] 所有风险颜色都有文本/符号辅助。

### 技术

- [ ] 保持 schemaVersion 1，复用现有 Baseline 类型。
- [ ] 活动 ID 只在 useViewStore。
- [ ] Renderer 不读取 Zustand。
- [ ] 比较与汇总保持 O(n)。
- [ ] 图表范围包含活动基线。
- [ ] 切换基线不改变视口中心日期。
- [ ] JSON 导入导出和项目复制保持基线。
- [ ] 单测、E2E、截图、暗色和性能测试通过。

---

## 11. Coding Agent 实施注意事项

1. 先实现并测试 `lib/baseline.ts`，再接 UI；所有展示必须复用同一偏差口径。
2. 不要提升 schemaVersion，也不要给现有 BaselineTask 增加非必要字段。
3. 不要把 `activeBaselineId` 写进项目文件或 Repository preferences。
4. 不要让 command 直接修改 `useViewStore`；项目数据和临时 UI 状态保持解耦。
5. 不要在 map/render 循环里反复 `baseline.tasks.find()`。
6. 不要把基线轨道染成红/绿；风险语义只属于当前偏差结果。
7. 不要为了基线重构无关 Canvas、store 或项目目录代码。
8. 不要实现本方案“非目标”中的恢复、进度偏差、筛选或分析面板。
9. 修改 TaskTable grid 时同时更新 header 和 row 使用的共享 template。
10. 修改 chart origin 时同步检查 Toolbar Today、ScrollShim、Scene 和截图测试，避免多个时间原点。

实现完成后，应能用一句话描述结果：

> 用户可以保存多个不可变计划基线，并在画布、任务表和详情中按项目工作日查看当前计划相对基线的完成偏差。
