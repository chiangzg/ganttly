# 自建部署（Self-hosting）

一台全新机器按本文档操作，即可运行属于你自己的 ganttly 实例：同源提供 Web 界面、REST API、MCP 端点、SSE 实时通知和实例发现，数据存在本地 PostgreSQL。

官方实例与自建实例运行**同一份代码、同一个镜像**；区别只在配置（spec §0/§14.2）。

---

## 前置条件

- Docker 与 Docker Compose（v2）
- 一台 GitHub 账号可访问的机器（用于创建 OAuth App）
- （推荐）一个域名 + TLS 反向代理；纯 HTTP 仅建议用于可信内网

## 1. 创建 GitHub OAuth App

ganttly 不自建用户名/密码库，登录完全走 GitHub OAuth（spec §8.2）：

1. 打开 GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**
2. 填写：
   - **Homepage URL**：`https://ganttly.example.com`（你的实例地址）
   - **Authorization callback URL**：`https://ganttly.example.com/api/v1/auth/github/callback`
3. 创建后记录 **Client ID**，并 **Generate a new client secret** 记录 **Client Secret**

> 回调 URL 必须与 `PUBLIC_BASE_URL` 完全一致（协议、域名、端口），否则 GitHub 报 `redirect_uri_mismatch`。

## 2. 生成密钥

```bash
openssl rand -hex 16   # → POSTGRES_PASSWORD
openssl rand -hex 32   # → SESSION_SECRET（再生成一次 → TOKEN_PEPPER）
```

## 3. 配置并启动

```bash
git clone https://github.com/your-org/ganttly.git && cd ganttly
cp .env.example .env
# 编辑 .env：填入 POSTGRES_PASSWORD、PUBLIC_BASE_URL/WEB_APP_URL、
# GANTTLY_INSTANCE_ID/NAME、GitHub Client ID/Secret、SESSION_SECRET、TOKEN_PEPPER
docker compose up -d
```

`docker compose up -d` 会依次完成：构建镜像 → 启动 PostgreSQL → 运行数据库迁移（一次性 `migrate` 服务）→ 启动服务端。查看状态：

```bash
docker compose ps                 # postgres 与 server 应为 healthy
docker compose logs migrate       # 应输出 "[migrate] migrations applied successfully"
curl http://localhost:3001/health/ready
# {"status":"ok","checks":{"database":"ok","migrations":"ok"}}
```

> **纯 HTTP 内网部署**：镜像以 `NODE_ENV=production` 运行，会话 Cookie 默认带 `Secure`（仅 HTTPS 可携带）。纯 HTTP 局域网部署须在 `.env` 中设置 `SESSION_COOKIE_SECURE=false`（见 `.env.example` 注释），仅限可信网络。公网部署请务必走 HTTPS。

## 4. TLS 反向代理（推荐）

SSE 需要关闭代理缓冲（服务端已发送 `X-Accel-Buffering: no`，多数代理会遵循）。

**Caddy**（自动 HTTPS，最省事）：

```text
ganttly.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

**nginx**：

```nginx
server {
    listen 443 ssl;
    server_name ganttly.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;          # /mcp 的 DNS-rebinding 防护依赖正确的 Host
        proxy_buffering off;                  # SSE 实时推送必需
        proxy_read_timeout 3600s;             # 长连接（SSE）不被掐断
    }
}
```

配置 TLS 后，把 `.env` 中 `SESSION_COOKIE_SECURE=false` 删除（恢复默认 Secure），然后 `docker compose up -d` 生效。

## 5. 首次登录与日常使用

1. 浏览器打开 `https://ganttly.example.com` —— 自建同源部署下，Web 内置的"ganttly Cloud"入口就是本实例（它指向当前页面 origin），无需手动"添加实例"
2. 点击 **登录**，走 GitHub OAuth 授权，回到 ganttly 后自动创建个人工作区
3. 在本地工作区创建项目后，可通过项目卡片菜单 **复制到远端** 上传到自建实例
4. "添加远端服务"入口用于添加**其他** ganttly 实例（输入其 HTTPS 地址，经 `/.well-known/ganttly-instance` 发现校验）

### MCP 接入（AI 助手管理任务）

