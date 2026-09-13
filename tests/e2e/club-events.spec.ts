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
    // attendance toggle is what a signed-in member gets.
    await expect(card.locator('.event-rsvp')).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'I was there' })).toBeVisible()
  })

  test('a ticketed event links out to the box office instead of taking an RSVP', async ({ page }) => {
    await signInAs(page, 'tix-e2e@example.com', { name: 'Ticket Tina' })
    await seedEvents(page, [{
      id: 'e2e-tix', title: 'Preview Screening', film: 'Nosferatu', year: 2024,
      date: FUTURE, venue: 'The Capri Theater',
      rsvp: true, ticketUrl: 'https://tickets.example.com/nosferatu',
    }])

    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Preview Screening' })
    const tickets = card.getByRole('link', { name: 'Get tickets' })
    await expect(tickets).toHaveAttribute('href', 'https://tickets.example.com/nosferatu')
    await expect(tickets).toHaveAttribute('target', '_blank')

    // ticketUrl wins over rsvp: true, so no RSVP block is offered.
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
})
