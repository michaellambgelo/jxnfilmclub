import { test, expect, seedKv, WORKER_ORIGIN } from './fixtures'
import type { Page } from '@playwright/test'

const EMAIL = 'remember-e2e@example.com'
const CODE = '424242'

// Sign in through the real OTP flow with the remember checkbox ticked.
async function signInRemembered(page: Page) {
  await seedKv(page, `member:${EMAIL}`, JSON.stringify({
    id: 'id-' + EMAIL, email: EMAIL, name: 'Remembered Member', pronouns: null, handle: null, joined: '2026-04-15',
  }))
  await page.goto('/signin')
  await page.getByLabel('Email', { exact: true }).fill(EMAIL)
  await page.getByRole('button', { name: /log in/i }).click()
  await expect(page.getByLabel('Code')).toBeVisible()
  await seedKv(page, `otp:${EMAIL}`, CODE, 600)
  await page.getByLabel('Code').fill(CODE)
  await page.getByRole('checkbox', { name: /remember my login/i }).check()
  await page.getByRole('button', { name: /verify/i }).click()
  await page.waitForURL('**/edit')
}

function readSession(page: Page) {
  return page.evaluate(() => {
    const raw = localStorage.jxnfc_session as string | undefined
    return raw ? JSON.parse(raw) : null
  })
}

// Simulate the 1-hour token lapsing without waiting an hour.
function expireToken(page: Page) {
  return page.evaluate(() => {
    const s = JSON.parse(localStorage.jxnfc_session as string)
    s.exp = Date.now() - 1000
    localStorage.jxnfc_session = JSON.stringify(s)
  })
}

test.describe('remember my login on this device', () => {
  test('checking the box stores a refresh token alongside the session', async ({ page }) => {
    await signInRemembered(page)
    const s = await readSession(page)
    expect(s.refresh).toMatch(/\.[a-z0-9]{32}$/)
  })

  test('a lapsed token is silently refreshed on /edit instead of bouncing to /signin', async ({ page }) => {
    await signInRemembered(page)
    await expireToken(page)

    await page.goto('/edit')
    await expect(page.locator('article.auth h1')).toHaveText('Your account')
    await expect(page.getByLabel('Display name')).toHaveValue('Remembered Member')

    const s = await readSession(page)
    expect(s.exp).toBeGreaterThan(Date.now())
    expect(s.refresh).toBeTruthy()
  })

  test('without the checkbox, a lapsed token still bounces to /signin', async ({ page }) => {
    await seedKv(page, `member:${EMAIL}`, JSON.stringify({
      id: 'id-' + EMAIL, email: EMAIL, name: 'Plain Member', pronouns: null, handle: null, joined: '2026-04-15',
    }))
    await page.goto('/signin')
    await page.getByLabel('Email', { exact: true }).fill(EMAIL)
    await page.getByRole('button', { name: /log in/i }).click()
    await expect(page.getByLabel('Code')).toBeVisible()
    await seedKv(page, `otp:${EMAIL}`, CODE, 600)
    await page.getByLabel('Code').fill(CODE)
    await page.getByRole('button', { name: /verify/i }).click()
    await page.waitForURL('**/edit')

    await expireToken(page)
    await page.goto('/edit')
    await page.waitForURL('**/signin')
  })

  test('sign out revokes the device token — the lapsed session cannot refresh again', async ({ page }) => {
    await signInRemembered(page)
    const s = await readSession(page)

    await page.getByRole('button', { name: /sign out/i }).click()
    await page.waitForURL(url => !url.pathname.includes('edit'))
    expect(await readSession(page)).toBeNull()

    // The server-side record is gone: replaying the old refresh token 401s.
    const res = await page.request.post(`${WORKER_ORIGIN}/session/refresh`, {
      data: { refresh: s.refresh },
    })
    expect(res.status()).toBe(401)
  })
})
