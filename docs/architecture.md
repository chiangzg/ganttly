# ganttly 架构详解

本文档补充 [PRD](./PRD.md) 没有展开的实现细节。PRD 的第 2 章 (ADR-lite) 记录了**为什么**这么选;本文记录**怎么落地**。两者一起读才能完整理解 ganttly。

> 适用版本:v0.1.0(MVP)。后续版本变更请参见 git 历史与本文件更新。

---

## 1. 总览

ganttly 是一个纯前端、本地优先的 Web 甘特图软件。单页应用,无后端。

```
┌──────────────────────────────────────────────────────────┐
│ React UI 层 (apps/web/src)                                │
│   components/  ←  GanttCanvas / TaskTable / Toolbar / ...  │
│       │             ▲                                      │
│       │ dispatch   │ useSyncExternalStore 订阅             │
│       ▼             │                                      │
│   store/  ←  Zustand (projectStore + viewStore)           │
│       │             ▲                                      │
│       │ load/save  │ Command pattern (undo/redo)           │
│       ▼             │                                      │
│   data/  ←  Repository 抽象 (IndexedDBRepository /         │
│              LocalStorageRepository 兜底)                  │
└──────────────────────────────────────────────────────────┘
              │
              ▼  纯函数管线 (apps/web/src/engine)
        ┌─────────────────────────────────────┐
        │ layout/  日期↔像素映射 (纯函数)      │
        │ scene/   扁平任务 → 可渲染场景树      │
        │ render/  场景 → Canvas 2D 指令 (纯)   │
        │ interaction/  pointer → DragState     │
        └─────────────────────────────────────┘
```

四个关键设计:

1. **Canvas 为主、DOM 叠层为辅**——任务条/网格/箭头在 Canvas,表头/tooltip/抽屉在 DOM
2. **引擎四层严格分离**——layout/scene/render/interaction 各自纯函数,可单测
3. **Command 模式统一所有变更**——撤销/重做/自动保存都建立在 Command 上
4. **Repository 抽象**——UI 不直接碰 IndexedDB,二期接后端零改动

---

## 2. Canvas 引擎四层 (PRD §5.2)

引擎位于 `apps/web/src/engine/`,严格分层。每层职责单一,输入输出明确,便于单测与替换。

### 2.1 layout 层 (`engine/layout/`)

**职责**:日期 ↔ 像素的纯映射。

```typescript
dateToPixel(iso, originDate, zoom) → number   // 日期 → 像素 X
pixelToDate(px, originDate, zoom) → iso        // 像素 → 日期
pixelsPerDay(zoom) → number                     // 每天占多少像素
dateRangeWidth(startIso, endIso, zoom) → number
```

**关键约定**:

- 像素坐标是 **chart-local**(以 `scrollLeft=0` 为原点)。渲染器加 `scrollLeft` 转换为视口坐标。
- `originDate` = `min(最早任务 start, project.startDate ?? '2026-01-05')`——见 `scene/assembly.ts:originDateFor`。
- 每个 zoom 有固定的列宽与"每列天数":day=32px/1天,week=140px/7天(20px/天),month=120px/30天,year=80px/30天(12列/年)。

**测试**:`tests/unit/engine/layout.test.ts`(22 个用例,覆盖跨月/跨年/闰年边界)。

### 2.2 scene 层 (`engine/scene/`)

**职责**:把扁平 `Task[]` 组装成可渲染的不可变 `Scene` 快照。

入口:`assembleScene(file, opts) → Scene`。它做四件事:

1. `buildTree(tasks)` —— 扁平 → 树
2. `flattenVisible(tree, collapsed)` —— 树 → 可见行列表(应用折叠态)
3. `computeAllRollups(tasks)` —— 摘要任务的汇总日期/进度
4. `computeCriticalPath(...)` —— 关键路径(CPM,见 `lib/cpm.ts`)
5. 虚拟化:只保留视口内可见的行

**Scene 是不可变快照**:每次状态变化生成新 Scene,React 通过 `useSyncExternalStore` 订阅。这让渲染器可以无副作用地遍历 Scene 输出 Canvas 指令。

**箭头几何**:`computeArrows` 计算 4 种依赖类型的端点(`endpointX`)——FS/FF 用前驱 END,SS/SF 用前驱 START;到后继侧同理。详见 `tests/unit/engine/arrows.test.ts`。

### 2.3 render 层 (`engine/render/`)

**职责**:Scene → Canvas 2D 指令。纯函数,可截图测试。

| 文件         | 职责                                        |
| ------------ | ------------------------------------------- |
| `bars.ts`    | 任务条 + 里程碑菱形 + 选中环 + 关键路径红条 |
| `arrows.ts`  | 依赖箭头(贝塞尔曲线 + 箭头头)               |
| `grid.ts`    | 时间轴网格 + 节假日/周休高亮 + 双层表头     |
| `overlay.ts` | Today 红线                                  |
| `theme.ts`   | CSS 变量 → rgb() 解析(支持暗色模式)         |

