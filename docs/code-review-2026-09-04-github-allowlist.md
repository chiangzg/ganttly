# Code Review — GitHub 登录白名单（PR #19 / `920d3bf`）

- 日期：2026-09-04
- 工具：ocr（`--from a73a4dd --to 920d3bf`，glm-5.3，44.7 万 tokens，13m47s）
- 范围：5 个源码文件（测试 / md / env.example 按默认规则排除）
- 结论：**0 high / 1 medium**（已人工核实）+ 3 条核实为真实但影响小的 low；PR CI 已绿

## Medium（已核实为真实 bug）

### `apps/web/src/App.tsx:129` — StrictMode 双调用吞掉具体失败原因

`PostLoginRedirect` 的 effect 在 React 18 StrictMode（`main.tsx:28` 已启用）下会双调用
（setup → cleanup → setup），两个异步分支都会跑 `checkAuth`：

- 第一个分支 `consumeLoginError()` 拿到 `not_allowed` → set 具体文案；
- 第二个分支 consume 到 `null`，`loginErrorMessage(null)` 返回 `null` → `setFailedMessage(null)`
  把具体文案覆盖为通用兜底「GitHub 授权未成功，请重试。」

两个 set 的顺序与 consume 顺序一致，null 永远最后落盘 → 开发模式下必然复现。
`LoginGate.tsx:46` 已有 `if (code)` 守卫，此处照搬即可：

```tsx
const code = useAuthStore.getState().consumeLoginError();
if (code) setFailedMessage(loginErrorMessage(code));
```

仅影响开发模式（生产 StrictMode 不双调用），故定级 medium。

## Low（已核实为真实，影响小，可选修）

1. **`apps/server/src/config.ts:222`** — `/^\d+$/` 放行 `0123` 这类非规范 ID：能通过启动校验，
   但永远不等于 GitHub 规范 ID 字符串 `"123"`，静默锁死该用户——恰是该处注释声称要防的失败模式。
   建议 strip 前导零归一化，或直接拒绝非规范写法。
2. **`apps/web/src/components/workspace/LoginGate.tsx:46`** — `lastLoginError` 是全局槽而认证按实例隔离：
   `PostLoginRedirect` 成功分支（`App.tsx:131-139`）不消费残留 code，被白名单拒绝但持有存量会话的
   用户导航离开后，`not_allowed` 仍滞留，之后任何其他实例的 LoginGate 挂载都会误显
   「该实例仅允许白名单内的用户登录」。建议 `checkAuth` 成功时顺手清掉，或按 instanceId 区分。
3. **`apps/web/src/store/useAuthStore.ts:234`** — `login_error` 参数未做长度/字符校验，default 分支原样回显：
   构造链接 `?login_error=<任意文本>` 可在实例自家域名下借「登录失败」标题展示诱导文案
   （React 转义，无 XSS，仅文案注入）。可改为未知 code 一律通用文案 + 记录原始值。

## Low（核实后弃置：nitpick / 重构建议）

- `App.tsx:41` useState 惰性初始化里做副作用 —— 有意为之且注释已说明幂等性，现状安全
- `config.ts:219` CSV 解析与 `ALLOWED_WEB_ORIGINS` 重复 —— 可抽 `splitCsvEnv` 助手，纯重构
- `useAuthStore.ts:225` login_error code 字面量跨端重复 —— 可挪进 `@ganttly/api-contract`，纯重构

## 状态

- 仅评审未改动代码；修复需另行确认
- PR #19 CI 全绿（Lint/Typecheck/Build/Unit 2m17s；Playwright E2E 5m3s）
