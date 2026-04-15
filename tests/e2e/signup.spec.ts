import { test, expect, WORKER_ORIGIN, seedKv } from './fixtures'

// Signup happens on the Worker origin (join.jxnfilm.club). On success it
// redirects to the main site with a session token in the URL fragment.

async function readPendingCode(page: any, email: string): Promise<string> {
  const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=pending:${encodeURIComponent(email)}`)
  const body = await res.json()
  return JSON.parse(body.value).code
}

test.describe('signup (join.jxnfilm.club)', () => {
  test('without a handle: signup → verify → redirect to /edit signed in', async ({ page }) => {
    const email = 'newbie@example.com'
    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Newbie')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: /email me a code/i }).click()

    await expect(page.getByLabel('Code')).toBeVisible()
    const code = await readPendingCode(page, email)
    await page.getByLabel('Code').fill(code)
    await page.getByRole('button', { name: /confirm membership/i }).click()

    // Worker redirects to main site; the URL fragment carries the session.
    await page.waitForURL('**/edit*', { timeout: 10_000 })
    await expect(page.locator('h1')).toHaveText('Your account')
    await expect(page.locator('p.lede').first()).toContainText(email)

    // Session persisted in localStorage after the hash handoff.
    const session = await page.evaluate(() => localStorage.jxnfc_session)
    expect(session).toBeTruthy()
    expect(JSON.parse(session!).email).toBe(email)

    // Member record written to KV.
    const memRes = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=member:${encodeURIComponent(email)}`)
    const member = JSON.parse((await memRes.json()).value)
    expect(member.name).toBe('Newbie')
    expect(member.handle).toBeNull()
  })

  test('with a handle: lb_token is minted for later verification', async ({ page }) => {
    const email = 'with-handle@example.com'
    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Handle User')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Letterboxd username').fill('handleuser')
    await page.getByRole('button', { name: /email me a code/i }).click()

    const lbRes = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=lb_token:${encodeURIComponent(email)}`)
    const lb = JSON.parse((await lbRes.json()).value)
    expect(lb.token).toMatch(/^jxnfc-verify-/)
    expect(lb.handle).toBe('handleuser')
  })

  test('duplicate email rejected with 409', async ({ page }) => {
    const email = 'exists@example.com'
    await seedKv(page, `member:${email}`, JSON.stringify({ id: 'x', email, name: 'Y' }))

    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Dupe')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: /email me a code/i }).click()
    await expect(page.locator('#status.err')).toContainText('already a member')
  })

  test('claimed handle rejected with 409', async ({ page }) => {
    await seedKv(page, 'email:spoken-for', 'other@example.com')

    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Late')
    await page.getByLabel('Email').fill('late@example.com')
    await page.getByLabel('Letterboxd username').fill('spoken-for')
    await page.getByRole('button', { name: /email me a code/i }).click()
    await expect(page.locator('#status.err')).toContainText('already claimed')
  })

  test('wrong code on verify stays on code step with an error', async ({ page }) => {
    const email = 'wrong-code@example.com'
    await page.goto(WORKER_ORIGIN + '/')
    await page.getByLabel('Display name').fill('Wrong Code')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: /email me a code/i }).click()

    await expect(page.getByLabel('Code')).toBeVisible()
    await page.getByLabel('Code').fill('000000')
    await page.getByRole('button', { name: /confirm membership/i }).click()
    await expect(page.locator('#status.err')).toContainText('invalid code')
  })

  test('privacy policy loads', async ({ page }) => {
    await page.goto(WORKER_ORIGIN + '/privacy')
    await expect(page.locator('body')).toContainText(/privacy/i)
  })
})