1. 登录后进入 **设置 → MCP 访问令牌**，创建限定工作区、勾选 `task:write` 的 PAT（明文只显示一次）
2. MCP Host（如 MCP Inspector / Claude Desktop 等）配置：
   - URL：`https://ganttly.example.com/mcp`
   - 鉴权：`Authorization: Bearer <PAT 明文>`
3. 可用工具：`list_workspaces` / `list_projects` / `get_project` / `search_tasks` / `get_task` / `create_task` / `create_tasks` / `update_task` / `move_task` / `add_dependency` / `remove_dependency`

## 6. 升级

```bash
git pull
docker compose up -d --build     # 重建镜像并自动执行新的迁移
```

迁移仍是显式发布步骤（`migrate` 一次性服务，spec §14.1）：`server` 只在 `migrate` 成功退出后启动。回滚代码前请先阅读对应版本的 release notes；数据库卷 `pgdata` 不受 `docker compose down` 影响（**除非**显式 `down -v`，那会删除全部数据）。

## 7. 备份与恢复

```bash
# 备份（建议 cron 每日）
docker compose exec -T postgres pg_dump -U postgres ganttly > ganttly-$(date +%F).sql

# 恢复到全新卷
docker compose down
docker volume rm ganttly_pgdata
docker compose up -d            # 重建库 + 迁移
docker compose exec -T postgres psql -U postgres ganttly < ganttly-2026-08-14.sql
```

**恢复演练必须验证**（spec §14.3）：项目 JSON 完整、revision 正确、工作区成员关系、PAT 撤销状态、outbox 事件游标。PAT 明文不可恢复——数据库中只有 hash，恢复后原有令牌继续有效。

## 8. 安全清单

- `.env` 含全部密钥：权限设为 `600`，绝不提交仓库
- 公网部署必须 HTTPS（会话 Cookie `Secure` + SameSite=Lax）
- `SESSION_COOKIE_SECURE=false` 仅限可信内网，且不要与公网混用
- `/metrics` 无鉴权：公网部署建议在反代屏蔽该路径，或 `.env` 设 `METRICS_ENABLED=false`
- `TOKEN_PEPPER` 与 `SESSION_SECRET` 不要复用同一个值；更换 pepper 会使所有 PAT 失效（需重新签发）
- 数据库仅在 compose 内网可达，未映射宿主机端口

## 9. 验收冒烟清单（全新机器）

对应 spec §17 PR7 验收（"可登录、复制项目、MCP 建任务"）：

1. 打开 `https://<host>` 能看到 Web 界面
2. GitHub 登录成功，进入个人工作区
3. 本地项目"复制到远端"成功，远端可打开编辑
4. 创建 `task:write` PAT
5. MCP Host 用 PAT 调 `list_projects` 找到项目，`create_tasks` 建任务成功
6. Web 端开着的项目页收到 SSE，提示重新加载后可见新任务
7. 重试同一 `create_tasks`（相同 source/幂等键）不产生重复任务

## 10. 故障排查

| 症状                              | 排查                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 页面 502 / 打不开                 | `docker compose ps` 是否 healthy；`GANTTLY_PORT` 与反代后端端口是否一致                                   |
| 登录后仍是未登录                  | HTTP 部署忘了 `SESSION_COOKIE_SECURE=false`；或 HTTPS 部署反代未透传（检查 Cookie 是否被剥）              |
| GitHub 报 `redirect_uri_mismatch` | OAuth App 回调 URL 与 `PUBLIC_BASE_URL` 不一致（协议/域名/端口都要相同）                                  |
| `/health/ready` 503               | `checks.database` fail → PostgreSQL 问题；`migrations: behind/missing` → 看 `docker compose logs migrate` |
| MCP 连接 403                      | 反代未透传 `Host` 头（`/mcp` 有 DNS-rebinding 白名单校验）                                                |
| MCP 工具 401                      | PAT 过期/被撤销/权限不含所需 scope                                                                        |
| 改了 `.env` 不生效                | `docker compose up -d` 重建容器（env 在容器创建时注入）                                                   |

---

更多运维细节（指标、告警阈值、outbox 维护、多进程扩展）见 [ops-runbook.md](./ops-runbook.md)。
