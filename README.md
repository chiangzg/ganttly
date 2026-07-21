# ganttly

> 开源、本地优先、中文优先的 Web 甘特图软件 —— GanttProject 的现代平替。

[![CI](https://github.com/your-org/ganttly/actions/workflows/ci.yml/badge.svg)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 为什么做这个

GanttProject 是一款历史悠久的桌面甘特图工具,但它在三个方面长期困扰着中文用户:

1. **高分屏渲染糟糕** — 基于 Java/Swing,字体抗锯齿与 DPI 缩放在 macOS Retina 上表现差(GitHub issue [#1108](https://github.com/bardsoftware/ganttproject/issues/1108)、[#1471](https://github.com/bardsoftware/ganttproject/issues/1471))。
2. **本地化缺失** — 中国法定节假日需要每年手动添加,无内置 2026 调休支持。
3. **政治立场渗透** — UI 中嵌入了与功能无关的政治符号。

ganttly 通过以下方式解决这些痛点:

- ✅ **Web 渲染** — 借助浏览器的 HiDPI 适配,在 Mac / Windows / Linux 上像素级一致。
- ✅ **中国节假日一等公民** — 内置 2026 全年法定节假日与调休工作日,自动高亮、自动跳过工期计算。
- ✅ **政治中立** — 工具软件不携带任何政治符号。
- ✅ **本地优先** — 数据存浏览器 IndexedDB,天然离线,零后端、零运维。
- ✅ **完整甘特图特性** — WBS 任务树、4 种依赖(FS/SS/FF/SF)、关键路径(CPM)、撤销/重做、`.gan` 导入、JSON / CSV 导出。

## 快速上手

```bash
# 本地开发
pnpm install
pnpm dev          # 启动 http://localhost:5173

# 生产构建
pnpm build

# 跑测试
pnpm test         # 单元测试 (140+)
pnpm test:e2e     # Playwright + 截图回归
```

环境要求:Node ≥ 18, pnpm ≥ 9。

## 主要功能

| 功能         | MVP   | 说明                                       |
| ------------ | ----- | ------------------------------------------ |
| WBS 任务树   | ✅    | 任意嵌套,Tab 升降级,鼠标拖拽排序           |
| 任务字段     | ✅    | 名称、日期、工期、进度、里程碑、颜色、备注 |
| 4 种依赖     | ✅    | FS / SS / FF / SF,带 lag,自动排期          |
| 关键路径     | ✅    | CPM 算法,一键高亮,多等长路径支持           |
| 中国节假日   | ✅    | 2026 全年法定节假日 + 调休补班             |
| 4 个时间视图 | ✅    | 日 / 周 / 月 / 年,Ctrl+滚轮缩放            |
| 撤销/重做    | ✅    | 命令模式,深度无限                          |
| 本地持久化   | ✅    | IndexedDB 自动保存                         |
| 导入导出     | ✅    | JSON / CSV 导出,JSON / `.gan` 导入         |
| 资源分配     | 🚧 P1 | 团队管理与负载图                           |
| 基线对比     | 🚧 P1 | 计划 vs 实际                               |
| 多人协作     | 📋 P2 | CRDT 实时同步                              |

完整路线图见 [`docs/PRD.md`](docs/PRD.md) 第 8 章。

## 技术栈

| 关注点   | 选型                                     |
| -------- | ---------------------------------------- |
| 渲染内核 | Canvas(自研)+ DOM 叠层                   |
| 框架     | React 18 + TypeScript 5                  |
| 构建     | Vite 5                                   |
| UI       | Tailwind CSS + 自定义组件(主题跟随系统)  |
| 状态     | Zustand + Command pattern(撤销/重做)     |
| 持久化   | IndexedDB(降级 LocalStorage)             |
| 测试     | Vitest(单测)+ Playwright(E2E + 截图回归) |
| 工程     | pnpm monorepo                            |

monorepo 结构:

```
ganttly/
├── apps/web/                 # React 前端
├── packages/
│   ├── schema/               # 数据模型 + JSON Schema
│   ├── calendar-data/        # 节假日数据(zh-CN.json)
│   ├── gan-parser/           # GanttProject .gan 导入器
│   └── tsconfig/             # 共享 tsconfig
└── docs/
    ├── PRD.md                # 产品需求文档
    └── roadmap.json          # dogfooding:用 ganttly 管理 ganttly 自己
```

## 文件格式

ganttly 自有 JSON 格式(`.ganttly.json`),扁平 `parentId` 引用,一等 `calendar`,显式 `schemaVersion`。完整 schema 见 [`packages/schema/schema.json`](packages/schema/schema.json)。

也支持导入 GanttProject `.gan` 文件(XML)。导入映射见 PRD §3.9——MVP 阶段导入任务树、4 种依赖、里程碑;资源、基线、PERT 记入"已跳过"报告,P1 再支持。

## 节假日数据

中国节假日数据维护在 [`packages/calendar-data/calendars/zh-CN.json`](packages/calendar-data/calendars/zh-CN.json),每年 11 月(国务院发布次年放假安排后)由维护者更新。

其他地区的数据欢迎以 PR 形式贡献。新增 `<region>.json` 后,在 `src/index.ts` 的 `CALENDAR_FILES` 中注册即可。

## dogfooding

ganttly 用 ganttly 管理自己的开发计划:[`docs/roadmap.json`](docs/roadmap.json) 可以直接用 ganttly 打开、编辑、保存。

## License

MIT © Chiang
