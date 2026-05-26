import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test'

export const WORKER_ORIGIN = 'http://localhost:8787'

export async function seedKv(page: Page | { request: APIRequestContext }, key: string, value: string, ttl?: number) {
  const req = 'request' in page ? page.request : (page as any).request
  const res = await req.post(`${WORKER_ORIGIN}/__test/kv`, { data: { key, value, ttl } })
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
  await page.getByLabel('Email', { exact: true }).fill(email)
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
// instances don't leak pending/member/otp entries between runs.
// In CI (fresh server), this is a no-op.
test.beforeEach(async ({ request }) => {
  for (const prefix of ['pending:', 'member:', 'members:', 'otp:', 'lb_token:', 'email:', 'handle:', 'session:', 'rate:', 'revoked:', '__last_']) {
    await request.delete(`${WORKER_ORIGIN}/__test/kv?prefix=${encodeURIComponent(prefix)}`)
  }
  // ATTENDANCE_KV (separate namespace) — wipe attend:* + attendance:* +
  // event:* + events:* so anonymize / unattend / events tests don't see
  // stale entries between runs.
  for (const prefix of ['attend:', 'attendance:', 'event:', 'events:']) {
    await request.delete(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&prefix=${encodeURIComponent(prefix)}`)
  }

  // Seed the live read aggregates from the static JSON snapshots so SPA
  // tests that expect the production directory contents work the same way
  // they did when the SPA fetched /data/*.json directly. Tests that need a
  // clean state can wipe `members:all` / `events:all` themselves after this.
  const [membersRes, eventsRes] = await Promise.all([
    request.get(`http://localhost:8083/data/members.json`),
    request.get(`http://localhost:8083/data/events.json`),
  ])
  if (membersRes.ok()) {
    await request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { key: 'members:all', value: await membersRes.text() },
    })
  }
  if (eventsRes.ok()) {
    await request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: 'events:all', value: await eventsRes.text() },
    })
  }
})

export { expect }
