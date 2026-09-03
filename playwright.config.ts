import { defineConfig, devices } from '@playwright/test'

const SITE_PORT = 8083
const WORKER_PORT = 8787
// Not 5174 (the real local admin's default): reuseExistingServer is OFF for
// the admin server too, and a port clash with a developer's running admin —
// which talks to production KV via wrangler — must fail loudly, never be
// adopted.
const ADMIN_PORT = 5175

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Dot-prefixed artifact dirs: `nue serve` watches the whole project tree
  // and only ignores `.*` / `_*` / node_modules. Playwright streams trace
  // chunks + screenshots into its output dir DURING tests, and every write
  // used to trigger an HMR broadcast into the page under test — reload
  // churn, cascading failures, and ever-growing traces until Node's string
  // limit blew up. Keep every test artifact behind a dot.
  outputDir: '.test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: '.playwright-report' }]],
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${SITE_PORT}`,
    // on-first-retry, not retain-on-failure. When the local Worker wobbles the
    // failures CASCADE — a dozen tests fail in one run — and retain-on-failure
    // keeps a full trace for every one of them. That is the "ever-growing
    // traces until Node's string limit blew up" this file already warns about
    // above, and it is what a JSON.stringify OOM in the Playwright worker
    // looks like. A first-retry trace still captures anything reproducible.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      command: `npx nue serve --port ${SITE_PORT}`,
      port: SITE_PORT,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // E2E binds the *staging* env (`--env staging`) with local simulated KV
      // (`--local`), so it can never touch production data — and if `--local` is
      // ever dropped, writes land in the staging namespace, not prod.
      // reuseExistingServer is OFF: a stray `wrangler dev` left on this port
      // (e.g. a remote/prod session) must never be silently adopted — a port
      // clash should fail loudly instead of polluting another environment. This
      // is what previously leaked e2e fixtures into production KV.
      command: [
        'cd worker && npx wrangler dev --local --env staging',
        `--port ${WORKER_PORT}`,
        `--var SITE_ORIGIN:http://localhost:${SITE_PORT}`,
        '--var E2E_MODE:true',
        '--var OTP_SIGNING_KEY:e2e-test-signing-key',
        '--var ADMIN_TOKEN:e2e-admin-token',
        '--var GITHUB_OWNER:test --var GITHUB_REPO:test',
      ].join(' '),
      port: WORKER_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Admin dashboard in E2E mode: KV ops go to the join worker's
      // /__test/kv shim (shared simulated KV) instead of `wrangler kv
      // --remote`, and the admin proxies target the same local worker.
      // reuseExistingServer OFF for the same reason as the worker entry.
      command: 'node admin/server.mjs',
      env: {
        ADMIN_PORT: String(ADMIN_PORT),
        ADMIN_E2E_WORKER_ORIGIN: `http://localhost:${WORKER_PORT}`,
        ADMIN_TOKEN: 'e2e-admin-token',
      },
      port: ADMIN_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
