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
    await expect(page.locator('h1')).toHaveText('Speak on the podcast')
    await expect(page.locator('.speak-prompt-text')).toHaveText("Tell us what you're watching")
    await expect(page.locator('.speak .lede')).toContainText('log in')
  })

  test('config:voice_prompt overrides the prompt text', async ({ page }) => {
    await seedKv(page, 'config:voice_prompt', JSON.stringify({
      id: 'e2e-prompt', text: 'Best theater snack?', deadline: '2099-12-31',
    }))
    await page.goto('/speak')
    await expect(page.locator('.speak-prompt-text')).toHaveText('Best theater snack?')
    await expect(page.locator('.speak-deadline')).toBeVisible()
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

    // Success reloads the view; the submitted card shows pending status.
    await expect(page.locator('.speak-clip')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.speak-status')).toHaveText('Pending review')

    // Admin: the clip appears in the Voice tab and can be approved.
    await page.goto(`${ADMIN_ORIGIN}/`)
    await page.locator('#tabs button[data-tab="voice"]').click()
    const clip = page.locator('.voice-clip', { hasText: 'E2E Speaker' })
    await expect(clip).toBeVisible()
    await expect(clip.locator('.pill', { hasText: 'pending' })).toBeVisible()
    await clip.getByRole('button', { name: /approve/i }).click()
    await expect(clip.locator('.pill', { hasText: 'approved' })).toBeVisible()
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
    await page.locator('.speak-consent input[type="checkbox"]').check()
    await page.getByRole('button', { name: 'Submit clip' }).click()
    await expect(page.locator('.speak-clip')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.speak-status')).toHaveText('Pending review')
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
    await expect(page.locator('.speak-clip')).toBeVisible({ timeout: 10_000 })

    await page.getByRole('button', { name: 'Delete it' }).click()
    // Back to the fresh recorder state; the KV row is gone.
    await expect(page.locator('.speak-upload')).toBeVisible({ timeout: 10_000 })
    const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?prefix=${encodeURIComponent('voice:')}`)
    const { keys } = await res.json()
    expect((keys || []).filter((k: any) => String(k.name || k).includes('deleter'))).toHaveLength(0)
  })
})
