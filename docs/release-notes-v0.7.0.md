# ganttly v0.7.0 — 远端服务、自托管与 MCP 集成

> v0.6.0 之后的大版本：新增 Fastify 后端与 PostgreSQL 存储，项目可保存到远端工作区并实时同步；一份 Docker 镜像即可自托管（Web + REST API + SSE + MCP）；本地优先工作区完全不变。

🎨 **在线 demo**:https://chiangzg.github.io/ganttly/

---

## 主要特性

### 远端服务端(`apps/server`)

| 能力                 | 说明                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| **REST API v1**      | GitHub OAuth 登录、身份与工作区、项目 CRUD / 导入 / 命令 / 归档 / 回收站 |
| **SSE 实时通知**     | `/events` 端点支持断线 resume + 全量 resync,基于 outbox 的事件发布器     |
| **PAT 个人访问令牌** | 哈希存储、范围门控,令牌权限按工作区/项目端到端收窄                       |
| **MCP 端点**         | `/mcp` Streamable HTTP,11 个工具(查询 + 事务化写),外部幂等去重           |
| **生产就绪**         | 全局限流、Prometheus 指标、同源静态托管、健康/就绪与迁移状态检查         |
| **存储**             | PostgreSQL + Drizzle ORM,版本化迁移,`migrate` 独立可执行                 |

### Web 远端工作区

| 能力             | 说明                                                                          |
| ---------------- | ----------------------------------------------------------------------------- |
| **多实例注册**   | 工作区切换器添加自托管实例,经 `/.well-known/ganttly-instance` 发现文档校验    |
| **远端项目中心** | 远端工作区独立 URL(`/instances/:instance/...`),登录门禁、项目列表与操作同本地 |
| **实时同步**     | SSE 推送远端变更自动刷新,多端编辑时显示"远端已更新"横幅                       |
| **本地 → 远端**  | 一键把本地项目复制到远端工作区,viewState 与数据分离、撤销/重做不污染远端      |
| **PAT 管理**     | 设置页创建/吊销个人访问令牌,供 MCP 等外部工具鉴权                             |

### 自托管

- 多阶段 Docker 镜像 + `docker compose` 全栈(postgres / migrate / server),`.env.example` 模板
- 部署指南 [docs/self-hosting.md](self-hosting.md)(TLS、备份、升级、故障排查)与运维手册 [docs/ops-runbook.md](ops-runbook.md)

### 开发者模式

- `AUTH_MODE=dev` 零密钥启动,一键"开发登录"进入测试会话,其余链路(postgres/CRUD/SSE/MCP)完全真实
- `pnpm dev:setup` 自动准备 `.env` + postgres(容器)+ 迁移,`pnpm dev` 并行启动 web(5173)+ server(3001),`pnpm dev:down` 停库

## 缺陷修复

| 问题                               | 修复                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| **远端登录失败后本地工作区不可用** | 修复 React 子先于父的 effect 竞态导致 catalog 初始化被跳过;登录前预检实例可用性      |
| **代码评审 High 12 项**            | 契约形状错误、SSE 拆卸竞态、指标开关、批量创建幂等、依赖环防护、MCP transport 复用等 |
| **远端导航与操作**                 | 远端 scope 深链接与 URL/store 双向同步,项目操作按 ref 解析,viewState 撤销/重做仅缓存 |

## 技术实现

- 新增 `apps/server`(Fastify + Drizzle)与 `packages/api-contract`(Zod 契约,前后端共享)
- 抽取 `packages/domain`:纯函数 `applyProjectCommand` + toUndoable 包装,前端与 server 复用同一命令内核
- 单元/集成测试 600+,数据库集成测试在无 postgres 环境自动跳过,CI 零依赖可跑

## 不变项

- **本地优先**:数据默认存浏览器 IndexedDB,零后端、零运维的形态不变
- `GanttlyFile` 数据 schema **仍为 v1**
- 在线 demo 保持本地工作区形态;官方云实例尚未上线,demo 上"ganttly Cloud"入口会提示不可用(自托管实例可正常使用全部远端功能)

## License

MIT © Chiang
