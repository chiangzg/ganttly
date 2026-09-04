# ganttly 自建实例运维 Runbook

面向自建 ganttly 服务端实例（spec §15 / §17 PR7）。官方实例使用同一镜像，本文同样适用。涵盖备份恢复、可观测性、限流、SSE 反代、outbox 维护与多进程扩展。

> 配置项默认值见 `apps/server/src/config.ts`；所有 `OUTBOX_*`、`RATE_LIMIT_*`、`METRICS_ENABLED` 均可通过环境变量覆盖。

---

## 1. 备份与恢复

### 1.1 日常备份

项目真相全部存于 PostgreSQL（`projects.file_jsonb` 为完整文档，`summary_jsonb` 为查询投影）。对实例数据库做物理/逻辑备份即可：

```bash
# 逻辑备份（压缩、可跨大版本恢复）
pg_dump --format=custom --compress=9 \
  --dbname=ganttly --file=ganttly-$(date +%F).dump

# 仅校验一致性（不写入）
pg_dump --dbname=ganttly --schema-only --no-owner | psql --dbname=ganttly_check -v ON_ERROR_STOP=1
```

生产建议：WAL 归档 + 定时 `pg_basebackup`（PITR）；`pg_dump` 作为异地副本。保留策略遵循内部合规（示例：每日 ×14、每周 ×8）。

### 1.2 恢复演练（spec §15）

定期在独立环境恢复并验证以下五项，任一不一致即视为恢复失败：

1. **项目文档**：随机抽检项目的 `file_jsonb` 可被 `validateGanttlyFile` 通过，任务数与摘要一致。
2. **revision**：`projects.revision` 与 `project_operations.result_revision` 末端对齐，无回退。
3. **memberships**：`workspace_members` 行数与角色分布与备份时一致（IDOR 防线依赖此表）。
4. **PAT 撤销状态**：`personal_access_tokens.revoked_at` 保留；明文 token 不可恢复（仅存 hash+prefix），验证已撤销 token 被拒。
5. **outbox 游标**：`outbox_events` 已发布行可被 `Last-Event-ID` 续传；恢复后客户端重连不丢事件。

```bash
# 恢复到验证库
pg_restore --dbname=ganttly_restore --no-owner --clean --if-exists ganttly-YYYY-MM-DD.dump
# 跑一致性校验脚本（自建，按上述五项）
```

---

## 2. 可观测性

### 2.1 Prometheus 抓取

`GET /metrics` 暴露 Prometheus 文本格式（`METRICS_ENABLED=true`，默认开）。无鉴权，仅含聚合计数/延迟与（已公开的）`instance` 标签；如认为聚合流量数据敏感，在反代层做网络隔离。

```yaml
# prometheus.yml
scrape_configs:
  - job_name: ganttly
    scrape_interval: 15s
    static_configs:
      - targets: ['ganttly-backend:3001']
```

### 2.2 关键指标

| 指标                                      | 含义                                   | 关注点                                        |
| ----------------------------------------- | -------------------------------------- | --------------------------------------------- |
| `ganttly_http_request_duration_seconds`   | HTTP 延迟直方图（method/route/status） | p95/p99 抬升                                  |
| `ganttly_http_requests_total`             | 请求计数                               | 5xx 比例、`status="412"`（revision 冲突）突增 |
| `ganttly_rate_limited_total`              | 触发限流的请求                         | 持续增长 → 调 `RATE_LIMIT_MAX` 或查异常客户端 |
| `ganttly_auth_failures_total{kind="pat"}` | PAT 鉴权失败                           | 突增 → 可能的令牌扫描                         |
| `ganttly_mcp_tool_calls_total`            | MCP 工具调用总数                       | 结合 `/mcp` 路由的 HTTP 指标看成功率          |
| `ganttly_sse_connections`                 | 当前 SSE 连接数                        | 与并发用户量比对，异常高 → 连接泄漏           |
| `ganttly_outbox_unpublished`              | 未发布事件积压                         | 见 §3                                         |
| `ganttly_outbox_lag_seconds`              | 最老未发布事件年龄                     | 见 §3                                         |

建议 Grafana panel：HTTP p95、5xx 率、outbox 积压+延迟、SSE 连接数、限流速率。

### 2.3 告警（spec §15）

至少覆盖：

- **持续 5xx**：`rate(ganttly_http_requests_total{status=~"5.."}[5m]) > 0` 持续 2 分钟。
- **数据库不可用**：`/health/ready` 返回 503（外部黑盒探测）。
- **outbox 堆积**：`ganttly_outbox_unpublished > 1000` 或 `ganttly_outbox_lag_seconds > 60`（发布器落后或卡死）。
- **备份失败**：备份任务退出码非 0。
- **鉴权失败异常增长**：`rate(ganttly_auth_failures_total[5m])` 突增（令牌扫描/爆破）。

### 2.4 结构化日志

Pino 日志已带 `instance_id`（spec §15）与 `request.id`（响应头 `x-request-id` 与错误体 `error.requestId` 一致）。排查时用 request-id 串联日志与客户端报错。明文 token / cookie / 完整项目 JSON / 任务备注永不入日志。

### 2.5 向 OpenTelemetry 演进

当前用精简 `prom-client`（零 OTel SDK 依赖）。如需分布式 trace，部署 OTel Collector 的 `prometheus` receiver 抓取 `/metrics`，并按需在 `plugins/observability.ts` 中接入 `@opentelemetry/api` 注入 span（`httpDurationSeconds` 的 observe 点即天然 span 边界）。bus/publisher 表面稳定，仅观测层替换，不影响业务路径。