**主题**:Canvas 不能直接读 CSS 变量。`theme.ts` 在每次渲染时从 `getComputedStyle(html)` 读出变量值,转成 `rgb(r, g, b)` 字符串。暗色模式靠 `@media (prefers-color-scheme: dark)` 切换 CSS 变量,Canvas 自动跟上。

**截图回归**:`tests/e2e/render.spec.ts` 等 13 张基线覆盖 4 视图 / 关键路径 / 暗色 / 4 依赖 / 里程碑 / 100 任务。基线**无平台后缀**(playwright.config.ts 的 `snapshotPathTemplate`),CI 与本地共享同一份。

### 2.4 interaction 层 (`engine/interaction/`)

**职责**:原始 pointer 事件 → DragState → Command。

| 函数                                | 职责                                                              |
| ----------------------------------- | ----------------------------------------------------------------- |
| `hitTest(scene, x, y)`              | 命中检测:body / left-handle / right-handle / right-edge / empty   |
| `applyDrag(scene, row, drag, x, y)` | 计算拖拽后的新 start/end                                          |
| `DragState`                         | 联合类型:idle / move / resize-left / resize-right / connect / pan |

**右边缘"right-edge"区**:任务条右边缘 +6~18px 是"建依赖"热区。从这里拖出到另一任务上,默认建 FS 依赖,按住 Shift 切 SS。

---

## 3. 状态管理 (PRD §5.4)

三个 Zustand store。PRD 说"三个独立 store",但实现里 projectStore 与 historyStore 合并在一个文件(`store/useProjectStore.ts`),因为 Command 模式让它们紧耦合。viewStore 单独一个文件。

### 3.1 `useProjectStore`

持有 `GanttlyFile`(任务/依赖/日历/viewState)+ undo/redo 栈 + saveState。

**核心 API**:

- `dispatch(command)` —— 执行 command、入 undo 栈、清 redo 栈、触发 500ms 防抖自动保存
- `undo()` / `redo()` —— 反向/正向 apply command
- `save()` —— 写入 Repository(防抖后调用)

**所有结构性变更必须走 `dispatch(command)`**。任何直接 `setState` 的旁路(如滚动)不会进 undo 栈——这是有意的设计。

### 3.2 Command 模式 (PRD §3.7)

```typescript
interface Command<T = GanttlyFile> {
  readonly label: string; // 状态栏"撤销: 删除任务 'X'"
  apply(state: T): T; // 正向变更(纯函数,返回新 state)
  invert(state: T): T; // 反向变更(用于 undo)
}
```

**内置 command**(`useProjectStore.ts`):

- `addTaskCommand` / `deleteTaskCommand`(级联删子孙)
- `updateTaskCommand`(字段级,捕获旧值供 invert)
- `moveTaskCommand` / `moveTaskWithRollupCommand`(改 parent/order,带祖先汇总)
- `updateTaskWithRollupCommand`(改字段并联动祖先汇总)
- `addDependencyCommand` / `deleteDependencyCommand`(含循环依赖检测,见 `lib/schedule.ts:wouldCreateCycle`)
- `swapSiblingOrderCommand`(Alt+Up/Down 同级排序)
- `pasteTaskCommand`(Ctrl+V 粘贴)
- `setViewStateCommand`(视图状态:选中/缩放/折叠——也进 undo 栈)

**拖拽的 undo 处理**(M5 关键修复):
拖拽期间用 `useProjectStore.setState` 做实时跟手更新(绕过 undo 栈,否则每像素一次 command 会爆炸)。`pointerup` 时:

1. 把 store 恢复到 `preDragTasks`(拖拽前快照)
2. `dispatch(updateTaskWithRollupCommand(...))` 在真正的 pre-drag 态上执行

这样 command 的 `apply` 捕获正确的旧值,`invert` 能完美恢复。详见 `components/GanttCanvas.tsx:pointerup` 与 `tests/e2e/drag.spec.ts`。

### 3.3 `useViewStore`

UI 临时状态:抽屉开关、上下文菜单位置。不进 undo 栈。

---

## 4. 数据访问层抽象 (PRD §5.3)

```
项目中心 / 编辑器 ──→ Project Catalog Store ─┐
                                               ├─→ ProjectRepository ─→ IndexedDBRepository
Active Project Store ─────────────────────────┘                    └─→ RemoteRepository(二期)
项目标签 / 收藏 / 最近访问 ─→ ProjectPreferencesRepository
```

**为什么抽象**:当前数据保存在本地,未来登录后可让服务端成为主存储。Repository 返回 opaque `revision`,本地使用递增版本号,未来可直接映射 HTTP `ETag / If-Match`,避免并发保存静默覆盖。

**IndexedDB v2 schema**:

- `projects`:key 为 `projectId`,保存完整 `GanttlyFile`、列表摘要、revision 和 `deletedAt`。一个项目仍是一份原子文档。
- `preferences`:保存当前用户的最近项目、打开标签、固定和收藏。用户偏好不进入导出的项目 JSON。
- v1 的 `{ id, file }` 记录在读取时幂等补齐,旧 `default` 项目不改 ID。

