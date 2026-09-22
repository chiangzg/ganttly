# 自建部署（Self-hosting）

一台全新机器按本文档操作，即可运行属于你自己的 ganttly 实例：同源提供 Web 界面、REST API、MCP 端点、SSE 实时通知和实例发现，数据存在本地 PostgreSQL。

官方实例与自建实例运行**同一份代码、同一个镜像**；区别只在配置（spec §0/§14.2）。

---

## 前置条件

- Docker 与 Docker Compose（v2）
- 一个 OIDC 身份提供方（IdP）——如自建的 [authentik](https://goauthentik.io)、Keycloak，或任何标准 OIDC 服务
- （推荐）一个域名 + TLS 反向代理；纯 HTTP 仅建议用于可信内网

## 1. 在 IdP 创建 OIDC 应用（以 authentik 为例）

ganttly 不自建用户名/密码库，登录完全走标准 OIDC 授权码流程（spec §8.2）：

1. authentik 管理界面 → **Applications → Providers → Create → OAuth2/OpenID Connect**
2. 填写：
   - **Name**：`ganttly`
   - **Client type**：`Confidential`
   - **Redirect URIs**（Exact match）：`https://ganttly.example.com/api/v1/auth/oidc/callback`
   - **Authorization flow**：默认（implicit consent 可选）
3. 创建后记录 **Client ID** 与 **Client Secret**；Provider 详情页的 **OpenID Configuration Issuer** 就是下文的 `OIDC_ISSUER_URL`（形如 `https://auth.example.com/application/o/ganttly/`，注意结尾斜杠有无均可，服务端会归一化）
4. **Applications → Create application** 绑定该 Provider——**谁能登录 ganttly 就在这一步控制**：给应用绑定组（Group）或访问策略（Policy），不在组内的用户连授权页都进不去

其他 IdP（Keycloak 等）同理：创建 confidential OIDC 客户端、回调地址同上、记录 issuer 与凭据即可。ganttly 请求的 scope 默认为 `openid profile email`（可用 `OIDC_SCOPES` 覆盖），登录时通过发现文档（`{issuer}/.well-known/openid-configuration`）解析端点，用户身份取自 userinfo 的 `sub`/`name`/`preferred_username`/`email`。

> 回调 URL 必须与 `PUBLIC_BASE_URL` 完全一致（协议、域名、端口），否则 IdP 报 `redirect_uri_mismatch`。
>
> 历史：v0.13.0 之前 ganttly 使用 GitHub OAuth App 登录，已移除。升级部署见下文「从 GitHub 登录迁移」。

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
# GANTTLY_INSTANCE_ID/NAME、OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET、SESSION_SECRET、TOKEN_PEPPER
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
2. 点击 **登录**，跳转到你的 IdP 完成 SSO 授权，回到 ganttly 后自动创建个人工作区
3. 在本地工作区创建项目后，可通过项目卡片菜单 **复制到远端** 上传到自建实例
4. "添加远端服务"入口用于添加**其他** ganttly 实例（输入其 HTTPS 地址，经 `/.well-known/ganttly-instance` 发现校验）

### MCP 接入（AI 助手管理任务）

1. 登录后进入 **设置 → MCP 访问令牌**，创建限定工作区、勾选 `task:write` 的 PAT（明文只显示一次）
2. MCP Host（如 MCP Inspector / Claude Desktop 等）配置：
   - URL：`https://ganttly.example.com/mcp`
   - 鉴权：`Authorization: Bearer <PAT 明文>`
3. 可用工具：`list_workspaces` / `list_projects` / `get_project` / `search_tasks` / `search_resources` / `get_task` / `create_task` / `create_tasks` / `update_task` / `move_task` / `add_dependency` / `remove_dependency`

### 限制可登录用户（IdP 侧控制）

ganttly 服务端**不再内置登录白名单**：谁能登录由 IdP 决定。在 authentik 中打开 ganttly 应用 → **Policy / Group Bindings**，绑定允许使用的用户组或策略即可；未绑定的用户在 IdP 侧就会被拒绝，ganttly 数据库不落任何记录。

### 从 GitHub 登录迁移（v0.13.0）

GitHub OAuth 登录已移除，`AUTH_MODE=github` 会让服务启动失败（fail-fast，错误信息含迁移指引）。升级已有部署：

1. 按 §1 在你的 IdP 创建 OIDC 应用
2. `.env`：删除 `GITHUB_OAUTH_CLIENT_ID/SECRET`、`ALLOWED_GITHUB_USER_IDS`，改为 `AUTH_MODE=oidc` + `OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET`
3. `docker compose up -d`

**存量数据**：`users` 表按 `(provider, subject)` 区分身份，GitHub 时期的行（provider=`https://github.com`）升级后无法再登录——同一用户从 IdP 登录会创建**新用户**（provider=issuer URL）。如需把旧账号的项目"过户"给新身份，可在数据库手动改绑（按 email 匹配，需停机操作）：

```sql
-- 把 GitHub 用户的行改绑到 IdP 身份（sub 从 IdP userinfo 获取）：
UPDATE users SET provider='<你的issuer去尾斜杠>', subject='<authentik用户UUID>' WHERE email='<同一邮箱>' AND provider='https://github.com';
```

该用户旧的 PAT（MCP 令牌）与工作区归属随行保留；未改绑的 GitHub 孤儿用户不会自动清理，可按需删除（见 ops-runbook）。

### 跨域 Web 前端连接（添加远端服务）

"添加远端服务"的典型场景：Web 前端与实例**不同源**——托管在 GitHub Pages 的前端、本地 `http://localhost:5173` 开发服，或一套实例挂多个前端。这类部署必须在实例 `.env` 中把前端 origin（协议+域名+端口，精确匹配）加入 `ALLOWED_WEB_ORIGINS`，否则登录后的所有浏览器请求都会被浏览器 CORS 拦截（会话 Cookie 属凭据跨域，服务端不能返回 `*`，只能精确回显白名单内的 origin）：

```bash
# .env
ALLOWED_WEB_ORIGINS=http://localhost:5173,https://jiang.github.io
docker compose up -d   # 重启生效
```

- `/.well-known/ganttly-instance` 发现端点是公开只读元数据，服务端已对任意来源开放只读跨域，无需配置即可被"验证服务协议"（旧版本部署仍会拦截该端点的跨域读取，前端会提示"拦截了跨域响应"，升级服务端即可）
- 添加实例时前端会额外发一次带凭据的探测请求：若该 origin 不在 `ALLOWED_WEB_ORIGINS`，会明确提示"该实例未允许来自 … 的跨域访问"，而不是把实例加进去后请求全部失败
- 同源部署（server 托管 `WEB_DIST_DIR`）不涉及 CORS，`ALLOWED_WEB_ORIGINS` 留空即可（默认，最小暴露面）
- 反向代理（nginx）默认透传上游响应头，CORS 无需在代理层配置

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
- 多人使用的公网实例应在 IdP 侧限制谁能访问 ganttly 应用（见 §5「限制可登录用户」）

## 9. 验收冒烟清单（全新机器）

对应 spec §17 PR7 验收（"可登录、复制项目、MCP 建任务"）：

1. 打开 `https://<host>` 能看到 Web 界面
2. SSO（OIDC）登录成功，进入个人工作区
3. 本地项目"复制到远端"成功，远端可打开编辑
4. 创建 `task:write` PAT
5. MCP Host 用 PAT 调 `list_projects` 找到项目，`create_tasks` 建任务成功
6. Web 端开着的项目页收到 SSE，提示重新加载后可见新任务
7. 重试同一 `create_tasks`（相同 source/幂等键）不产生重复任务

## 10. 故障排查

| 症状                               | 排查                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 页面 502 / 打不开                  | `docker compose ps` 是否 healthy；`GANTTLY_PORT` 与反代后端端口是否一致                                          |
| 登录后仍是未登录                   | HTTP 部署忘了 `SESSION_COOKIE_SECURE=false`；或 HTTPS 部署反代未透传（检查 Cookie 是否被剥）                     |
| IdP 报 `redirect_uri_mismatch`     | IdP 应用的回调 URL 与 `PUBLIC_BASE_URL` 不一致（协议/域名/端口都要相同）                                         |
| 登录跳回且提示 `oidc_login_failed` | 服务端日志 `oidc discovery failed` → `OIDC_ISSUER_URL` 不可达/写错；`token endpoint returned` → 凭据或 code 问题 |
| `/health/ready` 503                | `checks.database` fail → PostgreSQL 问题；`migrations: behind/missing` → 看 `docker compose logs migrate`        |
| MCP 连接 403                       | 反代未透传 `Host` 头（`/mcp` 有 DNS-rebinding 白名单校验）                                                       |
| MCP 工具 401                       | PAT 过期/被撤销/权限不含所需 scope                                                                               |
| 改了 `.env` 不生效                 | `docker compose up -d` 重建容器（env 在容器创建时注入）                                                          |

---

更多运维细节（指标、告警阈值、outbox 维护、多进程扩展）见 [ops-runbook.md](./ops-runbook.md)。
