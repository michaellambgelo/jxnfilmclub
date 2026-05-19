import { test, expect, WORKER_ORIGIN, signInAs } from './fixtures'

// /edit "Remove membership" flow:
//   1. The submit button is disabled until the typed email matches the
//      signed-in email (type-to-confirm gate).
//   2. Clicking it calls POST /member/delete, which cascades MEMBERS_KV,
//      writes revoked:{jti}, and dispatches the remove-member workflow.
//   3. The page clears localStorage and redirects to /.
//   4. The (still-unexpired) token can no longer hit authed endpoints.

const EMAIL = 'delete-me@example.com'

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [payload] = token.split('.')
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
}

test.describe('remove membership (/edit danger zone)', () => {
  test('type-to-confirm gates the button; clicking it deletes server-side state and revokes the token', async ({ page }) => {
    const member = await signInAs(page, EMAIL, { name: 'Delete Me', handle: 'deleteme' })
    // signInAs only seeds member:{email}; mirror the handle indices the real
    // /letterboxd/verify flow would have written so we can assert their removal.
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { key: `email:${member.handle}`, value: EMAIL },
    })
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { key: `handle:${EMAIL}`, value: member.handle },
    })

    // Capture the session token now — we'll replay it after delete.
    const sessionRaw = await page.evaluate(() => localStorage.jxnfc_session)
    const session = JSON.parse(sessionRaw!)
    const { jti } = decodeJwtPayload(session.token) as { jti?: string }

    // The danger-zone section + its disabled button render unconditionally on /edit.
    const dangerHeading = page.getByRole('heading', { name: /remove membership/i })
    await expect(dangerHeading).toBeVisible()
    const submitBtn = page.getByRole('button', { name: /remove my membership/i })
    await expect(submitBtn).toBeDisabled()

    // Typing the wrong email keeps it disabled.
    const confirmInput = page.locator('input[name="confirm"]')
    await confirmInput.fill('not-the-right-email@example.com')
    await expect(submitBtn).toBeDisabled()

    // Typing the exact signed-in email enables it.
    await confirmInput.fill(EMAIL)
    await expect(submitBtn).toBeEnabled()

    await submitBtn.click()
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '')
    // localStorage cleared client-side.
    const afterSession = await page.evaluate(() => localStorage.jxnfc_session)
    expect(afterSession).toBeFalsy()

    // KV cascade: member row + reverse indices gone.
    const memberRow = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=member:${EMAIL}`)
    expect((await memberRow.json()).value).toBeNull()
    const handleIdx = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=email:${member.handle}`)
    expect((await handleIdx.json()).value).toBeNull()

    // Token is now revoked: the same Bearer that worked moments ago is dead.
    const replay = await page.request.get(`${WORKER_ORIGIN}/member/me`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
    expect(replay.status()).toBe(401)
    const revokedRow = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=revoked:${jti}`)
    expect((await revokedRow.json()).value).toBe('1')

    // The Worker dispatched remove-member with the member id.
    const dispatch = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=__last_dispatch__`)
    const dispatchPayload = JSON.parse((await dispatch.json()).value)
    expect(dispatchPayload.event_type).toBe('remove-member')
    expect(dispatchPayload.client_payload).toEqual({ id: member.id })
  })

  test('the handle a deleted member held is immediately claimable again', async ({ page }) => {
    const member = await signInAs(page, 'first-claimant@example.com', { name: 'First', handle: 'shared-handle' })
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { key: `email:${member.handle}`, value: 'first-claimant@example.com' },
    })

    await page.locator('input[name="confirm"]').fill('first-claimant@example.com')
    await page.getByRole('button', { name: /remove my membership/i }).click()
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '')

    // Reverse index is gone, so the next /letterboxd/request for the same
    // handle would now succeed instead of returning 409.
    const reverseIdx = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=email:${member.handle}`)
    expect((await reverseIdx.json()).value).toBeNull()
  })

  test('Anonymize checkbox is disabled until email matches, and scrubs past attendance when ticked', async ({ page, request }) => {
    const EMAIL = 'anonymize-e2e@example.com'
    const NAME = 'Quiet Departure'
    await signInAs(page, EMAIL, { name: NAME })

    // Seed past attendance for this member directly in ATTENDANCE_KV via the
    // E2E shim. Two events with the member's name, one without.
    const seedAttend = async (eventId: string, attendees: string[]) =>
      request.post(`${WORKER_ORIGIN}/__test/kv`, {
        data: { ns: 'ATTENDANCE_KV', key: `attend:${eventId}`, value: JSON.stringify(attendees) },
      })
    await seedAttend('past-evt-a', [NAME, 'Other Member'])
    await seedAttend('past-evt-b', ['Other Member', NAME, 'Third Person'])
    await seedAttend('past-evt-c', ['Other Member'])

    const checkbox = page.locator('input[type="checkbox"][name="anonymize"]')

    // Pre-match: checkbox is disabled. Even forcing a state change shouldn't
    // matter — the Worker only acts on `{ anonymize: true }` in the POST body.
    await expect(checkbox).toBeDisabled()

    // Type the correct email — checkbox becomes interactive.
    await page.locator('input[name="confirm"]').fill(EMAIL)
    await expect(checkbox).toBeEnabled()
    await checkbox.check()
    await expect(checkbox).toBeChecked()

    // Capture the outbound POST body so we can confirm the UI actually sent
    // anonymize:true. If it didn't, the assertion failure later would be
    // ambiguous between a UI-side bug and a Worker-side bug.
    const deletePostPromise = page.waitForRequest(
      (req) => req.url().endsWith('/member/delete') && req.method() === 'POST',
    )
    await page.getByRole('button', { name: /remove my membership/i }).click()
    const deletePost = await deletePostPromise
    expect(JSON.parse(deletePost.postData() || '{}')).toMatchObject({ anonymize: true })
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '')

    // Events that listed the member now show "former member" instead.
    const readAttend = async (eventId: string) => {
      const res = await request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=attend:${eventId}`)
      const { value } = await res.json()
      return value ? JSON.parse(value) : null
    }
    expect(await readAttend('past-evt-a')).toEqual(['Other Member', 'former member'])
    expect(await readAttend('past-evt-b')).toEqual(['Other Member', 'Third Person', 'former member'])
    // Event that did NOT list the member is untouched.
    expect(await readAttend('past-evt-c')).toEqual(['Other Member'])
  })

  test('Anonymize defaults to opt-out: clicking Remove without ticking leaves attendance intact', async ({ page, request }) => {
    const EMAIL = 'optout@example.com'
    const NAME = 'Stays In Archive'
    await signInAs(page, EMAIL, { name: NAME })
    await request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: 'attend:optout-evt', value: JSON.stringify([NAME, 'Bystander']) },
    })

    await page.locator('input[name="confirm"]').fill(EMAIL)
    // Do NOT tick the checkbox. Submit.
    await page.getByRole('button', { name: /remove my membership/i }).click()
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '')

    const res = await request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=attend:optout-evt`)
    const attendees = JSON.parse((await res.json()).value)
    // The member's name stays in the archive; "former member" never appears.
    expect(attendees).toEqual([NAME, 'Bystander'])
  })
})
