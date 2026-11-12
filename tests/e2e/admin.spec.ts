import { test, expect, seedKv, WORKER_ORIGIN } from './fixtures'
import type { Page } from '@playwright/test'

// Admin dashboard e2e — the SPA served by admin/server.mjs in E2E mode
// (ADMIN_E2E_WORKER_ORIGIN), so every KV op and admin proxy lands on the same
// simulated KV as the join worker under test. The hosted admin worker (Access
// JWT gate, service bindings) is deliberately NOT covered here — it can't run
// without a JWT bypass and stays covered by tests/admin-worker/.
const ADMIN_ORIGIN = 'http://localhost:5175'

async function getKv(page: Page, key: string): Promise<string | null> {
  const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=${encodeURIComponent(key)}`)
  expect(res.ok()).toBeTruthy()
  return (await res.json()).value
}

// Every admin action goes through confirm() — auto-accept.
function acceptDialogs(page: Page) {
  page.on('dialog', d => d.accept())
}

function member(email: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'id-' + email, email, name: 'Admin E2E ' + email.split('@')[0],
    pronouns: null, handle: null, newsletter: false, joined: '2026-04-15',
    ...overrides,
  }
}

test.describe('admin dashboard', () => {
  test('members tab renders rows; unlink button only where a handle exists', async ({ page }) => {
    const linked = member('linked@e2e.test', { handle: 'linkeduser' })
    const plain = member('plain@e2e.test')
    await seedKv(page, 'member:linked@e2e.test', JSON.stringify(linked))
    await seedKv(page, 'member:plain@e2e.test', JSON.stringify(plain))
    await seedKv(page, 'members:all', JSON.stringify([
      { id: linked.id, name: linked.name, joined: linked.joined, handle: 'linkeduser' },
      { id: plain.id, name: plain.name, joined: plain.joined },
    ]))

    await page.goto(`${ADMIN_ORIGIN}/`)
    const linkedRow = page.locator('#members-table tbody tr', { hasText: 'linked@e2e.test' })
    const plainRow = page.locator('#members-table tbody tr', { hasText: 'plain@e2e.test' })
    await expect(linkedRow.locator('code', { hasText: '@linkeduser' })).toBeVisible()
    await expect(linkedRow.getByRole('button', { name: 'unlink LB' })).toBeVisible()
    await expect(plainRow.getByRole('button', { name: /unlink LB|repair LB/ })).toHaveCount(0)
  })

  test('unlink LB runs the full worker cascade end-to-end', async ({ page }) => {
    acceptDialogs(page)
    const m = member('mod@e2e.test', { handle: 'modhandle' })
    await seedKv(page, 'member:mod@e2e.test', JSON.stringify(m))
    await seedKv(page, 'email:modhandle', 'mod@e2e.test')
    await seedKv(page, 'handle:mod@e2e.test', 'modhandle')
    await seedKv(page, 'lb_token:mod@e2e.test', 'tok')
    await seedKv(page, 'members:all', JSON.stringify([
      { id: m.id, name: m.name, joined: m.joined, handle: 'modhandle' },
    ]))

    await page.goto(`${ADMIN_ORIGIN}/`)
    const row = page.locator('#members-table tbody tr', { hasText: 'mod@e2e.test' })
    await row.getByRole('button', { name: 'unlink LB' }).click()

    // The tab re-renders after the cascade; the handle cell empties.
    await expect(row.locator('code', { hasText: '@modhandle' })).toHaveCount(0)

    expect(JSON.parse((await getKv(page, 'member:mod@e2e.test'))!).handle).toBeNull()
    expect(await getKv(page, 'email:modhandle')).toBeNull()
    expect(await getKv(page, 'handle:mod@e2e.test')).toBeNull()
    expect(await getKv(page, 'lb_token:mod@e2e.test')).toBeNull()

    const agg = JSON.parse((await getKv(page, 'members:all'))!)
    const aggRow = agg.find((r: { id: string }) => r.id === m.id)
    expect(aggRow).toBeTruthy()
    expect(aggRow.handle).toBeUndefined()

    const dispatch = JSON.parse((await getKv(page, '__last_dispatch__'))!)
    expect(dispatch.event_type).toBe('update-member')
    expect(dispatch.client_payload).toEqual({ id: m.id, updates: { handle: null } })
  })

  test('repair LB scrubs a stale aggregate handle when the canonical row is already unlinked', async ({ page }) => {
    acceptDialogs(page)
    const m = member('drift@e2e.test', { handle: null })
    await seedKv(page, 'member:drift@e2e.test', JSON.stringify(m))
    // The drifted state the old raw-KV admin unlink left behind.
    await seedKv(page, 'members:all', JSON.stringify([
      { id: m.id, name: m.name, joined: m.joined, handle: 'stalehandle' },
    ]))

    await page.goto(`${ADMIN_ORIGIN}/`)
    const row = page.locator('#members-table tbody tr', { hasText: 'drift@e2e.test' })
    await row.getByRole('button', { name: 'repair LB' }).click()

    await expect(row.getByRole('button', { name: 'repair LB' })).toHaveCount(0)
    const agg = JSON.parse((await getKv(page, 'members:all'))!)
    expect(agg.find((r: { id: string }) => r.id === m.id).handle).toBeUndefined()
  })

  test('evict session deletes the cached snapshot', async ({ page }) => {
    acceptDialogs(page)
    const m = member('sess@e2e.test')
    await seedKv(page, 'member:sess@e2e.test', JSON.stringify(m))
    await seedKv(page, `session:${m.id}`, JSON.stringify(m))
    await seedKv(page, 'members:all', '[]')

    await page.goto(`${ADMIN_ORIGIN}/`)
    const row = page.locator('#members-table tbody tr', { hasText: 'sess@e2e.test' })
    await row.getByRole('button', { name: 'evict session' }).click()

    await expect.poll(() => getKv(page, `session:${m.id}`)).toBeNull()
  })

  test('newsletter toggle flips the member flag and evicts the session', async ({ page }) => {
    acceptDialogs(page)
    const m = member('nl@e2e.test', { newsletter: false })
    await seedKv(page, 'member:nl@e2e.test', JSON.stringify(m))
    await seedKv(page, `session:${m.id}`, JSON.stringify(m))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="newsletter"]').click()
    const row = page.locator('#nl-table tbody tr', { hasText: 'nl@e2e.test' })
    await expect(row.locator('.pill.off')).toBeVisible()
    await row.getByRole('button', { name: 'opt in' }).click()

    await expect(row.locator('.pill.on')).toBeVisible()
    expect(JSON.parse((await getKv(page, 'member:nl@e2e.test'))!).newsletter).toBe(true)
    expect(await getKv(page, `session:${m.id}`)).toBeNull()
  })

  // Scheduled reminders: the table lists an upcoming RSVP event's reminder
  // with its recipients, and Preview loads that event into the gallery.
  test('Emails tab lists scheduled reminders and previews one', async ({ page }) => {
    const ev = { id: 'e2e-remind', title: 'E2E Reminder Night', date: '2099-07-15', time: '19:30', kind: 'meetup',
      venue: 'The Capri Theatre', rsvp: true }
    const att = (key: string, value: string) =>
      page.request.post(`${WORKER_ORIGIN}/__test/kv`, { data: { ns: 'ATTENDANCE_KV', key, value } })
    // Append to events:all rather than replace it — other tests' rows stay.
    const cur = await (await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=events:all`)).json()
    const all = (cur.value ? JSON.parse(cur.value) : []).filter((e: { id: string }) => e.id !== ev.id)
    await att('events:all', JSON.stringify([...all, ev]))
    await att(`event:${ev.id}`, JSON.stringify(ev))
    await att(`rsvp:${ev.id}`, JSON.stringify({ confirmed: [{ memberId: 'm-e2e', name: 'Remy', email: 'remy@e2e.test', at: Date.now() }], waitlist: [] }))
    try {
      await page.goto(`${ADMIN_ORIGIN}/`)
      await page.locator('#tabs button[data-tab="emails"]').click()
      const row = page.locator('.email-schedule tr', { hasText: 'E2E Reminder Night' })
      await expect(row).toContainText('Mon, Jul 13, 7:30 PM')
      await expect(row.locator('.pill')).toHaveText('Scheduled')
      await row.locator('summary').click()
      await expect(row).toContainText('Remy — will get it')
      await expect(row).not.toContainText('remy@e2e.test')
      await row.locator('[data-em-preview]').click()
      await expect(page.locator('#em-event')).toHaveValue(ev.id)
      await expect(page.locator('.email-card', { hasText: 'Reminder (48 hours before)' })).toContainText('Reminder: E2E Reminder Night')
    } finally {
      await att('events:all', JSON.stringify(all))
      await page.request.delete(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&prefix=${encodeURIComponent('event:e2e-remind')}`)
      await page.request.delete(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&prefix=${encodeURIComponent('rsvp:e2e-remind')}`)
    }
  })

  // The Emails tab renders the join Worker's real transactional senders and
  // can mail one of them as a test. It must never mail anything on render.
  test('Emails tab previews every transactional email and test-sends one', async ({ page }) => {
    await seedKv(page, '__last_email__', '')
    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="emails"]').click()
    await expect(page.locator('.email-card')).toHaveCount(11)
    await expect(page.locator('.email-card', { hasText: 'RSVP confirmation' })).toContainText("You're in for")
    expect(await getKv(page, '__last_email__')).toBe('')

    await page.locator('#em-test-to').fill('preview@e2e.test')
    await page.locator('button[data-em-send="cancelled"]').click()
    await expect(page.locator('#toast')).toContainText('Sent "Event cancelled" test to preview@e2e.test')
    const mail = JSON.parse((await getKv(page, '__last_email__'))!)
    expect(mail.to).toBe('preview@e2e.test')
    expect(mail.subject).toMatch(/^\[Test\] Cancelled:/)
    expect(mail.html).toContain('is cancelled')
  })

  // The Worker writes a public /n/:id copy of every broadcast and links it from
  // that email's footer, but an admin who wants to share one had to go find the
  // email. Sent history carries the link itself. Rows predating the archive
  // have no archiveId, and must not render an href to /n/undefined.
  test('sent history links each broadcast to its shareable copy', async ({ page }) => {
    await seedKv(page, 'newsletter:sent:2026-09-01T00:00:00.000Z', JSON.stringify({
      subject: 'September dispatch', count: 12, at: Date.parse('2026-09-01'),
      archiveId: '2026-09-september-dispatch-a1b2c3d4e5',
    }))
    await seedKv(page, 'newsletter:sent:2026-05-01T00:00:00.000Z', JSON.stringify({
      subject: 'Pre-archive dispatch', count: 7, at: Date.parse('2026-05-01'),
    }))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="newsletter"]').click()

    const archived = page.locator('.nl-history tbody tr', { hasText: 'September dispatch' })
    await expect(archived.getByRole('link', { name: 'view shared copy' })).toHaveAttribute(
      'href', 'https://join.jxnfilm.club/n/2026-09-september-dispatch-a1b2c3d4e5')

    const legacy = page.locator('.nl-history tbody tr', { hasText: 'Pre-archive dispatch' })
    await expect(legacy.getByRole('link')).toHaveCount(0)
  })

  // Inserts append generated blocks by assigning textarea .value, which never
  // enters the native undo stack — so the snapshot stack is the only thing
  // making them reversible. Cover both entry points: the button and Cmd/Ctrl+Z.
  test('newsletter insert is undoable via the button and via the undo key', async ({ page }) => {
    const ev = {
      id: 'nl-undo-e2e', title: 'Undo Test Night', film: 'Sunrise',
      year: 1927, date: '2030-03-09', time: '19:30', venue: 'The Parlor',
    }
    const res = await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: `event:${ev.id}`, value: JSON.stringify(ev) },
    })
    expect(res.ok()).toBeTruthy()

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="newsletter"]').click()

    const html = page.locator('#nl-html')
    const undo = page.locator('#nl-undo')
    await expect(undo).toBeDisabled()
    const before = await html.inputValue()

    // The regrouped controls: the entries count now has a visible label rather
    // than reading as a bare "8" between two unrelated buttons.
    await expect(page.getByLabel('Entries')).toHaveValue('8')

    // --- Undo button ---
    await page.getByRole('button', { name: 'Insert upcoming events' }).click()
    await expect(html).toHaveValue(/Sunrise/)
    await expect(undo).toBeEnabled()
    await expect(undo).toHaveText(/Undo upcoming events/)

    await undo.click()
    await expect(html).toHaveValue(before)
    await expect(undo).toBeDisabled()

    // --- Cmd/Ctrl+Z, with the caret in the HTML body ---
    await page.getByRole('button', { name: 'Insert upcoming events' }).click()
    await expect(html).toHaveValue(/Sunrise/)
    await html.focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(html).toHaveValue(before)
    await expect(undo).toBeDisabled()

    // --- Cmd/Ctrl+Z with the caret in the preview, which is a separate
    // document: its keydown never bubbles to the page, and srcdoc replaces it
    // on every sync, so the listener has to re-attach per load.
    await page.getByRole('button', { name: 'Insert upcoming events' }).click()
    await expect(html).toHaveValue(/Sunrise/)
    await page.frameLocator('#nl-preview').locator('body').press('ControlOrMeta+z')
    await expect(html).toHaveValue(before)
    await expect(undo).toBeDisabled()
  })

  // The preview is a designMode document with its own native history. These
  // buttons drive it, and are a different thing from the insert-undo above:
  // this reverses an edit made in the preview, not a whole inserted block.
  test('editor undo/redo reverses and restores a preview edit', async ({ page }) => {
    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="newsletter"]').click()

    const html = page.locator('#nl-html')
    const body = page.frameLocator('#nl-preview').locator('body')
    await body.waitFor()

    // Type into the preview; the edit syncs back into the HTML textarea.
    await body.click()
    await page.keyboard.type('ZZMARKERZZ')
    await expect(html).toHaveValue(/ZZMARKERZZ/)
    const edited = await html.inputValue()

    await page.locator('#nl-fmt button[data-cmd="undo"]').click()
    await expect(html).not.toHaveValue(/ZZMARKERZZ/)
    // Undo removed the edit, not the document.
    await expect(html).toHaveValue(/Jackson Film Club/)

    await page.locator('#nl-fmt button[data-cmd="redo"]').click()
    await expect(html).toHaveValue(/ZZMARKERZZ/)
    await expect(html).toHaveValue(edited)
  })

  // A no-op command must not clear the insert-clean flag — otherwise clicking
  // undo on an empty history would silently disable Cmd+Z for the insert.
  test('a no-op editor undo leaves the insert still undoable', async ({ page }) => {
    const ev = { id: 'nl-noop-e2e', title: 'No-op Night', film: 'Solaris', year: 1972,
      date: '2030-06-01', time: '19:30', venue: 'The Parlor' }
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: `event:${ev.id}`, value: JSON.stringify(ev) },
    })
    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="newsletter"]').click()

    const html = page.locator('#nl-html')
    const before = await html.inputValue()

    // Insert, then click editor-undo: the srcdoc reload left the preview's
    // native history empty, so this changes nothing.
    await page.getByRole('button', { name: 'Insert upcoming events' }).click()
    await expect(html).toHaveValue(/Solaris/)
    await page.locator('#nl-fmt button[data-cmd="undo"]').click()
    await expect(html).toHaveValue(/Solaris/)

    // The insert is still reversible by keyboard, which is what the no-op
    // guard protects.
    await html.focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(html).toHaveValue(before)
  })

  // Once the operator edits by hand, the insert is no longer the most recent
  // change and the key must fall through to the browser's own undo.
  test('undo key falls through to native undo after a manual edit', async ({ page }) => {
    const ev = {
      id: 'nl-clean-e2e', title: 'Clean Flag Night', film: 'Nosferatu',
      year: 1922, date: '2030-04-02', time: '19:30', venue: 'The Parlor',
    }
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: `event:${ev.id}`, value: JSON.stringify(ev) },
    })

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="newsletter"]').click()

    const html = page.locator('#nl-html')
    await page.getByRole('button', { name: 'Insert upcoming events' }).click()
    await expect(html).toHaveValue(/Nosferatu/)

    await html.focus()
    await page.keyboard.type('ZZZ')
    await page.keyboard.press('ControlOrMeta+z')

    // The typing was undone natively; the inserted block survives.
    await expect(html).toHaveValue(/Nosferatu/)
    await expect(page.locator('#nl-undo')).toBeEnabled()
  })

  test('Config tab: theater list edit round-trips to config:theaters', async ({ page }) => {
    // Seed podcast config so the tab render skips the cross-origin
    // episodes.json fetch (deterministic offline).
    await seedKv(page, 'config:podcast', JSON.stringify({ featured_id: '', episodes: [] }))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="config"]').click()

    // No override yet: defaults prefilled, and the row says so.
    await expect(page.locator('#cfg-theaters .list-row [data-source]')).toHaveText('Default')
    await page.locator('#cfg-theaters button[data-action="cfg-open"]').click()
    const rows = page.locator('#cfg-theaters-list input[data-theater]')
    await expect(rows).toHaveCount(7)

    await page.locator('button[data-action="cfg-theater-add"]').click()
    await rows.last().fill('E2E Added Cinema')
    await page.locator('button[data-action="cfg-theaters-save"]').click()

    await expect.poll(async () => {
      const raw = await getKv(page, 'config:theaters')
      return raw ? JSON.parse(raw) : null
    }).toContain('E2E Added Cinema')
    await expect(page.locator('#cfg-theaters .list-row [data-source]')).toHaveText('Custom')
  })

  // A message belongs to no round, so the round-level toggle never applied to
  // it and an approved message had no way to ever read as aired. The toggle is
  // per message now, on the card, writing its own config key.
  test('Voice tab: publishing a message writes only the message set', async ({ page }) => {
    acceptDialogs(page)
    const promptId = 'msg_admine2e01'
    const key = `voice:${promptId}:id-msgpub@example.com`
    await seedKv(page, key, JSON.stringify({
      memberId: 'id-msgpub@example.com', name: 'Msg Member', promptId,
      promptText: 'Something I wanted to say', kind: 'message', note: 'a note',
      r2Key: `voice/${promptId}/id-msgpub@example.com.webm`,
      contentType: 'audio/webm', size: 1024, consent: true,
      at: '2026-09-01T00:00:00.000Z', expiresAt: 4102444800, status: 'approved',
    }))

    await page.goto(ADMIN_ORIGIN)
    await page.locator('#tabs button[data-tab="voice"]').click()
    await expect(page.locator('.voice-group')).toContainText('Messages')

    const toggle = page.locator('button[data-action="voice-publish"][data-kind="message"]')
    await expect(toggle).toHaveText('publish message')
    await toggle.click()
    await expect(page.locator('button[data-action="voice-publish"][data-kind="message"]'))
      .toHaveText('unpublish message')

    // Its own key, and emphatically not the round key.
    expect(JSON.parse((await getKv(page, 'config:message_published'))!).promptIds).toEqual([promptId])
    expect(await getKv(page, 'config:voice_published')).toBeNull()
  })

  // The toggle inverts the ladder if it can publish something unapproved, so a
  // pending message must not offer it at all.
  test('Voice tab: a pending message offers no publish toggle', async ({ page }) => {
    const promptId = 'msg_admine2e02'
    await seedKv(page, `voice:${promptId}:id-msgpend@example.com`, JSON.stringify({
      memberId: 'id-msgpend@example.com', name: 'Pending Member', promptId,
      promptText: 'Not approved yet', kind: 'message',
      r2Key: `voice/${promptId}/id-msgpend@example.com.webm`,
      contentType: 'audio/webm', size: 1024, consent: true,
      at: '2026-09-01T00:00:00.000Z', expiresAt: 4102444800,
    }))

    await page.goto(ADMIN_ORIGIN)
    await page.locator('#tabs button[data-tab="voice"]').click()
    await expect(page.locator('.voice-group')).toContainText('Messages')
    await expect(page.locator('button[data-action="voice-publish"][data-kind="message"]')).toHaveCount(0)
  })

  test('active tab survives a reload; a stale stored tab falls back to members', async ({ page }) => {
    await page.goto(`${ADMIN_ORIGIN}/`)
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'members')

    await page.locator('#tabs button[data-tab="feedback"]').click()
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'feedback')

    await page.reload()
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'feedback')

    // A tab name that no longer exists must not wedge boot.
    await page.evaluate(() => { localStorage.jxnfc_admin_tab = 'gone-tab' })
    await page.reload()
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'members')

    // Pre-collapse auth tab names land on the merged Auth tab.
    await page.evaluate(() => { localStorage.jxnfc_admin_tab = 'sessions' })
    await page.reload()
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'auth')
  })

  // --- Review badges on the tab strip ---
  //
  // The whole point of the badge is that it is legible from a DIFFERENT tab,
  // so every count here is asserted while Members is the open tab.

  function badgeCount(page: Page, tab: string) {
    return page.locator(`#tabs button[data-tab="${tab}"] .badge`)
  }

  function voiceClip(memberId: string, overrides: Record<string, unknown> = {}) {
    return JSON.stringify({
      memberId, name: 'Badge ' + memberId, promptId: 'badge-round',
      promptText: 'Why badges?', r2Key: `voice/badge-round/${memberId}.webm`,
      contentType: 'audio/webm', size: 1024, consent: true,
      at: '2026-09-01T12:00:00.000Z',
      expiresAt: Math.floor(Date.now() / 1000) + 60 * 86400,
      status: 'pending', ...overrides,
    })
  }

  function feedbackRow(i: number) {
    return JSON.stringify({
      at: `2026-09-0${i}T12:00:00.000Z`, category: 'bug',
      page: '/events', message: `badge feedback ${i}`,
    })
  }

  test('voice + feedback badges count what is waiting, from any tab', async ({ page }) => {
    acceptDialogs(page)
    // Two pending clips and one already moderated — approved is not waiting.
    await seedKv(page, 'voice:badge-round:m1', voiceClip('m1'))
    await seedKv(page, 'voice:badge-round:m2', voiceClip('m2'))
    await seedKv(page, 'voice:badge-round:m3', voiceClip('m3', { status: 'approved' }))
    await seedKv(page, 'feedback:1', feedbackRow(1))
    await seedKv(page, 'feedback:2', feedbackRow(2))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await expect(page.locator('#tabs button.active')).toHaveAttribute('data-tab', 'members')
    await expect(badgeCount(page, 'voice')).toHaveText('2')
    await expect(badgeCount(page, 'feedback')).toHaveText('2')

    // The label the operator reads must survive the badge being appended.
    await expect(page.locator('#tabs button[data-tab="voice"]')).toContainText('Voice')

    // Handling an item clears it from the count.
    await page.locator('#tabs button[data-tab="feedback"]').click()
    await page.locator('tr', { hasText: 'badge feedback 1' })
      .getByRole('button', { name: 'handled' }).click()
    await expect(badgeCount(page, 'feedback')).toHaveText('1')
  })

  test('the badge disappears entirely once the queue is empty', async ({ page }) => {
    acceptDialogs(page)
    // Moderated clips still have KV rows, but nothing is waiting on a
    // verdict — the Voice tab must look untouched rather than show a 0.
    await seedKv(page, 'voice:badge-round:done1', voiceClip('done1', { status: 'approved' }))
    await seedKv(page, 'voice:badge-round:done2', voiceClip('done2', { status: 'rejected' }))
    await seedKv(page, 'feedback:solo', feedbackRow(1))

    await page.goto(`${ADMIN_ORIGIN}/`)
    // The feedback badge appearing is the sync point that proves the counts
    // have run — without it, "no voice badge" would pass on an empty page.
    await expect(badgeCount(page, 'feedback')).toHaveText('1')
    await expect(badgeCount(page, 'voice')).toHaveCount(0)

    await page.locator('#tabs button[data-tab="feedback"]').click()
    await page.locator('tr', { hasText: 'badge feedback 1' })
      .getByRole('button', { name: 'handled' }).click()
    await expect(badgeCount(page, 'feedback')).toHaveCount(0)
  })

  test('revoke device deletes the refresh token', async ({ page }) => {
    acceptDialogs(page)
    const key = 'refresh:id-dev@e2e.test:secret123abc'
    await seedKv(page, key, JSON.stringify({ email: 'dev@e2e.test' }))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="auth"]').click()
    const row = page.locator('tr', { hasText: 'dev@e2e.test' })
    await row.getByRole('button', { name: 'revoke' }).click()

    await expect.poll(() => getKv(page, key)).toBeNull()
  })

  test('content gen builds copy + canvas from an event; private fields never render', async ({ page }) => {
    // Hosted event with the private fields that must never reach social output.
    const ev = {
      id: 'cg-e2e-screening', title: 'CG Test Night', film: 'Sherlock Jr.',
      year: 1924, date: '2030-01-15', time: '19:30', venue: 'The Parlor',
      hostId: 'id-host', hostName: 'Hosty',
      address: '456 Hidden Lane', notes: 'gate code 9999',
    }
    const res = await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: `event:${ev.id}`, value: JSON.stringify(ev) },
    })
    expect(res.ok()).toBeTruthy()

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="contentgen"]').click()

    // Copy panel: one card per platform, populated from the event.
    await expect(page.locator('.cg-copy-card')).toHaveCount(5)
    const fb = page.locator('.cg-copy-card[data-platform="facebook"] textarea')
    await expect(fb).toHaveValue(/Sherlock Jr\. \(1924\)/)
    await expect(fb).toHaveValue(/The Parlor/)

    // Private fields are nowhere in the rendered tab.
    const html = await page.locator('#content').innerHTML()
    expect(html).not.toContain('Hidden Lane')
    expect(html).not.toContain('9999')

    // Canvas renders at the selected size and follows the size switcher.
    const canvas = page.locator('#cg-canvas')
    await expect(canvas).toBeVisible()
    await expect(canvas).toHaveAttribute('width', '1080')
    await page.locator('.cg-size[data-size="fb"]').click()
    await expect(canvas).toHaveAttribute('width', '1200')
    await expect(page.getByRole('button', { name: 'Download PNG' })).toBeVisible()

    // Roundup mode swaps the event picker for the collage-size control.
    // E2E_MODE /watched is empty → the 7-day window has nothing, so the tab
    // shows the empty state instead of generating a hollow post.
    await page.locator('#cg-kind').selectOption('roundup')
    await expect(page.locator('#cg-limit')).toBeVisible()
    await expect(page.locator('#content .empty')).toHaveText(/No member watches logged in the last 7 days/)

    // Diary mode reads the same empty /watched, so it shows its own empty
    // state rather than a pager. The paging itself is unit-tested against
    // buildDiaryPages — that's why the logic lives in pure lib.js.
    await page.locator('#cg-kind').selectOption('diary')
    // The diary defaults to the trailing week, so the empty state names that
    // window rather than the whole-feed one.
    await expect(page.locator('#content .empty')).toHaveText(/No member watches logged in the last 7 days/)
    await expect(page.locator('#cg-diary-page')).toHaveCount(0)
    await expect(page.locator('#cg-download-all')).toHaveCount(0)
    // The Range select survives an empty result — it's the only way back out
    // of a window that returned nothing.
    await expect(page.locator('#cg-diary-range')).toBeVisible()
    // Everything page-scoped stays absent in the empty state.
    await expect(page.locator('#cg-pager')).toHaveCount(0)
    await expect(page.locator('.cg-copy-all')).toHaveCount(0)
    await expect(page.locator('.cg-copy-page')).toHaveCount(0)
  })

  test('Content Gen: poster layout knobs save per event + size and survive a reload', async ({ page }) => {
    // Poster on a host the image proxy allowlists; the layout panel keys off
    // the event HAVING a poster, so this doesn't depend on the bytes loading.
    const poster = 'https://image.tmdb.org/t/p/w500/e2e-layout.jpg'
    const ev = { id: 'cg-e2e-layout', title: 'Layout Night', film: 'Metropolis', year: 1927, date: '2030-02-01', venue: 'The Parlor', poster }
    const seeded = await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: `event:${ev.id}`, value: JSON.stringify(ev) },
    })
    expect(seeded.ok()).toBeTruthy()
    const key = `cardlayout:${ev.id}:ig-post`
    const getLayout = async (): Promise<string | null> => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent(key)}`)
      expect(res.ok()).toBeTruthy()
      return (await res.json()).value
    }

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="contentgen"]').click()
    await page.locator('#cg-event').selectOption(ev.id)

    const panel = page.locator('#cg-layout')
    await expect(panel).toBeVisible()
    await page.locator('#cg-l-text').fill('1.2')
    await page.getByRole('button', { name: 'Full-bleed' }).click()
    // Full-bleed has no band, so its size knob goes away.
    await expect(page.locator('[data-knob="band"]')).toBeHidden()

    await expect.poll(async () => JSON.parse((await getLayout()) || '{}').mode).toBe('full')
    const saved = JSON.parse((await getLayout())!)
    expect(saved).toMatchObject({ text: 1.2, poster })

    // Another size is untouched; a reload restores this one.
    await page.locator('.cg-size[data-size="ig-story"]').click()
    await expect(page.locator('#cg-l-text')).toHaveValue('1')
    await page.reload()
    await page.locator('#tabs button[data-tab="contentgen"]').click()
    await page.locator('#cg-event').selectOption(ev.id)
    await page.locator('.cg-size[data-size="ig-post"]').click()
    await expect(page.locator('#cg-l-text')).toHaveValue('1.2')
    await expect(page.locator('[data-mode="full"]')).toHaveClass(/active/)

    // Reset removes the key rather than persisting defaults.
    await page.locator('#cg-l-reset').click()
    await expect.poll(() => getLayout()).toBeNull()

    // Cards without a single poster don't offer the knobs.
    await page.locator('#cg-kind').selectOption('titlecard')
    await expect(page.locator('#cg-layout')).toBeHidden()
  })
  // The Events tab writes KV directly, so the form scrape IS the validation.
  // Two things it has to get right, both of which were wrong before:
  // a checkbox carries its state in .checked (its .value is the string "on"
  // whether ticked or not), and the scrape must not reach the guest-add
  // inputs that renderRsvpSection puts lower down inside the same form.
  test('Events tab: RSVP round-trips as a real boolean, and guest fields never leak into the row', async ({ page }) => {
    const id = 'e2e-admin-event'
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: {
        ns: 'ATTENDANCE_KV',
        key: `event:${id}`,
        value: JSON.stringify({ id, title: 'Admin E2E Event', date: '2099-09-09', venue: 'Somewhere' }),
      },
    })

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="events"]').click()
    // One event is open at a time: its row opens the shared form beneath it.
    const item = page.locator(`.list-item[data-id="${id}"]`)
    await item.locator('.list-row').click()
    const form = item.locator('[data-form="edit"]')
    await expect(form).toBeVisible()

    // Tick RSVP and pick a kind from the select (a scrape of input+textarea
    // only would silently never read the select).
    await form.locator('input[name="rsvp"]').check()
    await form.locator('select[name="kind"]').selectOption('social')
    await form.locator('button[data-action="event-save"]').click()

    const readRow = async () => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent('event:' + id)}`)
      const raw = (await res.json()).value
      return raw ? JSON.parse(raw) : null
    }

    // A real boolean, not the string "on".
    await expect.poll(async () => (await readRow())?.rsvp).toBe(true)

    expect((await readRow()).kind).toBe('social')

    // The save used the Worker's merge and sent only what changed: the row
    // was never asked the admission question, so it still has no answer, and
    // no `ticketed: false` was stamped on it either.
    expect('admission' in (await readRow())).toBe(false)
    expect('ticketed' in (await readRow())).toBe(false)

    // Now that RSVPs are on, the guest-add block sits right under the form.
    // Fill it and save the event again: an unscoped scrape would sweep those
    // inputs onto the event row — and because a checkbox's .value is "on"
    // whether ticked or not, it once did exactly that.
    await expect(item.locator('input[name="guest-name"]')).toBeVisible()
    await item.locator('input[name="guest-name"]').fill('Should Not Persist')
    await item.locator('input[name="guest-email"]').fill('leak@example.com')
    await form.locator('input[name="venue"]').fill('Somewhere Else')
    await item.locator('button[data-action="event-save"]').click()

    await expect.poll(async () => (await readRow())?.venue).toBe('Somewhere Else')
    const row = await readRow()
    expect('guest-force' in row).toBe(false)
    expect('guest-name' in row).toBe(false)
    expect('guest-email' in row).toBe(false)
    // And the real fields survived the second save intact.
    expect(row.rsvp).toBe(true)
    expect(row.kind).toBe('social')
  })
  // The scenario this whole path exists for: an event is announced, members
  // RSVP, it gets postponed, and everyone holding a spot has to be told.
  test('Events tab: postponing an event emails confirmed and waitlisted RSVPs', async ({ page }) => {
    const id = 'e2e-postpone'
    const putKv = (key: string, value: string, ns = 'ATTENDANCE_KV') =>
      page.request.post(`${WORKER_ORIGIN}/__test/kv`, { data: { ns, key, value } })

    await putKv(`event:${id}`, JSON.stringify({
      id, title: 'Drinks at Banner Hall', kind: 'social',
      date: '2099-08-01', venue: 'Banner Hall', rsvp: true, capacity: 1,
    }))
    await putKv(`rsvp:${id}`, JSON.stringify({
      confirmed: [{ memberId: 'm1', name: 'Confirmed Cass', email: 'cass@example.com', at: 1 }],
      waitlist:  [{ memberId: 'm2', name: 'Waiting Wes',   email: 'wes@example.com',  at: 2 }],
    }))

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="events"]').click()
    await page.locator(`.list-item[data-id="${id}"] .list-row`).click()
    const form = page.locator(`.list-item[data-id="${id}"] [data-form="edit"]`)
    await expect(form).toBeVisible()

    // The notify control names its audience, so the admin knows the blast
    // radius before ticking it.
    const notify = form.locator('input[name="notify-rsvps"]')
    await expect(form.locator('.notify-rsvps')).toContainText('1 confirmed + 1 waitlisted')

    await form.locator('input[name="date"]').fill('2099-09-15')
    await notify.check()

    // Declining the confirm must not write OR send — mailing people is not
    // undoable, so the dialog is a real gate rather than a formality.
    page.once('dialog', d => d.dismiss())
    await form.locator('button[data-action="event-save"]').click()
    const readEvent = async () => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent('event:' + id)}`)
      return JSON.parse((await res.json()).value)
    }
    expect((await readEvent()).date).toBe('2099-08-01')

    // Accept it this time.
    page.once('dialog', async d => {
      expect(d.message()).toContain('2099-08-01 → 2099-09-15')
      await d.accept()
    })
    await form.locator('button[data-action="event-save"]').click()

    await expect(page.locator('#toast')).toContainText('emailed 2 people')
    await expect.poll(async () => (await readEvent()).date).toBe('2099-09-15')

    // E2E mode stashes only the most recent send; the count above covers the
    // rest. This proves the body an RSVP actually receives.
    const mailRes = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=__last_email__`)
    const mail = JSON.parse((await mailRes.json()).value)
    expect(mail.to).toBe('wes@example.com')
    expect(mail.subject).toContain('Drinks at Banner Hall')
    // Waitlisted, so the mail states their position and offers no cancel link.
    expect(mail.text).toContain('#1 on the waitlist')
    expect(mail.text).toContain('2099-08-01 → 2099-09-15')
    // A social club event is not "the screening", and has no host.
    expect(mail.text).toContain('Jackson Film Club updated the event')
  })
  // A social event has no film, so no poster to borrow. Content Gen draws one
  // from the title instead, and this promotes it to the event's real artwork
  // — which is what puts it in the newsletter and the social cards too, not
  // just the site (the site renders its own title card in CSS regardless).
  test('Content Gen: a generated title card can become the event poster', async ({ page }) => {
    const id = 'e2e-titlecard'
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: {
        ns: 'ATTENDANCE_KV', key: `event:${id}`,
        value: JSON.stringify({
          id, title: 'Drinks at Banner Hall', kind: 'social',
          date: '2099-09-15', time: '19:00', venue: 'Banner Hall', rsvp: true,
        }),
      },
    })

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="contentgen"]').click()
    await page.locator('#cg-kind').selectOption('titlecard')

    // Choosing the poster kind lands on the 2:3 size, because that is the only
    // shape the site's poster slot can take without letterboxing.
    await expect(page.locator('.cg-size.active')).toContainText('Poster')

    await page.locator('#cg-event').selectOption(id)
    await expect(page.locator('#cg-use-poster')).toBeEnabled()
    await page.locator('#cg-use-poster').click()
    await expect(page.locator('#toast')).toContainText('Poster set on')

    const row = await expect.poll(async () => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent('event:' + id)}`)
      return JSON.parse((await res.json()).value).poster
    }).toMatch(/\/nl\/img\/[0-9a-f]{64}\.png$/).then(async () => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent('event:' + id)}`)
      return JSON.parse((await res.json()).value)
    })

    // A one-field PUT must not have disturbed anything else on the row — the
    // Worker merges, so title/date/rsvp all survive untouched.
    expect(row.title).toBe('Drinks at Banner Hall')
    expect(row.rsvp).toBe(true)
    expect(row.time).toBe('19:00')

    // The bytes really landed in R2 and are served publicly, with no auth.
    //
    // Fetched by PATH against the dev worker rather than by the stored URL:
    // the staging env has a custom_domain route, and `wrangler dev` rewrites
    // request.url to that hostname even while listening on localhost — so the
    // Worker builds join-staging.jxnfilm.club into the URL it returns. A local
    // artifact, not a bug; production origins are correct.
    const img = await page.request.get(`${WORKER_ORIGIN}${new URL(row.poster).pathname}`)
    expect(img.status()).toBe(200)
    expect(img.headers()['content-type']).toBe('image/png')

    // And the card swaps its CSS stand-in for the real artwork.
    await page.goto('/events')
    const card = page.locator('.event-card', { hasText: 'Drinks at Banner Hall' })
    await expect(card.locator('.event-titlecard')).toHaveCount(0)
    await expect(card.locator('img.event-poster')).toHaveAttribute('src', row.poster)
  })
  // Creating used to be a prompt() for a slug that immediately wrote an
  // "Untitled" row dated today — and since the public GET /events reads the
  // same aggregate, that placeholder was live on the site until somebody
  // finished it. The form is the editorial gate.
  test('Events tab: the new-event form derives an id, refuses to write until valid, then publishes', async ({ page }) => {
    await page.request.delete(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&prefix=event%3A`)
    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="events"]').click()

    // Wait for the list to actually render before counting it — the tab loads
    // asynchronously, and a count taken too early reads 0 and proves nothing.
    await expect(page.locator('#ev-list .list-item').first()).toBeAttached()
    const before = await page.locator('#ev-list .list-item').count()

    await page.locator('button[data-action="event-new"]').click()
    const panel = page.locator('#event-new-panel')
    await expect(panel).toBeVisible()
    // Opening the form must not have created anything.
    await expect(page.locator('#ev-list .list-item')).toHaveCount(before)

    // The id derives from date + film as you type.
    // 2099 + a nonsense film: data/events.json is re-snapshotted from
    // production every 6h and the fixture reseeds events:all from it, so any
    // plausible real slug can collide with live club data. This one cannot.
    await panel.locator('[name="date"]').fill('2099-10-22')
    await panel.locator('[name="film"]').fill('Zzyzx Testfilm')
    await expect(panel.locator('[name="id"]')).toHaveValue('2099-10-22-zzyzx-testfilm')

    // No title and no admission yet: creating is refused, BOTH problems are
    // listed at once, and still nothing is written.
    const issues = panel.locator('[data-issues]')
    await panel.locator('button[data-action="event-create"]').click()
    await expect(issues).toContainText('Title is required')
    await expect(issues).toContainText('Choose an admission')
    const stillNothing = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&prefix=${encodeURIComponent('event:')}`)
    expect((await stillNothing.json()).keys).toHaveLength(0)

    // A bad optional field is caught before the Worker ever sees it.
    await panel.locator('[name="title"]').fill('Zzyzx Preview Screening')
    await panel.locator('[name="admission"][value="ticketed"]').check()
    await panel.locator('[name="ticketUrl"]').fill('http://tix.example.com')
    await panel.locator('button[data-action="event-create"]').click()
    await expect(issues).toContainText('https link')
    await expect(issues).not.toContainText('Title is required')
    await panel.locator('[name="ticketUrl"]').fill('')

    // Now it publishes, complete.
    await panel.locator('[name="venue"]').fill('Capri Theater')
    await panel.locator('[name="time"]').fill('20:30')
    await panel.locator('[name="kind"]').selectOption('meetup')
    await panel.locator('button[data-action="event-create"]').click()
    await expect(page.locator('#toast')).toContainText('live on /events')
    await expect(page.locator('#event-new-panel')).toHaveCount(0)

    const readRow = async (key: string) => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent(key)}`)
      const raw = (await res.json()).value
      return raw ? JSON.parse(raw) : null
    }
    await expect.poll(() => readRow('event:2099-10-22-zzyzx-testfilm')).not.toBeNull()
    const row = await readRow('event:2099-10-22-zzyzx-testfilm')
    expect(row).toMatchObject({
      id: '2099-10-22-zzyzx-testfilm', title: 'Zzyzx Preview Screening', date: '2099-10-22',
      film: 'Zzyzx Testfilm', venue: 'Capri Theater', time: '20:30', kind: 'meetup', rsvp: true,
      // The admission is stored, and decides the flag the pre-sale queue reads.
      admission: 'ticketed', ticketed: true,
    })
    // Never written half-made: the very first version in KV is the finished one.
    expect(row.title).not.toBe('Untitled')

    // It lands in the list with its admission and pre-sale state on the row.
    const item = page.locator('.list-item[data-id="2099-10-22-zzyzx-testfilm"]')
    await expect(item.locator('.list-row')).toContainText('Ticketed')
    await expect(item.locator('.list-row')).toContainText('Pre-sale')

    // A second event on the same day and film is caught as a duplicate id.
    await page.locator('button[data-action="event-new"]').click()
    await panel.locator('[name="date"]').fill('2099-10-22')
    await panel.locator('[name="film"]').fill('Zzyzx Testfilm')
    await panel.locator('[name="title"]').fill('Another one')
    await panel.locator('[name="admission"][value="free"]').check()
    await panel.locator('button[data-action="event-create"]').click()
    await expect(panel.locator('[data-issues]')).toContainText('already exists')
  })

  // The list replaced a wall of always-open forms: upcoming first, one event
  // open at a time, search across everything, and a fold on the long past.
  test('Events tab: a searchable list with one event open at a time', async ({ page }) => {
    const put = (row: Record<string, unknown>) => page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: `event:${row.id}`, value: JSON.stringify(row) },
    })
    await page.request.delete(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&prefix=event%3A`)
    await put({ id: 'e2e-up-far', title: 'Far Future Night', date: '2099-12-01', venue: 'Capri Theater', admission: 'free' })
    await put({ id: 'e2e-up-near', title: 'Near Future Night', date: '2099-01-01', venue: 'Banner Hall' })
    for (let i = 1; i <= 17; i++) {
      await put({ id: `e2e-past-${i}`, title: `Old Night ${i}`, date: `20${String(i).padStart(2, '0')}-05-05`, venue: i === 1 ? 'Needle Haystack Hall' : 'Capri Theater' })
    }

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="events"]').click()
    const groups = page.locator('#ev-list .list-group')
    const upcoming = groups.nth(0), past = groups.nth(1)

    // Upcoming soonest-first, with the admission on the row only where set.
    await expect(upcoming.locator('.list-item')).toHaveCount(2)
    await expect(upcoming.locator('.list-item').nth(0)).toContainText('Near Future Night')
    await expect(upcoming.locator('.list-item').nth(1)).toContainText('Free')
    await expect(upcoming.locator('.list-item').nth(0)).not.toContainText('Free')

    // The past is folded to its most recent rows until asked for.
    await expect(past.locator('.list-item:visible')).toHaveCount(15)
    await expect(past.locator('.list-item:visible').first()).toContainText('Old Night 17')

    // Nothing is open until a row is clicked, and opening a second closes the first.
    await expect(page.locator('[data-form]')).toHaveCount(0)
    await page.locator('.list-item[data-id="e2e-up-near"] .list-row').click()
    await expect(page.locator('[data-form="edit"]')).toHaveCount(1)
    await page.locator('.list-item[data-id="e2e-up-far"] .list-row').click()
    await expect(page.locator('[data-form="edit"]')).toHaveCount(1)
    await expect(page.locator('.list-item[data-id="e2e-up-far"] [data-form="edit"]')).toBeVisible()

    // Unsaved edits are not thrown away silently when another row is clicked.
    await page.locator('[data-form="edit"] [name="venue"]').fill('Typed But Not Saved')
    page.once('dialog', d => d.dismiss())
    await page.locator('.list-item[data-id="e2e-up-near"] .list-row').click()
    await expect(page.locator('.list-item[data-id="e2e-up-far"] [name="venue"]')).toHaveValue('Typed But Not Saved')

    // Search reaches past the fold, and does not disturb the open form.
    await page.locator('#ev-search').fill('needle haystack')
    await expect(past.locator('.list-item:visible')).toHaveCount(1)
    await expect(past.locator('.list-item:visible')).toContainText('Old Night 1')
    await expect(upcoming.locator('.list-none')).toBeVisible()
    await page.locator('#ev-search').fill('')
    await expect(page.locator('.list-item[data-id="e2e-up-far"] [name="venue"]')).toHaveValue('Typed But Not Saved')

    await past.locator('button[data-action="event-past-all"]').click()
    await expect(past.locator('.list-item:visible')).toHaveCount(17)
  })

  // The bug this form was rebuilt around: the old one scraped every input on
  // every save, so fixing a typo on a 2021 row stamped rsvp:false and
  // ticketed:false onto it. An edit now sends only what changed.
  test('Events tab: saving a legacy row changes only what was edited', async ({ page }) => {
    const id = 'e2e-legacy-row'
    const legacy = { id, title: 'Whiplash', film: 'Whiplash', year: 2014, date: '2021-01-13', venue: 'Capri Theater' }
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: { ns: 'ATTENDANCE_KV', key: `event:${id}`, value: JSON.stringify(legacy) },
    })
    const readRow = async () => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent('event:' + id)}`)
      return JSON.parse((await res.json()).value)
    }

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="events"]').click()
    await page.locator('#ev-search').fill('whiplash')
    const item = page.locator(`.list-item[data-id="${id}"]`)
    await item.locator('.list-row').click()
    const form = item.locator('[data-form="edit"]')

    // Never asked the admission question, so it is offered as unanswered.
    await expect(form.locator('[name="admission"][value=""]')).toBeChecked()

    // Saving untouched writes nothing at all.
    await item.locator('button[data-action="event-save"]').click()
    await expect(page.locator('#toast')).toContainText('No changes')
    expect(await readRow()).toEqual(legacy)

    // A one-field edit lands as a one-field change.
    await form.locator('[name="title"]').fill('Whiplash (35mm)')
    await item.locator('button[data-action="event-save"]').click()
    await expect(page.locator('#toast')).toContainText('Saved')
    expect(await readRow()).toEqual({ ...legacy, title: 'Whiplash (35mm)' })

    // Answering the question stores it, and takes "Not set" off the table.
    await form.locator('[name="admission"][value="free"]').check()
    await item.locator('button[data-action="event-save"]').click()
    await expect.poll(async () => (await readRow()).admission).toBe('free')
    expect((await readRow()).ticketed).toBe(false)
    await expect(item.locator('[data-form="edit"] [name="admission"][value=""]')).toHaveCount(0)
    await expect(item.locator('.list-row')).toContainText('Free')
  })

  test('Events tab: duplicate starts a new event without the private parts', async ({ page }) => {
    const id = 'e2e-dup-source'
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: {
        ns: 'ATTENDANCE_KV', key: `event:${id}`,
        value: JSON.stringify({
          id, title: 'Monthly Meetup', film: 'Zzyzx Dupfilm', date: '2099-03-03', time: '19:00', venue: 'Malco Grandview',
          kind: 'meetup', rsvp: true, capacity: 12, admission: 'ticketed', ticketed: true,
          ticketUrl: 'https://tix.example.com/march', notes: 'Row F, ask for Sam',
        }),
      },
    })
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, {
      data: {
        ns: 'ATTENDANCE_KV', key: `rsvp:${id}`,
        value: JSON.stringify({ confirmed: [{ memberId: 'm1', name: 'Cass', email: 'cass@example.com', at: 1 }], waitlist: [] }),
      },
    })

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="events"]').click()
    await page.locator(`.list-item[data-id="${id}"] .list-row`).click()
    await page.locator(`.list-item[data-id="${id}"] button[data-action="event-dup"]`).click()

    const panel = page.locator('#event-new-panel')
    await expect(panel).toContainText('a copy of Monthly Meetup')
    await expect(panel.locator('[name="title"]')).toHaveValue('Monthly Meetup')
    await expect(panel.locator('[name="venue"]')).toHaveValue('Malco Grandview')
    await expect(panel.locator('[name="capacity"]')).toHaveValue('12')
    await expect(panel.locator('[name="admission"][value="ticketed"]')).toBeChecked()
    // The date is blank on purpose, and the private parts stayed behind.
    await expect(panel.locator('[name="date"]')).toHaveValue('')
    await expect(panel.locator('[name="notes"]')).toHaveValue('')
    await expect(panel.locator('[name="ticketUrl"]')).toHaveValue('')

    await panel.locator('[name="date"]').fill('2099-04-07')
    await expect(panel.locator('[name="id"]')).toHaveValue('2099-04-07-zzyzx-dupfilm')
    await panel.locator('button[data-action="event-create"]').click()
    await expect(page.locator('#toast')).toContainText('live on /events')

    const read = async (key: string) => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent(key)}`)
      const raw = (await res.json()).value
      return raw ? JSON.parse(raw) : null
    }
    await expect.poll(() => read('event:2099-04-07-zzyzx-dupfilm')).not.toBeNull()
    const copy = await read('event:2099-04-07-zzyzx-dupfilm')
    expect(copy).toMatchObject({ title: 'Monthly Meetup', date: '2099-04-07', kind: 'meetup', capacity: 12, admission: 'ticketed', rsvp: true })
    expect('notes' in copy).toBe(false)
    expect('ticketUrl' in copy).toBe(false)
    // Nobody came along: the copy starts with an empty list.
    expect((await read('rsvp:2099-04-07-zzyzx-dupfilm'))?.confirmed ?? []).toHaveLength(0)
    // And the source is untouched.
    expect((await read(`event:${id}`)).notes).toBe('Row F, ask for Sam')
  })

  // The two RSVP-list actions that are not an event edit. Both go through the
  // join Worker, and neither may disturb an unsaved edit in the form above.
  test('Events tab: promote one waitlisted person, then message the list', async ({ page }) => {
    const id = 'e2e-people'
    const putKv = (key: string, value: unknown) =>
      page.request.post(`${WORKER_ORIGIN}/__test/kv`, { data: { ns: 'ATTENDANCE_KV', key, value: JSON.stringify(value) } })
    await putKv(`event:${id}`, { id, title: 'Night at the Capri', date: '2099-08-01', venue: 'Capri Theater', rsvp: true, capacity: 1 })
    await putKv(`rsvp:${id}`, {
      confirmed: [{ memberId: 'm1', name: 'Confirmed Cass', email: 'cass@example.com', at: 1 }],
      waitlist: [
        { memberId: 'm2', name: 'Waiting Wes', email: 'wes@example.com', at: 2 },
        { memberId: 'm3', name: 'Waiting Wyn', email: 'wyn@example.com', at: 3 },
      ],
    })
    const readRsvp = async () => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?ns=ATTENDANCE_KV&key=${encodeURIComponent('rsvp:' + id)}`)
      return JSON.parse((await res.json()).value)
    }
    const lastMail = async () => {
      const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=__last_email__`)
      return JSON.parse((await res.json()).value)
    }

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="events"]').click()
    const item = page.locator(`.list-item[data-id="${id}"]`)
    await item.locator('.list-row').click()
    await item.locator('[data-form="edit"] [name="venue"]').fill('Typed But Not Saved')

    // The event is full, so the button says what it is about to do.
    const wyn = item.locator('.rsvp-admin li', { hasText: 'Waiting Wyn' })
    await expect(wyn.locator('button[data-action="rsvp-promote"]')).toHaveText('promote over capacity')
    await wyn.locator('button[data-action="rsvp-promote"]').click()
    await expect(page.locator('#toast')).toContainText('Promoted')

    // Wyn jumped the queue; Wes is still waiting.
    await expect.poll(async () => (await readRsvp()).confirmed.map((r: { memberId: string }) => r.memberId)).toEqual(['m1', 'm3'])
    expect((await readRsvp()).waitlist.map((r: { memberId: string }) => r.memberId)).toEqual(['m2'])
    expect((await lastMail()).to).toBe('wyn@example.com')
    await expect(item.locator('.list-row')).toContainText('2/1 RSVPed')
    // The list refreshed in place: the unsaved venue edit is still there.
    await expect(item.locator('[data-form="edit"] [name="venue"]')).toHaveValue('Typed But Not Saved')

    // The send button names its audience, and follows the waitlist box.
    await item.locator('.people-message summary').click()
    const send = item.locator('button[data-action="rsvp-message"]')
    await expect(send).toHaveText('Send to 2 confirmed')
    await item.locator('[name="msg-waitlist"]').check()
    await expect(send).toHaveText('Send to 2 confirmed + 1 waitlisted')

    // An empty note is refused before anything is sent.
    await send.click()
    await expect(page.locator('#toast')).toContainText('Write a message first')

    await item.locator('[name="msg-body"]').fill('Doors open at 6:30 this time.')
    await send.click()
    await expect(page.locator('#toast')).toContainText('Sent to 3 people')
    await expect(item.locator('[name="msg-body"]')).toHaveValue('')

    // E2E mode keeps only the most recent send: the waitlisted copy, which
    // carries the note but no cancel link.
    const mail = await lastMail()
    expect(mail.to).toBe('wes@example.com')
    expect(mail.subject).toBe('A note about Night at the Capri')
    expect(mail.text).toContain('Doors open at 6:30 this time.')
    expect(mail.text).not.toContain('/rsvp/cancel')
  })

  // Thirty days after an RSVP event the scrub deletes rsvp:{id} and keeps the
  // names-only attend:{id}. That attendance is then the only record of who
  // came, so the tab has to keep showing it - and keep it editable.
  test('Events tab: a past RSVP event still shows and edits its attendance', async ({ page }) => {
    const id = 'e2e-past-rsvp'
    const putKv = (key: string, value: unknown) =>
      page.request.post(`${WORKER_ORIGIN}/__test/kv`, { data: { ns: 'ATTENDANCE_KV', key, value: JSON.stringify(value) } })
    await putKv(`event:${id}`, { id, title: 'Scrubbed Meetup', date: '2001-07-30', venue: 'Malco Grandview', kind: 'meetup', hostId: 'm9', hostName: 'Sam', rsvp: true, scrubbedAt: '2001-08-30T00:00:00Z' })
    await putKv(`attend:${id}`, [{ id: 'm9', name: 'Sam' }, { id: 'm1', name: 'Cass Carter' }])
    // No rsvp: row at all - the scrub removed it.

    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="events"]').click()
    await page.locator('#ev-search').fill('scrubbed meetup')
    const item = page.locator(`.list-item[data-id="${id}"]`)
    await expect(item.locator('.list-row')).toContainText('2 attended')
    await expect(item.locator('.list-row')).not.toContainText('RSVPed')

    await item.locator('.list-row').click()
    const attendanceBlock = item.locator('.attendance:not(.rsvp-admin)')
    await expect(attendanceBlock).toContainText('Attendance (2)')
    await expect(attendanceBlock).toContainText('Cass Carter')
    // Nothing to promote on a past event.
    await expect(item.locator('button[data-action="rsvp-promote"]')).toHaveCount(0)

    page.once('dialog', d => d.accept())
    await attendanceBlock.locator('li', { hasText: 'Cass Carter' }).locator('button[data-action="attend-rm"]').click()
    await expect(attendanceBlock).toContainText('Attendance (1)')
    await expect(item.locator('.list-row')).toContainText('1 attended')
  })
})

