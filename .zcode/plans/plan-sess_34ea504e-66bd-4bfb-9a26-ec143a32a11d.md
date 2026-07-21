# ganttly PRD 撰写计划

## 目标
在 `docs/PRD.md` 产出一份完整的中文 PRD,作为 ganttly(MVP)的开发蓝图。这份 PRD 既是给 AI 开发的执行手册,也是产品验收基准。

## 本次产出(单个文件)
- `docs/PRD.md` — 全量 PRD(中文,按下方大纲)

## PRD 内容结构

### 1. 背景与动机
- GanttProject 三大痛点(渲染不一致 / 本地化差 / 政治立场)
- ganttly 的目标:开源 Web 平替,本地优先,中文优先
- dogfooding 自举约束:用 ganttly 管理 ganttly 自己的开发

### 2. 决策记录(ADR-lite,带理由)
记录本次 grilling 锁定的全部决策:
| 决策项 | 选定方案 |
|---|---|
| 产品形态 | Web 应用 |
| 数据模式 | 本地优先 + 预留后端 |
| 渲染内核 | Canvas 自研 + DOM 叠层(借鉴 frappe-gantt 算法不引依赖) |
| 前端栈 | React + TypeScript + Vite + shadcn/ui + Tailwind + Zustand |
| 文件格式 | JSON(扁平 parentId + 一等 calendar + 显式 schemaVersion)+ JSON Schema 文件 |
| 节假日 | 仓库内静态 `calendars/zh-CN.json`,每年维护者更新 |
| 交互 | 全做 + 鼠标拖拽排序 |
| i18n | 中文为主,英文预留(i18next) |
| 主题 | 跟随系统 `prefers-color-scheme` |
| 测试 | Vitest 单测 + Playwright 截图测试 |
| 工程 | pnpm monorepo |
| Docker | MVP 不主推,二期随后端引入 |
| AI 开发节奏 | 5 里程碑(M0-M4),每个 M 拆 1-3h 子任务 |

### 3. 功能需求(P0 范围)
10 个核心功能模块(每个含验收点):
- WBS 任务树(扁平 parentId,Tab 升降级,鼠标拖拽排序)
- 任务字段(名称/开始/结束/工期/进度/里程碑/颜色/备注)
- 4 种依赖(FS/SS/FF/SF)+ 拖拽连线 + 箭头渲染
- 时间轴多视图(日/周/月/年)+ Ctrl+滚轮缩放
- 中国节假日/调休/周休高亮
- 关键路径(CPM 算法)+ 高亮开关
- 撤销/重做(命令模式)
- 本地持久化(IndexedDB + 自动保存)
- 文件导入导出(JSON 自有格式 + `.gan` 核心子集)
- 完整交互清单(鼠标/键盘/右键菜单/双击编辑抽屉)

### 4. 数据模型(JSON Schema 详解)
- 顶层 schema(附 TypeScript 类型 + JSON Schema 引用)
- 关键设计:扁平 parentId、calendar 一等公民、显式 schemaVersion
- `.gan` 导入子集映射表(哪些字段导,哪些丢)

### 5. 技术架构
- 目录结构(apps/web + packages/{schema,calendar-data,gan-parser,tsconfig})
- Canvas 引擎分层(scene/render/layout/interaction)
- 数据访问层抽象(load/save 接口,为二期后端预留)
- 状态管理(Zustand store 边界)
- 截图测试策略(Playwright + 像素 diff)

### 6. 里程碑与任务树(M0-M4)
每个 M 含:
- 目标产出
- 1-3 小时粒度的子任务清单(给 AI 逐条执行)
- 验收信号(截图/测试/人工)
- 估算(以"AI 协作会话"为单位)

M0 工程地基 / M1 数据+引擎 / M2 编辑+依赖 / M3 灵魂特性(关键路径+节假日) / M4 收尾+dogfooding 闭环

### 7. 验收标准(9 条)
渲染一致性 / 性能(1000 任务 60fps) / 节假日正确性 / 4 种依赖 / 关键路径算法 / 数据持久化 / .gan 导入 / 撤销重做 / **dogfooding 闭环(本仓库 roadmap.json 自维护)**

### 8. 路线图(P1/P2,不进 MVP)
P1:资源分配+负载图、基线对比、PDF/PNG 导出、任务约束、成本、自定义列
P2:PERT 图、iCalendar、MS Project XML 导入、EVM、服务端同步、协作

### 9. 开放问题(列而不决)
- 节假日云端更新机制
- 主题切换粒度
- 是否做插件系统

## 不做的事
- 不写代码、不建工程结构(M0 才做)
- 不生成 `docs/roadmap.json`(M0 任务之一,本次只产 PRD)
- 不生成 `architecture.md`(避免与 PRD 第 5 节重复,M0 时再细化)
- 不讨论 GanttProject 的政治/国旗细节(PRD 只中立描述为"UI 政治立场问题")

## 写作约束
- 中文为主,代码/类型/字段名用英文
- 决策记录给理由(让未来读者知道为什么这么选)
- 子任务清单可被 AI 直接执行(自包含、有验收)
- 引用调研结论时标注数据来源(issue 号/源文件路径)