# ganttly v0.4.2 — 跨版本导入兼容与人天列恒驻

> 修复跨版本导入：新版导出的项目文件在旧版本上导入会因 `additionalProperties` 严格校验整体失败。本期为导入增加前向兼容剥离，并把「人天列」从可切换开关改为恒驻显示。

🎨 **在线 demo**:https://chiangzg.github.io/ganttly/

---

## 主要特性

### 跨版本导入前向兼容（Bug 修复）

**现象**：用新版（含 `Task.overtimeDates` 等新字段）导出的 `.ganttly.json`，在旧版本 app 上导入时报错：

```
导入失败：项目数据校验失败：/tasks/0: must NOT have additional properties; /tasks/1: …
```

**根因**：数据 schema 演进是**累加式**的（新字段可选），但校验用 `additionalProperties: false` 严格模式，而导入前的 `normalizeFile` 只补缺失字段、**不剥离未知字段**。于是旧版本 app 不认识新版本导出的可选字段，直接整体拒绝。

**修复**：在 `@ganttly/schema` 的 `normalizeFile` 流水线最前端新增「未知字段剥离」阶段：

| 能力                     | 说明                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **`stripUnknownFields`** | 递归遍历文件，对照 `schema.json` 的 `$defs`，对每个 `additionalProperties:false` 的子对象只保留 `properties` 列出的键，删除其余键         |
| **不破坏现有契约**       | 只删不补默认（与补默认逻辑正交）；保持「不 mutate 输入 / 幂等 / shallow-clone」                                                           |
| **用户可见告警**         | 通过新增的 `normalizeFile` option `onStripped?: (paths: string[]) => void` 暴露被删字段路径，导入界面会提示「忽略未知字段: tasks[0].xxx」 |
| **嵌套对象覆盖**         | 递归覆盖 task / dependency / constraints / assignment / resource / baseline 等所有 strict 子对象及数组                                    |

> 注意：剥离是对照**当前 app 自己的** schema 进行。因此它能防止「比当前 app 更新的版本」导出的文件被当前 app 拒绝。若文件本就对当前版本合法，则零剥离、零告警。

### 人天列恒驻显示

把任务视图与资源视图的「人天（人日）」列从**可选开关**改为**恒驻显示**：

| 改动                       | 说明                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| **移除工具栏开关**         | 删除 `Toolbar` 中的「人天列」按钮与「更多」菜单里的勾选项；移除 `Columns3` 图标           |
| **移除 `showCostColumns`** | 从 `useViewStore` 删除该临时状态及其 setter                                               |
| **列恒驻**                 | `TaskTable` / `ResourceList` 始终渲染人天列（工期与进度之间），列宽模板与表格宽度相应固化 |
| **i18n 清理**              | 删除不再使用的 `toolbar.effortColumn` 文案（中 / 英）                                     |

## 技术实现

| 模块                              | 说明                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/schema/stripUnknown.ts` | 新增。递归剥离器：`resolveRef` 解析 `$defs`，`stripValue` 处理对象 / 数组 / 标量，变更时返回新引用、否则原样返回 |
| `packages/schema/normalize.ts`    | `normalizeFile` 最前端调用 `stripUnknownFields`，经 `onStripped` 回调上报被删字段                                |
| `packages/schema/index.ts`        | 导出 `stripUnknownFields` 及其类型                                                                               |
| `apps/web/.../projectImport.ts`   | `parseGanttlyJson` 收集被删字段，push 进现有 `result.skipped`，复用 `ProjectDialogs` 已有的 alert 告警链路       |
| `apps/web/.../Toolbar.tsx` 等     | 移除人天列开关相关代码与 i18n                                                                                    |

## 不变项

- `GanttlyFile` 数据 schema **仍为 v1**，`schemaVersion` 不变。
- `schema.json` 的 `additionalProperties: false` **保留**（它是检测真实数据错误的防线）；不启用 AJV 的 `removeAdditional`（无法告警）。
- 导出（`ExportMenu`）逻辑不变；关键路径、基线比较、视图切换、撤销 / 重做 / 保存等功能行为不变。

## 测试

- **`packages/schema`**：`normalize.test.ts` 新增 7 个用例——未知任务字段剥离、嵌套字段（dependency / assignment）剥离、`onStripped` 回调、无字段可剥时不回调、schema 合法文件 no-op、幂等、不 mutate。schema 包 32 项测试全部通过。
- **`apps/web`**：266 项单元测试全部通过；含导入路径的回归用例。
- 全套 `pnpm typecheck` / `lint` / `test` / `pnpm build` 通过。

## License

MIT © Chiang
