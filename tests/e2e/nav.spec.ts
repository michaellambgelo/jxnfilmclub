import { test, expect } from './fixtures'

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

  test('the cross-origin Join link is left alone', async ({ page }) => {
    await page.goto('/watched')
    await page.locator('.mastnav-links a[href^="https://join."]').click()
    await page.waitForURL(/join\.jxnfilm\.club/)
    expect(page.url()).toContain('join.jxnfilm.club')
  })
})
