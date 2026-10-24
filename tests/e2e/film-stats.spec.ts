import { test, expect, signInAs, WORKER_ORIGIN } from './fixtures'
import type { Page } from '@playwright/test'

// Film stats (docs/features/film-stats.md) in the browser: the direction A
// strip on /watched and the /film page. E2E_MODE makes GET /watched return {}
// (no RSS in tests), so the strip is fed by route mocks over real members from
// members:all; /films/* is mocked per test so each state is deterministic.
// The last block hits the real local Worker to prove FILMS_DB is wired.

// Today as a bare Central-time diary date, the same clock the strip windows on.
function centralToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
}

function entry(handle: string, slug: string, title: string) {
  return {
    title,
    year: '2026',
    link: `https://letterboxd.com/${handle}/film/${slug}/`,
    watched_date: centralToday(),
  }
}

// Handles below are real rows in data/members.json, which seeds members:all.
const DIGGER = ['michaellamb', 'draketerry', 'winonarideher', 'VesperEvensong', 'badmov1eenjoyer']
const ODYSSEY = ['ChillLTB', 'Davidatwood24', 'dacoats', 'draketerry', 'heath_walt', 'isawthatontv', 'jdavidlewis', 'jl7345']

function watchedMap() {
  const map: Record<string, any[]> = {}
  const add = (h: string, e: any) => { (map[h] = map[h] || []).push(e) }
  for (const h of DIGGER) add(h, entry(h, 'digger-2026', 'Digger'))
  for (const h of ODYSSEY) add(h, entry(h, 'the-odyssey-2026', 'The Odyssey'))
  add('heath_walt', entry('heath_walt', 'obsession-2025', 'Obsession'))
  add('michaellamb', entry('michaellamb', 'nosferatu-2024', 'Nosferatu'))
  return map
}

async function mockWatched(page: Page) {
  await page.route(`${WORKER_ORIGIN}/watched*`, route =>
    route.fulfill({ json: watchedMap(), headers: { 'Access-Control-Allow-Origin': '*' } }))
}

async function mockStats(page: Page, stats: Record<string, any> | null) {
  await page.route(`${WORKER_ORIGIN}/films/stats*`, route => {
    if (stats === null) return route.abort()
    return route.fulfill({ json: { stats }, headers: { 'Access-Control-Allow-Origin': '*' } })
  })
}

const card = (page: Page, title: string) =>
  page.locator('.ws-card').filter({ has: page.locator('.ws-name', { hasText: title }) })

