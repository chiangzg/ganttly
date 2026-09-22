# ganttly v0.13.0 — 登录切换标准 OIDC：接入 authentik 等任意 IdP

> v0.12.0 以来 1 个 PR 的版本：服务端登录从手写 GitHub OAuth **整体切换为标准 OIDC 授权码流程**——issuer 完全由配置决定，authentik、Keycloak 等任一合规 IdP 均可接入。按既定决策，GitHub OAuth 彻底移除、服务端不再维护登录白名单，**谁能登录交由 IdP 侧的应用访问策略控制**。**⚠️ Breaking：前后端须同步升级**——新前端不兼容仅支持 GitHub 的旧服务端（反之亦然）；自建实例需在 IdP 创建应用并更换环境变量后方可启动（详见文末「升级与迁移」）。纯前端本地模式与 MCP / PAT 机制零影响。

🎨 **在线 demo**：https://chiangzg.github.io/ganttly/

---

## Breaking：GitHub OAuth → 标准 OIDC（#38）

### 动机

项目此前仅支持手写 GitHub OAuth App 登录，自建场景被绑死在 GitHub。本版本将登录整体切换为标准 OIDC 授权码流程：`OIDC_ISSUER_URL` 指向谁，就用谁登录——本次驱动场景为自建 authentik。

### 服务端

- **新增 `src/auth/oidc.ts`**：`GET {issuer}/.well-known/openid-configuration` 惰性发现 + 进程内缓存（IdP 抖动不影响启动）；授权码换 token（client_secret_post），userinfo 取 `sub` / `name` / `preferred_username` / `email`，token 用完即弃；网络层 `OidcOAuthDeps` 可注入，测试不打真 IdP
- **路由**：新增 `GET /auth/oidc` + `GET /auth/oidc/callback`；state CSRF 机制复用不变
- **账号绑定无需数据库迁移**：`users.provider` 存归一化 issuer URL（去尾斜杠）、`subject` 存 IdP 的 `sub`（authentik 为稳定 UUID）——兑现 schema 里 `(provider, subject)` 唯一约束留给 OIDC issuer 的设计伏笔；同一 IdP 账号二次登录 upsert 不重复
- **配置**：`AUTH_MODE = dev | oidc`（默认 `oidc`）；新增 `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_SCOPES`（默认 `openid profile email`）；`AUTH_MODE=github` 启动即 fail-fast 并输出迁移指引，不会静默降级
- **删除**：`auth/github.ts` 与 `ALLOWED_GITHUB_USER_IDS` 白名单（含解析、拦截门、测试与文档）

### 前端

- `login()` 跳转 `/api/v1/auth/oidc`；登录按钮「连接 GitHub」→「SSO 登录」
- 新错误码 `oidc_login_failed` / `dev_mode_no_oidc` 映射；checkAuth 三态、returnTo 回跳、devLogin 降级逻辑零改动

### 契约与兼容性

- `authProviderSchema`：`z.enum(['github'])` → `z.enum(['oidc'])`
- ⚠️ 新前端不再兼容仅 GitHub 的旧服务端，反之亦然；monorepo 前后端随本版本同步发版，混布不同版本才会踩到

### 测试与文档

- 新增 OIDC 单测 12 例（发现缓存、缺端点、token 交换 form body、无 sub 拒绝等）；重写 auth 路由测试（入口跳转 + state cookie、发现失败回弹、state mismatch 无 session、dev-session 守卫）；新增真库集成测试（建用户 + 个人工作区 + 会话，`/me` 返回 provider=issuer，二次登录 upsert 不重复）
- `self-hosting.md` §1 改为 authentik 配置指南（含通用 OIDC 说明），新增「从 GitHub 登录迁移」章节；`ops-runbook.md` 审计段改为迁移后孤儿账号 / PAT 处理；README、`.env.example`、架构图同步更新

---

## 升级与迁移（自建实例必读）

1. **IdP 侧创建应用**（以 authentik 为例）：redirect URI = `<PUBLIC_BASE_URL>/api/v1/auth/oidc/callback`，回调 URL 必须与 `PUBLIC_BASE_URL` 完全一致（协议、域名、端口），否则报 `redirect_uri_mismatch`；记录 Client ID / Client Secret，Provider 详情页的 OpenID Configuration Issuer 即 `OIDC_ISSUER_URL`（结尾斜杠有无均可，服务端会归一化）
2. **`.env` 更换**：删除 `GITHUB_OAUTH_CLIENT_ID/SECRET` 与 `ALLOWED_GITHUB_USER_IDS`，改为 `AUTH_MODE=oidc` + `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`（`SESSION_SECRET` / `TOKEN_PEPPER` 保持），随后 `docker compose up -d`
3. **存量用户改绑**：GitHub 时期的行（provider=`https://github.com`）升级后无法再登录，同一用户从 IdP 登录会创建新用户；如需把旧账号的项目过户给新身份，按 email 手动改绑（`docs/self-hosting.md` 附 SQL，需停机操作）；未改绑的孤儿用户可按需清理（见 `ops-runbook.md`）
4. **纯前端用户零影响**：本地文件模式不涉及登录；MCP / PAT 机制无变化
