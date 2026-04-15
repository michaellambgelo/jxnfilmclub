import { test, expect, seedKv } from './fixtures'

const EMAIL = 'michaellamb-e2e@example.com'
const HANDLE = 'michaellamb'
const CODE = '424242'

async function requestCode(page: any) {
  // Go through the real email step, then overwrite the random code the Worker
  // just wrote with a known one. Can't seed before sendCode — sendCode itself
  // puts a random code at the same KV key.
  await page.goto('/signin')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByRole('button', { name: /email me a code/i }).click()
  await expect(page.getByLabel('Code')).toBeVisible()
  await seedKv(page, `otp:${EMAIL}`, CODE, 600)
}

test.describe('signin + edit flow', () => {
  test('email step renders and transitions to code step', async ({ page }) => {
    await page.goto('/signin')
    await expect(page.locator('h1')).toHaveText('Sign in to edit your entry')

    await page.getByLabel('Email').fill(EMAIL)
    await page.getByRole('button', { name: /email me a code/i }).click()

    await expect(page.getByLabel('Code')).toBeVisible()
    await expect(page.locator('p.lede')).toContainText(EMAIL)
  })

  test('valid code redirects to /edit with prefilled form', async ({ page }) => {
    await seedKv(page, `handle:${EMAIL}`, HANDLE)
    await requestCode(page)

    await page.getByLabel('Code').fill(CODE)
    await page.getByRole('button', { name: /verify/i }).click()

    await page.waitForURL('**/edit')
    await expect(page.locator('h1')).toHaveText('Edit your entry')
    await expect(page.getByLabel('Display name')).toHaveValue('Michael Lamb')
    await expect(page.locator('p.lede')).toContainText(EMAIL)
  })

  test('wrong code shows error and stays on code step', async ({ page }) => {
    await requestCode(page)

    await page.getByLabel('Code').fill('000000')
    await page.getByRole('button', { name: /verify/i }).click()

    await expect(page.locator('.err')).toContainText('invalid code')
    await expect(page.getByLabel('Code')).toBeVisible()
  })

  test('save on /edit posts update and shows success', async ({ page }) => {
    await seedKv(page, `handle:${EMAIL}`, HANDLE)
    await requestCode(page)

    await page.getByLabel('Code').fill(CODE)
    await page.getByRole('button', { name: /verify/i }).click()
    await page.waitForURL('**/edit')

    await page.getByLabel('Pronouns').fill('they/them')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.ok')).toContainText('Saved')
  })
})
