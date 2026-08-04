# ganttly v0.5.0 — 任务多选与批量操作、面板列宽拖拽与编辑器交互大版本

> 自 v0.4.2 以来累积的编辑器交互优化大版本:任务多选与批量操作、批量负责人分配、左右面板与关键列宽可手动拖拽、任务抽屉停靠化、键盘快捷键与行内编辑、搜索筛选、拖拽排序与层级调整、删除确认对话框,以及基线家族 i18n 收尾。

🎨 **在线 demo**:https://chiangzg.github.io/ganttly/

---

## 主要特性

### 任务多选与批量操作

- **多选交互**:Ctrl/Cmd 点击 toggle 单个任务、Shift 点击范围选择,`computeSelectionOnPointerDown` 处理拖拽起点的选择计算。
- 选择状态保存在 `useViewStore`(ephemeral),不进 undo stack,刷新即清空。
- `BatchActionBar` 浮动批量操作栏:已选 N 项 + 分配负责人 + 清空选择。

### 批量负责人分配

| 能力                             | 说明                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| **`batchAssignResourceCommand`** | 复合命令,单 undo 还原整批分配(完整捕获原 assignments 的 Map),按 resourceId 替换语义 |
| **跳过汇总任务**                 | 与抽屉 G13 同源判定(`!tasks.some(t => t.parentId === id)`),父+子同选只分配子任务    |
| **`BatchAssignPopover`**         | 资源下拉 + 负载输入(默认 100),空资源 / 全汇总时禁用                                 |

### 左右面板与关键列宽拖拽(§4.1)+ 容量 % 单位(§5.3)

- **按项目持久化**:`lib/layoutPrefs.ts` 以项目 id 为 key 持久化面板/列宽(任务表 320-720 默认 480、资源表 300-640 默认 420),纯函数 + 边界钳制(mirror `drawerWidthPrefs` 模式)。
- **项目切换隔离**:`useLayoutPrefs` hooks 以 `activeProjectId` 驱动加载/保存,切换项目自动重载各自的宽度偏好。
- **共享分隔线组件**:`ui/ResizeHandle`(`role=separator` + 双击复位 + 拖拽管线)。
- **任务名弹性吸收**:表头列分隔线可拖(工期/工时/进度/基线),任务名列保持 `minmax(0,1fr)` 弹性吸收所有 delta,面板拉宽时任务名自动变宽、永不出现空白。
- **表头与行同步**:computed gridTemplate 由 header 和 rows 共享同一变量,从根上规避历史 alignment bug。
- **容量 % 单位**:容量输入补 `%` 单位(列宽 64→72)。

### 任务抽屉停靠模式与可调宽度

- TaskDrawer 从页面级绝对定位覆盖层改为与主内容并排的 flex 子元素,不再遮挡工具栏和画布。
- `drawerWidthPrefs` 持久化抽屉宽度偏好,拖拽手柄调整大小 + 双击重置。
- 抽屉打开时触发画布尺寸重计算,并自动重新定位至目标任务,防止任务被遮挡。

### 键盘快捷键与行内编辑

- 全局撤销 / 重做 / 保存快捷键 + 平台修饰键识别(macOS Cmd / Windows Ctrl)。
- 任务表格行内编辑(名称、工期、进度)。
- 上下文菜单与工具栏的跨平台快捷键提示。

### 任务搜索与筛选

- 任务搜索与筛选功能,支持按关键词快速定位任务。

### 拖拽排序与层级调整

- `taskDropTarget` 模块计算拖拽落点(上方 / 内部 / 下方)。
- 跨层级移动时重新打包同级任务的顺序,移动命令支持完整撤销。

### 悬停提示与负责人摘要

- 任务 / 资源悬停 tooltip,`useTaskHover` / `useResourceHover` 提供 hit-test 与内容计算。
- 负责人摘要(`assigneeSummary`),在画布条上展示分配资源。

### 删除确认对话框与撤销体验

- 任务 / 资源删除重构为 `ConfirmDialog` 确认对话框,`deleteImpact` 预估删除影响。
- `showUndoToast` 提供「一次撤销恢复整个操作」的 toast 体验。

### 拖拽与草稿保存 bug 修复

- `dragleave` 回调提前捕获 taskId,修复异步状态更新中读取过期合成事件的崩溃。
- `updateTaskFromDraftCommand` 改为三方合并策略,保留抽屉打开期间画布上的实时编辑,确保撤销能正确恢复应用前的最新状态。

### 工具栏作用域

- 非任务视图下禁用任务专属工具栏控件,避免误操作。

