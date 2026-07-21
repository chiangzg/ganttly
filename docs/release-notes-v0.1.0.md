# ganttly v0.1.0 — MVP

> 开源、本地优先、中文优先的 Web 甘特图软件 —— GanttProject 的现代平替。

首个正式版本。**PRD §7 九条验收标准全部通过。**

🎨 **在线 demo**:https://chiangzg.github.io/ganttly/
📖 **完整文档**:[PRD](https://github.com/chiangzg/ganttly/blob/main/docs/PRD.md) · [架构详解](https://github.com/chiangzg/ganttly/blob/main/docs/architecture.md)

---

## 主要特性

| 功能                   | 说明                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| **WBS 任务树**         | 任意层级嵌套,Tab 升降级,鼠标拖拽排序,WBS 编号自动生成               |
| **4 种依赖**           | FS / SS / FF / SF,带 lag,自动排期,循环依赖检测阻断                  |
| **关键路径 (CPM)**     | 正向/反向推算 + 总浮动,一键高亮,多等长路径支持                      |
| **中国节假日一等公民** | 2026 全年法定节假日 + 调休补班,自动高亮,工期计算跳过,hover 显示名称 |
| **4 个时间视图**       | 日 / 周 / 月 / 年,Ctrl+滚轮缩放,双层表头,光标处锚定                 |
| **撤销/重做**          | 命令模式,深度无限,含拖拽改期/连线/复制粘贴等所有结构性变更          |
| **完整交互**           | 复制/剪切/粘贴 (Ctrl+C/X/V),Alt+Up/Down 排序,右键菜单,双击编辑      |
| **本地持久化**         | IndexedDB 自动保存 (500ms debounce),LocalStorage 兜底               |
| **导入导出**           | JSON / CSV 导出,JSON / GanttProject `.gan` 导入                     |

## 为什么做这个

GanttProject 是一款历史悠久的桌面甘特图工具,但在三个方面长期困扰着中文用户:

1. **高分屏渲染糟糕** — 基于 Java/Swing,字体抗锯齿与 DPI 缩放在 macOS Retina 上表现差
2. **本地化缺失** — 中国法定节假日需要每年手动添加
3. **政治立场渗透** — UI 中嵌入了与功能无关的政治符号

ganttly 通过 Web 形态 + 浏览器原生 HiDPI + 中国节假日一等公民 + 政治中立解决这些痛点。详见 [PRD §1 背景与动机](https://github.com/chiangzg/ganttly/blob/main/docs/PRD.md)。

## 技术栈

React 18 + TypeScript 5 (strict) + Vite 5 + Zustand + Tailwind + Canvas 自研引擎 + Playwright。pnpm monorepo。

## 测试

- **135 单元测试** (Vitest):覆盖日历计算、CPM 算法、依赖排期、循环检测、命令系统、汇总回滚
- **37 E2E 测试** (Playwright):含 13 张截图基线(4 视图 / 暗色模式 / 4 依赖类型 / 里程碑 / 100 任务 / 节假日 tooltip)
- **PRD §7 九条验收全过**:渲染一致性、性能 (1000 任务 60fps)、节假日、4 依赖、关键路径、持久化、.gan 导入、撤销重做 (50 步)、dogfooding 自举

## dogfooding

ganttly 用 ganttly 管理自己的开发计划:[`docs/roadmap.json`](https://github.com/chiangzg/ganttly/blob/main/docs/roadmap.json) 可直接用 ganttly 打开、编辑、保存。这是 PRD §7.9 的硬验收约束。

## 已知问题

- CI 上 `collapse-rollup.spec.ts` 有 2 个 flaky 测试(retries 兜底,workflow 整体 success),根因是测试夹具的 store 注入与 autosave 周期竞态,不阻塞功能,发布后单独处理。

## License

MIT © Chiang
