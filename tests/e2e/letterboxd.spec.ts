import { test, expect, signInAs, seedKv, WORKER_ORIGIN } from './fixtures'

test.describe('Letterboxd handle from /edit', () => {
  test('no handle yet → type + save → "Linked as @handle" + KV reverse index written', async ({ page, request }) => {
    const email = 'lb-add@example.com'
    await signInAs(page, email)

    // Start state: no Letterboxd on record.
    await expect(page.getByRole('heading', { name: 'Letterboxd' })).toBeVisible()
    const handleInput = page.getByLabel('Letterboxd username')
    await expect(handleInput).toBeVisible()

    await handleInput.fill('linkeduser')
    await page.getByRole('button', { name: /save handle/i }).click()

    // UI flips to the linked state.
    await expect(page.locator('.ok')).toContainText('Linked as')
    await expect(page.getByRole('link', { name: '@linkeduser' })).toBeVisible()

    // Reverse index landed in MEMBERS_KV.
    const reverse = await request.get(`${WORKER_ORIGIN}/__test/kv?key=email:linkeduser`)
    expect((await reverse.json()).value).toBe(email)
    const member = JSON.parse((await (await request.get(
      `${WORKER_ORIGIN}/__test/kv?key=member:${encodeURIComponent(email)}`)).json()).value)
    expect(member.handle).toBe('linkeduser')
  })

  test('saving a handle already claimed by another member surfaces a 409 error', async ({ page }) => {
    const email = 'lb-collide@example.com'
    await signInAs(page, email)
    // Pre-claim the handle for someone else.
    await seedKv(page, 'email:disputed', 'rival@example.com')

    await page.getByLabel('Letterboxd username').fill('disputed')
    await page.getByRole('button', { name: /save handle/i }).click()

    await expect(page.locator('.err')).toContainText(/already claimed/i)
    // Form stays — user can pick a different handle.
    await expect(page.getByLabel('Letterboxd username')).toBeVisible()
  })

  test('members with a saved handle see "Linked as @handle"', async ({ page }) => {
    const email = 'linked-already@example.com'
    await seedKv(page, 'email:laUser', email)
    await seedKv(page, `handle:${email}`, 'laUser')
    await signInAs(page, email, { name: 'Already', handle: 'laUser' })

    await expect(page.locator('.ok')).toContainText('Linked as')
    await expect(page.getByRole('link', { name: '@laUser' })).toBeVisible()
  })

  test('linked member can unlink Letterboxd; panel flips back to the input form', async ({ page, request }) => {
    const email = 'unlink-e2e@example.com'
    await seedKv(page, 'email:unlinkbox', email)
    await seedKv(page, `handle:${email}`, 'unlinkbox')
    await signInAs(page, email, { name: 'Unlink Me', handle: 'unlinkbox' })

    await expect(page.getByRole('link', { name: '@unlinkbox' })).toBeVisible()

    page.on('dialog', d => d.accept())
    await page.getByRole('button', { name: /remove letterboxd link/i }).click()

    await expect(page.getByLabel('Letterboxd username')).toBeVisible()
    await expect(page.getByRole('link', { name: '@unlinkbox' })).toHaveCount(0)

    const emailRow = (await (await request.get(
      `${WORKER_ORIGIN}/__test/kv?key=email:unlinkbox`)).json()).value
    expect(emailRow).toBeNull()
    const member = JSON.parse((await (await request.get(
      `${WORKER_ORIGIN}/__test/kv?key=member:${encodeURIComponent(email)}`)).json()).value)
    expect(member.handle).toBeNull()
  })
})