---

## 3. Outbox 维护（spec §11.2）

- 发布器每 `OUTBOX_POLL_INTERVAL_MS`（默认 250ms）用 `FOR UPDATE SKIP LOCKED` 批量取未发布事件、置 `published_at`、推送到进程内 EventBus → SSE。
- 维护循环每 `OUTBOX_MAINTENANCE_INTERVAL_MS`（默认 30s）：删除已发布且早于 `OUTBOX_RETENTION_DAYS`（默认 7 天）的行；积压超过 `OUTBOX_LAG_ALERT_THRESHOLD`（默认 1000）记 `warn` 日志。
- **单进程首版**：进程内 EventBus 仅同进程可见。多进程部署需改 `modules/events/publisher.ts`，提交后 `NOTIFY outbox`，各进程 `LISTEN outbox` 唤醒各自发布器；EventBus 表面不变，SSE 路由无需改动。
- **故障语义**：进程在 `UPDATE published_at` 后、推送前崩溃 → 行已标记发布，仅丢实时推送；客户端经 `Last-Event-ID` 重连从 outbox 补发（验收：故障注入不丢事件记录）。

---

## 4. 限流调参

全局每 IP 上限 `RATE_LIMIT_MAX`（默认 300/分钟），窗口 `RATE_LIMIT_WINDOW_SECONDS`（默认 60）。超限返回 `429 RATE_LIMITED` + `Retry-After`。

- 调高前先看 `ganttly_rate_limited_total` 是否真由正常流量触发。
- 需要对 `/auth/*` 或 `/mcp` 收紧时，在对应路由注册处加 `config: { rateLimit: { max, timeWindow } }`（`@fastify/rate-limit` 支持 route 级覆盖）。
- 多进程部署需换 Redis 后端（`@fastify/rate-limit` 的 `redisStore` 或自定义 `Store`），否则各进程独立计数。

---

## 5. SSE 反向代理

SSE 长连接需禁用代理缓冲，否则事件被攒批延迟下发：

```nginx
location /api/v1/events {
    proxy_pass http://ganttly_backend;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;          # 关键：禁用缓冲
    proxy_read_timeout 1h;        # 长连接
    proxy_cache off;
}
```

服务端已发 `X-Accel-Buffering: no`，nginx 默认遵守，但显式 `proxy_buffering off` 更稳妥。每 15s 心跳（`: heartbeat`）防止中间代理超时断连。

---

## 6. Cookie / 跨实例

- 会话 cookie 由 `@fastify/secure-session` 签发，生产 `SameSite=Lax` + `Secure` + `HttpOnly`（`config.isProduction`）。
- official 实例同源，EventSource 自动带 cookie。自建（跨源）实例：EventSource 以 `withCredentials:true` 打开，且服务端 CORS 须将该 Web origin 加入 `ALLOWED_WEB_ORIGINS` 并保持 `credentials:true`，cookie 方能跨站送达。
- 凭证不跨实例：每个实例独立签发 cookie/PAT，互不通用（spec §2.3）。

---

## 7. 升级与迁移

- **DB 迁移是显式发布步骤**：进程启动不自动迁移。发布流程：停旧版 → `pnpm --filter @ganttly/server migrate`（应用 `drizzle/*.sql`）→ 启新版。
- 迁移文件提交入库（`apps/server/drizzle/`）；`pnpm --filter @ganttly/server db:generate` 仅在改 `src/db/schema.ts` 后运行，确认无 diff 即 schema 与代码一致。
- 升级后冒烟：`/health/ready` 200 → 登录 → 列项目 → MCP `create_tasks` → Web SSE 收到刷新。

---

## 8. 登录白名单启用审计

`ALLOWED_GITHUB_USER_IDS` 只拦截新登录。对启用白名单**之前**已注册的存量用户，应做一次性核对（他们最多靠会话 Cookie 再活跃 7 天，但 PAT 不过期）：

```sql
-- 1. 列出全部用户及登录标识（provider='https://github.com' 时 subject 即 GitHub 数字 ID）
SELECT id, provider, subject, email, display_name, created_at
FROM users ORDER BY created_at;

-- 2. 找出白名单外的账号（把 12345678,87654321 换成你的白名单）
SELECT id, subject, email, display_name, created_at
FROM users
WHERE provider = 'https://github.com'
  AND subject NOT IN ('12345678', '87654321');

-- 3. 吊销上述账号的 PAT（先跑 2 核对结果，再替换 <陌生用户id 列表> 执行）
UPDATE personal_access_tokens
SET revoked_at = now()
WHERE revoked_at IS NULL
  AND user_id IN (
    SELECT id FROM users
    WHERE provider = 'https://github.com'
      AND subject NOT IN ('12345678', '87654321')
  );

-- 4. 确认无未撤销的陌生 PAT（应返回 0 行）
SELECT pat.id, pat.user_id, u.subject
FROM personal_access_tokens pat JOIN users u ON u.id = pat.user_id
WHERE pat.revoked_at IS NULL
  AND u.provider = 'https://github.com'
  AND u.subject NOT IN ('12345678', '87654321');
```

白名单外的存量用户无需删行：会话 7 天内自然失效、PAT 吊销后即不可用，其个人工作区数据保留与否可自行决定。
