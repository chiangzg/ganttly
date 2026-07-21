# ganttly 产品需求文档 (PRD)

| 字段     | 值                            |
| -------- | ----------------------------- |
| 项目     | ganttly — 开源 Web 甘特图软件 |
| 版本     | v0.1 (MVP)                    |
| 文档状态 | 已批准                        |
| 创建日期 | 2026-07-21                    |
| 作者     | Chiang (产品/架构), AI 协作   |
| 适用范围 | MVP (P0 功能集)               |

---

## 1. 背景与动机

### 1.1 起源

作者长期使用 [GanttProject](https://www.ganttproject.biz/) (`github.com/bardsoftware/ganttproject`,Java/Swing 桌面应用)进行项目排期,但累计了三类无法忍受的痛点,因此决定构建一个开源 Web 平替 —— **ganttly**。

### 1.2 痛点分析

**痛点 A — 渲染不一致,高分屏体验糟糕**

GanttProject 基于 Java AWT/Swing,字体渲染与 DPI 缩放长期受诟病:

- Issue [#1108 "Mac OS Retina display compatibility"](https://github.com/bardsoftware/ganttproject/issues/1108):2015 年提出,2018 年才通过在 `Info.plist` 中加 `NSHighResolutionCapable` 标志位与应用层 DPI 线性缩放勉强解决;
- Issue [#1471 "HiDPI"](https://github.com/bardsoftware/ganttproject/issues/1471):JVM 的 `-Dsun.java2d.uiScale=2` 标志无效,因为 GanttProject 走应用层缩放而非 JDK HiDPI 管线;
- Issue [#2220](https://github.com/bardsoftware/ganttproject/issues/2220):导出 PNG/PDF 字体使用固定 12pt,且子像素抗锯齿缺失。

根本原因:Java 桌面 GUI 的字体/DPI 管线相比现代浏览器落后了一代。**浏览器在各厂商几十亿美金投入下,HiDPI/Retina 适配已经是基础设施级别的能力**——这是 ganttly 选择 Web 形态的根本理由。

**痛点 B — 本地化差,中国节假日缺失**

GanttProject 的本地化虽通过 [Crowdin](https://crowdin.com/project/ganttproject-30) 维护,简体中文 (`zh_CN`) 也已存在(约 33KB,字节覆盖率 ~71%),但**节假日日历**是另一回事:

- 仓库 `biz.ganttproject.app.localization/src/main/resources/calendars/i18n_cn.calendar` 仅覆盖 2019-2026;
- 中国放假安排**每年由国务院在 11 月发布次年通知**,包含大量调休工作日(`type="WORKING_DAY"`),非固定规则可生成;
- 2027 年起用户必须**手动一年年添加节假日**——这是中国用户的硬伤。

ganttly 必须把**中国节假日**作为一等公民来设计。

**痛点 C — 政治立场渗透到软件 UI**

GanttProject 在 UI 多处嵌入了乌克兰国旗元素(2022 年起)。本 PRD 对该决定本身保持中立,但坚持一个原则:**开源工具软件不应携带与功能无关的政治立场**。ganttly 在整个产品生命周期中保持政治中立,UI、文案、文档不嵌入任何政治符号。

### 1.3 ganttly 的目标

> **构建一个开源、本地优先、中文优先、渲染一致的 Web 甘特图软件,作为 GanttProject 的现代平替。**

四个关键词:

- **开源** — MIT 协议,接受社区贡献;
- **本地优先** — 数据存在用户浏览器,天然离线,零运维;
- **中文优先** — UI、文档、节假日日历以中国用户为第一公民;
- **渲染一致** — 借助浏览器,在 Mac/Win/Linux/平板上像素级一致。

### 1.4 非目标 (MVP 不做)

为控制 MVP 范围,以下明确**不做**(列入第 8 章路线图):

- 多人实时协作(类 Figma 的 CRDT 同步);
- 服务端账户系统与多设备同步;
- 资源分配、基线对比、PERT 图、挣值分析(EVM);
- MS Project `.mpp` 文件双向互操作;
- 任何形式的政治/营销/广告内容嵌入。

### 1.5 dogfooding 自举约束

> **ganttly 必须用 ganttly 自己管理 ganttly 的开发计划。**

具体约束:

- 本仓库维护 `docs/roadmap.json` 文件,格式遵循本 PRD 第 4 章数据模型;
- M0 完成后,`roadmap.json` 必须能被 ganttly 自身打开并完整编辑;
- 每个里程碑(M1-M4)完成后,该文件中的对应任务状态必须由 ganttly 自身更新;
- 这是 MVP 的**硬验收标准**(见第 7.9 条),也是 ganttly 的第一个真实使用场景。

---

## 2. 决策记录 (ADR-lite)

本章记录 MVP 设计阶段通过 grilling 流程锁定的全部根决策。每条都带**理由**,让未来读者(包括 AI 协作者)知道为什么这么选,而不是只看到结论。

### 2.1 产品形态:Web 应用

|          |                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| **决策** | 以浏览器 Web 应用形态分发,不打包桌面 GUI。                                                                           |
| **理由** | 浏览器的 HiDPI/字体渲染彻底解决痛点 A;一套代码跨设备(Mac/Win/Linux/平板)渲染一致;开源项目零运维(静态托管即可)。      |
| **备选** | (a) Web + Tauri/Electron 桌面壳;(b) 纯原生桌面(Tauri/Electron/Qt)。两者都要自己处理字体/DPI,重蹈 GanttProject 覆辙。 |
| **未来** | 二期可加 PWA 离线 + 可选 Tauri 桌面壳,不影响 MVP。                                                                   |

### 2.2 数据模式:本地优先 + 预留后端

|          |                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **决策** | MVP 纯前端,数据存 IndexedDB + 可导入导出文件。架构上为二期后端预留数据访问层抽象。                                                                           |
| **理由** | 单人/小团队是甘特图主要场景,覆盖 90% 用户;本地优先天然离线,无后端=零运维;但节假日等"公共数据"将来需要云端更新,因此数据访问必须抽象,不能散落 IndexedDB 调用。 |
| **备选** | (a) 一上来就做服务端账户/同步:引入用户系统、CRDT、运维,过载;(b) 一上来就做实时协作:成本最高。                                                                |

### 2.3 渲染内核:Canvas 自研 + DOM 叠层

|          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | Canvas 绘制任务条/网格/依赖箭头(主渲染),DOM/SVG 绘制表头/tooltip/拖拽手柄/UI chrome。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **理由** | 调研 [frappe-gantt](https://github.com/frappe/gantt) 发现:它纯 SVG 无虚拟化,issue [#486](https://github.com/frappe/gantt/issues/486) 报告 5000 任务浏览器假死 5-6 秒;v1.x 滚动抖动 ([#490](https://github.com/frappe/gantt/issues/490))、横向滚动断裂 ([#544](https://github.com/frappe/gantt/issues/544))、月/年视图定位错 ([#533](https://github.com/frappe/gantt/issues/533)) 仍 open;**关键路径被维护者明确拒绝** (issue [#88 closed `not_planned`](https://github.com/frappe/gantt/issues/88));**无左侧 WBS 表、无基线、无资源、无 React 封装**(社区版 5 年未更新)。甘特图产品 = 图表(~25% 工作量) + WBS/依赖/关键路径/资源/基线/IO(~75%),frappe-gantt 只交付了那 25%,且在它负责的 25% 里还带硬伤。Canvas 给我们性能天花板与渲染完全掌控。 |
| **备选** | (a) frappe-gantt:接受几百任务上限与已知 bug;(b) WebGL(pixi.js):万级任务也不卡,但开发调试成本最高,文字渲染麻烦。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **借鉴** | frappe-gantt 的算法(日期刻度计算、view-mode 定义、节假日高亮逻辑、贝塞尔箭头曲线)**作为读源码的参考**,不引依赖。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 2.4 前端栈:React + TypeScript + Vite + shadcn/ui + Tailwind + Zustand

|          |                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | React 18 + TypeScript(strict) + Vite 构建;UI 用 shadcn/ui(源码进项目,可定制)+ Tailwind;状态用 Zustand。                                                                    |
| **理由** | React 生态最广,开源协作友好;TypeScript 是现代开源标配,降低协作门槛;Vite 构建快;shadcn/ui 不锁定(组件源码进项目),便于本地化与主题定制;Zustand 轻量,适合本地优先的状态管理。 |
| **备选** | (a) Vue 3 + Pinia:中文社区熟但甘特图生态较少;(b) Svelte 5:运行时轻但生态最少。                                                                                             |

### 2.5 文件格式:JSON(扁平 parentId + 一等 calendar + 显式 schemaVersion)

|          |                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | 自有 JSON 格式;任务用扁平 `parentId + order` 而非嵌套;`calendar` 是顶层一等公民;显式 `schemaVersion` 字段;同时提供 JSON Schema(draft 2020-12)文件供外部工具校验。                       |
| **理由** | 扁平结构让拖拽改层级是 O(1) 改动而非整树重写;`calendar` 一等公民是因为节假日是核心痛点,必须能独立更新;`schemaVersion` 为未来升级留逃生口;JSON Schema 文件让 IDE 与外部工具能校验/读写。 |
| **备选** | 嵌套 `children: []`:直观但拖拽改层级需整树重写。详见第 4 章。                                                                                                                           |

### 2.6 节假日数据:仓库内静态 JSON

|          |                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| **决策** | 在 `packages/calendar-data/calendars/zh-CN.json` 维护中国节假日数据,每年由维护者更新(国务院 11 月发次年通知后)。 |
| **理由** | 零运行时依赖,符合本地优先原则;数据进 Git 可审计、可贡献;避免 MVP 引入后端调用第三方 API。                        |
| **未来** | 二期可加"从云端拉取最新节假日"选项,与本地静态文件并行。                                                          |

### 2.7 交互:全做 + 鼠标拖拽排序

|          |                                                                                               |
| -------- | --------------------------------------------------------------------------------------------- |
| **决策** | MVP 实现完整的专业甘特图交互(对标 GanttProject/MS Project 工业标准),包括鼠标拖拽排序/改层级。 |
| **理由** | 这些都是甘特图用户的基础预期,少一项都会让产品"不像专业软件"。详见第 3.10 节完整交互清单。     |

### 2.8 国际化:中文为主,英文预留

|          |                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | i18n 框架(i18next)一次到位;MVP 只交付中文 UI,英文键值预留但调词后期补充。日期/数字格式化借助浏览器 `Intl` API。                         |
| **理由** | 中文用户是第一公民(本项目动机);但 i18n 框架不在 MVP 引入会让二期补英文时重构成本大;`Intl` API 已覆盖 `zh-CN` locale 的日期/数字格式化。 |

### 2.9 主题:跟随系统

|          |                                                                                        |
| -------- | -------------------------------------------------------------------------------------- |
| **决策** | MVP 跟随系统 `prefers-color-scheme`,亮/暗自动切换;CSS 变量一次写好。                   |
| **理由** | 用户偏好零配置体验;暗色模式在开发者群体中是高频需求;手动切换三档(亮/暗/跟随)留待二期。 |

### 2.10 测试:单测 + 截图测试

|          |                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| **决策** | Vitest 单测覆盖引擎纯逻辑(日期映射、依赖计算、CPM 算法);Playwright 截图测试覆盖 Canvas 视觉回归(像素 diff)。 |
| **理由** | Canvas 渲染**必须**做截图测试,否则视觉回归无法发现——这正是 frappe-gantt v1.x 一堆滚动 bug 长期未发现的原因。 |

### 2.11 工程:pnpm monorepo

|          |                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| **决策** | pnpm monorepo,即使 MVP 只有前端一个包。目录见第 5.1 节。                                                         |
| **理由** | 二期会加后端、节假日数据包、共享类型包;现在不建,等二期重构成本高。pnpm 在 monorepo 与磁盘占用上都优于 npm/yarn。 |

### 2.12 Docker:MVP 不主推

|          |                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **决策** | MVP 主推静态托管(GitHub Pages / Cloudflare Pages / Vercel)+ 本地 `pnpm dev/preview`。提供可选 Dockerfile 但不作为主推方式。二期随后端正式引入容器化。 |
| **理由** | 对纯静态前端,Docker 是"用集装箱运快递盒"——容器里跑的就是个 Nginx 提供 5MB 静态文件。Docker 的真实价值在二期有后端时才显现。                           |
| **未来** | 二期随后端 API 一起提供 `docker-compose.yml`,那时容器化才是最佳实践。                                                                                 |

### 2.13 AI 开发节奏:5 里程碑 + 子任务清单

|          |                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **决策** | 5 个垂直切片里程碑(M0-M4),每个 M 拆成 1-3 小时粒度的子任务清单。人类专家(作者)负责产品决策、架构设计、最终验收;AI 负责代码生成与自检。                 |
| **理由** | AI 开发特征:单次产出代码量大、并行探索快、但上下文窗口有限。垂直切片让人类每个 M 都能立即验收;子任务清单让 AI 一次推进一条,自包含可验收。详见第 6 章。 |

---

## 3. 功能需求 (P0)

本章描述 MVP 必须实现的 10 个功能模块。每个模块含**功能描述**与**验收点**(用于第 7 章验收标准)。

### 3.1 WBS 任务树

**功能**:

- 左侧任务表显示 WBS(工作分解结构),支持任意层级嵌套;
- 任务以**扁平 `parentId + order`** 存储,UI 渲染时组装成树;
- WBS 编号自动生成(如 `1.2.3`),跟随层级变化;
- 增删任务:Enter 新建同级任务,Tab/Shift+Tab 升降级,Delete 删除;
- 鼠标拖拽行:重新排序 + 改层级;
- 行内编辑:双击单元格编辑名称;
- 折叠/展开子任务(带计数提示)。

**验收点**:

- 5 层嵌套任务渲染正确,缩进对齐;
- 拖拽某任务到另一任务下方,`parentId` 与 `order` 正确更新;
- 删除父任务时,子任务一并删除(带二次确认);
- WBS 编号在层级变化后即时重算。

### 3.2 任务字段与里程碑

**功能**:每个任务包含以下字段:

| 字段           | 类型           | 说明                           |
| -------------- | -------------- | ------------------------------ |
| `id`           | string         | UUID,主键                      |
| `name`         | string         | 任务名                         |
| `parentId`     | string \| null | 父任务 ID,顶层为 null          |
| `order`        | number         | 同级排序                       |
| `start`        | ISO date       | 开始日期                       |
| `end`          | ISO date       | 结束日期                       |
| `duration`     | number         | 工期(工作日),与 start/end 联动 |
| `progress`     | 0-100          | 完成百分比                     |
| `isMilestone`  | boolean        | 里程碑(显示为菱形,工期 0)      |
| `color`        | string         | 任务条颜色(CSS 颜色值)         |
| `note`         | string         | 备注(Markdown)                 |
| `dependencies` | array          | 见 3.3                         |
| `constraints`  | object         | P1 预留,空对象                 |
| `assignments`  | array          | P1 预留,空数组                 |
| `customFields` | object         | P1 预留,空对象                 |

**联动逻辑**:

- 修改 `start` + `duration` → 自动算 `end`(跳过节假日);
- 修改 `end` → 反算 `duration`;
- 里程碑 `isMilestone=true` 强制 `duration=0`,`start=end`;
- 摘要任务(有子任务)的 start/end/progress 由子任务汇总,不可手动编辑。

**验收点**:

- 摘要任务 start = min(子任务 start),end = max(子任务 end);
- 摘要任务 progress = 加权平均(按工期);
- 改子任务日期,父任务自动重算;
- 里程碑在时间轴上显示为菱形而非横条。

### 3.3 四种依赖类型

**功能**:支持项目管理标准 4 种依赖:

| 类型                    | 含义                    | 排期影响                                  |
| ----------------------- | ----------------------- | ----------------------------------------- |
| `FS` (Finish-to-Start)  | 前置完成后,后置才能开始 | `successor.start ≥ predecessor.end`       |
| `SS` (Start-to-Start)   | 前置开始后,后置才能开始 | `successor.start ≥ predecessor.start`     |
| `FF` (Finish-to-Finish) | 前置完成后,后置才能完成 | `successor.end ≥ predecessor.end`         |
| `SF` (Start-to-Finish)  | 前置开始后,后置才能完成 | `successor.end ≥ predecessor.start`(罕见) |

每个依赖可带 `lag`(滞后/提前天数,可为负)。

**交互**:

- 从任务条右边缘拖出 → 落到目标任务,默认建 FS 依赖;
- 按住 Shift 拖 = 循环切换类型(状态栏提示当前类型);
- 单击依赖箭头选中 → Delete 删除 / 在右侧面板改类型与 lag;
- 创建依赖时检测**循环引用**,拒绝并提示。

**自动排期**:修改前置任务日期时,后置任务根据依赖类型 + lag 自动调整(可配置"自动排期"开关,默认开)。

**验收点**:

- 4 种依赖类型排期逻辑正确(用含 50+ 任务的项目核对,与手工计算一致);
- 依赖箭头渲染避开任务条交叉;
- 循环依赖被正确检测并阻断;
- lag 正负数均生效。

### 3.4 时间轴多视图与缩放

**功能**:

- 4 个时间视图:**日 / 周 / 月 / 年**(对应不同列宽与表头格式);
- Ctrl + 滚轮 = 在 4 个视图间缩放;
- 双层表头(如月视图:上层显示月份,下层显示周);
- 视图切换保持当前滚动位置(以光标处日期为锚点);
- 横向滚动条 + 拖拽空白区域平移;
- "今天"红色竖线 + 点击跳转今天按钮。

**列宽与日期映射**:每个视图有默认列宽(日=30px / 周=140px / 月=120px / 年=80px),可由用户在 settings 调整。日期↔像素映射是纯函数,有完整单测。

**验收点**:

- 4 视图切换后任务条位置与日期严格对应;
- 缩放时光标处日期保持不动(类似 Figma 缩放);
- 跨月/跨年时表头分组正确(如 2026 年 12 月 → 2027 年 1 月)。

### 3.5 中国节假日、周休、调休高亮

**功能**(本项目核心痛点之一):

- 时间轴网格按 `calendar.holidays` 高亮非工作日(浅红背景);
- 周休日(默认周六周日,可在 calendar 配置)同样高亮;
- **调休工作日**(`type: "working"`,如春节周末补班)不高亮,正常计入工作日;
- Hover 节假日列显示节假日名称 tooltip;
- **工期计算跳过非工作日**(节假日 + 周休 - 调休工作日);
- 依赖 lag 也按工作日计算;
- 设置面板可切换不同地区日历(MVP 只提供 zh-CN,但接口预留)。

**数据源**:`packages/calendar-data/calendars/zh-CN.json`,2026 全年数据(M0 填充)。每年由维护者更新。

**验收点**:

- 2026 年全部法定节假日(元旦、春节、清明、劳动节、端午、中秋、国庆)正确高亮;
- 春节/国庆调休补班日正常计入工作日(不高亮);
- 工期 = 5 工作日的任务,如果跨越 7 天含 2 天节假日,实际跨度为 7 天;
- 节假日名称 tooltip 正确显示。

### 3.6 关键路径 (Critical Path Method)

**功能**:

- 实现 CPM(Critical Path Method)算法:正向推算最早开始/结束,反向推算最晚开始/结束,总浮动时间为 0 的任务串联即为关键路径;
- 工具栏"关键路径"开关,开启后:
  - 关键路径上的任务条变红(可配置颜色);
  - 关键路径上的依赖箭头变红加粗;
  - 状态栏显示关键路径总工期;
- 关键路径随依赖/日期修改实时重算;
- 支持多个等长关键路径(全红显示)。

**这是甘特图的灵魂特性**。frappe-gantt 上游明确拒绝实现(issue #88),我们必须自研。

**验收点**:

- 在含 50+ 任务、多层级依赖的项目上,关键路径与手工计算一致;
- 修改非关键路径任务的工期(在浮动时间内),关键路径不变;
- 修改关键路径任务的工期,关键路径与总工期即时更新;
- 无依赖任务的孤立子图各算各的关键路径。

### 3.7 撤销/重做

**功能**:

- 命令模式(Command Pattern),所有结构性修改(增删改任务/依赖/日历)封装为 command;
- 撤销栈 + 重做栈,深度无限制(实际限制为内存);
- Ctrl+Z 撤销,Ctrl+Y / Ctrl+Shift+Z 重做;
- 状态栏显示可撤销/重做操作描述(如"撤销:删除任务 '设计评审'");
- 撤销栈在数据保存后不清空(用户期望保存后仍可撤销)。

**验收点**:

- 连续 50 步操作后,撤销 50 步能完全恢复初始状态;
- 重做 50 步能完全恢复最终状态;
- 撤销过程中数据完整(无字段丢失或损坏)。

### 3.8 本地持久化

**功能**:

- 数据存浏览器 IndexedDB(单数据库,每项目一记录,key = projectId);
- **自动保存**:任何修改后 debounce 500ms 自动写盘(状态栏显示"已保存");
- 应用启动时自动加载最近项目,无项目则创建空项目;
- 多项目支持:左侧项目切换器(MVP 限单设备);
- 提供手动 Ctrl+S 触发即时保存(虽自动保存,但保留心智);
- IndexedDB 不可用时降级到 localStorage(容量更小但兼容性好)。

**验收点**:

- 关闭浏览器再打开,数据 100% 恢复(任务/依赖/视图状态);
- 自动保存不影响编辑流畅度(500ms debounce 不阻塞 UI);
- IndexedDB 配额不足时给出明确错误提示。

### 3.9 文件导入导出

**功能**:

**导出**:

- 导出为 ganttly 自有 JSON 格式(`.ganttly.json`),完整数据;
- 导出为 CSV(任务表,不含图表布局信息)。

**导入**:

- 导入 ganttly JSON(校验 schemaVersion,跨版本带迁移);
- **导入 GanttProject `.gan` 文件**(核心子集),映射规则:

| GanttProject `<task>` 属性 | ganttly 字段                               |
| -------------------------- | ------------------------------------------ |
| `id`                       | `id`                                       |
| `name`                     | `name`                                     |
| `start`                    | `start`                                    |
| `duration`                 | `duration`(转工作日)                       |
| `complete`                 | `progress`                                 |
| `meeting="true"`           | `isMilestone`                              |
| `color`                    | `color`                                    |
| `notes`                    | `note`                                     |
| 嵌套 `<task>` 子元素       | 转扁平 `parentId`                          |
| `<depend id type>`         | `dependencies`(映射 type 数字→FS/SS/FF/SF) |

**导入丢弃**(P1 再说):资源分配、基线、PERT、自定义列、视图状态。

**校验**:导入失败的字段跳过并汇总报告(不阻塞整体导入)。

**验收点**:

- 导入 GanttProject 官方 [`HouseBuildingSample.gan`](https://github.com/bardsoftware/ganttproject/blob/master/ganttproject-builder/HouseBuildingSample.gan) 成功,任务树与依赖完整;
- 导出 JSON 再导入,数据完全一致(round-trip);
- 导入损坏文件给出明确错误,不崩溃。

### 3.10 完整交互清单

**任务条交互**:

- 拖拽中间 = 整体平移任务(按工作日 snap);
- 拖拽两端手柄 = 改开始/结束日期;
- 双击任务条 = 打开右侧编辑抽屉;
- 右键任务条 = 上下文菜单(编辑/删除/转里程碑/复制/剪切/粘贴);
- Hover = tooltip 显示工期/进度/前后置任务数。

**WBS 左侧表交互**:

- 行拖拽 = 排序 + 改层级;
- Tab/Shift+Tab = 升降级;
- Alt+Up/Down = 上下移动;
- Enter = 新建同级任务;
- F2 = 重命名;
- Delete = 删除(带二次确认);
- 双击单元格 = 行内编辑。

**时间轴交互**:

- Ctrl + 滚轮 = 缩放(4 视图切换);
- 拖拽空白 = 横向平移;
- "今天"按钮 = 跳转今天。

**依赖连线交互**:

- 从任务条右边缘拖出 = 建 FS 依赖;
- Shift + 拖 = 循环切换类型;
- 单击箭头 = 选中,Delete 删除。

**全局键盘**:

- Ctrl+Z / Ctrl+Y = 撤销/重做;
- Ctrl+S = 手动保存;
- Ctrl+C / Ctrl+V = 复制/粘贴任务;
- Esc = 取消选中 / 关闭面板;
- Delete = 删除选中;
- Ctrl+鼠标滚轮 = 缩放。

---

## 4. 数据模型

### 4.1 顶层结构

```typescript
interface GanttlyFile {
  schemaVersion: 1; // 显式版本号,跨版本迁移用
  project: Project;
  calendar: Calendar; // 一等公民:节假日/周休/工时
  tasks: Task[]; // 扁平数组,parentId 引用
  resources: Resource[]; // P1 预留,MVP 为 []
  baselines: Baseline[]; // P1 预留,MVP 为 []
  viewState: ViewState; // 持久化上次视图(缩放/滚动/选中)
  meta: {
    createdAt: string; // ISO datetime
    updatedAt: string;
    appVersion: string; // 生成此文件的 ganttly 版本
  };
}

interface Project {
  name: string;
  company?: string;
  manager?: string;
  startDate?: string; // ISO date,项目计划起点(参考用)
  locale: 'zh-CN' | 'en'; // 默认 zh-CN
  timezone?: string; // IANA 时区,如 'Asia/Shanghai'
}

interface Calendar {
  id: 'zh-CN' | string; // 日历区域,MVP 只支持 zh-CN
  weekStart: 0 | 1; // 0=周日,1=周一(中国习惯)
  weekends: number[]; // 周休日,如 [0, 6] = 周日+周六
  holidays: Holiday[]; // 节假日 + 调休工作日
  workingHours: { start: string; end: string }; // '09:00' / '18:00'
}

interface Holiday {
  date: string; // ISO date '2026-01-01'
  name: string; // 显示名 '元旦'
  type: 'holiday' | 'working'; // working = 调休补班
}

interface Task {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  start: string; // ISO date
  end: string; // ISO date
  duration: number; // 工作日数
  progress: number; // 0-100
  isMilestone: boolean;
  color?: string;
  note?: string;
  dependencies: Dependency[];
  constraints: object; // P1 预留
  assignments: object[]; // P1 预留
  customFields: Record<string, unknown>; // P1 预留
}

interface Dependency {
  targetId: string; // 依赖指向的任务 ID(predecessor)
  type: 'FS' | 'SS' | 'FF' | 'SF';
  lag: number; // 工作日,可负
}

interface ViewState {
  zoom: 'day' | 'week' | 'month' | 'year';
  scrollLeft: number;
  scrollTop: number;
  selectedTaskId: string | null;
  showCriticalPath: boolean;
  collapsedTaskIds: string[];
}
```

### 4.2 关键设计决策

**4.2.1 扁平 `parentId + order` 而非嵌套**

```jsonc
// ✅ 采用:扁平
"tasks": [
  { "id": "t1", "name": "需求", "parentId": null, "order": 0 },
  { "id": "t2", "name": "调研", "parentId": "t1", "order": 0 },
  { "id": "t3", "name": "PRD",  "parentId": "t1", "order": 1 }
]

// ❌ 不采用:嵌套
"tasks": [
  { "id": "t1", "name": "需求", "children": [
    { "id": "t2", "name": "调研" },
    { "id": "t3", "name": "PRD" }
  ]}
]
```

理由:拖拽任务 t3 到 t2 下方,扁平只需改 t3 的 `order` 与可能的 `parentId`(2 个字段更新);嵌套需要把 t3 从 t1.children 数组移出再插入,涉及整棵子树重写。React 渲染时由 selector 把扁平数组组装成树。

**4.2.2 `calendar` 一等公民**

节假日是本项目核心痛点,必须独立可更新。`calendar.holidays` 数组与 `tasks` 平级,更新节假日只需替换 `calendar` 对象。二期可让用户在 `packages/calendar-data/calendars/` 维护多个地区日历。

**4.2.3 显式 `schemaVersion`**

未来加字段时版本递增(1 → 2 → ...),配套写 `migrate(oldDoc, fromVersion, toVersion)` 函数。打开旧文件自动迁移。避免一次性破坏性变更。

### 4.3 JSON Schema 文件

在 `packages/schema/schema.json`(draft 2020-12)提供完整 JSON Schema,用于:

- IDE 自动补全(用户编辑 `.ganttly.json` 时);
- 导入时校验;
- 外部工具(如脚本批量生成项目)读写;
- 单测中作为 fixture 校验。

### 4.4 `.gan` 导入映射

详见 3.9 节导入映射表。`<task>` 的 `thirdDate-constraint`、`<allocations>`、`<previous>`(基线)、`<customproperty>` 在 MVP 阶段**忽略**,记入导入报告的 "skipped" 列表,P1 再支持。

---

## 5. 技术架构

### 5.1 目录结构

```
ganttly/
├── apps/
│   └── web/                         # React 前端(Vite)
│       ├── src/
│       │   ├── engine/              # Canvas 渲染引擎(核心)
│       │   │   ├── scene/           # 场景树:TaskBarNode/GridNode/ArrowNode/TodayLineNode
│       │   │   ├── render/          # Canvas 绘制器(纯函数,输入场景树 → 输出绘制)
│       │   │   ├── layout/          # dateToPixel / pixelToDate / 行高 / 列宽
│       │   │   └── interaction/     # 拖拽/缩放/连线/选中
│       │   ├── components/          # React UI 组件
│       │   │   ├── GanttCanvas/     # Canvas 容器 + DOM 叠层
│       │   │   ├── TaskTable/       # WBS 左侧表
│       │   │   ├── Toolbar/
│       │   │   ├── TaskDrawer/      # 右侧编辑抽屉
│       │   │   └── ui/              # shadcn/ui 组件
│       │   ├── store/               # Zustand store
│       │   │   ├── projectStore.ts  # 项目数据
│       │   │   ├── viewStore.ts     # 视图状态
│       │   │   └── historyStore.ts  # 撤销/重做栈
│       │   ├── data/                # 数据访问层(抽象,二期接后端)
│       │   │   ├── repository.ts    # interface ProjectRepository
│       │   │   └── indexeddb.ts     # IndexedDB 实现
│       │   ├── i18n/                # 本地化(zh-CN 必填,en 预留)
│       │   ├── lib/                 # 工具函数
│       │   │   ├── cpm.ts           # 关键路径算法
│       │   │   ├── schedule.ts      # 排期计算(依赖 + 节假日)
│       │   │   └── calendar.ts      # 工作日计算
│       │   ├── pages/
│       │   └── App.tsx
│       ├── tests/
│       │   ├── unit/                # Vitest 单测
│       │   └── e2e/                 # Playwright 截图测试
│       └── public/
├── packages/
│   ├── schema/                      # TS 类型 + JSON Schema 文件
│   │   ├── src/types.ts
│   │   ├── schema.json              # draft 2020-12
│   │   └── migrators/               # 跨版本迁移函数
│   ├── calendar-data/               # 节假日数据
│   │   └── calendars/
│   │       └── zh-CN.json           # 中国节假日(2026 起)
│   ├── gan-parser/                  # .gan XML 导入器
│   │   └── src/parser.ts
│   └── tsconfig/                    # 共享 tsconfig
├── docs/
│   ├── PRD.md                       # 本文档
│   ├── roadmap.json                 # dogfooding:ganttly 自己的开发计划
│   └── architecture.md              # 架构详解(M0 产出)
├── .github/workflows/               # CI:lint + typecheck + test + build
├── pnpm-workspace.yaml
├── package.json
├── turbo.json                       # 可选任务编排
└── README.md
```

### 5.2 Canvas 引擎分层

引擎严格分四层,每层职责单一,便于单测与替换:

```
┌─────────────────────────────────────────────┐
│ interaction/  (鼠标/键盘 → 命令)              │  产出 command 对象
├─────────────────────────────────────────────┤
│ scene/        (场景树:逻辑对象)               │  不可变快照,纯数据
├─────────────────────────────────────────────┤
│ layout/       (日期↔像素映射、行布局)          │  纯函数,有单测
├─────────────────────────────────────────────┤
│ render/       (场景树 → Canvas 绘制指令)       │  纯函数,可截图测试
└─────────────────────────────────────────────┘
```

**关键设计**:

- **场景树是不可变快照**:每次状态变化生成新场景树,React 的 `useSyncExternalStore` 订阅;
- **layout 是纯函数**:`dateToPixel(date, zoom, scrollLeft) → number`,无副作用,易测试;
- **render 是纯函数**:输入 Canvas ctx + 场景树,输出绘制结果,Playwright 截图即可回归测试;
- **虚拟化**:只绘制视口内可见的任务行 + 时间列,Canvas 自带裁剪。

### 5.3 数据访问层抽象

为二期后端预留,前端不直接调 IndexedDB:

```typescript
// packages/data/repository.ts
interface ProjectRepository {
  load(projectId: string): Promise<GanttlyFile | null>;
  save(projectId: string, file: GanttlyFile): Promise<void>;
  listProjects(): Promise<ProjectMeta[]>;
  deleteProject(projectId: string): Promise<void>;
}

// MVP 实现
class IndexedDBRepository implements ProjectRepository { ... }

// 二期实现(不在 MVP)
class RemoteRepository implements ProjectRepository { ... }
```

UI 通过 React Context 注入 Repository,MVP 注入 IndexedDBRepository,二期无缝切换。

### 5.4 状态管理 (Zustand)

三个独立 store,职责清晰:

- **`projectStore`**:任务/依赖/日历数据,所有结构性修改走 command 模式;
- **`viewStore`**:缩放/滚动/选中/折叠,UI 临时状态,不入撤销栈;
- **`historyStore`**:撤销/重做栈,订阅 projectStore 的 command 事件。

UI 组件按需订阅 store 切片,避免全量 re-render。

### 5.5 截图测试策略

- **测试工具**:Playwright + `toHaveScreenshot()`(内置像素 diff,容差可配);
- **测试矩阵**:3 平台(macOS / Windows / Linux)× 3 浏览器(Chrome / Firefox / Safari),CI 用 Playwright Docker 镜像保证一致;
- **基线截图**:提交进 Git(`tests/e2e/__screenshots__/`),变更需 PR 审查;
- **覆盖场景**:
  - 空 / 1 任务 / 100 任务 / 1000 任务渲染;
  - 4 个视图(日/周/月/年);
  - 关键路径开关;
  - 节假日高亮;
  - 暗色模式;
  - 4 种依赖类型;
  - 里程碑菱形;
  - 拖拽中状态(快照中间帧)。

### 5.6 工程化栈

| 关注点   | 选型                                                        |
| -------- | ----------------------------------------------------------- |
| 包管理   | pnpm + workspace                                            |
| 构建     | Vite 5                                                      |
| 框架     | React 18 + TypeScript 5 (strict)                            |
| UI 组件  | shadcn/ui(源码进项目)+ Tailwind CSS                         |
| 状态     | Zustand                                                     |
| i18n     | i18next + react-i18next                                     |
| 日期     | date-fns + Intl API(避免 moment)                            |
| UUID     | nanoid                                                      |
| 测试     | Vitest(单测)+ Playwright(E2E + 截图)                        |
| 代码质量 | ESLint + Prettier + TypeScript strict + TypeScript ESLint   |
| 提交规范 | Conventional Commits + commitlint + lint-staged + husky     |
| CI       | GitHub Actions(lint + typecheck + test + build + 截图 diff) |
| 部署     | GitHub Pages(MVP),二期加后端时引入 Docker                   |

---

## 6. 里程碑与任务树

5 个垂直切片里程碑。每个 M 都是**可独立 demo 的产物**,人类专家在每个 M 结束时验收。

**估算单位**:以"AI 协作会话"计,一个会话 = 一次连续协作(几小时)。AI 生成代码速度快,但架构决策、调试、截图回归仍是瓶颈。全 MVP 约 5-8 个集中会话,分散在 2-4 周。

---

### M0 — 工程地基

**目标**:空壳能起来,CI 跑通,数据 schema 与节假日数据就位。

**产出**:

- `pnpm dev` 起来看到一个空白页(带标题 "ganttly");
- `pnpm build` 产物正确;
- CI 全绿(lint + typecheck + build);
- `packages/schema` 含完整 TS 类型 + JSON Schema;
- `packages/calendar-data/calendars/zh-CN.json` 含 2026 全年节假日;
- `docs/roadmap.json` 用本 PRD 的 schema 描述 M0-M4 任务。

**子任务清单**(每条 1-3 小时):

```
[M0.1]   初始化 pnpm monorepo(pnpm-workspace.yaml + 根 package.json)
[M0.2]   创建 apps/web(Vite + React 18 + TS strict)
[M0.3]   配置 ESLint + Prettier + TypeScript ESLint + Tailwind
[M0.4]   配置 Vitest + Playwright(空测试跑通)
[M0.5]   配置 commitlint + lint-staged + husky + Conventional Commits
[M0.6]   创建 packages/schema,写 src/types.ts(第 4 章 TS 类型)
[M0.7]   创建 packages/schema/schema.json(JSON Schema draft 2020-12)
[M0.8]   创建 packages/calendar-data,填充 zh-CN.json(2026 节假日 + 调休)
[M0.9]   创建 packages/tsconfig,共享 tsconfig(base / react / node)
[M0.10]  GitHub Actions:lint + typecheck + test + build
[M0.11]  apps/web 显示标题 "ganttly" + Tailwind 暗色模式跟随系统
[M0.12]  生成 docs/roadmap.json,内容为 M0-M4 任务(用第 4 章 schema)
```

**验收信号**:

- `pnpm install && pnpm dev` 在本机能起;
- CI 在 PR 上跑通全绿;
- `zh-CN.json` 通过 `schema.json` 校验;
- `roadmap.json` 通过 `schema.json` 校验。

**估算**:1 个 AI 会话 + 1 次人类验收。

---

### M1 — 数据 + 引擎核心

**目标**:能加载 `roadmap.json` 显示一张静态甘特图。

**产出**:

- 应用启动自动加载默认项目,左侧任务表 + 右侧 Canvas 显示;
- 任务条、里程碑菱形、网格、时间轴表头正确渲染;
- 4 个时间视图可切换;
- 数据自动保存到 IndexedDB;
- 关闭重开数据完整恢复。

**子任务清单**:

```
[M1.1]   实现 packages/data/repository.ts interface
[M1.2]   实现 IndexedDBRepository(load/save/list/delete)
[M1.3]   apps/web/data/ 注入 Repository(React Context)
[M1.4]   projectStore:load/save/autosave(debounce 500ms)
[M1.5]   lib/calendar.ts:工作日计算(跳过节假日/周休,计入调休)
[M1.6]   lib/calendar.ts 单测(覆盖 2026 全年边界)
[M1.7]   engine/layout:dateToPixel / pixelToDate(4 视图)纯函数
[M1.8]   engine/layout 单测(跨月/跨年/闰年边界)
[M1.9]   engine/scene:场景树数据结构 + flatten→tree 组装
[M1.10]  engine/render:网格渲染器(节假日/周休高亮)
[M1.11]  engine/render:时间轴表头渲染器(4 视图双层表头)
[M1.12]  engine/render:任务条渲染器(进度填充 + 颜色)
[M1.13]  engine/render:里程碑菱形渲染器
[M1.14]  components/GanttCanvas:Canvas + DOM 叠层容器
[M1.15]  components/TaskTable:WBS 表只读渲染(WBS 编号 + 名称 + 日期)
[M1.16]  components/Toolbar:视图切换(日/周/月/年)+ "今天"按钮
[M1.17]  虚拟化:只渲染可见行 + 可见列
[M1.18]  Playwright 截图测试基线(空/1 任务/100 任务 × 4 视图)
[M1.19]  autosave 单测(修改后 500ms 写盘)
```

**验收信号**:

- 加载 `roadmap.json` 后看到完整 M0-M4 任务甘特图;
- 4 视图切换正确;
- 2026 节假日正确高亮;
- 关闭浏览器重开数据 100% 恢复;
- 截图测试基线通过。

**估算**:2-3 个 AI 会话 + 2 次人类验收。

---

### M2 — 编辑 + 依赖

**目标**:能完整编辑 `roadmap.json` 并保存。

**产出**:

- WBS 表完整 CRUD(Tab 升降级 / 拖拽排序 / 行内编辑);
- 任务条拖拽(平移/改日期/改工期);
- 4 种依赖 + 拖拽连线 + 箭头渲染;
- 循环依赖检测;
- 自动排期(改前置,后置联动);
- 撤销/重做 50 步不丢数据;
- 右键菜单 + 双击编辑抽屉。

**子任务清单**:

```
[M2.1]   historyStore:命令模式框架(Command interface + undo/redo 栈)
[M2.2]   实现 AddTaskCommand / DeleteTaskCommand
[M2.3]   实现 UpdateTaskCommand(字段级)
[M2.4]   实现 MoveTaskCommand(改 parentId/order)
[M2.5]   实现 AddDependencyCommand / DeleteDependencyCommand
[M2.6]   lib/schedule.ts:依赖排期算法(FS/SS/FF/SF + lag + 节假日)
[M2.7]   lib/schedule.ts:循环依赖检测(DFS)
[M2.8]   lib/schedule.ts 单测(50+ 任务项目)
[M2.9]   components/TaskTable:Tab/Shift+Tab 升降级
[M2.10]  components/TaskTable:Enter 新建同级 / F2 重命名 / Delete
[M2.11]  components/TaskTable:鼠标拖拽行排序 + 改层级
[M2.12]  components/TaskTable:行内单元格编辑
[M2.13]  engine/interaction:任务条拖拽平移(snap 到工作日)
[M2.14]  engine/interaction:任务条两端手柄拖拽(改开始/结束)
[M2.15]  engine/interaction:从任务条右边缘拖出连线
[M2.16]  engine/interaction:Shift+拖循环切换依赖类型
[M2.17]  engine/render:依赖箭头渲染(4 类型,贝塞尔曲线)
[M2.18]  engine/interaction:单击箭头选中 + Delete 删除
[M2.19]  components/TaskDrawer:右侧编辑抽屉(全部字段)
[M2.20]  components/TaskTable:右键上下文菜单
[M2.21]  store:撤销/重做键盘绑定 + 状态栏描述
[M2.22]  Playwright 截图测试:拖拽中间态、依赖箭头、右键菜单
[M2.23]  E2E:连续 50 步操作 → 撤销 50 步 → 数据完全恢复
```

**验收信号**:

- 能完整编辑 `roadmap.json`,把 M2 标记为进行中、添加子任务;
- 4 种依赖类型排期正确;
- 循环依赖被阻断;
- 撤销 50 步完整恢复。

**估算**:2-3 个 AI 会话 + 2 次人类验收。

---

### M3 — 灵魂特性:关键路径 + 节假日完善

**目标**:一个真正像样的甘特图软件。

**产出**:

- 关键路径算法(CPM)完整实现 + UI 高亮开关;
- 节假日列 tooltip;
- 工期/依赖按工作日计算(自动跳过节假日/周休,含调休补班);
- Today 红线 + 跳转;
- Ctrl+滚轮缩放(光标处日期锚定);
- 拖拽空白横向平移;
- 摘要任务自动汇总(日期 + 进度)。

**子任务清单**:

```
[M3.1]   lib/cpm.ts:正向推算(最早开始/结束)
[M3.2]   lib/cpm.ts:反向推算(最晚开始/结束)
[M3.3]   lib/cpm.ts:总浮动时间计算 + 关键路径提取
[M3.4]   lib/cpm.ts 单测(50+ 任务,与手工计算一致)
[M3.5]   lib/cpm.ts:多等长关键路径支持
[M3.6]   engine/render:关键路径高亮(红色任务条 + 红色箭头)
[M3.7]   components/Toolbar:关键路径开关
[M3.8]   lib/calendar.ts:HolidayTooltip 数据(名称 + 类型)
[M3.9]   engine/render:节假日列 hover tooltip(DOM 叠层)
[M3.10]  lib/schedule.ts:工期/依赖按工作日计算(整合 calendar)
[M3.11]  lib/schedule.ts:调休补班日正确计入工作日
[M3.12]  lib/schedule.ts 单测(春节/国庆调休边界)
[M3.13]  engine/scene:摘要任务汇总逻辑(min/max start/end + 加权 progress)
[M3.14]  engine/render:Today 红线渲染
[M3.15]  components/Toolbar:"今天"按钮跳转
[M3.16]  engine/interaction:Ctrl+滚轮缩放(光标处锚定)
[M3.17]  engine/interaction:拖拽空白横向平移
[M3.18]  Playwright 截图测试:关键路径开关、Today 线、缩放
[M3.19]  Playwright 性能测试:1000 任务滚动 60fps
```

**验收信号**:

- 关键路径在含 50+ 任务项目上正确;
- 春节/国庆调休补班日不计入节假日;
- 1000 任务滚动 60fps;
- 缩放光标处日期不动。

**估算**:2-3 个 AI 会话 + 2 次人类验收。

---

### M4 — 收尾 + dogfooding 闭环

**目标**:发布 v0.1.0。

**产出**:

- JSON 导入导出 + `.gan` 导入;
- CSV 导出;
- README + 用户文档;
- 截图测试覆盖全部关键场景;
- **用 ganttly 自身把 `docs/roadmap.json` 填满 + 标记 M0-M3 完成状态**;
- GitHub Release v0.1.0;
- GitHub Pages 部署在线 demo。

**子任务清单**:

```
[M4.1]   导出 ganttly JSON(含 schemaVersion 校验)
[M4.2]   导出 CSV(任务表)
[M4.3]   导入 ganttly JSON(schemaVersion 迁移框架)
[M4.4]   packages/gan-parser:.gan XML 解析器
[M4.5]   packages/gan-parser:任务树展平 + 依赖类型映射
[M4.6]   导入 .gan 集成到 UI(拖拽文件 + 文件选择)
[M4.7]   导入 HouseBuildingSample.gan E2E 测试
[M4.8]   round-trip 测试(导出再导入,数据一致)
[M4.9]   i18n 框架接入(i18next + react-i18next)
[M4.10]  提取 UI 字符串到 i18n/zh-CN.json
[M4.11]  i18n/en.json 占位(键值预留,翻译待补)
[M4.12]  README.md:简介 + 截图 + 快速上手
[M4.13]  docs/architecture.md:架构详解
[M4.14]  GitHub Actions:GitHub Pages 自动部署
[M4.15]  dogfooding:用 ganttly 打开 docs/roadmap.json,标记 M0-M3 完成,添加 v0.1.0 发布任务
[M4.16]  Playwright 截图测试:导入 .gan / 导出文件对话框
[M4.17]  发布 v0.1.0(GitHub Release + 在线 demo)
```

**验收信号**(对应第 7 章全部 9 条):

- 9 条验收标准全部通过;
- `roadmap.json` 显示 M0-M3 已完成、v0.1.0 发布任务已开始;
- 在线 demo 可访问。

**估算**:1-2 个 AI 会话 + 1 次最终人类验收。

---

## 7. 验收标准

MVP 发布(v0.1.0)前必须全部通过。每条可机器验证或人工核对。

### 7.1 渲染一致性

**标准**:在 macOS Retina + Windows + Linux 三平台,Chrome / Firefox / Safari 三浏览器,同一项目渲染像素一致(Playwright 截图 diff 容差 < 0.1%)。
**验证**:CI 矩阵截图测试。

### 7.2 性能

**标准**:1000 任务项目滚动 60fps,首次渲染 < 1 秒。
**验证**:Playwright 性能测试 (`await page.evaluate(() => requestAnimationFrame))` 帧率采样)。

### 7.3 中国节假日正确性

**标准**:2026 年全部法定节假日(元旦、春节、清明、劳动节、端午、中秋、国庆)正确高亮;春节/国庆调休补班日不高亮且计入工作日。
**验证**:单测覆盖全年 365 天的工作日判定 + 截图测试。

### 7.4 四种依赖类型

**标准**:FS / SS / FF / SF 四种依赖的排期逻辑,在含 50+ 任务、多层级嵌套的项目上与手工计算完全一致;lag 正负数均生效。
**验证**:单测数据驱动 + E2E 操作场景。

### 7.5 关键路径算法

**标准**:CPM 算法在含 50+ 任务的项目上与手工计算一致;修改非关键任务工期(在浮动时间内)关键路径不变;多等长关键路径全显示。
**验证**:单测覆盖经典案例(含钻石依赖图)。

### 7.6 数据持久化

**标准**:关闭浏览器再打开,数据 100% 恢复(任务/依赖/视图状态);自动保存不阻塞 UI。
**验证**:E2E 测试 + autosave 单测。

### 7.7 .gan 导入

**标准**:导入 GanttProject 官方 `HouseBuildingSample.gan` 成功,任务树与 4 种依赖完整保留;导入损坏文件给出明确错误,不崩溃。
**验证**:E2E 测试 + 单测覆盖 schema 边界。

### 7.8 撤销/重做

**标准**:连续 50 步操作(增删改任务/依赖)后,撤销 50 步能完全恢复初始状态;重做 50 步完全恢复最终状态;过程中数据完整。
**验证**:E2E 测试。

### 7.9 dogfooding 闭环(硬约束)

**标准**:本仓库 `docs/roadmap.json` 能被 ganttly 自身打开并完整维护——M0-M3 任务可标记完成,M4 任务可编辑。这是用户(作者)特别指定的硬约束。
**验证**:人工 + E2E(启动应用 → 打开 roadmap.json → 修改任务 → 保存 → 重新打开验证)。

---

## 8. 路线图(P1 / P2,不进 MVP)

### P1 — 专业特性(发布后 3-6 个月)

| 特性                            | 价值                                |
| ------------------------------- | ----------------------------------- |
| 资源分配 + 资源负载图           | 团队管理,资源冲突可视化             |
| 基线对比                        | 项目计划 vs 实际偏差                |
| 任务约束(最早开始 / 必须完成于) | 精细排期控制                        |
| 成本计算                        | 任务/资源成本汇总                   |
| 自定义列                        | 用户扩展任务字段                    |
| PDF / PNG 导出                  | 分享与汇报                          |
| 节假日云端更新                  | 自动拉取最新节假日,无需手动升级版本 |
| iCalendar (.ics) 导出           | 与日历应用同步                      |

### P2 — 长尾差异化(无明确时间)

| 特性                         | 价值                      |
| ---------------------------- | ------------------------- |
| PERT 图                      | 活动节点图视图            |
| MS Project `.mpp` 双向互操作 | 企业迁移                  |
| 挣值分析(EVM)                | 项目健康度量化            |
| 服务端账户系统 + 多设备同步  | 跨设备使用                |
| 多人实时协作(CRDT)           | 团队协同                  |
| 插件系统                     | 社区扩展                  |
| Tauri 桌面壳                 | 离线 + 系统集成(本地文件) |

---

## 9. 开放问题(列而不决)

以下问题不影响 MVP 推进,留待遇到时讨论。

### 9.1 节假日云端更新机制

MVP 用仓库内静态 JSON,每年维护者更新。但用户如何获取更新?

- (a) 升级 ganttly 版本(简单但用户可能不升级);
- (b) 二期加"从云端拉取最新节假日"选项(需后端);
- (c) 提供 `pnpm update:holidays` 脚本给自部署用户。
  **MVP 不决策**,二期再定。

### 9.2 主题切换粒度

MVP 跟随系统 `prefers-color-scheme`。是否提供手动三档(亮/暗/跟随)?

- 跟随系统对大多数用户足够;
- 但深度用户可能想强制亮色(暗色下长时间看甘特图累眼)。
  **MVP 不决策**,看 P1 用户反馈。

### 9.3 是否做插件系统

P2 候选。插件系统能让社区扩展(自定义视图、自定义导出格式),但增加架构复杂度与安全风险。
**MVP 不决策**,等核心稳定后有明确需求再做。

### 9.4 自定义视图持久化

`viewState` 是否进 `.ganttly.json` 文件?

- 进:跨设备打开看到相同视图;
- 不进:视图是用户偏好,每个设备独立。
  **MVP 决策**:进 `viewState` 字段(已在 schema 中),但部分设备相关参数(如窗口大小)不进。

---

## 附录 A — 调研参考

- [GanttProject 主仓库](https://github.com/bardsoftware/ganttproject)
- [GanttProject 本地化子模块](https://github.com/bardsoftware/biz.ganttproject.app.localization)
- [GanttProject Retina issue #1108](https://github.com/bardsoftware/ganttproject/issues/1108)
- [GanttProject HiDPI issue #1471](https://github.com/bardsoftware/ganttproject/issues/1471)
- [frappe-gantt 主仓库](https://github.com/frappe/gantt)
- [frappe-gantt 关键路径拒绝 issue #88](https://github.com/frappe/gantt/issues/88)
- [frappe-gantt 性能 issue #486](https://github.com/frappe/gantt/issues/486)
- [frappe-gantt 滚动 bug #490](https://github.com/frappe/gantt/issues/490)
- [GanttProject HouseBuildingSample.gan](https://github.com/bardsoftware/ganttproject/blob/master/ganttproject-builder/HouseBuildingSample.gan)
- [国务院办公厅节假日通知](https://www.gov.cn/zhengce/zhengceku/)(每年 11 月发布次年安排)

## 附录 B — 术语表

| 术语              | 含义                                                                               |
| ----------------- | ---------------------------------------------------------------------------------- |
| WBS               | Work Breakdown Structure,工作分解结构(任务树)                                      |
| CPM               | Critical Path Method,关键路径方法                                                  |
| FS / SS / FF / SF | Finish-to-Start / Start-to-Start / Finish-to-Finish / Start-to-Finish,四种依赖类型 |
| Lag               | 依赖滞后天数,可负(提前)                                                            |
| 调休              | 中国节假日制度中的补班工作日(如春节周末补班)                                       |
| dogfooding        | 自己用自己的产品                                                                   |
| 节假日            | 法定公共假期(元旦、春节等)                                                         |
| 周休日            | 默认周六周日,可配置                                                                |
| MVP               | Minimum Viable Product,最小可行产品                                                |
| ADR               | Architecture Decision Record,架构决策记录                                          |
