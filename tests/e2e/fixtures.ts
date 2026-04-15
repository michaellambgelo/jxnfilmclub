import { test as base, expect, type Page } from '@playwright/test'

export const WORKER_ORIGIN = 'http://localhost:8787'

export async function seedKv(page: Page, key: string, value: string, ttl?: number) {
  const res = await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
    data: { key, value, ttl },
  })
  expect(res.ok()).toBeTruthy()
}

export async function readKv(page: Page, key: string): Promise<string | null> {
  // Uses the fetched __last_*__ helper keys written by the worker's E2E shims.
  // Caller is responsible for using the right sentinel key.
  const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=${encodeURIComponent(key)}`)
  if (res.status() === 404) return null
  return (await res.text()) || null
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

// Warm up the Nue dev server's bundle cache before the suite runs —
// first page load is noticeably slower than subsequent ones.
base.beforeAll(async ({ request }) => {
  await request.get('/')
  await request.get('/data/members.json')
})

export { expect }
