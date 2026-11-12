import { test, expect, WORKER_ORIGIN, signInAs, seedKv } from './fixtures'

// Admin-created club events: the three card modes that replaced the old
// bimodal "hosted => RSVP, curated => attendance" split. The worker unit
// tests (tests/worker/screenings.test.js) cover the RSVP/waitlist/email
// logic; this proves the SPA picks the right affordance and that a filmless
// event renders without empty slots.
//
// Seeded through KV rather than data/events.json: that file is rewritten
// wholesale from production every 6h by snapshot-events.yml, so a fixture row
// added to it would silently disappear.

const FUTURE = '2099-07-04'

// Events live in ATTENDANCE_KV, so every call passes ns explicitly — the
// shared seedKv/wipeKv helpers default to MEMBERS_KV.
//
// Both keys are written deliberately: GET /events reads the events:all
// aggregate, but POST /events/:id/rsvp reads the canonical event:{id} row.
// Seeding only the aggregate renders an RSVP button whose click 404s.
async function seedEvents(page, rows: Record<string, unknown>[]) {
  const put = (key: string, value: string) =>
    page.request.post(`${WORKER_ORIGIN}/__test/kv`, { data: { ns: 'ATTENDANCE_KV', key, value } })
  const wipe = (prefix: string) =>
    page.request.delete(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&prefix=${encodeURIComponent(prefix)}`)

  await wipe('events:')
  await wipe('event:')
  for (const row of rows) await put(`event:${row.id}`, JSON.stringify(row))
  await put('events:all', JSON.stringify(rows))
}

test.describe('club events', () => {
  test('a social event renders with no film line and still takes attendance', async ({ page }) => {
    await signInAs(page, 'social-e2e@example.com', { name: 'Social Sam' })
    await seedEvents(page, [{
      id: 'e2e-social', title: 'Drinks at Banner Hall', kind: 'social',
      date: FUTURE, venue: 'Banner Hall',
    }])

    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Drinks at Banner Hall' })
    await expect(card).toBeVisible()

    // No film => no film paragraph at all, rather than an empty one.
    await expect(card.locator('.event-film')).toHaveCount(0)
    await expect(card.locator('.event-venue')).toHaveText('Banner Hall')

    // RSVP is off by default for a row with no rsvp field, so the post-hoc
    // attendance toggle is what a signed-in member gets — worded for an
    // event that has not happened yet.
    await expect(card.locator('.event-rsvp')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'I will be there' })).toBeVisible()
    // ...and the count is worded the same way: nobody has attended yet.
    await expect(card.locator('.attendance-count')).toHaveText('0 going')
  })

  // A ticket link with no RSVP: pure funnel to the box office, no headcount.
  // (A ticket link ALONGSIDE an RSVP is the venue-ticketed flow, covered at
  // the bottom of this file — the two used to be mutually exclusive.)
  test('a ticket link with no RSVP links out and offers no RSVP block', async ({ page }) => {
    await signInAs(page, 'tix-e2e@example.com', { name: 'Ticket Tina' })
    await seedEvents(page, [{
      id: 'e2e-tix', title: 'Preview Screening', film: 'Nosferatu', year: 2024,
      date: FUTURE, venue: 'The Capri Theater',
      ticketed: true, ticketUrl: 'https://tickets.example.com/nosferatu',
    }])

    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Preview Screening' })
    const tickets = card.getByRole('link', { name: 'Get tickets' })
    await expect(tickets).toHaveAttribute('href', 'https://tickets.example.com/nosferatu')
    await expect(tickets).toHaveAttribute('target', '_blank')

    // rsvp was never set and there is no host, so the legacy fallback applies.
    await expect(card.locator('.event-rsvp')).toHaveCount(0)
  })

  test('a club event with rsvp on shows an RSVP button that actually confirms', async ({ page }) => {
    await signInAs(page, 'clubrsvp-e2e@example.com', { name: 'Rsvp Rita' })
    await seedEvents(page, [{
      id: 'e2e-club-rsvp', title: 'Members Night', film: 'Stalker', year: 1979,
      date: FUTURE, venue: 'The Capri Theater', rsvp: true, capacity: 10,
    }])

    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Members Night' })
    await expect(card.locator('.rsvp-meter')).toContainText('/ 10 RSVPed')

    // No host, so no "You're hosting" line — the plain RSVP button instead.
    await card.getByRole('button', { name: 'RSVP' }).click()
    await expect(card.locator('.rsvp-status')).toContainText(/You.re in/)

    // And the server agrees, not just the optimistic local patch.
    const res = await page.request.get(`${WORKER_ORIGIN}/events/e2e-club-rsvp/attendance`)
    expect(JSON.stringify(await res.json())).toContain('Rsvp Rita')
  })
  // Every RSVP event since they shipped had a dead end here: a member who
  // left a tab open past the one-hour token got a card with no RSVP button
  // AND no "Log in" hint. The nav still read "Account" (isSignedIn counts a
  // stored refresh token optimistically), but getSession() returned null, so
  // the cards mounted session-less and event-card skipped its /rsvp/me fetch.
  // The background refresh then set a session the card could no longer act
  // on, because a Nue child cannot repaint itself after its parent re-renders.
  test('an expired token with a remembered device still gets an RSVP button', async ({ page }) => {
    // Sign in through the real OTP flow with "remember my login" ticked —
    // signInAs() seeds a session directly and carries no refresh token, so it
    // cannot exercise this path at all.
    const email = 'lapsed-e2e@example.com'
    await seedKv(page, `member:${email}`, JSON.stringify({
      id: 'id-' + email, email, name: 'Lapsed Lou', pronouns: null, handle: null, joined: '2026-04-15',
    }))
    await page.goto('/signin')
    await page.getByLabel('Email', { exact: true }).fill(email)
    await page.getByRole('button', { name: /log in/i }).click()
    await expect(page.getByLabel('Code')).toBeVisible()
    await seedKv(page, `otp:${email}`, '424242', 600)
    await page.getByLabel('Code').fill('424242')
    await page.getByRole('checkbox', { name: /remember my login/i }).check()
    await page.getByRole('button', { name: /verify/i }).click()
    await page.waitForURL('**/edit')
    expect((await page.evaluate(() => JSON.parse(localStorage.jxnfc_session))).refresh).toBeTruthy()

    await seedEvents(page, [{
      id: 'e2e-lapsed', title: 'Members Night', film: 'Stalker', year: 1979,
      date: FUTURE, venue: 'The Capri Theater', kind: 'meetup', rsvp: true,
    }])

    // Exactly the state of a tab left open overnight: the bearer has lapsed,
    // the remembered-device token has not.
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.jxnfc_session)
      s.exp = Date.now() - 60_000
      localStorage.jxnfc_session = JSON.stringify(s)
    })

    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Members Night' })
    await expect(card.locator('.event-rsvp')).toHaveCount(1)

    // The affordance is there, and it works — not just rendered.
    await card.getByRole('button', { name: 'RSVP' }).click()
    await expect(card.locator('.rsvp-status')).toContainText(/You.re in/)

    // And it is a real RSVP server-side, not an optimistic local patch.
    const res = await page.request.get(`${WORKER_ORIGIN}/events/e2e-lapsed/attendance`)
    expect(JSON.stringify(await res.json())).toContain('Lapsed Lou')
  })

  // The other half of the same gate: a genuinely anonymous visitor must still
  // be told what to do, and must not pay for a session refresh that cannot
  // succeed.
  test('an anonymous visitor still gets the log-in hint', async ({ page }) => {
    await seedEvents(page, [{
      id: 'e2e-anon', title: 'Members Night', film: 'Stalker', year: 1979,
      date: FUTURE, venue: 'The Capri Theater', kind: 'meetup', rsvp: true,
    }])
    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Members Night' })
    // Two hints can render on a meetup (the self-organized note is the other),
    // so match the one this test is about rather than the whole set.
    await expect(card.locator('.rsvp-hint').filter({ hasText: 'to RSVP' })).toHaveCount(1)
    await expect(card.getByRole('button', { name: 'RSVP' })).toHaveCount(0)
  })
  // Venue-ticketed: the club markets the screening and funnels members to the
  // theater box office, but controls neither admission nor the door. The card
  // must never imply a seat, and before tickets are on sale there is nothing
  // to be confirmed for.
  test('a venue-ticketed event queues RSVPs until tickets go on sale', async ({ page }) => {
    await signInAs(page, 'tix-pre@example.com', { name: 'Pre Sale' })
    await seedEvents(page, [{
      id: 'e2e-pre', title: 'CLAYFACE Preview Screening', film: 'Clayface',
      date: FUTURE, venue: 'Capri Theater', rsvp: true, ticketed: true,
    }])
    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'CLAYFACE' })

    // A confirmed-attendee meter would read 0 forever while every RSVP queues,
    // so the meter counts the pre-sale list instead.
    await expect(card.locator('.rsvp-meter')).toHaveText('0 people on the pre-sale list')
    await expect(card.locator('.rsvp-hint')).toContainText('not on sale yet')

    await card.getByRole('button', { name: 'Count me in' }).click()
    await expect(card.locator('.rsvp-status')).toContainText('email you the box office link')
    // Never "you're in": nothing has been secured.
    await expect(card.locator('.rsvp-status')).not.toContainText(/You.re in/)
  })

  test('once tickets are on sale, one click opens the box office and records the RSVP', async ({ page }) => {
    await signInAs(page, 'tix-on@example.com', { name: 'On Sale' })
    await seedEvents(page, [{
      id: 'e2e-on', title: 'CLAYFACE Preview Screening', film: 'Clayface',
      date: FUTURE, venue: 'Capri Theater', rsvp: true, ticketed: true,
      ticketUrl: 'https://capri.example.com/clayface',
    }])
    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'CLAYFACE' })
    await expect(card.locator('.rsvp-hint')).toContainText('headcount, not a ticket')

    // Wrap window.open rather than stub it: the recorded argument proves where
    // the tab was aimed, and letting the call through still proves the browser
    // did not block it. Reading popup.url() alone is not enough — the fake host
    // fails to resolve and the URL becomes chrome-error before we can read it.
    await page.evaluate(() => {
      const real = window.open
      ;(window as any).__opened = []
      window.open = function (u, ...rest) { (window as any).__opened.push(u); return real.call(window, u, ...rest) }
    })

    // Hold the RSVP response open, then require the tab within a fraction of
    // that. This tests the ordering directly — the tab must not wait on the
    // POST — which is the invariant that keeps the browser from treating it as
    // an unsolicited popup. Asserting only that a popup eventually appears
    // does NOT discriminate: Chrome's transient user activation lasts about
    // five seconds, so even an await-then-open passes on a fast local server
    // while failing on a slow network.
    await page.route('**/events/e2e-on/rsvp', async (route) => {
      await new Promise(r => setTimeout(r, 4000))
      await route.continue()
    })

    const popupSoon = page.context().waitForEvent('page', { timeout: 1500 })
    await card.getByRole('button', { name: 'RSVP and get tickets' }).click()
    const popup = await popupSoon
    expect(popup).toBeTruthy()
    expect(await page.evaluate(() => (window as any).__opened)).toEqual(['https://capri.example.com/clayface'])

    await expect(card.locator('.rsvp-status')).toContainText('Your spot is not held')
    // And the box office stays reachable afterwards, beside Cancel.
    await expect(card.getByRole('link', { name: 'Get tickets' }))
      .toHaveAttribute('href', 'https://capri.example.com/clayface')

    const res = await page.request.get(`${WORKER_ORIGIN}/events/e2e-on/attendance`)
    expect(JSON.stringify(await res.json())).toContain('On Sale')
  })

  // A meetup the venue tickets: each flag owns a hint and a status line, and
  // stacking both read as three contradictory messages on one card.
  test('a ticketed meetup shows one hint and one status, not both sets', async ({ page }) => {
    await signInAs(page, 'tix-meetup@example.com', { name: 'Meetup Tix' })
    await seedEvents(page, [{
      id: 'e2e-meetup-tix', title: 'DUNE Premiere Meetup', film: 'Dune',
      kind: 'meetup', date: FUTURE, venue: 'Malco Grandview', rsvp: true,
      ticketed: true, ticketUrl: 'https://malco.example.com/dune',
    }])
    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'DUNE Premiere Meetup' })
    await expect(card.locator('.rsvp-hint')).toHaveText(
      'Self-organized — buy your ticket from Malco Grandview; the club just shows up together.')

    await card.getByRole('button', { name: 'RSVP and get tickets' }).click()
    await expect(card.locator('.rsvp-status')).toHaveText(
      'You\'re in. Get your ticket from Malco Grandview and meet us there.')
    await expect(card.locator('.rsvp-hint')).toHaveCount(1)
  })

  // Admission is an explicit admin answer. Free is only ever said about an
  // upcoming event the open internet can see, and is never inferred from the
  // absence of a ticket flag.
  test('a free event carries a Free tag on its card and on the home page; others do not', async ({ page }) => {
    await signInAs(page, 'free-e2e@example.com', { name: 'Free Fran' })
    await seedEvents(page, [
      { id: 'e2e-free', title: 'Free Night at the Capri', film: 'Paris, Texas', date: FUTURE, venue: 'Capri Theater', rsvp: true, admission: 'free' },
      { id: 'e2e-unset', title: 'Unlabelled Night', film: 'Stalker', date: '2099-07-05', venue: 'Capri Theater', rsvp: true },
      { id: 'e2e-free-house', title: 'Porch Night', film: 'Clue', kind: 'house', hostId: 'someone', hostName: 'Sam', date: '2099-07-06', rsvp: true, admission: 'free' },
      { id: 'e2e-free-past', title: 'Old Free Night', film: 'Heat', date: '2001-01-01', venue: 'Capri Theater', admission: 'free' },
    ])
    await page.goto('/events')
    const card = (title: string) => page.locator('.event-card', { hasText: title })
    await expect(card('Free Night at the Capri').locator('.event-free')).toHaveText('Free')
    await expect(card('Unlabelled Night')).toBeVisible()
    await expect(card('Unlabelled Night').locator('.event-free')).toHaveCount(0)
    await expect(card('Porch Night')).toBeVisible()
    await expect(card('Porch Night').locator('.event-free')).toHaveCount(0)
    await expect(card('Old Free Night')).toBeVisible()
    await expect(card('Old Free Night').locator('.event-free')).toHaveCount(0)

    await page.goto('/')
    const row = (film: string) => page.locator('.program-row', { hasText: film })
    await expect(row('Paris, Texas').locator('.program-tag.-free')).toBeVisible()
    await expect(row('Stalker')).toBeVisible()
    await expect(row('Stalker').locator('.program-tag.-free')).toBeHidden()
  })

  test('a free meetup drops the buy-your-own copy; a self-organized club night gains it', async ({ page }) => {
    await signInAs(page, 'adm-e2e@example.com', { name: 'Admission Ada' })
    await seedEvents(page, [
      { id: 'e2e-free-meetup', title: 'Free Meetup', film: 'Tampopo', kind: 'meetup', date: FUTURE, venue: 'Malco Grandview', rsvp: true, admission: 'free' },
      { id: 'e2e-own-club', title: 'Own Ticket Night', film: 'Ran', date: '2099-07-05', venue: 'Capri Theater', rsvp: true, admission: 'own' },
      { id: 'e2e-legacy-meetup', title: 'Legacy Meetup', film: 'Ikiru', kind: 'meetup', date: '2099-07-06', venue: 'Malco Grandview', rsvp: true },
    ])
    await page.goto('/events')
    const card = (title: string) => page.locator('.event-card', { hasText: title })
    const selfOrg = 'Self-organized — buy your own ticket; the club just shows up together.'

    const free = card('Free Meetup')
    await expect(free.locator('.event-free')).toHaveText('Free')
    await expect(free.locator('.rsvp-hint')).toHaveCount(0)
    await free.getByRole('button', { name: 'RSVP', exact: true }).click()
    await expect(free.locator('.rsvp-status')).toHaveText('You\'re in. Check your email for the details.')

    const own = card('Own Ticket Night')
    await expect(own.locator('.rsvp-hint')).toHaveText(selfOrg)
    await own.getByRole('button', { name: 'RSVP', exact: true }).click()
    await expect(own.locator('.rsvp-status')).toHaveText('You\'re in. Meet at Capri Theater — get your own ticket.')

    // A meetup that predates the field reads exactly as it always did.
    await expect(card('Legacy Meetup').locator('.rsvp-hint')).toHaveText(selfOrg)
  })

  // /events?event=ID: the shareable per-event link (docs/features/link-previews.md).
  test('an event link outlines that card, and Copy link copies it', async ({ page, context }) => {
    const rows = []
    for (let i = 1; i <= 12; i++) {
      rows.push({ id: `2099-07-${String(i).padStart(2, '0')}-e2e-film-${i}`, title: `Film Night ${i}`, kind: 'meetup', date: `2099-07-${String(i).padStart(2, '0')}`, venue: 'Malco Grandview' })
    }
    rows.push({ id: '2099-08-01-e2e-house', title: 'Private House Night', kind: 'house', hostId: 'someone', date: '2099-08-01', venue: 'A house' })
    await seedEvents(page, rows)

    // Newest first, so Film Night 1 sits at the bottom of the list.
    await page.goto('/events?event=2099-07-01-e2e-film-1')
    const card = page.locator('#event-2099-07-01-e2e-film-1')
    await expect(card).toHaveClass(/-target/)
    await expect(card).toBeInViewport()
    await expect(page.locator('.event-card.-target')).toHaveCount(1)

    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const share = card.locator('.event-share')
    await share.click()
    await expect(share).toHaveText('Link copied')
    expect(await page.evaluate(() => navigator.clipboard.readText()))
      .toBe(new URL('/events?event=2099-07-01-e2e-film-1', page.url()).href)

    // Signed out, a house screening link just shows the public list.
    await page.goto('/events?event=2099-08-01-e2e-house')
    await expect(page.locator('.event-card')).toHaveCount(12)
    await expect(page.locator('.event-card.-target')).toHaveCount(0)
  })
})

// Waitlists are public and numbered, like the RSVP list beside them: a member
// who asked to be listed can see where they stand, and a visitor can see that
// others are already waiting.
test.describe('waitlists on the card', () => {
  const presale = {
    id: 'e2e-presale-list', title: 'Presale List Preview', film: 'Clayface',
    date: FUTURE, venue: 'Capri Theater', rsvp: true, ticketed: true,
  }
  const full = {
    id: 'e2e-full-list', title: 'Full House Night', date: FUTURE, venue: 'Capri Theater', rsvp: true, capacity: 1,
  }
  const putAtt = (page, key: string, value: unknown) =>
    page.request.post(`${WORKER_ORIGIN}/__test/kv`, { data: { ns: 'ATTENDANCE_KV', key, value: JSON.stringify(value) } })
  const person = (n: number, name = `Queued ${n}`) => ({ memberId: `q${n}`, name, email: `q${n}@example.com`, at: n })
  const seedQueue = (page, waitlist: Record<string, unknown>[]) =>
    putAtt(page, `rsvp:${presale.id}`, { confirmed: [], waitlist })
  // A full event: one confirmed seat taken, the rest waiting.
  async function seedFull(page, waitlist: Record<string, unknown>[]) {
    const seat = person(9, 'Seated Sam')
    await putAtt(page, `rsvp:${full.id}`, { confirmed: [seat], waitlist })
    await putAtt(page, `attend:${full.id}`, [{ id: seat.memberId, name: seat.name }])
    await putAtt(page, 'attendance:all', { [full.id]: [{ id: seat.memberId, name: seat.name }] })
  }
  const names = (card) => card.locator('.waiting-list .attendee')

  test('a signed-out visitor sees who is on a pre-sale list, in order', async ({ page }) => {
    await seedEvents(page, [presale])
    await seedQueue(page, [person(1), person(2)])
    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Presale List Preview' })
    await expect(card.locator('.presale-meter')).toHaveText('2 people on the pre-sale list')
    await expect(names(card)).toHaveText(['1. Queued 1', '2. Queued 2'])
    // They are on a list, not attending: the attendance block stays empty.
    await expect(card.locator('.event-attendance .attendee')).toHaveCount(0)
    await expect(card).not.toContainText('@example.com')
  })

  test('joining an empty pre-sale list and leaving it again both repaint the card', async ({ page }) => {
    await signInAs(page, 'presale-list-e2e@example.com', { name: 'Paula Presale' })
    await seedEvents(page, [presale])
    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Presale List Preview' })
    await expect(card.locator('.presale-meter')).toHaveText('0 people on the pre-sale list')
    await expect(card.locator('.waiting-list')).toHaveCount(0)

    await card.getByRole('button', { name: 'Count me in' }).click()
    await expect(card.locator('.presale-meter')).toHaveText('1 person on the pre-sale list')
    await expect(names(card)).toHaveText(['1. Paula Presale'])
    await expect(card.locator('.rsvp-status')).toContainText('You are #1 on the list')

    await card.getByRole('button', { name: 'Cancel RSVP' }).click()
    await expect(card.locator('.presale-meter')).toHaveText('0 people on the pre-sale list')
    await expect(card.locator('.waiting-list')).toHaveCount(0)

    // And the server agrees after a reload.
    await card.getByRole('button', { name: 'Count me in' }).click()
    await expect(names(card)).toHaveText(['1. Paula Presale'])
    await page.reload()
    const again = page.locator('.event-card', { hasText: 'Presale List Preview' })
    await expect(names(again)).toHaveText(['1. Paula Presale'])
    await expect(again.locator('.rsvp-status')).toContainText('You are #1 on the list')
  })

  test('a full event lists its waitlist, and joining shows your place on it', async ({ page }) => {
    await signInAs(page, 'full-join-e2e@example.com', { name: 'Joiner Jo' })
    await seedEvents(page, [full])
    await seedFull(page, [person(1)])
    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Full House Night' })
    await expect(card.locator('.rsvp-meter')).toHaveText('1 / 1 RSVPed')
    await expect(card.locator('.waiting-label')).toHaveText('Waitlist:')
    await expect(names(card)).toHaveText(['1. Queued 1'])
    // The confirmed list is still its own list.
    await expect(card.locator('.event-attendance .attendee')).toHaveText(['Seated Sam'])

    await card.getByRole('button', { name: 'Join waitlist' }).click()
    await expect(names(card)).toHaveText(['1. Queued 1', '2. Joiner Jo'])
    await expect(card.locator('.rsvp-status')).toContainText('You are #2 on the waitlist')

    await card.getByRole('button', { name: 'Cancel RSVP' }).click()
    await expect(names(card)).toHaveText(['1. Queued 1'])
  })

  test('a signed-out visitor sees a full event\'s waitlist; an event with room shows none', async ({ page }) => {
    const roomy = { id: 'e2e-roomy', title: 'Plenty Of Room', date: FUTURE, venue: 'Capri Theater', rsvp: true, capacity: 9 }
    await seedEvents(page, [full, roomy])
    await seedFull(page, [person(1), person(2)])
    await page.goto('/events')
    await expect(names(page.locator('.event-card', { hasText: 'Full House Night' }))).toHaveText(['1. Queued 1', '2. Queued 2'])
    const other = page.locator('.event-card', { hasText: 'Plenty Of Room' })
    await expect(other.locator('.rsvp-meter')).toHaveText('0 / 9 RSVPed')
    await expect(other.locator('.waiting-list')).toHaveCount(0)
  })

  test('when a confirmed member cancels, the head of the waitlist moves up on the card', async ({ page }) => {
    await signInAs(page, 'seat-holder-e2e@example.com', { name: 'Holder Hal' })
    await seedEvents(page, [full])
    await putAtt(page, `rsvp:${full.id}`, { confirmed: [], waitlist: [] })
    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Full House Night' })
    await card.getByRole('button', { name: 'RSVP', exact: true }).click()
    await expect(card.locator('.rsvp-meter')).toHaveText('1 / 1 RSVPed')

    // Two people queue behind them, then the page is reloaded to pick it up.
    const raw = await (await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent('rsvp:' + full.id)}`)).json()
    const rsvp = JSON.parse(raw.value)
    await putAtt(page, `rsvp:${full.id}`, { confirmed: rsvp.confirmed, waitlist: [person(1), person(2)] })
    await page.reload()
    const again = page.locator('.event-card', { hasText: 'Full House Night' })
    await expect(names(again)).toHaveText(['1. Queued 1', '2. Queued 2'])

    await again.getByRole('button', { name: 'Cancel RSVP' }).click()
    await expect(names(again)).toHaveText(['1. Queued 2'])
    await expect(again.locator('.event-attendance .attendee')).toHaveText(['Queued 1'])
    await page.reload()
    const after = page.locator('.event-card', { hasText: 'Full House Night' })
    await expect(names(after)).toHaveText(['1. Queued 2'])
    await expect(after.locator('.event-attendance .attendee')).toHaveText(['Queued 1'])
  })
})