**Store 职责**:

- `useProjectCatalogStore`:项目列表、创建/复制/重命名、回收站、收藏和标签导航。
- `useProjectStore`:当前项目文件、revision、自动保存与项目内撤销/重做。
- 项目切换先 flush 当前项目,随后加载目标快照并清空撤销历史。保存定时器绑定 projectId,避免快速切换时串写项目。

**路由**:`/projects` 为项目中心,`/projects/trash` 为回收站,`/projects/:projectId` 为编辑器。根路径恢复最近项目,无项目时进入项目中心。

**LocalStorage 实现**:保持相同接口和兼容迁移逻辑,用于不支持 IndexedDB 的环境。RemoteRepository 尚未实现。

---

## 5. 数据模型 (PRD §4)

### 5.1 扁平 `parentId + order`

任务存为扁平数组,每个任务带 `parentId` 和 `order`。**不嵌套 `children: []`**。

为什么:拖拽改层级是 O(1) 改动(改 2 个字段),嵌套需要整树重写。React 渲染时由 `engine/scene/buildTree` 把扁平数组组装成树。

### 5.2 `calendar` 是顶层一等公民

```typescript
interface GanttlyFile {
  schemaVersion: 1;
  project: Project;
  calendar: Calendar;  // ← 与 tasks 平级,不是嵌在 project 里
  tasks: Task[];
  ...
}
```

节假日是核心痛点(PRD §1.2 痛点 B),必须能独立更新。`packages/calendar-data/calendars/zh-CN.json` 是数据源,每年国务院发通知后维护者更新。

### 5.3 节假日 vs 调休

```typescript
interface Holiday {
  date: string; // '2026-02-17'
  name: string; // '春节(正月初一)'
  type: 'holiday' | 'working'; // working = 调休补班
}
```

`type === 'holiday'` 高亮浅红;`type === 'working'`(调休补班)**不高亮**,正常计入工作日。`lib/calendar.ts:isWorkingDay` 综合判断周休 + 节假日 + 调休。

---

## 6. 关键算法 (`lib/`)

| 文件          | 算法                                  | 测试                                |
| ------------- | ------------------------------------- | ----------------------------------- |
| `calendar.ts` | 工作日计算(跳节假日/周休,计调休)      | 25 用例,覆盖 2026 全年 7 个法定假日 |
| `schedule.ts` | 4 种依赖排期 + 循环检测(DFS)          | 16 用例,含跨春节调休边界            |
| `cpm.ts`      | 关键路径 CPM(正向/反向 pass + 总浮动) | 8 用例,含菱形依赖图                 |
| `summary.ts`  | 摘要任务汇总(min/max 日期 + 加权进度) | 11 用例,含多层级联                  |

---

## 7. 工程化

### 7.1 monorepo (pnpm workspace)

```
apps/web/              # React 前端
packages/schema/       # TS 类型 + JSON Schema + 校验
packages/calendar-data/  # zh-CN 节假日数据
packages/gan-parser/   # .gan XML 导入器
packages/tsconfig/     # 共享 tsconfig
```

### 7.2 质量门禁 (`.github/workflows/ci.yml`)

PR 必须全绿:

1. `format:check` → `lint` → `typecheck`(strict + `noUncheckedIndexedAccess`)
2. `test`(Vitest 单测)
3. `validate:roadmap`(dogfooding 硬约束:校验 `docs/roadmap.json` 符合 schema)
4. `build`
5. `test:e2e`(Playwright + 13 张截图基线)

### 7.3 提交规范

Conventional Commits + commitlint + husky + lint-staged。中文 subject 允许。

---

## 8. dogfooding 自举 (PRD §1.5, §7.9)

> ganttly 必须用 ganttly 自己管理 ganttly 的开发计划。

`docs/roadmap.json` 是 ganttly 自己的开发计划,**格式遵循本仓库的 schema**。它必须能被 ganttly 自身打开并完整编辑。

**硬验收**:

- 文件 schema-valid(CI `validate:roadmap` 步骤把关)
- 应用能加载并编辑它(`tests/e2e/dogfooding.spec.ts` 验证)
- 状态锁:`dogfooding.spec.ts` 断言 m0-m4 的 `customFields.status === 'done'`,防止文档与现实脱钩

---

## 9. 已知限制与未来方向

参见 PRD §8(P1/P2 路线图)与 §9(开放问题)。MVP 明确**不做**:多人协作、服务端账户、资源分配、基线、PERT、`.mpp` 互操作。

M5(v0.1.0 验收冲刺)补齐的缺口记录在各 commit 中,主要是:

- 拖拽操作可 undo
- 节假日 hover tooltip
- 截图基线平台无关化 + 暗色/4 视图/4 依赖覆盖
- §3.10 交互清单补齐(复制/剪切/粘贴、Alt+Up/Down、Esc)
