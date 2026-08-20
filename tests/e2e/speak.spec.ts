import { test, expect, seedKv, signInAs, WORKER_ORIGIN } from './fixtures'

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
    await expect(page.locator('.speak-player audio')).toBeAttached()
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