test.describe('watched strip: You + the club', () => {
  test('signed out: count line, hero, film link, structural separators', async ({ page }) => {
    await mockWatched(page)
    await mockStats(page, {
      'digger-2026': { members: 9, logs: 11, thisWeek: 5 },
      'the-odyssey-2026': { members: 14, logs: 15, thisWeek: 8 },
    })
    await page.goto('/watched')

    const odyssey = card(page, 'The Odyssey')
    await expect(odyssey.locator('.ws-count')).toHaveText('14 members have logged it · 8 this week')
    // Most all-time members leads the strip as the hero.
    await expect(page.locator('.ws-card').first()).toHaveClass(/-hero/)
    await expect(page.locator('.ws-card').first()).toContainText('The Odyssey')
    await expect(odyssey.locator('a.ws-film-link')).toHaveAttribute('href', '/film?slug=the-odyssey-2026')

    // The comma is markup inside each name box, not CSS content, so a wrapped
    // line can never start with one.
    const diggerNames = card(page, 'Digger').locator('.ws-who')
    await expect(diggerNames).toHaveCount(5)
    await expect(diggerNames.first().locator('.ws-sep')).toHaveText(',')
    await expect(diggerNames.last().locator('.ws-sep')).toHaveText('')
    const before = await diggerNames.nth(1).locator('.ws-watcher')
      .evaluate(el => getComputedStyle(el, '::before').content)
    expect(['none', 'normal']).toContain(before)
    await expect(card(page, 'Digger')).not.toHaveClass(/-you/)
  })

  test('count line only says what the card does not: one member, all this week', async ({ page }) => {
    await mockWatched(page)
    await mockStats(page, {
      'digger-2026': { members: 5, logs: 5, thisWeek: 5 },
      'the-odyssey-2026': { members: 14, logs: 15, thisWeek: 8 },
      'obsession-2025': { members: 1, logs: 1, thisWeek: 1 },
    })
    await page.goto('/watched')

    // One member: the name under the title already says it.
    const obsession = card(page, 'Obsession')
    await expect(obsession.locator('.ws-who')).toHaveCount(1)
    await expect(obsession.locator('.ws-count')).toHaveCount(0)
    // Everyone logged it this week: no week part to repeat the count.
    await expect(card(page, 'Digger').locator('.ws-count')).toHaveText('5 members have logged it')
    await expect(card(page, 'Digger').locator('.ws-week')).toHaveCount(0)
    // Otherwise the week part is its own no-wrap piece.
    const week = card(page, 'The Odyssey').locator('.ws-week')
    await expect(week).toHaveText('· 8 this week')
    expect(await week.evaluate(el => getComputedStyle(el).whiteSpace)).toBe('nowrap')
  })

  test('more than six watchers fold behind +N more, which opens in place', async ({ page }) => {
    await mockWatched(page)
    await mockStats(page, { 'the-odyssey-2026': { members: 14, logs: 15, thisWeek: 8 } })
    await page.goto('/watched')

    const odyssey = card(page, 'The Odyssey')
    const more = odyssey.getByRole('button', { name: '+2 more' })
    await expect(more).toBeVisible()
    const extras = odyssey.locator('.ws-who.-extra')
    await expect(extras).toHaveCount(2)
    await expect(extras.first()).toBeHidden()

    await more.click()
    await expect(extras.first()).toBeVisible()
    await expect(more).toBeHidden()
    // Focus lands on the first revealed name so a keyboard user keeps their place.
    await expect(extras.first().locator('.ws-watcher')).toBeFocused()
  })

  test('signed in: You leads, You too stamp, others counted', async ({ page }) => {
    await signInAs(page, 'ml@example.com', { id: 'ml-seed001', name: 'Michael Lamb', handle: 'michaellamb' })
    await mockWatched(page)
    await mockStats(page, {
      'digger-2026': { members: 9, logs: 11, thisWeek: 5, you: true },
      'the-odyssey-2026': { members: 14, logs: 15, thisWeek: 8, you: false },
      'nosferatu-2024': { members: 1, logs: 1, thisWeek: 1, you: true },
    })
    await page.goto('/watched')

    const digger = card(page, 'Digger')
    await expect(digger).toHaveClass(/-you/)
    await expect(digger.locator('.ws-stamp')).toHaveText('You too')
    await expect(digger.locator('.ws-count')).toHaveText('You + 8 others have logged it · 5 this week')
    await expect(digger.locator('.ws-watcher').first()).toHaveText('You')
    // Not on The Odyssey: plain count, no stamp.
    await expect(card(page, 'The Odyssey').locator('.ws-stamp')).toHaveCount(0)
    // Not when the viewer is the only one this week: that is just their diary.
    const solo = card(page, 'Nosferatu')
    await expect(solo.locator('.ws-watcher')).toHaveText('You')
    await expect(solo.locator('.ws-stamp')).toHaveCount(0)
    await expect(solo).not.toHaveClass(/-you/)
  })

  test('a watcher name still scrolls to that member section', async ({ page }) => {
    await mockWatched(page)
    await mockStats(page, { 'digger-2026': { members: 9, logs: 11, thisWeek: 5 } })
    await page.goto('/watched')
    await card(page, 'Digger').getByRole('button', { name: 'Kathy' }).click()
    await expect(page.locator('#member-winonarideher')).toBeInViewport()
  })

  test('stats endpoint down: falls back to the weekly Watched by byline', async ({ page }) => {
    await mockWatched(page)
    await mockStats(page, null)
    await page.goto('/watched')

    const digger = card(page, 'Digger')
    await expect(digger.locator('.ws-by')).toHaveText('Watched by')
    await expect(digger.locator('.ws-count')).toHaveCount(0)
    await expect(digger.locator('a.ws-film-link')).toHaveCount(0)
    await expect(page.locator('.ws-card.-hero')).toHaveCount(0)
  })
})

