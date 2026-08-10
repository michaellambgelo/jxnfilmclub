import { test, expect, seedKv } from './fixtures'

test.describe('members view', () => {
  test('renders members from data/members.json', async ({ page }) => {
    await page.goto('/members')
    await expect(page.locator('h1')).toHaveText('Members')
    await expect(page.getByRole('heading', { name: 'Michael Lamb' })).toBeVisible()
    await expect(page.getByRole('link', { name: '@michaellamb' })).toHaveAttribute(
      'href', 'https://letterboxd.com/michaellamb/',
    )
  })

  test('search updates ?query= and filters rows', async ({ page }) => {
    await page.goto('/members')
    await expect(page.getByRole('heading', { name: 'Michael Lamb' })).toBeVisible()
    await page.getByPlaceholder('Search members').fill('nobody-matches-this')
    await expect.poll(() => page.url()).toContain('query=nobody-matches-this')
    await expect(page.getByRole('heading', { name: 'Michael Lamb' })).toHaveCount(0)
  })

  test('sort select updates ?sort=', async ({ page }) => {
    await page.goto('/members')
    await page.getByRole('combobox').selectOption('name')
    await expect.poll(() => page.url()).toContain('sort=name-asc')
  })

  test('direction toggle flips ?sort= and its label', async ({ page }) => {
    await page.goto('/members')
    const toggle = page.locator('.dir-toggle')
    await expect(toggle).toHaveText('Newest first')
    await toggle.click()
    await expect.poll(() => page.url()).toContain('sort=joined-asc')
    await expect(toggle).toHaveText('Oldest first')
  })

  test('deep link ?sort=handle-desc restores key, direction, and filter', async ({ page }) => {
    await page.goto('/members?sort=handle-desc')
    await expect(page.getByRole('combobox')).toHaveValue('handle')
    await expect(page.locator('.dir-toggle')).toHaveText('Z → A')
    // The handle sort filters to Letterboxd members, so no muted
    // no-Letterboxd labels may remain in the grid.
    await expect(page.getByRole('heading', { name: 'Michael Lamb' })).toBeVisible()
    await expect(page.locator('.handle.-none')).toHaveCount(0)
  })

  test('@handle link opens Letterboxd in a new tab (bypasses autolink)', async ({ page, context }) => {
    await page.goto('/members')
    await expect(page.getByRole('heading', { name: 'Michael Lamb' })).toBeVisible()
    const [popup] = await Promise.all([
      context.waitForEvent('page', { timeout: 5_000 }),
      page.getByRole('link', { name: '@michaellamb' }).click(),
    ])
    expect(popup.url()).toBe('https://letterboxd.com/michaellamb/')
    await popup.close()
  })
})

test.describe('config-driven homepage copy', () => {
  test('config:copy overrides render on the homepage; missing fields keep defaults', async ({ page }) => {
    await seedKv(page, 'config:copy', JSON.stringify({ heroLede: 'E2E override lede — config wins.' }))
    await page.goto('/')
    await expect(page.locator('.nshero-lede')).toHaveText('E2E override lede — config wins.')
    // A field absent from the override falls back to the hardcoded default.
    await expect(page.getByRole('heading', { name: 'Get in the room.' })).toBeVisible()
  })
})

test.describe('site footer', () => {
  test('footer is visible on the homepage and links to the privacy policy', async ({ page }) => {
    await page.goto('/')
    const footer = page.locator('footer.site-footer')
    await expect(footer).toBeVisible()
    await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute(
      'href', 'https://join.jxnfilm.club/privacy',
    )
    await expect(footer.getByRole('link', { name: 'Contact' })).toHaveAttribute(
      'href', 'mailto:privacy@jxnfilm.club',
    )
  })
})

test.describe('signed-in nav', () => {
  test('Account Actions click lands on /edit, not join.jxnfilm.club', async ({ page }) => {
    // Seed a session so the nav shows Account Actions instead of Join/Log in.
    await page.goto('/')
    await page.evaluate(() => {
      localStorage.jxnfc_session = JSON.stringify({
        token: 'bogus.sig', email: 'x@example.com', id: 'x',
        handle: 'x', exp: Date.now() + 3600_000,
      })
    })
    await page.reload()
    await page.getByRole('link', { name: 'Account Actions' }).click()
    await page.waitForURL(/\/edit/, { timeout: 5_000 })
    expect(page.url()).toContain('/edit')
    expect(page.url()).not.toContain('join.jxnfilm.club')
  })
})

