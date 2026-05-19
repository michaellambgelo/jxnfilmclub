import { test, expect, WORKER_ORIGIN, signInAs } from './fixtures'

// S2: server-side session revocation.
// The edit-view "Sign out" button awaits POST /session/revoke before clearing
// localStorage. The Worker records `revoked:{jti}` in MEMBERS_KV and
// subsequent authenticated reads with that token return 401, even though the
// JWT's exp hasn't lapsed yet.

const EMAIL = 'revoke-e2e@example.com'

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [payload] = token.split('.')
  // The Worker uses base64url for the payload — restore standard alphabet
  // before decoding. atob is available in node 18+.
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
}

test.describe('sign-out triggers server-side revocation (S2)', () => {
  test('clicking Sign out revokes the token server-side; replayed token returns 401', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Revoke Me' })

    // Capture the live session BEFORE signing out — we'll replay this token
    // post-revocation to prove the server (not just the browser) dropped it.
    const sessionRaw = await page.evaluate(() => localStorage.jxnfc_session)
    expect(sessionRaw).toBeTruthy()
    const session = JSON.parse(sessionRaw!)
    expect(session.token).toBeTruthy()
    const { jti } = decodeJwtPayload(session.token) as { jti?: string }
    expect(jti).toMatch(/^[a-z0-9]{16}$/)

    // Sanity: the token works against /member/me right now.
    const before = await page.request.get(`${WORKER_ORIGIN}/member/me`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
    expect(before.status()).toBe(200)

    // Click the edit-view Sign out button. The handler awaits
    // POST /session/revoke before clearing localStorage and redirecting.
    await page.getByRole('button', { name: /sign out/i }).click()
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '')
    // localStorage session was cleared on the client too.
    const afterSession = await page.evaluate(() => localStorage.jxnfc_session)
    expect(afterSession).toBeFalsy()

    // The captured (still-unexpired) token must now be rejected — proves
    // revocation propagated to the server, not just the client.
    const after = await page.request.get(`${WORKER_ORIGIN}/member/me`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
    expect(after.status()).toBe(401)

    // And the KV revocation entry exists with the matching jti.
    const kvRes = await page.request.get(
      `${WORKER_ORIGIN}/__test/kv?key=revoked:${jti}`,
    )
    expect(kvRes.ok()).toBeTruthy()
    const { value } = await kvRes.json()
    expect(value).toBe('1')
  })
})
