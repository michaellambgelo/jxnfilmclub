import { test, expect, seedKv, WORKER_ORIGIN } from './fixtures'
import type { Page } from '@playwright/test'

// Admin dashboard e2e — the SPA served by admin/server.mjs in E2E mode
// (ADMIN_E2E_WORKER_ORIGIN), so every KV op and admin proxy lands on the same
// simulated KV as the join worker under test. The hosted admin worker (Access
// JWT gate, service bindings) is deliberately NOT covered here — it can't run
// without a JWT bypass and stays covered by tests/admin-worker/.
const ADMIN_ORIGIN = 'http://localhost:5175'

async function getKv(page: Page, key: string): Promise<string | null> {
  const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=${encodeURIComponent(key)}`)
  expect(res.ok()).toBeTruthy()
  return (await res.json()).value
}

// Every admin action goes through confirm() — auto-accept.
function acceptDialogs(page: Page) {
  page.on('dialog', d => d.accept())
}

function member(email: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'id-' + email, email, name: 'Admin E2E ' + email.split('@')[0],
    pronouns: null, handle: null, newsletter: false, joined: '2026-04-15',
    ...overrides,
  }
}

test.describe('admin dashboard', () => {
  test('members tab renders rows; unlink button only where a handle exists', async ({ page }) => {
    const linked = member('linked@e2e.test', { handle: 'linkeduser' })
    const plain = member('plain@e2e.test')
    await seedKv(page, 'member:linked@e2e.test', JSON.stringify(linked))
    await seedKv(page, 'member:plain@e2e.test', JSON.stringify(plain))
    await seedKv(page, 'members:all', JSON.stringify([
      { id: linked.id, name: linked.name, joined: linked.joined, handle: 'linkeduser' },
      { id: plain.id, name: plain.name, joined: plain.joined },
    ]))

    await page.goto(`${ADMIN_ORIGIN}/`)
    const linkedRow = page.locator('#members-table tbody tr', { hasText: 'linked@e2e.test' })
    const plainRow = page.locator('#members-table tbody tr', { hasText: 'plain@e2e.test' })
    await expect(linkedRow.locator('code', { hasText: '@linkeduser' })).toBeVisible()
    await expect(linkedRow.getByRole('button', { name: 'unlink LB' })).toBeVisible()
    await expect(plainRow.getByRole('button', { name: /unlink LB|repair LB/ })).toHaveCount(0)
  })

  test('unlink LB runs the full worker cascade end-to-end', async ({ page }) => {
    acceptDialogs(page)
    const m = member('mod@e2e.test', { handle: 'modhandle' })
    await seedKv(page, 'member:mod@e2e.test', JSON.stringify(m))
    await seedKv(page, 'email:modhandle', 'mod@e2e.test')
    await seedKv(page, 'handle:mod@e2e.test', 'modhandle')
    await seedKv(page, 'lb_token:mod@e2e.test', 'tok')
    await seedKv(page, 'members:all', JSON.stringify([
      { id: m.id, name: m.name, joined: m.joined, handle: 'modhandle' },
    ]))

    await page.goto(`${ADMIN_ORIGIN}/`)
    const row = page.locator('#members-table tbody tr', { hasText: 'mod@e2e.test' })
    await row.getByRole('button', { name: 'unlink LB' }).click()

    // The tab re-renders after the cascade; the handle cell empties.
    await expect(row.locator('code', { hasText: '@modhandle' })).toHaveCount(0)

    expect(JSON.parse((await getKv(page, 'member:mod@e2e.test'))!).handle).toBeNull()
    expect(await getKv(page, 'email:modhandle')).toBeNull()
    expect(await getKv(page, 'handle:mod@e2e.test')).toBeNull()
    expect(await getKv(page, 'lb_token:mod@e2e.test')).toBeNull()

    const agg = JSON.parse((await getKv(page, 'members:all'))!)
    const aggRow = agg.find((r: { id: string }) => r.id === m.id)
    expect(aggRow).toBeTruthy()
    expect(aggRow.handle).toBeUndefined()

    const dispatch = JSON.parse((await getKv(page, '__last_dispatch__'))!)
    expect(dispatch.event_type).toBe('update-member')
    expect(dispatch.client_payload).toEqual({ id: m.id, updates: { handle: null } })
  })

  test('repair LB scrubs a stale aggregate handle when the canonical row is already unlinked', async ({ page }) => {
    acceptDialogs(page)
    const m = member('drift@e2e.test', { handle: null })
    await seedKv(page, 'member:drift@e2e.test', JSON.stringify(m))
    // The drifted state the old raw-KV admin unlink left behind.
    await seedKv(page, 'members:all', JSON.stringify([
      { id: m.id, name: m.name, joined: m.joined, handle: 'stalehandle' },
    ]))

    await page.goto(`${ADMIN_ORIGIN}/`)
    const row = page.locator('#members-table tbody tr', { hasText: 'drift@e2e.test' })
    await row.getByRole('button', { name: 'repair LB' }).click()

    await expect(row.getByRole('button', { name: 'repair LB' })).toHaveCount(0)
    const agg = JSON.parse((await getKv(page, 'members:all'))!)
    expect(agg.find((r: { id: string }) => r.id === m.id).handle).toBeUndefined()
  })

  test('evict session deletes the cached snapshot', async ({ page }) => {
    acceptDialogs(page)
    const m = member('sess@e2e.test')
    await seedKv(page, 'member:sess@e2e.test', JSON.stringify(m))
    await seedKv(page, `session:${m.id}`, JSON.stringify(m))
    await seedKv(page, 'members:all', '[]')

    await page.goto(`${ADMIN_ORIGIN}/`)
    const row = page.locator('#members-table tbody tr', { hasText: 'sess@e2e.test' })
    await row.getByRole('button', { name: 'evict session' }).click()

    await expect.poll(() => getKv(page, `session:${m.id}`)).toBeNull()
  })

  test('newsletter toggle flips the member flag and evicts the session', async ({ page }) => {
    acceptDialogs(page)
    const m = member('nl@e2e.test', { newsletter: false })
    await seedKv(page, 'member:nl@e2e.test', JSON.stringify(m))
    await seedKv(page, `session:${m.id}`, JSON.stringify(m))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="newsletter"]').click()
    const row = page.locator('#nl-table tbody tr', { hasText: 'nl@e2e.test' })
    await expect(row.locator('.pill.off')).toBeVisible()
    await row.getByRole('button', { name: 'opt in' }).click()

    await expect(row.locator('.pill.on')).toBeVisible()
    expect(JSON.parse((await getKv(page, 'member:nl@e2e.test'))!).newsletter).toBe(true)
    expect(await getKv(page, `session:${m.id}`)).toBeNull()
  })

  test('revoke device deletes the refresh token', async ({ page }) => {
    acceptDialogs(page)
    const key = 'refresh:id-dev@e2e.test:secret123abc'
    await seedKv(page, key, JSON.stringify({ email: 'dev@e2e.test' }))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="sessions"]').click()
    const row = page.locator('tr', { hasText: 'dev@e2e.test' })
    await row.getByRole('button', { name: 'revoke' }).click()

    await expect.poll(() => getKv(page, key)).toBeNull()
  })
})
