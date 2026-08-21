import { test, expect, WORKER_ORIGIN, signInAs } from './fixtures'

// Attendance is keyed on the member id (docs/features/attendance.md § Identity).
// The worker unit tests cover the storage and resolution rules; this proves the
// SPA half — that the toggle reads its own state off the id, that a renamed
// member is renamed in the attendee list, and that a Letterboxd link is chosen
// by id rather than by display name.

const EVENT = {
  id: 'attendance-e2e',
  title: 'E2E Attendance Night',
  film: 'Crash',
  date: '2000-01-01',      // past: the toggle is the affordance, not RSVP
  venue: 'The Capri Theater',
}

const seed = (page, key: string, value: unknown) =>
  page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
    data: { ns: 'ATTENDANCE_KV', key, value: JSON.stringify(value) },
  })

test.describe('event attendance', () => {
  test('marking attendance, then renaming, renames the member in the attendee list', async ({ page }) => {
    const member = await signInAs(page, 'attend-e2e@example.com', { name: 'First Name' })
    await seed(page, `event:${EVENT.id}`, EVENT)
    await seed(page, 'events:all', [EVENT])

    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: EVENT.title })
    await expect(card).toBeVisible()

    await card.getByRole('button', { name: 'I was there' }).click()
    await expect(card.locator('.attendee')).toHaveText(['First Name'])
    // Button state is derived from the member id, not the name.
    await expect(card.getByRole('button', { name: 'Remove me' })).toBeVisible()

    // KV holds the id, not just the name.
    const stored = await page.request.get(
      `${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=attend:${EVENT.id}`)
    expect(JSON.parse((await stored.json()).value))
      .toEqual([{ id: member.id, name: 'First Name' }])

    // Rename from /edit, then come back. The stored row still says "First
    // Name"; the list must not.
    await page.goto('/edit')
    await page.locator('input[name="name"]').fill('Second Name')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.locator('.ok')).toBeVisible()

    await page.goto('/events')
    const again = page.locator('.event-card', { hasText: EVENT.title })
    await expect(again.locator('.attendee')).toHaveText(['Second Name'])
    await expect(again.getByRole('button', { name: 'Remove me' })).toBeVisible()

    // And the toggle still finds them — removal is by id.
    await again.getByRole('button', { name: 'Remove me' }).click()
    await expect(again.locator('.attendee')).toHaveCount(0)
    await expect(again.getByRole('button', { name: 'I was there' })).toBeVisible()
  })

  test('a guest with no member row renders as plain text, never as a Letterboxd link', async ({ page }) => {
    await signInAs(page, 'attend-guest-e2e@example.com', { name: 'Looker On' })
    await seed(page, `event:${EVENT.id}`, EVENT)
    await seed(page, 'events:all', [EVENT])
    // Seed the aggregate as well as the per-event key: the bulk endpoint reads
    // `attendance:all` only, and a stray request from the previous test can
    // bootstrap an empty aggregate that then masks a per-event seed. Same
    // both-keys idiom screenings.spec.ts uses for its legacy row.
    const attendees = [
      { id: 'guest:abcd1234', name: 'Plus One' },
      { id: null, name: 'former member' },
    ]
    await seed(page, `attend:${EVENT.id}`, attendees)
    await seed(page, 'attendance:all', { [EVENT.id]: attendees })

    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: EVENT.title })
    await expect(card.locator('.attendee')).toHaveText(['Plus One', 'former member'])
    await expect(card.locator('.attendee a')).toHaveCount(0)
  })
})
