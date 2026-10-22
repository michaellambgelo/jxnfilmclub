import { test, expect } from './fixtures'

// Regression: any update() on the root component wipes the mounted view.
//
// The root template renders an empty `<main class="wrap"><article/></main>`
// and each view is mounted into that <article>. A root update() re-renders
// the template and domdiffs it against the live DOM: the view's <article>
// survives (same tag) but loses its attributes and every child, and nothing
// remounts it. Navigating to a DIFFERENT page hides the bug, because the
// route handler mounts a fresh view after its own root update.
//
// Root updates that happen while a view is on screen:
//   - the hamburger (toggleMenu), on open AND close
//   - tapping the current page's link in the open menu (no route change, so
//     nothing closes the menu or remounts the view)
//   - the privacy-policy toast: shown when checkPrivacyVersion() resolves,
//     hidden by its × or by the 12s auto-hide
//
// Reproduced on production 2026-10-22: /events goes from 46 cards to none
// after opening the menu, and stays empty when it is closed.

// The hamburger only renders at phone width.
test.use({ viewport: { width: 390, height: 844 } })

const eventsLoaded = async (page) => {
  await expect(page.locator('h1')).toHaveText('Events')
  await expect(page.getByRole('heading', { name: 'November 2020 Screening' })).toBeVisible()
}

test.describe('root updates keep the mounted view', () => {
  test('/events: opening and closing the menu keeps the event list', async ({ page }) => {
    await page.goto('/events')
    await eventsLoaded(page)

    await page.locator('.nav-toggle').click()
    await expect(page.locator('.mastnav')).toHaveClass(/\bopen\b/)
    await eventsLoaded(page)

    await page.locator('.nav-toggle').click()
    await expect(page.locator('.mastnav')).not.toHaveClass(/\bopen\b/)
    await eventsLoaded(page)
  })

  test('/events: tapping Events in the open menu closes it and keeps the list', async ({ page }) => {
    await page.goto('/events')
    await eventsLoaded(page)

    await page.locator('.nav-toggle').click()
    await page.locator('.mastnav-links a[href="/events"]').click()
    await expect(page.locator('.mastnav')).not.toHaveClass(/\bopen\b/)
    expect(new URL(page.url()).pathname).toBe('/events')
    await eventsLoaded(page)
  })

  test('/: opening and closing the menu keeps the homepage', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.nshero-lede')).toBeVisible()

    await page.locator('.nav-toggle').click()
    await page.locator('.nav-toggle').click()
    await expect(page.locator('.nshero-lede')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Get in the room.' })).toBeVisible()
  })

  test('/events: the privacy toast showing and being dismissed keeps the list', async ({ page }) => {
    // Same stale-ack seed as site.spec's toast test: a returning visitor from
    // before the current policy revision, so checkPrivacyVersion() shows it.
    await page.addInitScript(() => {
      if (!localStorage.__e2e_ack_seeded) {
        localStorage.__e2e_ack_seeded = '1'
        localStorage.jxnfc_privacy_ack = '2000-01-01'
      }
    })
    await page.goto('/events')
    const toast = page.locator('.policy-toast')
    await expect(toast).toBeVisible()
    await eventsLoaded(page)

    await toast.locator('.policy-toast-close').click()
    await expect(toast).toBeHidden()
    await eventsLoaded(page)
  })

  test('/events: the privacy toast auto-hiding keeps the list', async ({ page }) => {
    await page.clock.install()
    await page.addInitScript(() => {
      if (!localStorage.__e2e_ack_seeded) {
        localStorage.__e2e_ack_seeded = '1'
        localStorage.jxnfc_privacy_ack = '2000-01-01'
      }
    })
    await page.goto('/events')
    const toast = page.locator('.policy-toast')
    await expect(toast).toBeVisible()
    await eventsLoaded(page)

    // The 12s auto-hide is a root update nobody has to click.
    await page.clock.runFor(13_000)
    await expect(toast).toBeHidden()
    await eventsLoaded(page)
  })
})