test.describe('admin giveaways', () => {
  const EVENT = { id: 'e2e-ig-event', title: 'IG Giveaway Screening', date: '2099-10-22', time: '20:30', venue: 'Capri Theater' }

  async function seedIgGiveaway(page: Page, id: string, status = 'open') {
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, { data: { ns: 'ATTENDANCE_KV', key: `event:${EVENT.id}`, value: JSON.stringify(EVENT) } })
    const now = Date.now()
    const res = await page.request.put(`${WORKER_ORIGIN}/admin/giveaways/${id}`, {
      headers: { Authorization: 'Bearer e2e-admin-token' },
      data: {
        event_id: EVENT.id, title: 'Instagram ticket giveaway', prize: 'Two tickets', winners: 1, tickets_per_winner: 2,
        status, starts_at: new Date(now - 7200_000).toISOString(),
        ends_at: new Date(now + (status === 'closed' ? -60_000 : 86400_000)).toISOString(),
        sources: { instagram: { how: 'Tag a friend in the comments' } },
      },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
  }

  async function openDetail(page: Page, id: string) {
    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="giveaways"]').click()
    await page.locator(`button[data-action="gw-detail"][data-id="${id}"]`).click()
    await expect(page.getByRole('heading', { name: /Instagram ticket giveaway/ })).toBeVisible()
  }

  test('records Instagram entrants by paste, keeps bad lines to fix, and removes one', async ({ page }) => {
    acceptDialogs(page)
    await seedIgGiveaway(page, 'e2e-ig-track')
    await openDetail(page, 'e2e-ig-track')
    await page.locator('#gw-entrants-add').fill('@janedoe\nSam Roe, @sam.roe x2 -- tagged 2 friends\nnot a handle')
    await page.locator('button[data-action="gw-entrants-add"]').click()
    const rows = page.locator('table.gw-entrants tbody tr')
    await expect(rows).toHaveCount(2)
    await expect(page.getByRole('heading', { name: /Entrants \(2 people, 3 entries\)/ })).toBeVisible()
    await expect(rows.nth(1)).toContainText('tagged 2 friends')
    await expect(page.locator('#gw-entrants-add')).toHaveValue('not a handle')

    await page.locator('button[data-action="gw-entrant-remove"][data-handle="janedoe"]').click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('@sam.roe')
  })

  test('use as winner fills the winners box, asking for a name when there is none', async ({ page }) => {
    await seedIgGiveaway(page, 'e2e-ig-win', 'closed')
    await page.request.post(`${WORKER_ORIGIN}/admin/giveaways/e2e-ig-win/entrants`, {
      headers: { Authorization: 'Bearer e2e-admin-token' }, data: { add: ['@janedoe'] },
    })
    page.on('dialog', d => d.accept('Jane Doe'))
    await openDetail(page, 'e2e-ig-win')
    await page.locator('button[data-action="gw-entrant-win"][data-handle="janedoe"]').click()
    await expect(page.locator('#gw-ig-winners')).toHaveValue('Jane Doe, @janedoe')
  })

  test('a portal giveaway still shows its entries sections', async ({ page }) => {
    await page.request.post(`${WORKER_ORIGIN}/__test/kv`, { data: { ns: 'ATTENDANCE_KV', key: `event:${EVENT.id}`, value: JSON.stringify(EVENT) } })
    const now = Date.now()
    const res = await page.request.put(`${WORKER_ORIGIN}/admin/giveaways/e2e-portal`, {
      headers: { Authorization: 'Bearer e2e-admin-token' },
      data: {
        event_id: EVENT.id, title: 'Portal ticket giveaway', prize: 'Two tickets', winners: 1, tickets_per_winner: 2,
        status: 'open', starts_at: new Date(now - 7200_000).toISOString(), ends_at: new Date(now + 86400_000).toISOString(),
        sources: { waitlist_signup: { weight: 1 } },
      },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="giveaways"]').click()
    await page.locator('button[data-action="gw-detail"][data-id="e2e-portal"]').click()
    await expect(page.getByRole('heading', { name: 'Entries by source' })).toBeVisible()
    await expect(page.getByRole('heading', { name: /All entries/ })).toBeVisible()
    await expect(page.locator('#gw-entrants-add')).toHaveCount(0)
    await expect(page.locator('button[data-action="gw-delete"]')).toBeVisible()
  })

  test('deletes a giveaway only after its id is typed', async ({ page }) => {
    await seedIgGiveaway(page, 'e2e-ig-del')
    await openDetail(page, 'e2e-ig-del')

    page.once('dialog', d => d.accept('wrong-id'))
    await page.locator('button[data-action="gw-delete"]').click()
    await expect(page.getByRole('heading', { name: /Instagram ticket giveaway/ })).toBeVisible()
    expect((await page.request.get(`${WORKER_ORIGIN}/admin/giveaways/e2e-ig-del`, { headers: { Authorization: 'Bearer e2e-admin-token' } })).status()).toBe(200)

    page.once('dialog', d => d.accept('e2e-ig-del'))
    await page.locator('button[data-action="gw-delete"]').click()
    await expect(page.locator('button[data-action="gw-detail"][data-id="e2e-ig-del"]')).toHaveCount(0)
    expect((await page.request.get(`${WORKER_ORIGIN}/admin/giveaways/e2e-ig-del`, { headers: { Authorization: 'Bearer e2e-admin-token' } })).status()).toBe(404)
  })
})

