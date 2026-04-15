import { test, expect, WORKER_ORIGIN } from './fixtures'

test.describe('signup form (join.jxnfilm.club)', () => {
  test('valid submission reveals verify panel with token', async ({ page }) => {
    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Test User')
    await page.getByLabel('Letterboxd username').fill('testuser')
    await page.getByLabel('Email').fill('testuser@example.com')
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.locator('#verify-panel')).toBeVisible()
    await expect(page.locator('#vtoken')).toHaveText(/^jxnfc-verify-[A-Za-z0-9]{8}$/)
  })

  test('unknown Letterboxd handle shows error', async ({ page }) => {
    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Ghost')
    await page.getByLabel('Letterboxd username').fill('ghost')
    await page.getByLabel('Email').fill('ghost@example.com')
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect(page.locator('#status.err')).toContainText('Letterboxd profile not found')
    await expect(page.locator('#verify-panel')).toBeHidden()
  })

  test('verify step surfaces 422 when token not on profile', async ({ page }) => {
    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Token Test')
    await page.getByLabel('Letterboxd username').fill('tokentest')
    await page.getByLabel('Email').fill('tokentest@example.com')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect(page.locator('#verify-panel')).toBeVisible()

    await page.getByRole('button', { name: "I've added it — verify me" }).click()
    await expect(page.locator('#status.err')).toContainText('token not found')
  })

  test('privacy policy loads', async ({ page }) => {
    await page.goto(WORKER_ORIGIN + '/privacy')
    await expect(page.locator('body')).toContainText(/privacy/i)
  })
})
