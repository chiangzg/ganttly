# WBS 任务树 UI 与交互设计

| 字段     | 内容                                                                                       |
| -------- | ------------------------------------------------------------------------------------------ |
| 文档状态 | Implemented(PR #14,2026-08-20,分支 `feature/wbs-tree-ui-modernize`)                        |
| 适用范围 | 编辑器左侧任务列表(WBS 任务树)及姊妹面板「资源明细栏」(§11)                                |
| 目标     | 提升可读性、降低误操作、交互规则单一可预期                                                 |
| 关联实现 | `TaskTable.tsx`、`ContextMenu.tsx`、`useViewStore.ts`、`tests/e2e/wbs-tree-layout.spec.ts` |

> 本文档描述**现行方案**(已落地并被 e2e 锁定)。早期草案与实施取舍记录见 §9。

## 1. 设计结论

左侧任务表由两个职责清晰的列组成:

- **WBS 列 = 扁平"行号列"**:固定 `[拖拽把手槽 18px][编号]` 两段,编号在所有
  深度上同一 x 起点垂直对齐,使用 `tabular-nums` 等宽数字。层级信息完全不在
  这一列,深层编号不会撑宽列(列宽按最长编号自适应,永不省略)。
- **任务名列 = 树形结构**:`[每级 16px 缩进参考线][16px 箭头槽(全行保留)]
[◆ 里程碑][名称][折叠计数徽标]`,即 VSCode / MS Project / GanttPRO 的
  惯例:展开箭头贴着它所控制的标签。

```text
☰     #    任务名称            工期
      1    ▾ 网站改版           2d   ← 父:箭头 + 半粗
      1.1    ┊ · 需求调研        1d   ← 叶:无箭头,占位对齐
      2    ▾ 设计阶段           2d
      2.1    ┊ ▸ 视觉稿 1 项     1d   ← 折叠父:右向箭头 + 计数徽标
```

任务行只保留一套稳定语义,双击无隐式分区:

- **单击行** = 选中(Cmd/Ctrl/Shift + 单击 = 多选,纯选择)。
- **双击行(任意位置)** = 打开任务详情抽屉。
- **`F2` / 右键菜单「重命名 F2」/ 抽屉内** = 重命名;`F2` 后 `Tab` 遍历
  工期/进度行内编辑。
- **箭头 / 把手 / 输入框** = 只执行各自操作,不选中、不开抽屉。

## 2. 解决的问题(2026-08 之前的旧版)

| 旧版问题                                        | 根因                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| WBS 列像纯文本,父/叶子靠缩进+编号肉眼分辨       | 编号随深度缩进且父/叶起始 x 错位(叶子无箭头占位),父任务仅有加粗+浅底色两个弱信号  |
| hover 行时内容右移 ~18px,点箭头要"追着点"       | 拖拽把手 `⠿` 是流内元素,`hidden → hover:inline-block` 从零宽变占宽,推移箭头与编号 |
| 双击语义像 bug:双击名字=重命名、双击空白=开抽屉 | 行级 `onDoubleClick` 靠 `closest('[data-field]')` 静默分流,无任何视觉线索         |
| 想单击却误拖整行                                | 整行 `draggable`,任何位置按住移动即触发 dragstart                                 |

## 3. 视觉设计规范

### 3.1 WBS 单元格(扁平编号)

- 结构:`[把手槽 18px 固定宽][编号文本]`,不随 depth 缩进。
- 编号:`data-testid="wbs-number"`,`tabular-nums text-[11px] text-fg-muted`,
  固定 x 起点 → 全表垂直对齐。
- 列宽自适应:`max(44, 18 + 6 + 最长编号长 × 8 + 8)`,无省略号、无 Tooltip
  (扁平编号最深处 `1.1.1.1.1` 也远小于旧缩进方案所需宽度)。
- 图标出现/隐藏只允许改 `opacity`,禁止改 `display`、宽度或 padding —— 这是
  "零位移"红线的实现约束。

### 3.2 拖拽把手(唯一拖拽源)

- lucide `GripVertical` 12px,绝对定位居中于 18px 保留槽。
- `opacity-0 → group-hover/row:opacity-100`(含 `group-focus-visible/row`),
  `transition-opacity` 淡入;`cursor-grab` / `active:cursor-grabbing`。
- `draggable` + `onDragStart`/`onDragEnd` 挂在把手槽上(`data-testid="row-drag-handle"`),
  行主体**不可拖拽**;`onClick`/`onDoubleClick` stopPropagation(点把手不选中、双击不开抽屉)。
- 行主体恢复原生文本选择(可划选复制任务名)。

### 3.3 任务名称单元格(树形结构)

- **缩进参考线**:每个 depth 渲染一个 16px 槽,`border-r border-border/60`
  1px 竖线(VSCode 式)。
- **箭头槽**:16px 全行保留(叶子渲染空占位),同级名称严格对齐。
  - 父任务:`<button data-testid="expand-toggle">`,lucide `ChevronDown`(展开)/
    `ChevronRight`(折叠),`aria-expanded` + `aria-label`(展开/折叠子任务),
    点击 `stopPropagation` + `toggleCollapse`(不改选中、不开抽屉),双击 stopPropagation。
  - 叶子任务:无按钮。
- **父/叶子区分信号**(颜色不是唯一来源):常驻箭头(父)/无箭头(叶)、
  名称 `font-semibold`(父)/`font-medium`(叶)、父行 `bg-bg-elevated` 底色。
- **折叠计数徽标**:父任务**处于折叠态**时名称右侧显示
  `data-testid="child-count"`,文案 `{{count}} 项`(en `{{count}}`),直接子任务数;
  展开时不显示(子行本身可见,避免噪音),名称编辑中隐藏。
- 里程碑 `◆` 前缀、名称 `truncate`、行内编辑 input 占内容区 `flex-1`。

### 3.4 状态样式

- Hover:整行 `hover:bg-bg`;把手淡入。任何 hover 不改变布局。
- 选中:每行 inset ring(锚点 2px,其余 1px),叠加在父任务底色之上。
- 拖拽源:整行 `opacity-40`;落点 `before/after` 显示 2px 插入线(x =
  `wbsWidth + depth×16 + 20`,对齐名称列缩进),`inside` 整行 `bg-primary/10` 高亮。

## 4. 布局与宽度

- 列模板(表头与每行共用同一字符串):`wbsWidth px | minmax(0,1fr) | 工期 | 人天 | 进度 | [基线偏差]`。
- 工期/人天/进度/基线列宽与面板默认宽度**维持既有偏好体系**
  (`useColumnWidths`/`usePanelWidth`,localStorage 持久化),未做列宽翻修。
- 名称列 `minmax(0,1fr)` 吸收全部剩余宽度。

## 5. 交互规范

### 5.1 点击与双击

1. 箭头、把手、输入框等明确控件先消费事件(`stopPropagation`)。
2. 其他区域单击只执行选择(修饰键 = 多选,永不打开抽屉)。
3. 其他区域双击**统一**打开详情抽屉 —— 不再按 name/WBS/工期/空白分流。

### 5.2 行内编辑与重命名

- `F2`:进入名称编辑;编辑中 `Enter` 提交、`Escape` 取消、失焦提交。
- `Tab`:提交当前格并遍历 `名称 → 工期 → 进度`(自动跳过摘要/里程碑只读格)。
- 右键菜单「重命名」(带 F2 hint,位于「编辑」之后):经 `useViewStore.renameRequest`
  一次性请求(`{taskId, nonce}`),TaskTable 监听后选中行、滚动聚焦并进入名称
  编辑 —— 与 F2 行为完全一致。
- **`Enter` 保持"新建同级任务并直接命名"**(快速录入),不做重命名。
- 摘要任务工期/进度、里程碑工期只读(汇总/无工期),与抽屉同源。

### 5.3 展开与收起

- 单行:点击箭头,或键盘 `←`/`→`(流式收起/展开,叶子跳到下一个可展开节点)。
- 批量:搜索栏「全部展开」/「全部收起」图标按钮
  (lucide `ChevronsUpDown`/`ChevronsDownUp`)。
  收起全部 = 所有含子任务的 id 集合;经**直连 `setState`** 写 `collapsedTaskIds`
  (仿 scrollTop 导航模式),不进 undo 栈 —— 与单行折叠(undoable)刻意不同:
  批量导航不是数据操作。

### 5.4 拖拽排序

- 仅把手槽启动 HTML5 DnD;行主体 `onDragOver/onDrop/onDragLeave` 保留为落点计算。
- 落点:`before | inside | after`(行内 25%/75% 边界),禁止拖入自身后代。
- 近上下边缘自动滚动;`Escape` 取消;一次拖拽 = 一条
  `moveTaskWithRollupCommand` undo 记录。

## 6. 可访问性

- 行容器 `role="treegrid"`(`aria-label` = 任务字段表头),行 `role="row"` +
  `aria-level={depth+1}` + 含子任务时 `aria-expanded`。
- 箭头按钮 `aria-expanded`/`aria-label`;把手 `title` 提示;菜单项快捷键 hint。
- 键盘路径完整:`↑↓` 行导航、`←→` 折叠展开、`Enter` 新增、`F2` 重命名、
  `Tab/Shift+Tab` 升降级、`Alt+↑↓` 同级移动、`Delete` 删除、`Escape` 清选。
- `aria-posinset`/`setsize` 需改 flatten 数据流,未实施(见 §9)。

## 7. 实现落点

| 能力                                                                                         | 位置                                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| WBS/名称两单元格、行交互、DnD、F2/Tab 编辑                                                   | `apps/web/src/components/TaskTable.tsx`                               |
| `wbsWidth` 自适应计算(扁平公式)                                                              | TaskTable `useMemo`                                                   |
| 拖放插入线几何                                                                               | TaskTable `dropIndent = wbsWidth + depth*16 + 20`                     |
| 「重命名」菜单项                                                                             | `apps/web/src/components/ContextMenu.tsx`                             |
| `renameRequest` 一次性通道、展开/收起全部 state                                              | `apps/web/src/store/useViewStore.ts` + TaskTable effect/直连 setState |
| i18n(`contextMenu.rename`、`table.expandTask/collapseTask/expandAll/collapseAll/childCount`) | `apps/web/src/i18n/zh-CN.ts`、`en.ts`                                 |

## 8. 测试与验收

| Spec                                                                      | 覆盖                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `tests/e2e/wbs-tree-layout.spec.ts`(新增)                                 | hover 前后编号/箭头 boundingBox 不变(零位移);跨深度编号同 x;treegrid aria;全部展开/收起(行数 + 徽标文案 + undo 深度不变) |
| `inline-edit.spec.ts`                                                     | F2/F2+Tab 进入行内编辑、Enter/Escape/Tab、摘要/里程碑只读;双击任意格(name/WBS/工期)统一开抽屉且不出输入框                |
| `task-row-drag.spec.ts`                                                   | dragstart 派发到把手;行主体无 `draggable` 且派发无效;before/inside/after、后代禁止、单条 undo、Escape 取消               |
| `collapse-rollup.spec.ts`                                                 | `[data-testid="expand-toggle"]` 折叠展开、行数恢复、折叠徽标「N 项」                                                     |
| `context-menu.spec.ts` / `context-menu-hints.spec.ts`                     | 方向键导航含新「重命名」项;激活后出行内编辑、Enter 提交;F2 hint                                                          |
| `row-keyboard-navigation` / `wbs` / `multi-select` / `drawer-transaction` | 回归确认,选择器兼容未变行为                                                                                              |

## 9. 未采纳方向与历史取舍

早期草案(本文件 2026-08 初版)与实施版本的差异及理由:

- **树形结构留在 WBS 列(缩进 + 固定 96px/上限 112px + 省略号 + Tooltip)**:
  编号永远无法全表对齐;深层缩进会撞上限频繁触发省略。扁平化后该问题不存在,
  自适应列宽即可,整套截断机制随之取消。
- **`Enter` = 重命名**:与既有 `Enter` = 新建同级任务冲突,会砍掉快速录入;
  重命名已有 F2/菜单/抽屉三个入口。
- **行尾 28px 固定「打开详情」槽**:双击已统一为开详情,再占一列收益不足。
- **列宽翻修(52/52/48、面板默认 400~420px)**:可能截断本地化内容、漏算
  基线列、动存量用户偏好,收益仅为主观紧凑。
- **名称列 hover 铅笔图标**:菜单已带 F2 提示,不加视觉噪音。
- 未实施(后续可选):`aria-posinset/setsize`、抽取 `TaskTreeCell` 展示组件、
  键盘发起拖拽(现由 `Alt+↑↓` 同级移动替代)。

## 10. 成功标准

1. 一眼区分父/叶子任务(箭头 + 半粗 + 底色 + 参考线,四重信号)。✅
2. hover 从名字移向箭头,没有任何元素位移。✅(e2e 锁定)
3. 只有把手能拖动任务,单击/双击不会误触拖拽或选中。✅
4. 双击行任意普通区域得到一致的详情结果。✅
5. 重命名有可见入口(F2 hint 出现在右键菜单),不依赖隐藏规则。✅

## 11. 姊妹面板:资源明细栏(2026-08-20 追加)

资源视图左侧 `ResourceList.tsx` 按同一套规则完成现代化(分支
`feature/resource-list-modernize`,堆叠于 PR #14 之上),差异点源于
「任务视图以任务为主,资源视图以人为主」。

**复用的规则(与任务树一一对应)**:

| 任务树                                 | 资源明细栏                                           |
| -------------------------------------- | ---------------------------------------------------- |
| 18px 把手槽,hover 淡入,仅把手可拖      | 同;拖拽 = 扁平重排(`moveResourceCommand`)            |
| lucide 箭头 + 槽位全行保留             | 同(`ChevronRight/Down`,无任务资源留空槽)             |
| 折叠父任务「N 项」徽标                 | 折叠资源「N 项」(名下叶子任务数)                     |
| 双击行 = 打开详情抽屉                  | 双击行 = 展开/收起该资源的任务下钻(人的详情)         |
| F2/Tab(name→duration→progress)行内编辑 | F2/Tab(name→role→capacity);一次提交一条命令          |
| 右键菜单「重命名 F2」(renameRequest)   | 同(resourceRenameRequest + kind:'resource' 菜单分支) |
| 搜索栏全部展开/收起                    | 表头第一格右侧两个图标按钮                           |
| treegrid + aria-level/aria-expanded    | 同(资源 =1 级,任务 lane =2 级)                       |
| 只许改 opacity 的零位移红线            | 同(把手/删除按钮)                                    |

**差异点(有意为之)**:

- **身份标识**:任务树用「父任务箭头+半粗+参考线」区分层级;资源是扁平
  名单,用**姓名 hash 配色的头像圆标**(孟/ZS/AC)承载"以人为主"的身份。
- **编辑模型**:原实现是三个常驻 `<input>`(每敲一键一条 undo 记录),
  现改为静态文本 + 点击后编辑,单命令提交修复 undo 污染。
- **双击语义**:资源没有详情抽屉,双击 = 下钻开合;任务 lane 保留
  双击 = 打开任务抽屉(与任务视图一致)。
- **常驻 `×` 删除按钮**改为 hover 淡入(任务树删除走右键/Delete,资源
  保留行内入口但去视觉噪音);`Delete` 键同样弹确认。
- 下钻任务 lane 保持只读,视觉对齐任务树叶子行(空箭头槽 + tabular WBS)。

**实现落点**:`ResourceList.tsx`(行重构/编辑/拖拽)、`ContextMenu.tsx`
(`contextMenu` 扩为 task|resource 判别联合,共用外壳)、
`useViewStore.ts`(`resourceRenameRequest`)、domain
`moveResourceCommand`(快照式 undo)。验收:`tests/e2e/resource-list-interactions.spec.ts`
(10 例:零位移、F2 单命令 undo、Tab/Esc、双击下钻徽标、右键全链路、
Delete 确认、把手拖拽单 undo、全部展开/收起、treegrid aria)+ 存量
`resources/panel-width/resource-canvas-info/effort-constraints` 同步。
