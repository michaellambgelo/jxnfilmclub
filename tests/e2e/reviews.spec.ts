import { test, expect, seedKv, WORKER_ORIGIN } from './fixtures'

// /reviews (ui/reviews.html): every cached Hot Take, newest first, revealed
// five at a time as the reader scrolls. E2E's GET /takes serves whatever is
// seeded into watched:cache and never fetches Letterboxd.

const HANDLES = ['michaellamb', 'jon_knowledge', 'jdavidlewis']

function seededTakes() {
  const takes = []
  for (let i = 0; i < 12; i++) {
    const day = String(28 - i).padStart(2, '0')
    takes.push({
      handle: HANDLES[i % 3], title: `Film ${i + 1}`, year: '2026',
      link: `https://letterboxd.com/${HANDLES[i % 3]}/film/film-${i + 1}/`,
      review: `Take number ${i + 1}.`, watched_date: `2026-09-${day}`,
      ...(i === 0 ? { rating: '4.5', liked: true } : {}),
    })
  }
  // A handle that is no longer a member never shows.
  takes.push({ handle: 'not-a-member', title: 'Ghost', link: 'https://letterboxd.com/x/film/ghost/', review: 'Boo.', watched_date: '2026-09-30' })
  return takes
}

test.describe('reviews page', () => {
  test.beforeEach(async ({ page }) => {
    await seedKv(page, 'watched:cache', JSON.stringify({ map: {}, takes: seededTakes(), fetchedAt: Date.now() }))
  })
  test.afterEach(async ({ page }) => {
    await page.request.delete(`${WORKER_ORIGIN}/__test/kv`, {
      headers: { 'Content-Type': 'application/json' }, data: { key: 'watched:cache' },
    })
  })

  test('the Reviews tab opens Hot Takes', async ({ page }) => {
    await page.goto('/')
    await page.locator('.mastnav-links a', { hasText: 'Reviews' }).click()
    await expect(page).toHaveURL(/[/]reviews$/)
    await expect(page.locator('h1')).toHaveText('Hot Takes')
  })

  test('home section titles link to their tabs; Hot Takes opens Reviews', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.program h2 a')).toHaveAttribute('href', '/events')
    await expect(page.locator('.lastfour h2 a')).toHaveAttribute('href', '/watched')
    const takes = page.locator('.takes h2 a')
    await expect(takes).toHaveAttribute('href', '/reviews')
    await takes.click()
    await expect(page).toHaveURL(/[/]reviews$/)
    await expect(page.locator('h1')).toHaveText('Hot Takes')
  })

  test('shows five, then five more as you scroll, until every review is in', async ({ page }) => {
    await page.goto('/reviews')
    const visible = page.locator('.rv-card:not(.-pending)')
    await expect(visible).toHaveCount(5)
    // All twelve current-member takes rendered (hidden); the ghost never is.
    await expect(page.locator('.rv-card')).toHaveCount(12)
    await expect(page.locator('.rv-card', { hasText: 'Ghost' })).toHaveCount(0)

    // Newest first, as the cache orders them, with the details on the card.
    const first = visible.first()
    await expect(first.locator('.rv-film')).toHaveText('Film 12026')
    await expect(first).toContainText('Take number 1.')
    await expect(first).toContainText('Michael Lamb')
    await expect(first.locator('.rv-tape')).toHaveText('Sep 28, 2026')
    await expect(first.locator('.lb-verdict')).toHaveText('★★★★½♥')
    await expect(first.locator('.rv-film a')).toHaveAttribute('href', '/film?slug=film-1')
    await expect(first.locator('.rv-source')).toHaveAttribute('href', 'https://letterboxd.com/michaellamb/film/film-1/')
    await expect(page.locator('.rv-end')).toBeHidden()

    await page.locator('.rv-more').scrollIntoViewIfNeeded()
    await expect(visible).toHaveCount(10)
    await page.locator('.rv-more').scrollIntoViewIfNeeded()
    await expect(visible).toHaveCount(12)
    await expect(page.locator('.rv-more')).toBeHidden()
    await expect(page.locator('.rv-end')).toBeVisible()
  })

  test('Show more reveals the next five without scrolling', async ({ page }) => {
    await page.goto('/reviews')
    await expect(page.locator('.rv-card:not(.-pending)')).toHaveCount(5)
    // Clicked by script so the button does not scroll into view first and
    // trip the observer, which would reveal a batch on its own.
    await page.locator('.rv-more-btn').evaluate((b: HTMLElement) => b.click())
    await expect(page.locator('.rv-card:not(.-pending)')).toHaveCount(10)
  })

  test('a Top button floats in two screens down and goes back up', async ({ page }) => {
    await page.goto('/reviews')
    await expect(page.locator('.rv-card:not(.-pending)')).toHaveCount(5)
    const top = page.locator('.rv-top')
    await expect(top).toBeHidden()
    // Reveal everything, then go to the very bottom.
    await page.locator('.rv-more-btn').evaluate((b: HTMLElement) => b.click())
    await page.locator('.rv-more-btn').evaluate((b: HTMLElement) => b.click())
    await expect(page.locator('.rv-end')).toBeVisible()
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight))
    await expect(top).toBeVisible()
    await top.click()
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
    await expect(top).toBeHidden()
  })

  test('says so when there are no reviews', async ({ page }) => {
    await seedKv(page, 'watched:cache', JSON.stringify({ map: {}, takes: [], fetchedAt: Date.now() }))
    await page.goto('/reviews')
    await expect(page.locator('.empty-state')).toBeVisible()
    await expect(page.locator('.rv-card')).toHaveCount(0)
    await expect(page.locator('.rv-end')).toBeHidden()
  })
})
