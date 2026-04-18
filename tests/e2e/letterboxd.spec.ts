import { test, expect, signInAs, primeLbRss, seedKv, WORKER_ORIGIN, LB_STUB_ORIGIN } from './fixtures'

test.describe('Letterboxd verification from /edit', () => {
  test('no handle yet → request tag → paste diary URL → verified', async ({ page }) => {
    const email = 'lb-flow@example.com'
    await signInAs(page, email)

    // Start state: no Letterboxd on record.
    await expect(page.getByRole('heading', { name: 'Letterboxd' })).toBeVisible()
    await expect(page.getByLabel('Letterboxd username')).toBeVisible()

    // Request a tag for a new handle.
    await page.getByLabel('Letterboxd username').fill('flowuser')
    await page.getByRole('button', { name: /get verification tag/i }).click()

    // Tag appears. Capture it and prime the stub so the diary URL scrape finds it.
    const tokenEl = page.locator('.lb-token')
    await expect(tokenEl).toBeVisible()
    const token = (await tokenEl.textContent())!.trim()
    expect(token).toMatch(/^jxnfc-verify-[A-Za-z0-9]{8}$/)
    await primeLbRss(page, token)

    // Paste a diary URL and submit. Worker's LETTERBOXD_BASE points at the
    // local stub origin for E2E, so the pasted URL must share that origin
    // to pass the Worker's SSRF/origin check.
    await page.getByLabel('Diary entry or list URL').fill(
      `${LB_STUB_ORIGIN}/flowuser/film/heroic-times/`)
    await page.getByRole('button', { name: /verify letterboxd/i }).click()
    await expect(page.locator('.ok')).toContainText('Verified as')
    await expect(page.getByRole('link', { name: '@flowuser' })).toBeVisible()
  })

  test('tag missing on pasted page → 422 error surfaced, lb_token kept', async ({ page }) => {
    const email = 'lb-missing@example.com'
    await signInAs(page, email)

    await page.getByLabel('Letterboxd username').fill('missinguser')
    await page.getByRole('button', { name: /get verification tag/i }).click()
    await expect(page.locator('.lb-token')).toBeVisible()

    // Stub serves a page without the token by default.
    await primeLbRss(page, null)
    await page.getByLabel('Diary entry or list URL').fill(
      `${LB_STUB_ORIGIN}/missinguser/film/untagged/`)
    await page.getByRole('button', { name: /verify letterboxd/i }).click()
    await expect(page.locator('.err')).toContainText(/couldn't find the tag/)
    // Still showing the tag (pending state intact)
    await expect(page.locator('.lb-token')).toBeVisible()
  })

  test('pasted URL pointing at another handle is rejected before any fetch', async ({ page }) => {
    const email = 'lb-hijack@example.com'
    await signInAs(page, email)

    await page.getByLabel('Letterboxd username').fill('rightfuluser')
    await page.getByRole('button', { name: /get verification tag/i }).click()
    await expect(page.locator('.lb-token')).toBeVisible()

    await page.getByLabel('Diary entry or list URL').fill(
      `${LB_STUB_ORIGIN}/someoneelse/film/foo/`)
    await page.getByRole('button', { name: /verify letterboxd/i }).click()
    await expect(page.locator('.err')).toContainText(/under letterboxd\.com\/rightfuluser/)
  })

  test('already-verified members see the verified state', async ({ page }) => {
    const email = 'already-verified@example.com'
    // Seed auxiliary KV rows the verified state reads from Worker,
    // then sign in through the normal flow.
    await seedKv(page, 'email:avuser', email)
    await seedKv(page, `handle:${email}`, 'avuser')
    await signInAs(page, email, { name: 'AV', handle: 'avuser' })

    await expect(page.locator('.ok')).toContainText('Verified as')
    await expect(page.getByRole('link', { name: '@avuser' })).toBeVisible()
  })

  test('verified member can unlink Letterboxd; panel flips back to none', async ({ page }) => {
    const email = 'unlink-e2e@example.com'
    await seedKv(page, 'email:unlinkbox', email)
    await seedKv(page, `handle:${email}`, 'unlinkbox')
    await signInAs(page, email, { name: 'Unlink Me', handle: 'unlinkbox' })

    await expect(page.getByRole('link', { name: '@unlinkbox' })).toBeVisible()

    page.on('dialog', d => d.accept())
    await page.getByRole('button', { name: /remove letterboxd link/i }).click()

    await expect(page.getByLabel('Letterboxd username')).toBeVisible()
    await expect(page.getByRole('link', { name: '@unlinkbox' })).toHaveCount(0)

    const emailRow = (await (await page.request.get(
      `${WORKER_ORIGIN}/__test/kv?key=email:unlinkbox`)).json()).value
    expect(emailRow).toBeNull()
    const member = JSON.parse((await (await page.request.get(
      `${WORKER_ORIGIN}/__test/kv?key=member:${encodeURIComponent(email)}`)).json()).value)
    expect(member.handle).toBeNull()
  })
})
