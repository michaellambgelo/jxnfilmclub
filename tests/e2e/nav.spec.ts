import { test, expect, signInAs, WORKER_ORIGIN } from './fixtures'

// Regression: clicking the nav link for the page you are already on used to
// leave the view untouched and rewrite the URL to the site root. nuestate's
// autolink saw a phantom "query changed" (absent params are null on the link
// side, stripped on the state side) and wrote it with replaceState('./'),
// which resolves against /watched to /.
test.describe('same-route nav links', () => {
  for (const [path, label, heading] of [
    ['/watched', 'Watched', 'Last Four Watched'],
    ['/members', 'Members', 'Members'],
    ['/events', 'Events', 'Events'],
  ] as const) {
    test(`${path}: clicking ${label} keeps the URL and the view`, async ({ page }) => {
      await page.goto(path)
      await expect(page.locator('h1')).toHaveText(heading)
      await page.locator(`.mastnav-links a[href="${path}"]`).click()
      await page.waitForTimeout(250)
      expect(new URL(page.url()).pathname).toBe(path)
      await expect(page.locator('h1')).toHaveText(heading)
    })
  }

  test('/watched: clicking Watched clears an active filter but keeps the path', async ({ page }) => {
    await page.goto('/watched')
    await page.locator('.watched-filter[data-tok="liked"]').click()
    await expect.poll(() => page.url()).toContain('filter=liked')

    await page.locator('.mastnav-links a[href="/watched"]').click()
    await page.waitForTimeout(250)
    const url = new URL(page.url())
    expect(url.pathname).toBe('/watched')
    expect(url.search).toBe('')
    await expect(page.locator('.watched-filter[data-tok="liked"]')).not.toHaveClass(/-on/)
  })

  test('a self-link scrolls back to the top', async ({ page }) => {
    await page.goto('/members')
    await page.locator('h1').waitFor()
    await page.evaluate(() => scrollTo(0, 2000))
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0)

    await page.locator('.mastnav-links a[href="/members"]').click()
    await expect.poll(() => page.evaluate(() => scrollY), { timeout: 5000 }).toBe(0)
    expect(new URL(page.url()).pathname).toBe('/members')
  })

  test('the cross-origin Join link is left alone', async ({ page }) => {
    await page.goto('/watched')
    await page.locator('.mastnav-links a[href^="https://join."]').click()
    await page.waitForURL(/join\.jxnfilm\.club/)
    expect(page.url()).toContain('join.jxnfilm.club')
  })
})

// join.jxnfilm.club/privacy can't read jxnfilm.club's localStorage, so a
// hidden same-site frame (embed/signed-in.htm) tells it whether you're signed
// in: signed in, its Signup links become Account → the site's /edit.
test.describe('privacy page on the join Worker', () => {
  test('a signed-out visitor sees Signup', async ({ page }) => {
    await page.goto(`${WORKER_ORIGIN}/privacy`)
    await expect(page.locator('.topnav-link')).toHaveText('Signup')
    await expect(page.locator('.topnav-link')).toHaveAttribute('href', '/')
  })

  test('a member signed in on the site sees Account, linking to their account page', async ({ page, baseURL }) => {
    await signInAs(page, 'privacy-nav@e2e.test')
    await page.goto(`${WORKER_ORIGIN}/privacy`)
    const top = page.locator('.topnav-link')
    await expect(top).toHaveText('Account')
    await expect(top).toHaveAttribute('href', `${baseURL}/edit`)
    await expect(page.locator('.site-footer-links a[data-member-link]')).toHaveText('Account')
  })
})