const FILM = {
  film: { slug: 'digger-2026', title: 'Digger', year: '2026', poster: null },
  members: 5, logs: 6, thisWeek: 2, avg: 4.2, liked: 3,
  histogram: { '0.5': 0, '1': 0, '1.5': 0, '2': 0, '2.5': 0, '3': 1, '3.5': 0, '4': 1, '4.5': 2, '5': 1 },
  screenings: [],
}

async function mockFilm(page: Page, status: number, body: any) {
  await page.route(`${WORKER_ORIGIN}/films/digger-2026*`, route =>
    route.fulfill({ status, json: body, headers: { 'Access-Control-Allow-Origin': '*' } }))
}

test.describe('film page', () => {
  test('public view: counts and ratings, names behind sign-in', async ({ page }) => {
    await mockFilm(page, 200, FILM)
    await page.goto('/film?slug=digger-2026')

    await expect(page.locator('.fp-title')).toContainText('Digger')
    await expect(page.locator('.fp-count')).toHaveText('5 members have logged it · 2 this week')
    await expect(page.locator('.fp-logs')).toHaveText('6 logs, rewatches included')
    await expect(page.locator('.fp-avg-num')).toBeVisible()
    await expect(page.locator('.fp-bar')).toHaveCount(10)
    await expect(page.locator('.fp-watchers')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin')
  })

  test('signed in: watcher list with rating, dates and review', async ({ page }) => {
    await signInAs(page, 'ml@example.com', { id: 'ml-seed001', name: 'Michael Lamb', handle: 'michaellamb' })
    await mockFilm(page, 200, {
      ...FILM,
      you: true,
      watchers: [
        { name: 'Michael Lamb', handle: 'michaellamb', rating: 4.5, liked: true, dates: ['2026-10-12', '2026-10-06'], review: 'Dug it.' },
        { name: 'Kathy', handle: 'winonarideher', rating: 3, liked: false, dates: ['2026-10-01'], review: null },
      ],
    })
    await page.goto('/film?slug=digger-2026')

    await expect(page.locator('.fp-count')).toHaveText('You + 4 others have logged it · 2 this week')
    const rows = page.locator('.fp-watcher')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('Michael Lamb')
    await expect(rows.first().locator('.fp-w-review')).toHaveText('Dug it.')
    await expect(rows.first().locator('.fp-w-dates')).toContainText('2026')
    await expect(page.getByText('to see who')).toHaveCount(0)
  })

  test('404 reads as not logged yet; 503 as resting', async ({ page }) => {
    await mockFilm(page, 404, { error: 'not found' })
    await page.goto('/film?slug=digger-2026')
    await expect(page.getByRole('heading', { name: 'Not logged yet' })).toBeVisible()

    await page.unroute(`${WORKER_ORIGIN}/films/digger-2026*`)
    await mockFilm(page, 503, { error: 'unavailable' })
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Film stats are resting' })).toBeVisible()
  })

  test('a cold load of /film/SLUG is rewritten to the query form', async ({ page }) => {
    await mockFilm(page, 200, FILM)
    await page.goto('/film/digger-2026')
    await expect(page.locator('.fp-title')).toContainText('Digger')
    await expect(page).toHaveURL(/\/film\?slug=digger-2026$/)
  })

  test('strip title navigates to the film page in the SPA', async ({ page }) => {
    await mockWatched(page)
    await mockStats(page, { 'digger-2026': { members: 9, logs: 11, thisWeek: 5 } })
    await mockFilm(page, 200, FILM)
    await page.goto('/watched')
    await card(page, 'Digger').locator('a.ws-film-link').click()
    await expect(page).toHaveURL(/\/film\?slug=digger-2026$/)
    await expect(page.locator('.fp-title')).toContainText('Digger')
  })
})

test.describe('films API on the local Worker (real FILMS_DB)', () => {
  test('stats for unknown slugs are empty; an unknown film is 404', async ({ request }) => {
    const stats = await request.get(`${WORKER_ORIGIN}/films/stats?slugs=never-logged-1999`)
    expect(stats.status()).toBe(200)
    expect(await stats.json()).toEqual({ stats: {} })

    const film = await request.get(`${WORKER_ORIGIN}/films/never-logged-1999`)
    expect(film.status()).toBe(404)
  })
})
