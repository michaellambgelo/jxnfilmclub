import { test, expect, seedKv } from './fixtures'

// S1: OTP brute-force lockout.
// /otp/verify locks the email after 5 wrong-code attempts within the 10-min
// OTP window. The 6th attempt returns 429 regardless of code correctness —
// even the real code is rejected until the rate-limit window expires.
// Counter lives at `rate:otp_verify_fail:{email}` in MEMBERS_KV.

const EMAIL = 'lockout-e2e@example.com'
const CODE = '424242'

test.describe('OTP brute-force lockout (S1)', () => {
  test('5 wrong codes lock the email; the correct code is rejected on attempt 6', async ({ page }) => {
    // Seed a member + the real OTP. Cleaner than driving through /otp/request
    // because we want the *verify* counter under test — not the send throttle.
    await seedKv(page, `member:${EMAIL}`, JSON.stringify({
      id: 'id-' + EMAIL, email: EMAIL, name: 'Lockout Test', handle: null, joined: '2026-01-01',
    }))

    await page.goto('/signin')
    await page.getByLabel('Email').fill(EMAIL)
    await page.getByRole('button', { name: /email me a code/i }).click()
    await expect(page.getByLabel('Code')).toBeVisible()

    // Seed the real OTP AFTER the UI requested one — the test shim overwrites
    // whatever the Worker generated so we know the value.
    await seedKv(page, `otp:${EMAIL}`, CODE, 600)

    // Five wrong attempts. Each must stay on the code step and surface
    // "invalid code". The counter persists across them via KV.
    for (let i = 1; i <= 5; i++) {
      await page.getByLabel('Code').fill('000000')
      await page.getByRole('button', { name: /verify/i }).click()
      await expect(page.locator('.err'), `attempt ${i} should show invalid-code error`).toContainText('invalid code')
      // Still on the code step — no redirect.
      await expect(page.getByLabel('Code')).toBeVisible()
      expect(page.url()).toMatch(/\/signin/)
    }

    // Sixth attempt with the CORRECT code. The lockout must trump correctness.
    await page.getByLabel('Code').fill(CODE)
    await page.getByRole('button', { name: /verify/i }).click()

    // UI shows the rate-limit error (server returns 429 with this message).
    await expect(page.locator('.err')).toContainText(/too many attempts/i)
    // And we did NOT redirect to /edit — the real code was rejected.
    expect(page.url()).toMatch(/\/signin/)
    await expect(page.getByLabel('Code')).toBeVisible()
    const session = await page.evaluate(() => localStorage.jxnfc_session)
    expect(session).toBeFalsy()
  })
})
