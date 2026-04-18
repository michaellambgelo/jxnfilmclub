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

  test('resumes on the code step after navigating away mid-OTP', async ({ page }) => {
    await seedKv(page, `member:${EMAIL}`, JSON.stringify({
      id: 'id-' + EMAIL, email: EMAIL, name: 'E2E Member', handle: null, joined: '2026-01-01',
    }))

    await page.goto('/signin')
    await page.getByLabel('Email').fill(EMAIL)
    await page.getByRole('button', { name: /email me a code/i }).click()
    await expect(page.getByLabel('Code')).toBeVisible()

    // User navigates away, then returns to /signin.
    await page.goto('/members')
    await page.goto('/signin')

    // The code step should be primed without re-entering the email.
    await expect(page.getByLabel('Code')).toBeVisible()
    await expect(page.locator('p.lede')).toContainText(EMAIL)
    await expect(page.getByLabel('Email')).toHaveCount(0)
  })

  test('"Use a different email" clears the in-flight resume', async ({ page }) => {
    await seedKv(page, `member:${EMAIL}`, JSON.stringify({
      id: 'id-' + EMAIL, email: EMAIL, name: 'E2E Member', handle: null, joined: '2026-01-01',
    }))

    await page.goto('/signin')
    await page.getByLabel('Email').fill(EMAIL)
    await page.getByRole('button', { name: /email me a code/i }).click()
    await expect(page.getByLabel('Code')).toBeVisible()

    await page.getByRole('button', { name: /use a different email/i }).click()
    await expect(page.getByLabel('Email')).toBeVisible()

    await page.goto('/signin')
    // Back on email step — no stale resume.
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Code')).toHaveCount(0)
  })

  // Feature 2: OTP in-flight resume via localStorage — additional coverage.

  test('expired in-flight (>10 min old) lands on email step, not code step', async ({ page }) => {
    await seedKv(page, `member:${EMAIL}`, JSON.stringify({
      id: 'id-' + EMAIL, email: EMAIL, name: 'E2E Member', handle: null, joined: '2026-01-01',
    }))

    // Seed an in-flight entry whose sentAt is older than the 10-minute window
    // (OTP_INFLIGHT_MS in ui/auth.html). The resume check must reject it and
    // keep us on the email step.
    await page.addInitScript((email) => {
      localStorage.jxnfc_otp_inflight = JSON.stringify({
        email,
        sentAt: Date.now() - 11 * 60 * 1000, // 11 minutes ago — past the 10m TTL
      })
    }, EMAIL)

    await page.goto('/signin')
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Code')).toHaveCount(0)

    // The expired entry should also be cleared from localStorage on read
    // (documented behavior of getOtpInflight).
    const remaining = await page.evaluate(() => localStorage.jxnfc_otp_inflight)
    expect(remaining).toBeFalsy()
  })

  test('signup /verify success clears in-flight state', async ({ page }) => {
    // Simulate a mid-flow pivot: user started sign-in on jxnfilm.club (which
    // wrote jxnfc_otp_inflight to THIS origin's localStorage), then
    // completed signup on /verify instead. The verify handler must clear
    // jxnfc_otp_inflight so a later /signin load doesn't strand them on the
    // code step with the wrong email.
    const signupEmail = 'signup-clears-inflight@example.com'

    // Land on the site origin first so the in-flight entry is scoped to
    // the same localStorage namespace that /verify clears from.
    await page.goto('/signin')
    await page.evaluate(() => {
      localStorage.jxnfc_otp_inflight = JSON.stringify({
        email: 'old-attempt@example.com',
        sentAt: Date.now(),
      })
    })
    // Sanity-check the seed landed where we expect it to.
    expect(await page.evaluate(() => localStorage.jxnfc_otp_inflight)).toBeTruthy()

    // Start a signup flow via the worker form so pending:/lb_token: get seeded.
    await page.goto('http://localhost:8787/')
    await page.getByLabel('Display name').fill('Pivot User')
    await page.getByLabel('Email').fill(signupEmail)
    await page.getByRole('button', { name: /email me a code/i }).click()
    await page.waitForURL(/\/verify/)

    // Pull the pending code out of the Worker KV and complete verification.
    const pendingRes = await page.request.get(
      `http://localhost:8787/__test/kv?key=pending:${encodeURIComponent(signupEmail)}`,
    )
    const code = JSON.parse((await pendingRes.json()).value).code
    await page.getByLabel('Code').fill(code)
    await page.getByRole('button', { name: /confirm membership/i }).click()
    await page.waitForURL('**/edit')

    // /verify ran on the site origin and its `clearOtpInflight()` must have
    // removed the key from THIS origin's localStorage.
    const remaining = await page.evaluate(() => localStorage.jxnfc_otp_inflight)
    expect(remaining).toBeFalsy()
  })

  test('clearing in-flight in one tab propagates to another via storage event', async ({ browser }) => {
    // Multi-tab behavior: localStorage mutations fire a `storage` event in
    // OTHER same-origin tabs. The sign-in view doesn't explicitly subscribe
    // to that event — resume is evaluated only at `mounted()`. So this test
    // documents current behavior: a fresh /signin load in tab 2 reads
    // localStorage at mount time and sees whichever tab wrote last. If tab 1
    // clears first, tab 2's next mount sees no resume.
    const ctx = await browser.newContext()
    try {
      await ctx.addInitScript((origin) => {
        // @ts-expect-error - injected into page context
        window.JXNFC_WORKER_ORIGIN = origin
      }, 'http://localhost:8787')

      const tab1 = await ctx.newPage()
      const tab2 = await ctx.newPage()

      // Seed a member so /signin doesn't fall over.
      await tab1.request.post('http://localhost:8787/__test/kv', {
        data: {
          key: `member:${EMAIL}`,
          value: JSON.stringify({
            id: 'id-' + EMAIL, email: EMAIL, name: 'Multi Tab', handle: null, joined: '2026-01-01',
          }),
        },
      })

      // Tab 1: arrive at code step (writes jxnfc_otp_inflight).
      await tab1.goto('/signin')
      await tab1.getByLabel('Email').fill(EMAIL)
      await tab1.getByRole('button', { name: /email me a code/i }).click()
      await expect(tab1.getByLabel('Code')).toBeVisible()

      // Tab 2: loads /signin fresh and sees the resume.
      await tab2.goto('/signin')
      await expect(tab2.getByLabel('Code')).toBeVisible()

      // Tab 1: "Use a different email" clears the in-flight key.
      await tab1.getByRole('button', { name: /use a different email/i }).click()
      await expect(tab1.getByLabel('Email')).toBeVisible()

      // Tab 2: reload /signin — a fresh mount reads localStorage again and
      // should NOT resume into the code step, because tab 1 wiped the key.
      await tab2.goto('/signin')
      await expect(tab2.getByLabel('Email')).toBeVisible()
      await expect(tab2.getByLabel('Code')).toHaveCount(0)
    } finally {
      await ctx.close()
    }
  })

  // Feature 1: session:{id} KV overlay — round-trip through /edit.

  test('after /member/update, a reload of /edit shows the new name from session KV', async ({ page }) => {
    // This exercises the write-through overlay end-to-end: edit → save →
    // reload — the fresh /edit mount calls GET /member/me, which must read
    // the session snapshot refreshed by handleMemberUpdate (not the stale
    // data/members.json that's still awaiting the update-member workflow).
    await signInAs(page, 'session-reload@example.com', { name: 'Before Save' })

    const NEW_NAME = 'After Save via Session KV'
    await page.getByLabel('Display name').fill(NEW_NAME)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.locator('.ok')).toContainText('Saved')

    // Full reload — clears any in-memory SPA state. The prefill must come
    // from /member/me, which now hits session:{id} and returns the fresh
    // name. If the overlay weren't being written on /member/update, this
    // would fall back to the stale member:{email} and fail.
    await page.reload()
    await expect(page.getByLabel('Display name')).toHaveValue(NEW_NAME)
  })
})
