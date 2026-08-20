import { test, expect, signInAs, wipeKv } from './fixtures'
import type { Page } from '@playwright/test'

const EMAIL = 'stats-e2e@example.com'

// /voice/history is unique to the stats card's fan-out — no other part of
// /edit calls it — so counting it is a clean proxy for "the card recomputed".
function countFanouts(page: Page) {
  const hits = { n: 0 }
  page.on('request', r => { if (r.url().includes('/voice/history')) hits.n++ })
  return hits
}

test.describe('account stats card', () => {
  test.beforeEach(async ({ page }) => {
    await wipeKv(page, 'member:' + EMAIL)
  })

  test('renders the tiles once the fan-out settles', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Stats Member' })

    // The gate is a positive "ready", so the pending line is what paints first.
    await expect(page.locator('.acct-stats-grid')).toBeVisible()
    await expect(page.locator('.acct-stats-pending')).toHaveCount(0)

    // This member has hosted nothing, so the Hosted tile is absent rather than
    // showing a 0 — three tiles, not four. Hosting costs time and a room, and
    // a member who has not managed it should not be shown a running tally.
    await expect(page.locator('.acct-stat')).toHaveCount(3)
    await expect(page.locator('.acct-stats-grid')).toHaveClass(/-three/)
    await expect(page.locator('.acct-stat-label', { hasText: 'Hosted' })).toHaveCount(0)

    // Voice clips is a tile now, not a meta footnote — we want every member
    // submitting one. At zero it keeps the count and wears the accent, because
    // zero is the state the tile exists to change.
    await expect(page.locator('.acct-stat-label', { hasText: 'Voice clips' })).toHaveCount(1)
    await expect(page.locator('.acct-stat-value.-nudge')).toHaveText('0')
    await expect(page.locator('.acct-stats-meta')).not.toContainText('voice')

    // Films logged is gone everywhere member-facing: it was a capped RSS window
    // (12 max), never a total, and exists only to source newsletter content.
    await expect(page.locator('.acct-stat-label', { hasText: 'Films' })).toHaveCount(0)

    // Newsletter state reads as a green/disabled chip rather than bare text.
    await expect(page.locator('.acct-pill.-off')).toHaveText('off')

  })

  // The card caches its fan-out on globalThis precisely because this handler
  // calls update() per character, which remounts the child component.
  test('typing in the delete-confirm field does not refire the fan-out', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Stats Member' })
    await expect(page.locator('.acct-stats-grid')).toBeVisible()

    const hits = countFanouts(page)
    await page.locator('input[name="confirm"]').fill('some@example.com')
    await page.waitForTimeout(500)

    expect(hits.n).toBe(0)
  })

  // ...but a real visit must recompute. edit-view.mounted() runs on an SPA
  // route change and not on an update(), which is the line the cache reset
  // is drawn along. Without the reset in mounted() this returns 0.
  test('navigating away and back recomputes the card', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Stats Member' })
    await expect(page.locator('.acct-stats-grid')).toBeVisible()

    const hits = countFanouts(page)

    await page.getByRole('link', { name: 'Members' }).click()
    await expect(page.locator('.acct-stats-grid')).toHaveCount(0)

    await page.getByRole('link', { name: 'Account Actions' }).click()
    await expect(page.locator('.acct-stats-grid')).toBeVisible()

    expect(hits.n).toBeGreaterThan(0)
  })

  // Saving does not remount the view, so mounted() never fires — the handler
  // has to drop the cache itself or the card contradicts the form below it.
  test('saving the newsletter preference refreshes the card', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Stats Member' })
    await expect(page.locator('.acct-pill.-off')).toHaveText('off')

    const hits = countFanouts(page)
    await page.getByRole('checkbox', { name: /announcements/i }).check()
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(page.locator('.acct-pill.-on')).toHaveText('on')
    expect(hits.n).toBeGreaterThan(0)
  })
})
