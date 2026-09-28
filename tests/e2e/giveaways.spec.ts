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

// Referral tracking must survive the whole signup flow: a member's link lands
// on the giveaway page, the Join link carries ?ref= to the Worker's signup
// form, the code rides the pending row through the email-code step, and the
// referrer is credited only after the new address is verified.
test('a referral link survives signup and credits the referrer after verification', async ({ page, browser }) => {
  await seedEventAndGiveaway(page, {
    sources: { waitlist_signup: { weight: 1 }, referral: { weight: 1, cap: 5 } },
  })
  await signInAs(page, 'referrer-e2e@example.com', { name: 'Ref Errer' })
  await page.goto(`/giveaways?event=${EVENT.id}`)
  await page.locator('.gw-accept').check()
  await page.getByRole('button', { name: 'Enter the giveaway' }).click()
  const link = await page.locator('.gw-ref input').inputValue()
  expect(link).toMatch(/[?&]ref=[a-z0-9]{8}$/)
  const code = new URL(link).searchParams.get('ref')

  // A friend, in a fresh browser with no session, follows the link.
  const friendCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const friend = await friendCtx.newPage()
  await friend.addInitScript((origin) => { (window as any).JXNFC_WORKER_ORIGIN = origin }, WORKER_ORIGIN)
  const path = new URL(link).pathname + new URL(link).search
  await friend.goto(path)
  await friend.getByRole('link', { name: 'Join free' }).click()
  await friend.waitForURL(new RegExp(`ref=${code}`))

  const email = 'referred-friend@example.com'
  await friend.getByLabel('Display name').fill('Referred Friend')
  await friend.getByLabel('Email', { exact: true }).fill(email)
  await friend.getByRole('button', { name: /email me a code/i }).click()
  await friend.waitForURL(/\/verify/)

  // Not credited yet: the address is unverified.
  await page.reload()
  await expect(page.locator('.gw-ref .muted')).toContainText('0 of 5')

  const pending = JSON.parse((await (await friend.request.get(
    `${WORKER_ORIGIN}/__test/kv?key=pending:${encodeURIComponent(email)}`)).json()).value)
  expect(pending.ref).toBe(code)
  await friend.getByLabel('Code').fill(pending.code)
  await friend.getByRole('button', { name: /confirm membership/i }).click()
  await friend.waitForURL(/\/(edit|giveaways)/)

  await page.reload()
  await expect(page.locator('.gw-ref .muted')).toContainText('1 of 5')
  await expect(page.locator('.gw-total')).toHaveText('1 entry so far')
  await friendCtx.close()
})

test('an Instagram giveaway shows how to enter there, with no Enter button', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await seedEventAndGiveaway(page, {
    sources: { instagram: {
      how: 'Follow all three accounts\nTag a friend in the comments',
      post_url: 'https://www.instagram.com/p/ABC123/',
    } },
  })
  await signInAs(page, 'ig-viewer@example.com', { name: 'Ig Viewer' })
  await page.goto(`/giveaways?event=${EVENT.id}`)
  await expect(page.getByText('This one happens on Instagram')).toBeVisible()
  await expect(page.getByText('Tag a friend in the comments')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open the Instagram post' })).toHaveAttribute('href', 'https://www.instagram.com/p/ABC123/')
  await expect(page.getByRole('button', { name: 'Enter the giveaway' })).toHaveCount(0)
  expect(errors).toEqual([])
})
