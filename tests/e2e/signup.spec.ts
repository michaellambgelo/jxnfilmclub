import { test, expect, WORKER_ORIGIN, seedKv } from './fixtures'

// Signup flow:
//   1. User fills the form on join.jxnfilm.club → POST /signup (Worker)
//   2. Worker sends OTP + LB tag email, returns { ok: true }
//   3. Browser is redirected to jxnfilm.club/verify?email=... (main site)
//   4. User enters code → main site calls POST /signup/verify → session stored
//      in localStorage on jxnfilm.club, redirect to /edit.

async function readPendingCode(page: any, email: string): Promise<string> {
  const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=pending:${encodeURIComponent(email)}`)
  const value = (await res.json()).value
  if (!value) throw new Error(`no pending for ${email}`)
  return JSON.parse(value).code
}

test.describe('signup (join.jxnfilm.club → jxnfilm.club/verify)', () => {
  test('without a handle: form submit redirects to /verify, code lands user on /edit', async ({ page }) => {
    const email = 'newbie@example.com'
    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Newbie')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: /email me a code/i }).click()

    // Worker redirects to the main site's /verify view with the email prefilled.
    await page.waitForURL(new RegExp(`/verify\\?email=${encodeURIComponent(email)}`))
    await expect(page.locator('h1')).toHaveText('Confirm your email')
    await expect(page.locator('p.lede')).toContainText(email)

    const code = await readPendingCode(page, email)
    await page.getByLabel('Code').fill(code)
    await page.getByRole('button', { name: /confirm membership/i }).click()

    await page.waitForURL('**/edit')
    await expect(page.locator('h1')).toHaveText('Your account')
    const session = await page.evaluate(() => localStorage.jxnfc_session)
    expect(session).toBeTruthy()
    expect(JSON.parse(session!).email).toBe(email)

    // KV reflects the new member.
    const memRes = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=member:${encodeURIComponent(email)}`)
    const member = JSON.parse((await memRes.json()).value)
    expect(member.name).toBe('Newbie')
    expect(member.handle).toBeNull()
  })

  test('with a handle: lb_token is minted so Letterboxd verification can follow', async ({ page }) => {
    const email = 'with-handle@example.com'
    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Handle User')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Letterboxd username').fill('handleuser')
    await page.getByRole('button', { name: /email me a code/i }).click()

    await page.waitForURL(/\/verify/)

    const lbRes = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=lb_token:${encodeURIComponent(email)}`)
    const lb = JSON.parse((await lbRes.json()).value)
    expect(lb.token).toMatch(/^jxnfc-verify-/)
    expect(lb.handle).toBe('handleuser')
  })

  test('duplicate email stays on signup form with an error', async ({ page }) => {
    const email = 'exists@example.com'
    await seedKv(page, `member:${email}`, JSON.stringify({ id: 'x', email, name: 'Y' }))

    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Dupe')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: /email me a code/i }).click()
    await expect(page.locator('#status.err')).toContainText('already a member')
    // No redirect happened.
    expect(page.url().startsWith(WORKER_ORIGIN)).toBe(true)
  })

  test('claimed handle stays on signup form with an error', async ({ page }) => {
    await seedKv(page, 'email:spoken-for', 'other@example.com')

    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Late')
    await page.getByLabel('Email').fill('late@example.com')
    await page.getByLabel('Letterboxd username').fill('spoken-for')
    await page.getByRole('button', { name: /email me a code/i }).click()
    await expect(page.locator('#status.err')).toContainText('already claimed')
  })

  test('wrong code on /verify stays on the page with an error', async ({ page }) => {
    const email = 'wrong-code@example.com'
    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Wrong Code')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: /email me a code/i }).click()
    await page.waitForURL(/\/verify/)

    await page.getByLabel('Code').fill('000000')
    await page.getByRole('button', { name: /confirm membership/i }).click()
    await expect(page.locator('.err')).toContainText('invalid code')
    await expect(page.url()).toMatch(/\/verify/)
  })

  test('/verify without an email query param falls back to asking for one', async ({ page }) => {
    await page.goto('/verify')
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Code')).toBeVisible()
  })

  test('privacy policy loads', async ({ page }) => {
    await page.goto(WORKER_ORIGIN + '/privacy')
    await expect(page.locator('body')).toContainText(/privacy/i)
  })
})
