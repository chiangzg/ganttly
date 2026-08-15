#!/usr/bin/env node
/**
 * 开发者模式环境准备（`pnpm dev:setup`）— 幂等，可重复执行。
 *
 *  1. apps/server/.env 缺失时从 .env.example 复制（AUTH_MODE=dev，零密钥）。
 *  2. 探测 localhost:5432：已有 postgres（包括任何来源的容器/本机实例）直接
 *     复用；不可达则 `docker compose -f docker-compose.dev.yml up -d` 并等待就绪。
 *  3. 应用数据库迁移（pnpm --filter @ganttly/server migrate）。
 *
 * 之后 `pnpm dev` 并行启动 web(5173) + server(3001)；远端功能在工作区
 * 切换器里选 ganttly Cloud → 开发登录。停库用 `pnpm dev:down`。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, 'apps/server/.env');
const envExamplePath = path.join(root, 'apps/server/.env.example');
const PG_HOST = '127.0.0.1';
const PG_PORT = 5432;

function log(step, message) {
  console.log(`[dev:setup] ${step}: ${message}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    // Windows 上 pnpm/docker 实为 .cmd，需要 shell 解析。
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`\`${command} ${args.join(' ')}\` 退出码 ${result.status}`);
  }
}

function probePostgres(timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: PG_HOST, port: PG_PORT });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * 等待容器的 pg_isready 健康检查通过。TCP 探测不够：全新 postgres 在
 * initdb 阶段（临时 server）就接受 TCP 连接，真正就绪前会 reset 连接。
 */
async function waitForContainerHealthy() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = spawnSync(
      'docker',
      ['inspect', '--format', '{{.State.Health.Status}}', 'ganttly-dev-pg'],
      { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    if (result.status === 0 && result.stdout.trim() === 'healthy') return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('postgres 90 秒内未通过健康检查，请运行 `docker logs ganttly-dev-pg` 排查');
}

async function ensurePostgres() {
  if (await probePostgres(500)) {
    log('postgres', `localhost:${PG_PORT} 已可用，直接复用`);
    return;
  }
  log('postgres', `${PG_PORT} 不可达，启动开发专用容器（docker-compose.dev.yml）…`);
  run('docker', ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d']);
  await waitForContainerHealthy();
  log('postgres', `已就绪（localhost:${PG_PORT}，数据卷 ganttly_pg_dev_data）`);
}

async function main() {
  if (fs.existsSync(envPath)) {
    log('env', 'apps/server/.env 已存在，跳过');
  } else {
    fs.copyFileSync(envExamplePath, envPath);
    log('env', '已从 apps/server/.env.example 创建 apps/server/.env（AUTH_MODE=dev）');
  }

  await ensurePostgres();

  log('migrate', '应用数据库迁移…');
  run('pnpm', ['--filter', '@ganttly/server', 'migrate']);

  console.log('');
  console.log('[dev:setup] ✔ 开发者环境就绪');
  console.log(
    '[dev:setup]   启动: pnpm dev    → web http://localhost:5173 + server http://localhost:3001',
  );
  console.log('[dev:setup]   远端: 工作区切换器 → ganttly Cloud → 开发登录');
  console.log(
    '[dev:setup]   停库: pnpm dev:down（数据保留；清数据: docker compose -f docker-compose.dev.yml down -v）',
  );
}

main().catch((err) => {
  console.error(`[dev:setup] 失败: ${err.message}`);
  process.exit(1);
});
