import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test'

export const WORKER_ORIGIN = 'http://localhost:8787'
export const LB_STUB_ORIGIN = 'http://localhost:8788'

export async function seedKv(page: Page | { request: APIRequestContext }, key: string, value: string, ttl?: number) {
  const req = 'request' in page ? page.request : (page as any).request
  const res = await req.post(`${WORKER_ORIGIN}/__test/kv`, { data: { key, value, ttl } })
  expect(res.ok()).toBeTruthy()
}

export async function primeLbRss(page: Page | { request: APIRequestContext }, token: string | null) {
  const req = 'request' in page ? page.request : (page as any).request
  const res = await req.post(`${LB_STUB_ORIGIN}/__prime`, { data: { token } })
  expect(res.ok()).toBeTruthy()
}

// Wipe any KV keys under the given prefix. Needed because wrangler dev's
// Miniflare KV persists across test runs locally, so state leaks between
// test invocations when reuseExistingServer is on.
export async function wipeKv(page: Page | { request: APIRequestContext }, prefix: string) {
  const req = 'request' in page ? page.request : (page as any).request
  const res = await req.delete(`${WORKER_ORIGIN}/__test/kv?prefix=${encodeURIComponent(prefix)}`)
  expect(res.ok()).toBeTruthy()
}

// Convenience: build a signed-in localStorage session by seeding KV + flowing
// through /otp/request+verify. Returns the member id.
export async function signInAs(page: Page, email: string, memberOverrides: Record<string, unknown> = {}) {
  const member = {
    id: 'id-' + email,
    email,
    name: 'E2E Member',
    pronouns: null,
    handle: null,
    joined: '2026-04-15',
    ...memberOverrides,
  }
  await seedKv(page, `member:${email}`, JSON.stringify(member))
  await page.goto('/signin')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: /email me a code/i }).click()
  await expect(page.getByLabel('Code')).toBeVisible()
  await seedKv(page, `otp:${email}`, '424242', 600)
  await page.getByLabel('Code').fill('424242')
  await page.getByRole('button', { name: /verify/i }).click()
  await page.waitForURL('**/edit')
  return member
}

// Point auth.html's WORKER_ORIGIN at local wrangler for every page.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript((origin) => {
      // @ts-expect-error - injected into page context
      window.JXNFC_WORKER_ORIGIN = origin
    }, WORKER_ORIGIN)
    await use(page)
  },
})

base.beforeAll(async ({ request }) => {
  await request.get('/')
  await request.get('/data/members.json')
})

// Wipe all Worker KV state before every test so reused wrangler-dev
// instances don't leak pending/member/otp/lb_token entries between runs.
// In CI (fresh server), this is a no-op.
test.beforeEach(async ({ request }) => {
  for (const prefix of ['pending:', 'member:', 'otp:', 'lb_token:', 'email:', 'handle:', '__last_']) {
    await request.delete(`${WORKER_ORIGIN}/__test/kv?prefix=${encodeURIComponent(prefix)}`)
  }
})

export { expect }