### i18n 尾巴:基线家族全收尾

- **ProjectHeader + ProjectSwitcher** 全量 i18n(`project.*` + `switcher.*`,en 同步翻译)。
- **BaselineControl / BaselineDialogs / BaselineVariance / useBaselineHover** 接线已有 `baseline.*` / `toolbar.*` keys。
- `validateBaselineName` 返回 i18n key;`common.save/close/cancel` 新增。
- 现有 E2E 断言的 zh 文案逐字保持(更多操作 / 项目操作 / 创建基线 / 收藏项目 / 基线:{{name}} 全角冒号)。

---

## 技术实现

| 模块                                       | 说明                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `store/useProjectStore.ts`                 | 新增 `batchAssignResourceCommand`、`batchDeleteTasksCommand` 复合命令(Command pattern,完整 invert capture)   |
| `store/useViewStore.ts`                    | 多选状态(`selectedTaskIds` ReadonlySet + `anchorTaskId`)、`viewMode`、`drawer`,ephemeral 不入 undo           |
| `lib/layoutPrefs.ts`                       | 按项目 localStorage key(`panel-widths:<projectId>`、`column-widths:<projectId>`),边界钳制,纯函数 + try/catch |
| `lib/drawerWidthPrefs.ts`                  | 抽屉宽度持久化(全局 key)                                                                                     |
| `lib/selection.ts`                         | 多选计算:toggle / range / anchor                                                                             |
| `lib/taskDropTarget.ts`                    | 拖拽落点计算(above / inside / below)                                                                         |
| `lib/taskFilter.ts`                        | 任务搜索筛选                                                                                                 |
| `lib/deleteImpact.ts`                      | 删除影响预估                                                                                                 |
| `lib/assigneeSummary.ts`                   | 负责人摘要                                                                                                   |
| `lib/fitProjectRange.ts` / `zoomAround.ts` | 适应范围 / 锚点缩放                                                                                          |
| `components/ui/ResizeHandle.tsx`           | 共享分隔线:window pointermove/up listeners + body cursor/userSelect + 双击复位                               |
| `components/useLayoutPrefs.ts`             | `usePanelWidth` / `useColumnWidths` hooks                                                                    |
| `TaskTable.tsx` / `ResourceList.tsx`       | computed gridTemplate 由 header 和 rows 共享,消除历史 alignment bug                                          |
| i18n                                       | `zh-CN.ts` + `en.ts` `as const` 对象,`t()` 非严格类型,新增 key 双文件同步                                    |

---

## 测试

- 全套 `pnpm typecheck` / `eslint . --max-warnings=0` / `vitest` / Playwright(单 worker)通过。
- **新增单测**:`batchAssign.test.ts`(6 例)、`batchDelete.test.ts`、`layoutPrefs.test.ts`(17 例)、`selection.test.ts`、`taskDropTarget.test.ts`、`taskFilter.test.ts`、`deleteImpact.test.ts`、`assigneeSummary.test.ts`、`drawerWidthPrefs.test.ts`、`fitProjectRange.test.ts`、`platform.test.ts`、`resourceHoverHit.test.ts`、`revealTask.test.ts`、`shortcutTarget.test.ts`、`taskHoverHit.test.ts`、`taskPosition.test.ts`、`zoomAround.test.ts`、`draft-command.test.ts`、`history.test.ts`。
- **新增 E2E**:`multi-select.spec.ts`、`batch-assign.spec.ts`(4 例)、`panel-width.spec.ts`(7 例)、`context-menu.spec.ts`、`context-menu-hints.spec.ts`、`delete-confirm.spec.ts`、`drawer-docked.spec.ts`、`drawer-transaction.spec.ts`、`editor-shortcuts.spec.ts`、`empty-states.spec.ts`、`fit-range.spec.ts`、`inline-edit.spec.ts`、`resource-canvas-info.spec.ts`、`reveal-task.spec.ts`、`search-filter.spec.ts`、`task-canvas-info.spec.ts`、`task-row-drag.spec.ts`、`toolbar-scope.spec.ts`、`zoom-anchor.spec.ts`。
- 现有 E2E 零改动保持全绿。

---

## 不变项

- `GanttlyFile` 数据 schema 仍为 **v1**,`schemaVersion` 不变。
- `schema.json` 的 `additionalProperties: false` 保留。
- 基线相关 E2E 依赖的全角冒号文案(`基线:{{name}}`)逐字保持。
- 导出、关键路径、基线比较、视图切换等核心功能行为不变。

---

## License

MIT © Chiang
