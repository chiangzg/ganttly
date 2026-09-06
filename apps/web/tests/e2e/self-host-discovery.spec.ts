import { expect, test, type Page } from '@playwright/test';

/**
 * Self-hosted instance onboarding (spec §2.2, PR7 E2E): adding a self-hosted
 * instance must go through `/.well-known/ganttly-instance` discovery, a
 * credentialed CORS probe against `<apiBaseUrl>/me`, and reject non-HTTPS
 * URLs, protocol-incompatible responses and duplicate instances BEFORE any
 * login flow starts.
 *
 * Discovery/probe responses are mocked with page.route — the first
 * route-mocked spec in this suite — because a real self-hosted server is not
 * available to the browser test environment. A probe `abort()` simulates the
 * browser rejecting a cross-origin response (missing Access-Control-Allow-Origin).
 */

/** A discovery document shaped exactly like a real self-hosted server's. */
function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 'ganttly-instance',
    protocolVersion: '1',
    instanceId: 'inst_selfhost_qa',
    displayName: 'Self-Host QA',
    baseUrl: 'http://localhost:9617',
    apiBaseUrl: 'http://localhost:9617/api/v1',
    webAppUrl: 'http://localhost:9617',
    mcp: { url: 'http://localhost:9617/mcp', transport: 'streamable-http', authMethods: ['pat'] },
    auth: { browserModes: ['session'], providers: ['github'] },
    events: { transport: 'sse', url: 'http://localhost:9617/api/v1/events' },
    apiVersions: ['v1'],
    minClientVersion: '0.6.0',
    features: { projectImport: true, mcp: true, sse: true, teamWorkspaces: false },
    ...overrides,
  };
}

/** Open the workspace switcher and the "添加远端服务" dialog. */
async function openAddDialog(page: Page): Promise<void> {
  // The switcher lives in the project center (VITE_E2E=1 redirects `/` into
  // the editor, where it is not rendered).
  await page.goto('/projects');
  await page.getByRole('button', { name: '本地工作区' }).click();
  await page.getByRole('menuitem', { name: '添加远端服务' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('a valid discovery document registers the self-hosted instance', async ({ page }) => {
  await page.route('**/.well-known/ganttly-instance', (route) =>
    route.fulfill({ json: descriptor() }),
  );
  // The credentialed CORS probe — a 401 response means the instance's
  // ALLOWED_WEB_ORIGINS lets this page's origin through.
  await page.route('http://localhost:9617/api/v1/me', (route) => route.fulfill({ status: 401 }));

  await openAddDialog(page);
  // Loopback over HTTP is the documented dev exception to the HTTPS rule.
  await page.getByPlaceholder('https://gan.your-company.com').fill('http://localhost:9617');
  await page.getByRole('button', { name: '添加' }).click();

  // Dialog closes on success and the instance shows up in the switcher.
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: '本地工作区' }).click();
  await expect(page.getByRole('menuitem', { name: /Self-Host QA/ })).toBeVisible();

  // Registered persistently (localStorage), keyed by the discovery instanceId.
  const stored = await page.evaluate(() => localStorage.getItem('ganttly:instances'));
  expect(stored).toContain('"id":"inst_selfhost_qa"');
  expect(stored).toContain('"kind":"custom"');
});

test('rejects a non-loopback HTTP URL before any network call', async ({ page }) => {
  let fetched = 0;
  await page.route('**/.well-known/ganttly-instance', (route) => {
    fetched++;
    return route.fulfill({ json: descriptor() });
  });

  await openAddDialog(page);
  await page.getByPlaceholder('https://gan.your-company.com').fill('http://gan.example.com');
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByText('远端服务地址必须是 HTTPS')).toBeVisible();
  expect(fetched).toBe(0);
  // Dialog stays open — no login flow starts.
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('rejects a protocol-incompatible discovery response', async ({ page }) => {
  await page.route('**/.well-known/ganttly-instance', (route) =>
    route.fulfill({ json: descriptor({ protocol: 'something-else' }) }),
  );

  await openAddDialog(page);
  await page.getByPlaceholder('https://gan.your-company.com').fill('http://localhost:9617');
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByText('服务协议不兼容或响应格式无效')).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('rejects adding when the credentialed CORS probe is blocked', async ({ page }) => {
  await page.route('**/.well-known/ganttly-instance', (route) =>
    route.fulfill({ json: descriptor() }),
  );
  // The instance is reachable but does not allowlist this page's origin —
  // the browser blocks the credentialed response and fetch rejects.
  await page.route('http://localhost:9617/api/v1/me', (route) => route.abort());

  await openAddDialog(page);
  await page.getByPlaceholder('https://gan.your-company.com').fill('http://localhost:9617');
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByText(/ALLOWED_WEB_ORIGINS/)).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('ganttly:instances'));
  expect(stored).toBeNull();
});

test('explains a reachable instance whose discovery response is CORS-blocked', async ({ page }) => {
  // Registered first (later routes win): abort everything, then override the
  // well-known URL — the CORS-mode discovery read (sec-fetch-mode: cors) is
  // aborted while the no-cors reachability probe is served, which is exactly
  // what an old ganttly server without open discovery CORS looks like.
  await page.route('http://localhost:9617/**', (route) => route.abort());
  await page.route('**/.well-known/ganttly-instance', (route) => {
    // The CORS-mode discovery read carries our Accept: application/json; the
    // no-cors reachability probe gets the browser-default Accept: */*
    // (sec-fetch-mode is not visible to route interception).
    if (route.request().headers()['accept'] === 'application/json') {
      return route.abort();
    }
    return route.fulfill({ status: 200 });
  });

  await openAddDialog(page);
  await page.getByPlaceholder('https://gan.your-company.com').fill('http://localhost:9617');
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByText(/拦截了它的跨域响应/)).toBeVisible();
  await expect(page.getByRole('dialog')).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('ganttly:instances'));
  expect(stored).toBeNull();
});

test('keeps the unreachable-URL message when the host is down', async ({ page }) => {
  await page.route('http://localhost:9617/**', (route) => route.abort());

  await openAddDialog(page);
  await page.getByPlaceholder('https://gan.your-company.com').fill('http://localhost:9617');
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByText('无法连接到该地址，请检查 URL')).toBeVisible();
});

test('rejects adding an already-registered instance', async ({ page }) => {
  await page.route('**/.well-known/ganttly-instance', (route) =>
    route.fulfill({ json: descriptor() }),
  );
  await page.route('http://localhost:9617/api/v1/me', (route) => route.fulfill({ status: 401 }));

  await openAddDialog(page);
  await page.getByPlaceholder('https://gan.your-company.com').fill('http://localhost:9617');
  await page.getByRole('button', { name: '添加' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  // Add the same instance again (same discovery instanceId).
  await page.getByRole('button', { name: '本地工作区' }).click();
  await page.getByRole('menuitem', { name: '添加远端服务' }).click();
  await page.getByPlaceholder('https://gan.your-company.com').fill('http://localhost:9617');
  await page.getByRole('button', { name: '添加' }).click();

  await expect(page.getByText('该实例已添加')).toBeVisible();
});
