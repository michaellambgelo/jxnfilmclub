import { test, expect, WORKER_ORIGIN, signInAs } from './fixtures'

// Member-hosted screenings: SPA wiring + privacy of the host's address.
// The worker unit tests (tests/worker/screenings.test.js) cover the RSVP /
// waitlist / promotion / email-template logic in detail; this e2e proves the
// /host SPA form, the multi-segment route (/:type/:sub), and the
// public-projection boundary (the address must never reach the rendered page
// or the public worker response).

test.describe('member-hosted screenings', () => {
  test('host creates screening via /host; appears on /events; address never leaves the worker', async ({ page }) => {
    const hostEmail = 'host-e2e@example.com'
    await signInAs(page, hostEmail, { name: 'Host McHostface' })

    // Navigate to /host via the SPA router (proves /:type/:sub works).
    await page.goto('/host')
    await expect(page.locator('article.auth h1')).toHaveText('Host a screening or meetup')

    // The form is hidden until a venue-type card is picked.
    await expect(page.locator('article.auth form')).toBeHidden()
    await page.getByRole('button', { name: /my house/i }).click()
    await expect(page.locator('article.auth form')).toBeVisible()

    // Fill the create form.
    const SCREENING_TITLE = 'E2E Test Screening'
    const SECRET_ADDRESS = '742 Evergreen Terrace, Springfield, MS 39201'
    // exact/name-attr locators: substring getByLabel is ambiguous here — the
    // theater select's hint contains "jxnfilm" (matches 'Film') and the house
    // option card's copy contains "address".
    await page.getByLabel('Title').fill(SCREENING_TITLE)
    await page.locator('input[name="film"]').fill('Crash')
    await page.getByLabel('Date').fill('2099-06-15')
    await page.locator('input[name="address"]').fill(SECRET_ADDRESS)
    await page.locator('input[name="time"]').fill('19:30')
    await page.getByLabel('Capacity').fill('4')
    await page.getByRole('button', { name: /create screening/i }).click()

    // Redirected to /events; the new screening renders with the "Hosted by"
    // line and the public-facing meta — but never the address.
    await page.waitForURL('**/events')
    const card = page.locator('.event-card', { hasText: SCREENING_TITLE })
    await expect(card).toBeVisible()
    await expect(card).toContainText(/Hosted by Host McHostface/i)
    await expect(card).toContainText(/0 \/ 4 RSVPed/)
    await expect(card).toContainText(/7:30 pm/)

    // The host panel's guest-list component (host-guests, a separate dhtml
    // child component) mounts with its add form — smoke for the custom-tag
    // instantiation; behavior is covered by the worker suite.
    await expect(card.locator('.host-guests input[name="guestName"]')).toBeVisible()

    // The full rendered events page must contain ZERO trace of the address.
    const html = await page.content()
    expect(html).not.toContain(SECRET_ADDRESS)
    expect(html).not.toContain('Evergreen Terrace')

    // The public worker response (what a signed-out scraper would see) also
    // strips the address — defense in depth at the projection layer.
    const listRes = await page.request.get(`${WORKER_ORIGIN}/events`)
    const list = await listRes.json()
    const ours = list.find((e: any) => e.title === SCREENING_TITLE)
    expect(ours).toBeTruthy()
    expect(ours.hostName).toBe('Host McHostface')
    expect(ours.capacity).toBe(4)
    expect(ours.time).toBe('19:30')
    expect(ours.venue).toBe("Host McHostface's house")  // public-friendly label, auto-stamped
    expect(ours.address).toBeUndefined()
    expect(JSON.stringify(list)).not.toContain('Evergreen Terrace')

    // And the canonical KV row (admin-only path) DOES still carry it — the
    // address has to live somewhere for the RSVP email to include it.
    const kvRes = await page.request.get(
      `${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=event:${encodeURIComponent(ours.id)}`,
    )
    const raw = JSON.parse((await kvRes.json()).value)
    expect(raw.address).toBe(SECRET_ADDRESS)
  })

  test('member creates a theater meetup via the toggle; venue listed publicly', async ({ page }) => {
    await signInAs(page, 'meetup-e2e@example.com', { name: 'Meetup Maker' })

    await page.goto('/host')
    await expect(page.locator('article.auth h1')).toHaveText('Host a screening or meetup')

    // Form hidden until a card is picked; the meetup card reveals the meetup
    // variant — the address input stays hidden, theater select shows.
    await expect(page.locator('article.auth form')).toBeHidden()
    await page.getByRole('button', { name: /a theater/i }).click()
    await expect(page.locator('article.auth form')).toBeVisible()
    await expect(page.locator('input[name="address"]')).toBeHidden()
    await expect(page.locator('select[name="venue"]')).toBeVisible()

    const MEETUP_TITLE = 'E2E Capri Meetup'
    await page.getByLabel('Title').fill(MEETUP_TITLE)

    // Poster search: typing in Film surfaces TMDB suggestions (canned fixture
    // under E2E_MODE); picking one fills film + year and attaches the poster.
    await page.locator('input[name="film"]').pressSequentially('matrix')
    const suggestion = page.locator('.poster-opt', { hasText: 'The Matrix (1999)' })
    await expect(suggestion).toBeVisible()
    await suggestion.click()
    await expect(page.locator('input[name="film"]')).toHaveValue('The Matrix')
    await expect(page.locator('input[name="year"]')).toHaveValue('1999')
    await expect(page.locator('.poster-picked')).toBeVisible()

    // Step 2: alternate posters load (canned fixture has 2); the primary is
    // preselected, picking the alternate swaps the selection.
    await expect(page.locator('.poster-choice')).toHaveCount(2)
    await expect(page.locator('.poster-choice.-selected img')).toHaveAttribute('src', /e2e-matrix\.jpg/)
    await page.locator('.poster-choice').nth(1).click()
    await expect(page.locator('.poster-choice.-selected img')).toHaveAttribute('src', /e2e-matrix-alt\.jpg/)
    await expect(page.locator('.poster-picked img')).toHaveAttribute('src', /e2e-matrix-alt\.jpg/)

    await page.getByLabel('Date').fill('2099-07-20')
    await page.locator('select[name="venue"]').selectOption('The Capri Theater')
    await page.locator('input[name="time"]').fill('19:30')
    // Capacity deliberately left blank — uncapped meetup.
    await page.getByRole('button', { name: /create meetup/i }).click()

    // The card renders the public venue, the self-organized hint, and an
    // uncapped meter (no "/ N" denominator).
    await page.waitForURL('**/events')
    const card = page.locator('.event-card', { hasText: MEETUP_TITLE })
    await expect(card).toBeVisible()
    await expect(card).toContainText('The Capri Theater')
    await expect(card).toContainText(/Hosted by Meetup Maker/i)
    await expect(card).toContainText(/Self-organized/i)
    await expect(card.locator('.rsvp-meter')).toHaveText(/^\s*0 RSVPed\s*$/)

    // Public worker response carries kind/venue/time, never an address.
    const listRes = await page.request.get(`${WORKER_ORIGIN}/events`)
    const list = await listRes.json()
    const ours = list.find((e: any) => e.title === MEETUP_TITLE)
    expect(ours).toBeTruthy()
    expect(ours.kind).toBe('meetup')
    expect(ours.venue).toBe('The Capri Theater')
    expect(ours.time).toBe('19:30')
    expect(ours.poster).toBe('https://image.tmdb.org/t/p/w500/e2e-matrix-alt.jpg')
    expect(ours.capacity).toBeUndefined()
    expect(ours.address).toBeUndefined()
  })

  test('/host prompts non-members to log in instead of showing the form', async ({ page }) => {
    // Fresh context (fixtures wipe KV before each test) so no session.
    await page.goto('/host')
    await expect(page.locator('article.auth h1')).toHaveText('Host a screening or meetup')
    await expect(page.locator('p.lede')).toContainText('log in')
    await expect(page.getByLabel('Title')).toHaveCount(0)
  })
})