test.describe('auth nav', () => {
  test('Join click navigates to join.jxnfilm.club (bypasses autolink)', async ({ page }) => {
    await page.goto('/')
    const join = page.getByRole('link', { name: 'Join', exact: true })
    await expect(join).toHaveAttribute('href', 'https://join.jxnfilm.club/')
    await Promise.all([
      page.waitForURL('https://join.jxnfilm.club/', { timeout: 10_000 }),
      join.click(),
    ])
  })
})

test.describe('events view', () => {
  test('/events deep link loads events-view', async ({ page }) => {
    await page.goto('/events')
    await expect(page.locator('h1')).toHaveText('Events')
    await expect(page.getByRole('heading', { name: 'November 2020 Screening' })).toBeVisible()
  })

  test('nav link from / to /events routes without full reload', async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => { (window as any).__navMarker = true })
    await page.getByRole('link', { name: 'Events', exact: true }).click()
    await expect(page.locator('h1')).toHaveText('Events')
    const markerStillThere = await page.evaluate(() => (window as any).__navMarker === true)
    expect(markerStillThere).toBe(true)
  })
})

test.describe('avatar widget', () => {
  test('letter fallback renders the uniform circle with a white monogram', async ({ page }) => {
    // The per-letter palette was removed 2026-08-09 (it never rendered — CSS
    // var name mismatch — and half the letters got near-invisible black
    // monograms on the gray fallback). Contract now: uniform --line-2 circle,
    // always-white letter, regardless of the member's first initial.
    await page.goto('/members')
    const letterAvatars = page.locator('figure.avatar:has(b)')
    await expect(letterAvatars.first()).toBeVisible()
    const count = Math.min(await letterAvatars.count(), 10)
    for (let i = 0; i < count; i++) {
      const b = letterAvatars.nth(i).locator('b')
      await expect(b).toHaveCSS('color', 'rgb(255, 255, 255)')
    }
    // No stray inline custom property from the old palette path.
    const style = await letterAvatars.first().getAttribute('style')
    expect(style || '').not.toContain('--bg')
  })
})

test.describe('privacy-policy update toast', () => {
  test('shows once when the stored ack is older, then re-stamps and stays gone', async ({ page }) => {
    // A stale ack simulates a returning visitor from before the policy bump.
    // Init scripts run on EVERY navigation, so guard the seed with a marker —
    // otherwise the second goto would re-prime the toast.
    await page.addInitScript(() => {
      if (!localStorage.__e2e_ack_seeded) {
        localStorage.__e2e_ack_seeded = '1'
        localStorage.jxnfc_privacy_ack = '2000-01-01'
      }
    })
    await page.goto('/members')
    const toast = page.locator('.policy-toast')
    await expect(toast).toBeVisible()
    await expect(toast.locator('a')).toContainText(/privacy policy was updated/i)

    // The × dismisses it without navigating.
    await toast.locator('.policy-toast-close').click()
    await expect(toast).toBeHidden()

    // The ack was re-stamped at fetch time (async — poll for it).
    await expect.poll(() => page.evaluate(() => localStorage.jxnfc_privacy_ack)).not.toBe('2000-01-01')
    const ack = await page.evaluate(() => localStorage.jxnfc_privacy_ack)
    expect(ack).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // Next load is silent: the stored ack now matches the served version.
    await page.goto('/events')
    await expect(page.locator('h1')).toHaveText('Events')
    await expect(toast).toBeHidden()
  })

  test('fresh visitor gets no toast — the ack is stored silently', async ({ page }) => {
    await page.goto('/members')
    await expect(page.getByRole('heading', { name: 'Michael Lamb' })).toBeVisible()
    // Poll: the version fetch is async, so the ack may land after page load.
    await expect.poll(() => page.evaluate(() => localStorage.jxnfc_privacy_ack)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    await expect(page.locator('.policy-toast')).toBeHidden()
  })
})
