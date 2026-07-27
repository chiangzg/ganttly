# ganttly v0.3.1 — 加班人天修复

> v0.3.0 多项目工作区的配套修复：把加班人天的计算口径改对——只有**显式标记的加班日**才计入人天与资源负载，不再把任务跨过的周末/节假日当作加班。

🎨 **在线 demo**:https://chiangzg.github.io/ganttly/

---

## 主要修复

### 加班人天（核心修复）

之前 `cost.ts` / `resourceLoad.ts` / `summary.ts` 的人天与负载计算直接用任务 `duration`（工作日跨度），导致任务**跨过**的周末/节假日被当作加班日重复计费，人天与资源负载普遍偏高。

引入统一的 `effectiveTaskDays(task, cal)`：工作日全部计入，非工作日**仅当**被显式列入该任务的 `overtimeDates` 时才计入。

| 模块                           | 修复内容                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **人天计算 `cost.ts`**         | `computeTaskPersonDays` / `computeAssignmentPersonDays` / `totalPersonDays` 改用 effort-day 计数，周末跨期不再虚增人天 |
| **资源负载 `resourceLoad.ts`** | 负载按 effort-day 聚合，未标记的休息日不产生负载条                                                                     |
| **汇总 `summary.ts`**          | `computeRollup` / `computeAllRollups` 接收 `ResolvedCalendar`，子任务人天向上 roll-up 时同样走 effort-day 口径         |
| **日历 `calendar.ts`**         | 新增 `effectiveTaskDays`，复用 `iterateWorkingDays` + `isNonWorkingDay`，milestone 与逆序区间返回空                    |

### 数据与交互

| 改动                    | 说明                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **schema 新增加班字段** | `Task.overtimeDates?: string[]`（可选，schema-v1 向后兼容）；`normalize.ts` 为旧文件补默认 `[]` 并清洗去重、丢弃越界/工作日           |
| **JSON Schema 校验**    | `schema.json` 增加 `overtimeDates` 定义；`validate` 与 `normalize` 各补充单测                                                         |
| **任务抽屉加班日编辑**  | `TaskDrawer` 新增加班日期添加/删除 UI，带「必填 / 必须是休息日 / 不能重复 / 必须在区间内」四类校验；改 start/end 时自动裁剪越界加班日 |
| **导出包含加班日**      | CSV 导出新增 `OvertimeDates` 列（按 `;` 拼接、升序）                                                                                  |
| **导出菜单键盘可达性**  | `ExportMenu` 的 JSON / CSV 项改为 Radix `DropdownMenu.Item`，获得键盘导航与正确 role，并在下载时保持菜单不关闭                        |
| **本地化**              | `zh-CN` / `en` 补齐加班日期相关文案                                                                                                   |

### 项目导入入口迁移

把项目导入从工具栏的「更多操作」下拉搬到**新建项目对话框**，导入即新建项目的交互更直观。

| 改动                           | 说明                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| **新增 `CreateProjectDialog`** | 「新建项目」对话框可直接输入名字创建，或通过 JSON / `.gan` 文件导入创建一个新项目        |
| **抽取 `projectImport` 模块**  | 把 JSON / GanttProject XML 的解析、校验、跳过项警告逻辑收敛到纯函数 `parseProjectImport` |
| **移除工具栏 `ImportMenu`**    | 工具栏只保留导出，简化菜单结构；全仓库已无残留引用                                       |

## 配套修复

- **Radix 菜单项处理**:导出项正确接入 DropdownMenu，修复键盘 / hover 下的选中行为。([`526cc01`](https://github.com/chiangzg/ganttly/commit/526cc01))
- **项目导入入口重构**:导入移入新建项目对话框，并抽出独立 `projectImport` 模块。([`136de31`](https://github.com/chiangzg/ganttly/commit/136de31))

## 不变项

- `GanttlyFile` 数据 schema **仍为 v1**,新增的 `overtimeDates` 为可选字段,旧版本数据可直接打开(`normalizeFile` 自动补全)。
- 服务端 API 与实时协同仍不在本期范围。

## 测试

- 单元测试:新增 `overtimeDates` 的 normalize / validate 覆盖;扩充 `cost` / `resourceLoad` 人天与负载用例;新增 `history` store 与 `projectImport` 模块单测。
- E2E:新增 `effort-constraints.spec.ts` 覆盖工期约束;重写 `import.spec.ts` 覆盖新的「新建项目 → 导入」流程(含非法 JSON 保持在对话框、可重新选择同一文件的回归用例)。
- 全套 `pnpm typecheck` / `lint` / `test` / `pnpm build` 通过。

## License

MIT © Chiang
