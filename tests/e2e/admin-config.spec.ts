import { test, expect, seedKv, WORKER_ORIGIN } from './fixtures'
import type { Page } from '@playwright/test'

// The admin Config tab: what a save writes, and what makes it write nothing.
// Every rule here can lose or publish site content, so each is pinned against
// the KV the join Worker reads rather than against what the tab displays.
const ADMIN_ORIGIN = 'http://localhost:5175'

async function getKv(page: Page, key: string): Promise<string | null> {
  const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=${encodeURIComponent(key)}`)
  expect(res.ok()).toBeTruthy()
  return (await res.json()).value
}
const getJson = async (page: Page, key: string) => {
  const raw = await getKv(page, key)
  return raw ? JSON.parse(raw) : null
}

// An existing podcast override keeps the tab from fetching the live site's
// episodes.json, so the tests that are not about the podcast stay offline.
const seedPodcast = (page: Page) =>
  seedKv(page, 'config:podcast', JSON.stringify({ featured_id: '', episodes: [{ title: 'Seeded', url: 'https://example.test/ep' }] }))

async function openConfig(page: Page) {
  await page.goto(`${ADMIN_ORIGIN}/`)
  await page.locator('#tabs button[data-tab="config"]').click()
  await expect(page.locator('#cfg-theaters')).toBeVisible()
}

// One section of the tab, opened and ready to type into.
async function section(page: Page, id: string) {
  return page.locator(`#cfg-${id}`)
}
const badge = (page: Page, id: string) => page.locator(`#cfg-${id} h3 .pill`)

