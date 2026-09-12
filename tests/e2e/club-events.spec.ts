import { test, expect, WORKER_ORIGIN, signInAs } from './fixtures'

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
})
