import { defineConfig, devices } from '@playwright/test'

const SITE_PORT = 8083
const WORKER_PORT = 8787
const LB_STUB_PORT = 8788

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
      command: `node tests/e2e/letterboxd-stub.mjs ${LB_STUB_PORT}`,
      port: LB_STUB_PORT,
      reuseExistingServer: !process.env.CI,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: [
        'cd worker && npx wrangler dev --local',
        `--port ${WORKER_PORT}`,
        `--var SITE_ORIGIN:http://localhost:${SITE_PORT}`,
        `--var LETTERBOXD_BASE:http://localhost:${LB_STUB_PORT}`,
        '--var E2E_MODE:true',
        '--var OTP_SIGNING_KEY:e2e-test-signing-key',
        '--var GITHUB_OWNER:test --var GITHUB_REPO:test',
      ].join(' '),
      port: WORKER_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
})
