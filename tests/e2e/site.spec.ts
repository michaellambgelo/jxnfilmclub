import { test, expect } from './fixtures'

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
    await expect.poll(() => page.url()).toContain('sort=name')
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
  test('renders with deterministic background color', async ({ page }) => {
    await page.goto('/members')
    const avatar = page.locator('figure.avatar').first()
    await expect(avatar).toBeVisible()
    const bg = await avatar.getAttribute('style')
    expect(bg).toMatch(/--bg:\s*#[0-9A-F]{6}/i)
  })
})
