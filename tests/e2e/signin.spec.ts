import { test, expect, seedKv, signInAs } from './fixtures'

const EMAIL = 'michaellamb-e2e@example.com'
const CODE = '424242'

test.describe('sign-in flow (returning members)', () => {
  test('email step renders and transitions to code step', async ({ page }) => {
    await seedKv(page, `member:${EMAIL}`, JSON.stringify({
      id: 'id-' + EMAIL, email: EMAIL, name: 'E2E Member', handle: null, joined: '2026-01-01',
    }))

    await page.goto('/signin')
    await expect(page.locator('h1')).toHaveText('Log in')

    await page.getByLabel('Email').fill(EMAIL)
    await page.getByRole('button', { name: /email me a code/i }).click()

    await expect(page.getByLabel('Code')).toBeVisible()
    await expect(page.locator('p.lede')).toContainText(EMAIL)
  })

  test('valid code redirects to /edit with prefilled name', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Prefilled Name' })
    await expect(page.locator('h1')).toHaveText('Your account')
    await expect(page.getByLabel('Display name')).toHaveValue('Prefilled Name')
    await expect(page.locator('p.lede').first()).toContainText(EMAIL)
  })

  test('wrong code shows invalid-code error', async ({ page }) => {
    await seedKv(page, `member:${EMAIL}`, JSON.stringify({
      id: 'id-' + EMAIL, email: EMAIL, name: 'X', handle: null, joined: '2026-01-01',
    }))

    await page.goto('/signin')
    await page.getByLabel('Email').fill(EMAIL)
    await page.getByRole('button', { name: /email me a code/i }).click()
    await expect(page.getByLabel('Code')).toBeVisible()
    await seedKv(page, `otp:${EMAIL}`, CODE, 600)

    await page.getByLabel('Code').fill('000000')
    await page.getByRole('button', { name: /verify/i }).click()
    await expect(page.locator('.err')).toContainText('invalid code')
  })

  test('save on /edit posts member update and shows success', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Save Me' })
    await page.getByLabel('Pronouns').fill('they/them')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.ok')).toContainText('Saved')
  })
})
