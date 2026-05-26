import { defineConfig, devices } from '@playwright/test'

const SITE_PORT = 8083
const WORKER_PORT = 8787

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${SITE_PORT}`,
    trace: 'retain-on-failure',
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
        '--var GITHUB_OWNER:test --var GITHUB_REPO:test',
      ].join(' '),
      port: WORKER_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
