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
    await page.goto('/map')
    const pin = page.locator('.jm-pin[aria-label^="The Capri Theatre"]')
    test.skip(!(await pin.waitFor({ timeout: 10_000 }).then(() => true, () => false)), 'no WebGL in this browser')
    await pin.click()
    await page.locator('.maplibregl-popup').getByRole('link', { name: 'Details' }).click()
    const card = page.locator('.jm-venue.jm-flash')
    await expect(card).toHaveCount(1)
    await expect(card).toHaveId('venue-the-capri-theatre')
    await expect(card).toBeInViewport()
    // The pulse clears itself so a later click can run it again.
    await expect(card).toHaveCount(0, { timeout: 4_000 })
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
