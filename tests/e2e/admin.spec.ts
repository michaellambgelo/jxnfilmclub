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

  test('Config tab: theater list edit round-trips to config:theaters', async ({ page }) => {
    // Seed podcast config so the tab render skips the cross-origin
    // episodes.json fetch (deterministic offline).
    await seedKv(page, 'config:podcast', JSON.stringify({ featured_id: '', episodes: [] }))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="config"]').click()

    // No override yet: defaults prefilled, badge says so.
    const rows = page.locator('#cfg-theaters-list input[data-theater]')
    await expect(rows).toHaveCount(7)
    await expect(page.locator('#cfg-theaters h3')).toContainText(/defaults/)

    await page.locator('button[data-action="cfg-theater-add"]').click()
    await rows.last().fill('E2E Added Cinema')
    await page.locator('button[data-action="cfg-theaters-save"]').click()

    await expect.poll(async () => {
      const raw = await getKv(page, 'config:theaters')
      return raw ? JSON.parse(raw) : null
    }).toContain('E2E Added Cinema')
    await expect(page.locator('#cfg-theaters h3')).toContainText(/KV override/)
  })

  test('active tab survives a reload; a stale stored tab falls back to members', async ({ page }) => {
    await page.goto(`${ADMIN_ORIGIN}/`)
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'members')

    await page.locator('#tabs button[data-tab="feedback"]').click()
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'feedback')

    await page.reload()
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'feedback')

    // A tab name that no longer exists must not wedge boot.
    await page.evaluate(() => { localStorage.jxnfc_admin_tab = 'gone-tab' })
    await page.reload()
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'members')

    // Pre-collapse auth tab names land on the merged Auth tab.
    await page.evaluate(() => { localStorage.jxnfc_admin_tab = 'sessions' })
    await page.reload()
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'auth')
  })

  test('revoke device deletes the refresh token', async ({ page }) => {
    acceptDialogs(page)
    const key = 'refresh:id-dev@e2e.test:secret123abc'
    await seedKv(page, key, JSON.stringify({ email: 'dev@e2e.test' }))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="auth"]').click()
    const row = page.locator('tr', { hasText: 'dev@e2e.test' })
    await row.getByRole('button', { name: 'revoke' }).click()

    await expect.poll(() => getKv(page, key)).toBeNull()
  })

  test('content gen builds copy + canvas from an event; private fields never render', async ({ page }) => {
    // Hosted event with the private fields that must never reach social output.
    const ev = {
      id: 'cg-e2e-screening', title: 'CG Test Night', film: 'Sherlock Jr.',
      year: 1924, date: '2030-01-15', time: '19:30', venue: 'The Parlor',
      hostId: 'id-host', hostName: 'Hosty',
      address: '456 Hidden Lane', notes: 'gate code 9999',
    }
    const res = await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: `event:${ev.id}`, value: JSON.stringify(ev) },
    })
    expect(res.ok()).toBeTruthy()

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="contentgen"]').click()

    // Copy panel: one card per platform, populated from the event.
    await expect(page.locator('.cg-copy-card')).toHaveCount(5)
    const fb = page.locator('.cg-copy-card[data-platform="facebook"] textarea')
    await expect(fb).toHaveValue(/Sherlock Jr\. \(1924\)/)
    await expect(fb).toHaveValue(/The Parlor/)

    // Private fields are nowhere in the rendered tab.
    const html = await page.locator('#content').innerHTML()
    expect(html).not.toContain('Hidden Lane')
    expect(html).not.toContain('9999')

    // Canvas renders at the selected size and follows the size switcher.
    const canvas = page.locator('#cg-canvas')
    await expect(canvas).toBeVisible()
    await expect(canvas).toHaveAttribute('width', '1080')
    await page.locator('.cg-size[data-size="fb"]').click()
    await expect(canvas).toHaveAttribute('width', '1200')
    await expect(page.getByRole('button', { name: 'Download PNG' })).toBeVisible()

    // Roundup mode swaps the event picker for the collage-size control.
    // E2E_MODE /watched is empty → the 7-day window has nothing, so the tab
    // shows the empty state instead of generating a hollow post.
    await page.locator('#cg-kind').selectOption('roundup')
    await expect(page.locator('#cg-limit')).toBeVisible()
    await expect(page.locator('#content .empty')).toHaveText(/No member watches logged in the last 7 days/)
  })
})
