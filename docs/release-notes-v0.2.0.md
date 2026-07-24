# ganttly v0.2.0 — 资源视图与工期约束

> 在 MVP 的甘特排期之上,加入资源视角、人天统计与工期约束,让计划更贴近真实的人力与工期约束。

🎨 **在线 demo**:https://chiangzg.github.io/ganttly/

---

## 主要特性

### 资源视图

| 功能                   | 说明                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| **资源负载视图**       | 独立的资源负载画布(`ResourceLoadCanvas`),滚轮 / 拖拽平移,今日线,点击下钻 |
| **资源分配与人天统计** | 按资源统计分配任务与工作量(人天),直观看出谁过载、谁空闲                  |
| **本地化任务表头**     | 资源视图下钻的任务列表使用本地化表头                                     |

### 工期与成本

- **资源成本计算**:新增 `lib/cost.ts`,支持按资源计算成本。
- **工期约束(effort constraints)**:新增约束类型与配套 E2E(`effort-constraints.spec.ts`),支持更贴近真实排期的工期建模。
- **排期引擎增强**:`schedule.ts` 大幅扩展,`cpm.ts` 关键路径计算配合资源与约束。

### 体验细节

- **节假日 hover 提示**:新增 `useHolidayHover`,在画布上 hover 节假日条纹显示名称。
- **工具栏 / 状态栏** 增加资源视图入口与统计信息。

## 配套修复

- **schema**:`constraints.date` 在 `type:none` 时改为可空(nullable),修正类型约束。
- **roadmap**:回填历史数据中空 `constraints` 为 `{type:none, date:null}`。
- **样式**:修正 E2E spec 的 prettier 格式。

## 测试

- 新增 `cascade.spec.ts`(级联排期)、`effort-constraints.spec.ts`(工期约束)。
- 多张截图基线刷新(关键路径、4 种依赖、节假日 tooltip、各视图)。

## License

MIT © Chiang