test.describe('admin Config tab', () => {
  test('reset deletes the key and the section goes back to defaults', async ({ page }) => {
    page.on('dialog', d => d.accept())
    await seedPodcast(page)
    await seedKv(page, 'config:theaters', JSON.stringify(['Only One Cinema']))
    await openConfig(page)

    const s = await section(page, 'theaters')
    await expect(s.locator('input[data-theater]')).toHaveCount(1)
    await expect(badge(page, 'theaters')).toHaveClass(/\bon\b/)

    await s.locator('button[data-action="cfg-theaters-reset"]').click()
    await expect.poll(() => getKv(page, 'config:theaters')).toBeNull()
    await expect(badge(page, 'theaters')).toHaveClass(/\boff\b/)
    await expect((await section(page, 'theaters')).locator('input[data-theater]')).toHaveCount(7)
  })

  test('homepage copy stores only the filled fields, and nothing at all when every field is empty', async ({ page }) => {
    await seedPodcast(page)
    await openConfig(page)

    const s = await section(page, 'copy')
    await s.locator('[data-copy-field="heroLabel"]').fill('  A new label  ')
    await s.locator('button[data-action="cfg-copy-save"]').click()
    await expect.poll(() => getJson(page, 'config:copy')).toEqual({ heroLabel: 'A new label' })

    const again = await section(page, 'copy')
    await expect(again.locator('[data-copy-field="heroLabel"]')).toHaveValue('A new label')
    await again.locator('[data-copy-field="heroLabel"]').fill('')
    await again.locator('button[data-action="cfg-copy-save"]').click()
    await expect.poll(() => getKv(page, 'config:copy')).toBeNull()
  })

  test('an empty newsletter template deletes the key instead of storing blanks', async ({ page }) => {
    await seedPodcast(page)
    await seedKv(page, 'config:newsletter_template', JSON.stringify({ subject: 'Stored subject', html: '<p>Stored</p>' }))
    await openConfig(page)

    const s = await section(page, 'nl-template')
    await expect(s.locator('#cfg-nl-subject')).toHaveValue('Stored subject')
    await s.locator('#cfg-nl-subject').fill('')
    await s.locator('#cfg-nl-html').fill('')
    await s.locator('button[data-action="cfg-nl-save"]').click()
    await expect.poll(() => getKv(page, 'config:newsletter_template')).toBeNull()
  })

  test('podcast save keeps fields the editor does not know about', async ({ page }) => {
    await seedKv(page, 'config:podcast', JSON.stringify({
      featured_id: 'abc', show: 'keep me',
      episodes: [{ id: 'abc', title: 'First', date: '2026-01-02', url: 'https://example.test/1', extra: 1 }],
    }))
    await openConfig(page)

    const s = await section(page, 'podcast')
    await s.locator('input[data-ep-field="title"]').first().fill('First, retitled')
    await s.locator('button[data-action="cfg-podcast-save"]').click()
    await expect.poll(() => getJson(page, 'config:podcast')).toEqual({
      featured_id: 'abc', show: 'keep me',
      episodes: [{ id: 'abc', title: 'First, retitled', date: '2026-01-02', url: 'https://example.test/1', extra: 1 }],
    })
  })

  test('podcast save asks before publishing an empty episode list', async ({ page }) => {
    await seedKv(page, 'config:podcast', JSON.stringify({ featured_id: 'before', episodes: [] }))
    await openConfig(page)

    const s = await section(page, 'podcast')
    await s.locator('#cfg-featured').fill('after')

    let asked = ''
    page.once('dialog', d => { asked = d.message(); d.dismiss() })
    await s.locator('button[data-action="cfg-podcast-save"]').click()
    await expect.poll(() => asked).toMatch(/EMPTY episode list/)
    expect((await getJson(page, 'config:podcast')).featured_id).toBe('before')

    page.once('dialog', d => d.accept())
    await s.locator('button[data-action="cfg-podcast-save"]').click()
    await expect.poll(async () => (await getJson(page, 'config:podcast')).featured_id).toBe('after')
  })

  test('podcast warns when the live episode list could not be loaded', async ({ page }) => {
    await page.route('https://jxnfilm.club/data/episodes.json', r => r.abort())
    await openConfig(page)

    const s = await section(page, 'podcast')
    await expect(s.locator('.cfg-warn')).toContainText(/started\s+empty/i)
    await expect(s.locator('.cfg-episode')).toHaveCount(0)
    expect(await getKv(page, 'config:podcast')).toBeNull()
  })

  test('map venues refuse a row with bad coordinates and write nothing', async ({ page }) => {
    await seedPodcast(page)
    await openConfig(page)

    const s = await section(page, 'venues')
    await s.locator('button[data-action="cfg-venue-add"]').click()
    const row = s.locator('.cfg-venue-row').last()
    await row.locator('[data-venue-field="name"]').fill('Bad Coordinates Hall')
    await row.locator('[data-venue-field="coords"]').fill('somewhere downtown')
    await s.locator('button[data-action="cfg-venues-save"]').click()

    await expect(page.locator('#toast')).toContainText('Bad Coordinates Hall: coordinates must be')
    expect(await getKv(page, 'config:venues')).toBeNull()

    await row.locator('[data-venue-field="coords"]').fill('32.3, -90.18')
    await s.locator('button[data-action="cfg-venues-save"]').click()
    await expect.poll(async () => (await getJson(page, 'config:venues'))?.length).toBe(14)
    const saved = (await getJson(page, 'config:venues')).at(-1)
    expect(saved).toEqual({ name: 'Bad Coordinates Hall', address: '', lat: 32.3, lng: -90.18, aliases: [] })
  })

  test('voice prompt needs an id and text, and stores the slugged id', async ({ page }) => {
    await seedPodcast(page)
    await openConfig(page)

    const s = await section(page, 'voice-prompt')
    await s.locator('#cfg-vp-id').fill('Best Of 2026')
    await s.locator('button[data-action="cfg-vp-save"]').click()
    await expect(page.locator('#toast')).toContainText('Prompt needs an id')
    expect(await getKv(page, 'config:voice_prompt')).toBeNull()

    await s.locator('#cfg-vp-text').fill('What was your film of the year?')
    await s.locator('button[data-action="cfg-vp-save"]').click()
    await expect.poll(() => getJson(page, 'config:voice_prompt'))
      .toEqual({ id: 'best-of-2026', text: 'What was your film of the year?' })
    await expect(badge(page, 'voice-prompt')).toHaveClass(/\bon\b/)
  })
})
