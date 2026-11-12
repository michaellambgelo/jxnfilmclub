import { test, expect, seedKv, WORKER_ORIGIN } from './fixtures'
import type { Page } from '@playwright/test'

// Correcting the public /n/{id} copy of a newsletter that has already gone
// out. The composer doubles as the editor, so the thing most worth pinning is
// that a sent newsletter is never loaded next to a working send button.
const ADMIN_ORIGIN = 'http://localhost:5175'
const ID = '2026-09-september-dispatch-a1b2c3d4e5'
const AT = '2026-09-01T00:00:00.000Z'

async function getJson(page: Page, key: string) {
  const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=${encodeURIComponent(key)}`)
  expect(res.ok()).toBeTruthy()
  const raw = (await res.json()).value
  return raw ? JSON.parse(raw) : null
}

async function openWithSentNewsletter(page: Page) {
  await seedKv(page, `newsletter:archive:${ID}`, JSON.stringify({
    subject: 'September dispatch', html: '<p>Sherlock Jr. on Friday</p>', text: 'Sherlock Jr. on Friday',
    at: AT, test: false,
  }))
  await seedKv(page, `newsletter:sent:${AT}`, JSON.stringify({
    subject: 'September dispatch', count: 12, at: Date.parse(AT), archiveId: ID,
  }))
  await page.goto(`${ADMIN_ORIGIN}/`)
  await page.locator('#tabs button[data-tab="newsletter"]').click()
  return page.locator('.nl-history tbody tr', { hasText: 'September dispatch' })
}

test.describe('admin Newsletter: editing a shared copy', () => {
  test('edit loads the sent newsletter, hides the send buttons, and save updates the public page', async ({ page }) => {
    const row = await openWithSentNewsletter(page)
    await page.locator('#nl-subject').fill('A draft in progress')

    await row.getByRole('button', { name: 'edit' }).click()
    await expect(page.locator('#nl-compose-title')).toHaveText('Edit shared copy')
    await expect(page.locator('#nl-edit-banner')).toContainText('already been sent')
    await expect(page.locator('#nl-subject')).toHaveValue('September dispatch')
    await expect(page.locator('#nl-html')).toHaveValue('<p>Sherlock Jr. on Friday</p>')
    await expect(page.locator('button[data-action="nl-send"]')).toBeHidden()
    await expect(page.locator('button[data-action="nl-test"]')).toBeHidden()
    await expect(page.locator('#nl-compose-hint')).toBeHidden()

    await page.locator('#nl-subject').fill('September dispatch (corrected)')
    await page.locator('#nl-html').fill('<p>Sherlock Jr. on Saturday</p>')
    await page.locator('#nl-text').fill('Sherlock Jr. on Saturday')
    await page.locator('button[data-action="nl-archive-save"]').click()

    await expect.poll(async () => (await getJson(page, `newsletter:archive:${ID}`)).html)
      .toBe('<p>Sherlock Jr. on Saturday</p>')
    const rec = await getJson(page, `newsletter:archive:${ID}`)
    expect(rec.at).toBe(AT)
    expect(rec.original.html).toBe('<p>Sherlock Jr. on Friday</p>')
    expect((await getJson(page, `newsletter:sent:${AT}`)).subject).toBe('September dispatch (corrected)')
    // Nothing was mailed.
    expect(await getJson(page, '__last_newsletter__')).toBeNull()

    const pub = await (await page.request.get(`${WORKER_ORIGIN}/n/${ID}`)).text()
    expect(pub).toContain('Sherlock Jr. on Saturday')
    expect(pub).toMatch(/updated \d{4}-\d{2}-\d{2} after it was sent/)

    // Back to composing: the draft is restored and sending is available again.
    await expect(page.locator('#nl-compose-title')).toHaveText('Compose')
    await expect(page.locator('#nl-subject')).toHaveValue('A draft in progress')
    await expect(page.locator('button[data-action="nl-send"]')).toBeVisible()
    await expect(row.locator('.nl-history-subject')).toHaveText('September dispatch (corrected)')
  })

  test('cancel asks only when something changed, and writes nothing', async ({ page }) => {
    const row = await openWithSentNewsletter(page)
    let asked = 0
    page.on('dialog', d => { asked++; d.accept() })

    await row.getByRole('button', { name: 'edit' }).click()
    await expect(page.locator('#nl-subject')).toHaveValue('September dispatch')
    await page.locator('button[data-action="nl-archive-cancel"]').click()
    expect(asked).toBe(0)
    await expect(page.locator('#nl-compose-title')).toHaveText('Compose')

    await row.getByRole('button', { name: 'edit' }).click()
    await expect(page.locator('#nl-subject')).toHaveValue('September dispatch')
    await page.locator('#nl-html').fill('<p>Never saved</p>')
    await page.locator('button[data-action="nl-archive-cancel"]').click()
    expect(asked).toBe(1)
    await expect(page.locator('button[data-action="nl-send"]')).toBeVisible()
    const rec = await getJson(page, `newsletter:archive:${ID}`)
    expect(rec.html).toBe('<p>Sherlock Jr. on Friday</p>')
    expect(rec.editedAt).toBeUndefined()
  })

  test('a double click on edit cannot make the sent newsletter the draft that Cancel restores', async ({ page }) => {
    const row = await openWithSentNewsletter(page)
    await page.locator('#nl-subject').fill('A draft in progress')
    await row.getByRole('button', { name: 'edit' }).dblclick()
    await expect(page.locator('#nl-subject')).toHaveValue('September dispatch')
    await page.locator('button[data-action="nl-archive-cancel"]').click()
    await expect(page.locator('#nl-subject')).toHaveValue('A draft in progress')
    await expect(page.locator('#nl-html')).not.toHaveValue('<p>Sherlock Jr. on Friday</p>')
  })

  test('a body the send would refuse is refused here too', async ({ page }) => {
    const row = await openWithSentNewsletter(page)
    await row.getByRole('button', { name: 'edit' }).click()
    await expect(page.locator('#nl-subject')).toHaveValue('September dispatch')
    await page.locator('#nl-html').fill('<img src="https://join-staging.jxnfilm.club/nl/img/abc.jpg">')
    await page.locator('button[data-action="nl-archive-save"]').click()
    await expect(page.locator('#nl-compose-title')).toHaveText('Edit shared copy')
    expect((await getJson(page, `newsletter:archive:${ID}`)).html).toBe('<p>Sherlock Jr. on Friday</p>')
  })
})
