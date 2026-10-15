import { test, expect, seedKv } from './fixtures'

// /map (docs/features/map.md). The tile layer itself is not asserted: nue
// serve has no HTTP Range support, so the basemap never draws under e2e (the
// production host does). The venue list and the privacy line are what these
// cover; both render whether or not WebGL and the tiles cooperate.

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
})
