import { test, expect, signInAs, WORKER_ORIGIN } from './fixtures'

// The member-facing giveaway page (/giveaways?event=), at phone size because
// most traffic arrives from Instagram. The Worker decides entries; these tests
// check the page shows them honestly and that entering is explicit and free.

const EVENT = {
  id: 'e2e-clayface', title: 'CLAYFACE Preview Screening', date: '2099-10-22', time: '20:30',
  venue: 'Capri Theater', rsvp: true, ticketed: true,
}

test.use({ viewport: { width: 390, height: 844 } })

async function seedEventAndGiveaway(page, overrides: Record<string, unknown> = {}) {
  const put = (key: string, value: string) =>
    page.request.post(`${WORKER_ORIGIN}/__test/kv`, { data: { ns: 'ATTENDANCE_KV', key, value } })
  await put(`event:${EVENT.id}`, JSON.stringify(EVENT))
  await put('events:all', JSON.stringify([EVENT]))
  const now = Date.now()
  const res = await page.request.put(`${WORKER_ORIGIN}/admin/giveaways/e2e-clay-wait`, {
    headers: { Authorization: 'Bearer e2e-admin-token' },
    data: {
      event_id: EVENT.id, title: 'Win a pair of Clayface tickets', prize: 'Two tickets to the preview',
      winners: 2, tickets_per_winner: 2, status: 'open',
      starts_at: new Date(now - 3600_000).toISOString(), ends_at: new Date(now + 86400_000).toISOString(),
      sources: { waitlist_signup: { weight: 1 }, letterboxd_link: { weight: 1 } },
      ...overrides,
    },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
}

test('an anonymous visitor sees how to enter and that it is free', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await seedEventAndGiveaway(page)
  await page.goto(`/giveaways?event=${EVENT.id}`)
  await expect(page.getByRole('heading', { name: 'CLAYFACE Preview Screening' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Win a pair of Clayface tickets' })).toBeVisible()
  await expect(page.getByText('RSVP to the screening')).toBeVisible()
  await expect(page.getByText('Link your Letterboxd profile')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Join free' })).toBeVisible()
  await expect(page.getByText(/No purchase or payment of any kind is necessary/)).toBeVisible()
  // Nothing on the page is wider than the phone.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
  expect(overflow).toBe(false)
  expect(errors).toEqual([])
})

test('a member must accept the rules, then RSVPing earns an entry', async ({ page }) => {
  await seedEventAndGiveaway(page)
  await signInAs(page, 'gw-e2e@example.com', { name: 'Gia Way' })
  await page.goto(`/giveaways?event=${EVENT.id}`)

  const enterBtn = page.getByRole('button', { name: 'Enter the giveaway' })
  await enterBtn.click()
  await expect(page.getByText('Tick the box to accept the official rules first.')).toBeVisible()

  await page.locator('.gw-accept').check()
  await enterBtn.click()
  await expect(page.getByText('entries so far')).toBeVisible()
  await expect(page.locator('.gw-total')).toHaveText('0 entries so far')

  // RSVP through the real endpoint with the page session.
  const token = await page.evaluate(() => JSON.parse(localStorage.jxnfc_session).token)
  const rsvp = await page.request.post(`${WORKER_ORIGIN}/events/${EVENT.id}/rsvp`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(rsvp.ok()).toBeTruthy()

  await page.reload()
  await expect(page.locator('.gw-total')).toHaveText('1 entry so far')
  await expect(page.locator('.gw-steps li.done')).toContainText('RSVP to the screening')
})

test('the official rules page is public', async ({ page }) => {
  await seedEventAndGiveaway(page, { rules_md: 'Sponsored by the Jackson Film Club.' })
  await page.goto(`${WORKER_ORIGIN}/giveaways/e2e-clay-wait/rules`)
  await expect(page.getByRole('heading', { name: /Official Rules/ })).toBeVisible()
  await expect(page.getByText(/NO PURCHASE OR PAYMENT OF ANY KIND IS NECESSARY/)).toBeVisible()
  await expect(page.getByText('Sponsored by the Jackson Film Club.')).toBeVisible()
})
