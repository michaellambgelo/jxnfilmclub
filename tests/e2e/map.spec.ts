import { test, expect, seedKv } from './fixtures'

// /map (docs/features/map.md). The venue list renders
// whether or not WebGL cooperates; the tile test checks the basemap's files
// are served whole, which is what the production host can do reliably.

test.describe('venue map', () => {
  test('is in the nav and lists theater venues from the event history', async ({ page }) => {
    await page.goto('/')
    await page.locator('.mastnav-links').getByRole('link', { name: 'Map' }).click()
    await expect(page).toHaveURL(/\/map$/)
    await expect(page.locator('h1')).toHaveText('Where the club gathers')

    const capri = page.locator('#venue-the-capri-theatre')
    await expect(capri.getByRole('heading', { name: 'The Capri Theatre' })).toBeVisible()
    await expect(capri).toContainText('3023 N State St')
    // Three historical spellings (Capri Theatre, Capri Theater, The Capri
    // Theater) all land on the one venue.
    await expect(capri.locator('.jm-count')).toHaveText(/^\d+ screenings since \d{4}$/)
    await expect(capri.getByRole('link', { name: 'Directions' })).toHaveAttribute('href', /google\.com\/maps\/dir/)
  })

  test('Details in a pin popup scrolls to the venue card and pulses it', async ({ page }) => {
    // The Capri and Duling Hall sit a block apart in Fondren, close enough
    // that at the default zoom they share one group pin (ui/map.html,
    // jmGroupVenues). Its popup lists both venues in full; Details on the
    // Capri entry must still reach the Capri card. Grouping does not depend
    // on which venue has an upcoming event, so no date seeding is needed.
    await page.goto('/map')
    const group = page.locator('.jm-pin-group[aria-label*="The Capri Theatre"]')
    test.skip(!(await group.waitFor({ timeout: 10_000 }).then(() => true, () => false)), 'no WebGL in this browser')
    await expect(group).toHaveAttribute('aria-label', /^2 venues close together: .*Duling Hall/)
    // Neither venue keeps a pin of its own to be covered by the other.
    await expect(page.locator('.jm-pin:not(.jm-pin-group)[aria-label^="The Capri Theatre"]')).toHaveCount(0)
    await expect(page.locator('.jm-pin:not(.jm-pin-group)[aria-label^="Duling Hall"]')).toHaveCount(0)

    await group.click()
    const popup = page.locator('.maplibregl-popup')
    await expect(popup.locator('.jm-pop-head')).toHaveText('2 venues close together')
    const capri = popup.locator('.jm-pop:not(.jm-pop-group)').filter({ has: page.locator('.jm-pop-name', { hasText: 'The Capri Theatre' }) })
    await capri.getByRole('link', { name: 'Details' }).click()
    const card = page.locator('.jm-venue.jm-flash')
    await expect(card).toHaveCount(1)
    await expect(card).toHaveId('venue-the-capri-theatre')
    await expect(card).toBeInViewport()
    // The pulse clears itself so a later click can run it again.
    await expect(card).toHaveCount(0, { timeout: 4_000 })
  })

  test('zooming in separates the grouped venues into their own pins', async ({ page }) => {
    await page.goto('/map')
    const group = page.locator('.jm-pin-group[aria-label*="The Capri Theatre"]')
    test.skip(!(await group.waitFor({ timeout: 10_000 }).then(() => true, () => false)), 'no WebGL in this browser')
    await group.click()
    await page.locator('.maplibregl-popup').getByRole('button', { name: 'Zoom in to separate' }).click()

    const capri = page.locator('.jm-pin:not(.jm-pin-group)[aria-label^="The Capri Theatre"]')
    const duling = page.locator('.jm-pin:not(.jm-pin-group)[aria-label^="Duling Hall"]')
    await expect(capri).toBeVisible()
    await expect(duling).toBeVisible()
    await expect(page.locator('.jm-pin-group')).toHaveCount(0)
    // Each pin now takes its own click: the Capri popup is the Capri's alone.
    await capri.click()
    await expect(page.locator('.maplibregl-popup .jm-pop-name')).toHaveText('The Capri Theatre')
  })

  test('never lists a home screening', async ({ page }) => {
    await page.goto('/map')
    await expect(page.locator('.jm-venue').first()).toBeVisible()
    await expect(page.locator('.jm-venues')).not.toContainText(/house|apartment/i)
  })

  test('config:venues replaces the built-in list', async ({ page }) => {
    await seedKv(page, 'config:venues', JSON.stringify([
      { name: 'Duling Hall', address: '622 Duling Ave, Jackson, MS 39216', lat: 32.3362, lng: -90.17523 },
    ]))
    await page.goto('/map')
    await expect(page.locator('.jm-venue')).toHaveCount(1)
    await expect(page.locator('.jm-venue h2')).toHaveText('Duling Hall')
  })

  test('serves the basemap as static vector tiles', async ({ page }) => {
    const style = await (await page.request.get('/tiles/style.json')).json()
    expect(style.sources.protomaps.url).toBeUndefined()
    expect(style.sources.protomaps.tiles).toEqual(['{origin}/tiles/jxn/{z}/{x}/{y}.pbf'])
    // A tile over downtown Jackson, decompressed MVT (no gzip magic bytes).
    const tile = await page.request.get('/tiles/jxn/12/1021/1659.pbf')
    expect(tile.status()).toBe(200)
    const body = await tile.body()
    expect(body.length).toBeGreaterThan(1000)
    expect(body[0] === 0x1f && body[1] === 0x8b).toBe(false)
  })
})
