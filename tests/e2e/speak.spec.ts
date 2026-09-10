import { test, expect, seedKv, wipeKv, signInAs, WORKER_ORIGIN } from './fixtures'

const ADMIN_ORIGIN = 'http://localhost:5175'

// Chromium's fake mic makes MediaRecorder real in CI — no permission prompt,
// a synthetic tone as input. Applies to every test in this file; the upload
// tests are unaffected by the flags.
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
})

// Minimal valid WAV: 44-byte RIFF header + 1600 samples of silence
// (0.1s @ 16kHz mono 16-bit). Real enough for <audio> to decode.
function tinyWav(): Buffer {
  const samples = 1600
  const dataSize = samples * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40)
  return buf
}

test.describe('speak page', () => {
  test('signed-out: shows the default prompt and a log-in nudge', async ({ page }) => {
    await page.goto('/speak')
    // The band makes the prompt the page headline (Claude Design 1a).
    await expect(page.locator('h1')).toContainText("Tell us what you're watching")
    await expect(page.locator('.speak-prompt-text')).toHaveText("Tell us what you're watching")
    await expect(page.locator('.speak .lede')).toContainText('log in')
  })

  test('config:voice_prompt overrides the prompt text', async ({ page }) => {
    await seedKv(page, 'config:voice_prompt', JSON.stringify({
      id: 'e2e-prompt', text: 'Best theater snack?', deadline: '2099-12-31',
    }))
    await page.goto('/speak')
    await expect(page.locator('.speak-prompt-text')).toHaveText('Best theater snack?')
    await expect(page.locator('.speak-deadline')).toContainText('Dec 31, 2099')
    // A cutoff still ahead of us says nothing extra.
    await expect(page.locator('.speak-band-closed')).toBeHidden()
  })

  test('a cutoff in the past says so, and still takes clips', async ({ page }) => {
    // The deadline is display-only in the Worker by design — the round keeps
    // accepting. What must not happen is a stale date sitting silently next
    // to a live Record button.
    await seedKv(page, 'config:voice_prompt', JSON.stringify({
      id: 'e2e-closed', text: 'Late answers welcome?', deadline: '2020-01-31',
    }))
    await signInAs(page, 'latecomer@e2e.test', { name: 'E2E Latecomer' })
    await page.goto('/speak')

    await expect(page.locator('.speak-deadline')).toContainText('Closed')
    await expect(page.locator('.speak-band-closed')).toBeVisible()
    await expect(page.locator('.speak-band-closed')).toContainText('may not make this episode')

    // Still submittable.
    await page.locator('.speak-upload input[type="file"]').setInputFiles({
      name: 'clip.wav', mimeType: 'audio/wav', buffer: tinyWav(),
    })
    await page.locator('.speak-consent input[type="checkbox"]').check()
    await page.getByRole('button', { name: 'Submit clip' }).click()
    await expect(page.locator('.speak-history .hrow').first())
      .toContainText('Submitted', { timeout: 10_000 })
  })

  test('member uploads a clip with consent; it round-trips; admin reviews it', async ({ page }) => {
    await signInAs(page, 'speaker@e2e.test', { name: 'E2E Speaker' })
    await page.goto('/speak')

    // Upload path (MediaRecorder needs a mic; upload is deterministic).
    await page.locator('.speak-upload input[type="file"]').setInputFiles({
      name: 'clip.wav', mimeType: 'audio/wav', buffer: tinyWav(),
    })
    await expect(page.locator('.speak-preview')).toBeVisible()

    // Submit is gated on consent.
    const submit = page.getByRole('button', { name: 'Submit clip' })
    await expect(submit).toBeDisabled()
    await page.locator('.speak-consent input[type="checkbox"]').check()
    await expect(submit).toBeEnabled()
    await submit.click()

    // Success reloads the view; the history row shows the submission,
    // badged as this round's.
    const row = page.locator('.speak-history .hrow').first()
    await expect(row).toBeVisible({ timeout: 10_000 })
    await expect(row).toContainText('Submitted')
    await expect(row.locator('.hrow-badge')).toHaveText('This round')

    // Listen streams the member's own bytes back into an inline player.
    await row.getByRole('button', { name: 'Listen' }).click()
    await expect(row.locator('.hrow-player audio')).toBeAttached()

    // Navigating away stops playback and revokes the blob URL.
    await page.locator('nav a[href="/events"]').first().click()
    await expect.poll(() => page.evaluate(() => (globalThis as any).jxnfcVoicePlay ?? null)).toBeNull()

    // Admin: the clip appears in the Voice tab and can be approved.
    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="voice"]').click()
    const clip = page.locator('.voice-clip', { hasText: 'E2E Speaker' })
    await expect(clip).toBeVisible()
    await expect(clip.locator('.pill', { hasText: 'pending' })).toBeVisible()
    await clip.getByRole('button', { name: /approve/i }).click()
    await expect(clip.locator('.pill', { hasText: 'approved' })).toBeVisible()

    // Approval is not publication. Until an admin says the episode aired,
    // the member must not be told their clip is out in the world.
    await page.goto('/speak')
    const approvedRow = page.locator('.speak-history .hrow').first()
    await expect(approvedRow).toContainText('Approved', { timeout: 10_000 })
    await expect(approvedRow).not.toContainText('Published')

    // Publishing the round is what flips it.
    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="voice"]').click()
    // Publishing is confirmed — it is the one action that tells members
    // their episode is out.
    page.once('dialog', d => d.accept())
    await page.getByRole('button', { name: 'publish round' }).first().click()
    await expect(page.locator('.pill', { hasText: 'published' }).first()).toBeVisible()

    await page.goto('/speak')
    await expect(page.locator('.speak-history .hrow').first())
      .toContainText('Published', { timeout: 10_000 })
  })

  test('leaving with an unsubmitted take asks first', async ({ page }) => {
    await signInAs(page, 'stager@e2e.test', { name: 'E2E Stager' })
    await page.goto('/speak')
    await page.locator('.speak-upload input[type="file"]').setInputFiles({
      name: 'clip.wav', mimeType: 'audio/wav', buffer: tinyWav(),
    })
    await expect(page.locator('.speak-status-dd')).toHaveText('Draft')

    // Dismissing the confirm keeps the member — and the take — on the page.
    // An unsubmitted recording lives only in the recorder's module scope, so
    // a navigation destroys it silently without this guard.
    let asked = ''
    page.once('dialog', d => { asked = d.message(); d.dismiss() })
    await page.locator('nav a[href="/events"]').first().click()
    await expect.poll(() => asked).toContain('not been submitted')
    await expect(page).toHaveURL(/\/speak/)
    await expect(page.locator('.speak-preview')).toBeVisible()

    // Accepting lets the navigation through.
    page.once('dialog', d => d.accept())
    await page.locator('nav a[href="/events"]').first().click()
    await expect(page).toHaveURL(/\/events/)
  })

  test('member records with the mic, previews, and submits', async ({ page }) => {
    await signInAs(page, 'recorder@e2e.test', { name: 'E2E Recorder' })
    await page.goto('/speak')

    const recBtn = page.locator('.speak-rec-btn')
    await expect(recBtn).toHaveText('Record')
    await recBtn.click()
    await expect(recBtn).toHaveText('Stop', { timeout: 10_000 })
    await page.waitForTimeout(2000)
    await recBtn.click()

    await expect(page.locator('.speak-preview')).toBeVisible()
    await expect(page.locator('audio.speak-player')).toBeAttached()
    // Staged-but-unsubmitted take surfaces as Draft in the band's rail.
    await expect(page.locator('.speak-status-dd')).toHaveText('Draft')
    await page.locator('.speak-consent input[type="checkbox"]').check()
    await page.getByRole('button', { name: 'Submit clip' }).click()
    await expect(page.locator('.speak-history .hrow').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.speak-history .hrow').first()).toContainText('Submitted')
  })

  test('member can delete their own clip', async ({ page }) => {
    page.on('dialog', d => d.accept())
    await signInAs(page, 'deleter@e2e.test', { name: 'E2E Deleter' })
    await page.goto('/speak')
    await page.locator('.speak-upload input[type="file"]').setInputFiles({
      name: 'clip.wav', mimeType: 'audio/wav', buffer: tinyWav(),
    })
    await page.locator('.speak-consent input[type="checkbox"]').check()
    await page.getByRole('button', { name: 'Submit clip' }).click()
    const row = page.locator('.speak-history .hrow').first()
    await expect(row).toBeVisible({ timeout: 10_000 })

    await row.getByRole('button', { name: 'Delete' }).click()
    // Back to the fresh recorder state; the rail reflects it; KV row gone.
    await expect(page.locator('.speak-upload')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.speak-status-dd')).toHaveText('Deleted')
    const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?prefix=${encodeURIComponent('voice:')}`)
    const { keys } = await res.json()
    expect((keys || []).filter((k: any) => String(k.name || k).includes('deleter'))).toHaveLength(0)
  })
})

test.describe('speak: free-form messages', () => {
  const EMAIL = 'msg-e2e@example.com'

  // Staging a clip is the same in either mode — the recorder is shared. Only
  // the subject fields and the submit metadata differ.
  async function stageAClip(page) {
    await page.locator('.speak-upload input[type="file"]').setInputFiles({
      name: 'take.wav', mimeType: 'audio/wav', buffer: tinyWav(),
    })
    await expect(page.locator('.speak-preview')).toBeVisible()
    await page.locator('.speak-consent input[type="checkbox"]').check()
  }

  async function sendMessage(page, subject: string, note = '') {
    // Real members are held to one message a minute on purpose (the cap is a
    // soft bound and this throttle is what makes beating it need concurrency
    // rather than a loop). A test sending two back to back has to clear it.
    await wipeKv(page, `rate:voice_msg:${EMAIL}`)
    await page.locator('.speak-mode-btn', { hasText: 'Send a message' }).click()
    await page.locator('.speak-subject-input').fill(subject)
    if (note) await page.locator('.speak-note-input').fill(note)
    await stageAClip(page)
    await page.getByRole('button', { name: 'Submit clip' }).click()
  }

  test('the member writes their own subject, and it becomes the headline', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')

    await page.locator('.speak-mode-btn', { hasText: 'Send a message' }).click()
    // The band stops calling it the round's prompt and stops quoting the
    // member's own words back at them.
    await expect(page.locator('.speak-eyebrow-text')).toHaveText('Your message')
    await expect(page.locator('.speak-q').first()).toBeHidden()
    await expect(page.locator('.speak-prompt-text')).toHaveText('What is on your mind?')

    await page.locator('.speak-subject-input').fill('The ending of Nope, explained')
    await expect(page.locator('.speak-prompt-text')).toHaveText('The ending of Nope, explained')
    await expect(page.locator('.speak-subject-left')).toHaveText('51')

    await stageAClip(page)
    await page.getByRole('button', { name: 'Submit clip' }).click()

    const row = page.locator('.hrow').filter({ hasText: 'The ending of Nope, explained' })
    await expect(row).toBeVisible()
    await expect(row.locator('.hrow-badge')).toHaveText('Your message')
    // The subject is NOT wrapped in the round's quote marks.
    await expect(row.locator('.hrow-prompt')).toHaveText('The ending of Nope, explained')
  })

  test('a message and a round answer coexist, and the round stays pinned first', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')
    await sendMessage(page, 'A thought about Sirk')

    // Answering the round is a separate submission on a separate throttle.
    await page.locator('.speak-mode-btn', { hasText: 'Answer this round' }).click()
    await stageAClip(page)
    await page.getByRole('button', { name: 'Submit clip' }).click()

    await expect(page.locator('.hrow')).toHaveCount(2)
    await expect(page.locator('.hrow').first().locator('.hrow-badge')).toHaveText('This round')
    await expect(page.locator('.hrow').nth(1).locator('.hrow-badge')).toHaveText('Your message')
  })

  test('several messages stack up, and deleting one leaves the rest', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')
    await sendMessage(page, 'First thing on my mind')
    await sendMessage(page, 'Second thing on my mind')
    await expect(page.locator('.hrow')).toHaveCount(2)

    page.once('dialog', d => d.accept())
    await page.locator('.hrow').filter({ hasText: 'First thing on my mind' })
      .getByRole('button', { name: 'Delete' }).click()

    await expect(page.locator('.hrow')).toHaveCount(1)
    await expect(page.locator('.hrow')).toContainText('Second thing on my mind')
  })

  test('the subject is required, and saying so costs no round trip', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')
    await page.locator('.speak-mode-btn', { hasText: 'Send a message' }).click()
    await stageAClip(page)
    await page.getByRole('button', { name: 'Submit clip' }).click()

    await expect(page.locator('.speak-recorder .rsvp-err')).toContainText('subject')
    // Nothing was sent, and the take is still staged for them.
    await expect(page.locator('.speak-preview')).toBeVisible()
    await expect(page.locator('.hrow')).toHaveCount(0)
  })

  test('switching modes does not destroy a staged recording', async ({ page }) => {
    // The whole reason speak-compose is its own component: a parent update()
    // re-evaluates speak-recorder's script and drops the module-scope blob.
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')
    await stageAClip(page)
    await expect(page.locator('.speak-status-dd')).toHaveText('Draft')

    await page.locator('.speak-mode-btn', { hasText: 'Send a message' }).click()
    await expect(page.locator('.speak-preview')).toBeVisible()
    await expect(page.locator('audio.speak-player')).toHaveCount(1)

    await page.locator('.speak-subject-input').fill('Kept my take across the switch')
    await page.getByRole('button', { name: 'Submit clip' }).click()
    await expect(page.locator('.hrow')).toContainText('Kept my take across the switch')
  })

  // A parent update() re-evaluates speak-recorder's script and wipes the
  // module-scope blob holding an unsubmitted take. Delete and Replace both
  // cause one, and both sit directly below the recorder — which in message
  // mode stays visible even after the round is answered. SPEAK_LOSE guarded
  // navigation only, so these two destroyed a take in silence.
  //
  // The assertions check the dialog TEXT, not just that a dialog appeared:
  // Delete has always confirmed, so dismissing that pre-existing prompt would
  // cancel the delete and leave the preview on screen whether the take was
  // guarded or not. Only the added sentence distinguishes the two.
  test('deleting warns that it will also lose an unsubmitted recording', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')
    await sendMessage(page, 'Something already on file')
    await expect(page.locator('.hrow')).toHaveCount(1)

    // Stage a second take and leave it unsubmitted.
    await stageAClip(page)
    await expect(page.locator('.speak-preview')).toBeVisible()

    let asked = ''
    page.once('dialog', d => { asked = d.message(); d.dismiss() })
    await page.locator('.hrow-act[data-act="delete"]').first().click()

    expect(asked).toContain('has not been submitted')
    // Dismissed, so nothing happened on either side.
    await expect(page.locator('.hrow')).toHaveCount(1)
    await expect(page.locator('.speak-preview')).toBeVisible()
  })

  test('replacing warns before it discards an unsubmitted recording', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')
    await stageAClip(page)
    await page.getByRole('button', { name: 'Submit clip' }).click()
    await expect(page.locator('.hrow')).toHaveCount(1)

    // Record again without submitting, then try to Replace.
    await page.locator('.speak-mode-btn', { hasText: 'Send a message' }).click()
    await stageAClip(page)
    await expect(page.locator('.speak-preview')).toBeVisible()

    let asked = ''
    page.once('dialog', d => { asked = d.message(); d.dismiss() })
    await page.locator('.hrow-act[data-act="replace"]').first().click()

    expect(asked).toContain('has not been submitted')
    await expect(page.locator('.speak-preview')).toBeVisible()
  })

  // The guard must not nag when there is nothing to lose: Replace with no
  // staged take asks nothing at all, and Delete keeps its original one-line
  // question rather than growing a sentence about a recording that does not
  // exist. Two stacked dialogs would also deadlock the page.
  test('with nothing staged, the warning stays out of the way', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')
    await sendMessage(page, 'Something already on file')
    await expect(page.locator('.hrow')).toHaveCount(1)

    let asked = ''
    page.once('dialog', d => { asked = d.message(); d.dismiss() })
    await page.locator('.hrow-act[data-act="delete"]').first().click()
    expect(asked).toContain('cannot be undone')
    expect(asked).not.toContain('has not been submitted')
  })

  // The band lives in speak-view's template, so a parent update() repaints it
  // from the round-mode bindings and remounts speak-compose. mounted() restored
  // the mode but never repainted, leaving the two halves disagreeing: chooser
  // and fields still set to message, headline and lede back on the round. The
  // fields carry no value binding either, so the remount blanked them while the
  // globals kept the text — which would submit a subject nobody can see.
  //
  // Delete is the cheapest parent update() to trigger, and in message mode it
  // sits directly below an always-visible recorder, so it is easy to reach.
  test('deleting the round clip does not disturb a message in progress', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')
    await stageAClip(page)
    await page.getByRole('button', { name: 'Submit clip' }).click()
    await expect(page.locator('.speak-upload')).toBeHidden()

    await page.locator('.speak-mode-btn', { hasText: 'Send a message' }).click()
    const subject = 'What I actually wanted to say'
    await page.locator('.speak-subject-input').fill(subject)
    await page.locator('.speak-note-input').fill('A note that must survive too')
    await expect(page.locator('.speak-prompt-text')).toHaveText(subject)

    page.once('dialog', d => d.accept())
    await page.locator('.hrow-act[data-act="delete"]').first().click()
    await expect(page.locator('.hrow-act[data-act="delete"]')).toHaveCount(0)

    // The band still describes the message, not the round...
    await expect(page.locator('.speak-prompt-text')).toHaveText(subject)
    await expect(page.locator('.speak-eyebrow-text')).toHaveText('Your message')
    // ...and the member can still see what they typed.
    await expect(page.locator('.speak-subject-input')).toHaveValue(subject)
    await expect(page.locator('.speak-note-input')).toHaveValue('A note that must survive too')
  })

  // The subject and note are member-authored free text with no spaces
  // guaranteed anywhere in them. Nothing in css/*.css wrapped long words, so a
  // single unbroken run pushed the document wider than the viewport — while
  // they were still typing it, in the band headline, and afterwards in history.
  test('a long unbroken subject or note never scrolls the page sideways', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/speak')

    const width = () => page.evaluate(() => document.documentElement.scrollWidth)
    const viewport = () => page.evaluate(() => document.documentElement.clientWidth)

    await page.locator('.speak-mode-btn', { hasText: 'Send a message' }).click()
    await page.locator('.speak-subject-input').fill('W'.repeat(80))
    // The headline mirrors the subject as it is typed, so the overflow is live.
    await expect(page.locator('.speak-band-head')).toContainText('WWWW')
    expect(await width()).toBeLessThanOrEqual(await viewport())

    await page.locator('.speak-note-input').fill('N'.repeat(500))
    await stageAClip(page)
    await page.getByRole('button', { name: 'Submit clip' }).click()
    await expect(page.locator('.hrow-prompt').first()).toContainText('WWWW')
    expect(await width()).toBeLessThanOrEqual(await viewport())
  })

  // Every non-2xx used to be reported to the member as "The consent box must be
  // checked first", including the eight other reasons the worker sends a 400
  // for. A pasted tab is the easiest one to hit by accident: a single-line
  // input strips CR/LF but keeps tabs, so the member was blamed for something
  // they had already done, with nothing to act on.
  test('a rejected subject says what is actually wrong with it', async ({ page }) => {
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await wipeKv(page, `rate:voice_msg:${EMAIL}`)
    await page.goto('/speak')

    await page.locator('.speak-mode-btn', { hasText: 'Send a message' }).click()
    await page.locator('.speak-subject-input').fill('The ending\tof Nope, explained')
    await stageAClip(page)
    await expect(page.locator('.speak-consent input[type="checkbox"]')).toBeChecked()
    await page.getByRole('button', { name: 'Submit clip' }).click()

    const err = page.locator('.speak .rsvp-err')
    await expect(err).toBeVisible()
    await expect(err).toContainText(/control characters/i)
    await expect(err).not.toContainText(/consent/i)
  })

  test('a member who already answered the round can still send a message', async ({ page }) => {
    // Answering hides the recorder behind the submitted state; the message
    // mode has to bring it back or the second door is unreachable.
    await signInAs(page, EMAIL, { name: 'Msg Member' })
    await page.goto('/speak')
    await stageAClip(page)
    await page.getByRole('button', { name: 'Submit clip' }).click()
    await expect(page.locator('.speak-upload')).toBeHidden()

    await page.locator('.speak-mode-btn', { hasText: 'Send a message' }).click()
    await expect(page.locator('.speak-upload')).toBeVisible()

    // ...and switching BACK has to hide it again. paint() only ever forced the
    // recorder open, never closed it, so the member returned to the round with
    // a live recorder and no "Keep my current clip" beside it — and submitting
    // from there silently replaced the answer they had already sent.
    await page.locator('.speak-mode-btn', { hasText: 'Answer this round' }).click()
    await expect(page.locator('.speak-upload')).toBeHidden()
  })
})

test.describe('speak: the signed-out door', () => {
  test('offers logging in and joining as the two different things they are', async ({ page }) => {
    await page.goto('/speak')
    // The primary action used to read "Record a clip" and silently jump to
    // /signin — a full load, which GitHub Pages answers with a 404 document.
    await expect(page.locator('.speak-band-btn').first()).toHaveText('Log in to record')
    await expect(page.locator('.speak-band-btn').nth(1)).toHaveText('Join the club')
    // The reassurance line is a real link now, not dead text saying "log in".
    const reassure = page.locator('.speak-band-reassure:visible')
    await expect(reassure.locator('a[href="/signin"]')).toHaveCount(1)
    await expect(reassure.locator('a[href="https://join.jxnfilm.club/"]')).toHaveCount(1)
  })

  test('logging in from /speak comes back to /speak', async ({ page }) => {
    await page.goto('/speak')
    await page.locator('.speak-band-btn').first().click()
    await page.waitForURL(/\/signin/)
    await signInAs(page, 'return-e2e@example.com', { name: 'Return Member', skipGoto: true })
    await page.waitForURL(/\/speak/, { timeout: 10_000 })
    expect(page.url()).toContain('/speak')
  })
})

test.describe('finding the way in', () => {
  test('Log in is one tap on a phone, without opening the menu', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 })
    await page.goto('/')
    const login = page.locator('.mastnav-auth a.nav-login')
    await expect(login).toBeVisible()
    // The collapsed menu is still collapsed — this is the point.
    await expect(page.locator('.mastnav-links')).toBeHidden()
    // …and it sits on the logo row rather than wrapping under it.
    const logo = await page.locator('.mastnav .logo').boundingBox()
    const box = await login.boundingBox()
    expect(Math.abs((box!.y + box!.height / 2) - (logo!.y + logo!.height / 2))).toBeLessThan(30)
  })

  test('Speak is in the nav — an open mic you can only find by email is not open', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('link', { name: 'Speak', exact: true }).click()
    await page.waitForURL(/\/speak/)
    await expect(page.locator('.speak-band')).toBeVisible()
  })

  test('a stashed return path is allowlisted, so it cannot be steered off-site', async ({ page }) => {
    await page.goto('/signin')
    await page.evaluate(() => { sessionStorage.jxnfc_next = '//evil.example' })
    await signInAs(page, 'safe-e2e@example.com', { name: 'Safe Member', skipGoto: true })
    await page.waitForURL(/\/edit/, { timeout: 10_000 })
    expect(page.url()).toContain('/edit')
    expect(page.url()).not.toContain('evil.example')
  })
})
