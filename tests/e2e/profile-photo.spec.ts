import zlib from 'node:zlib'
import { test, expect, signInAs, WORKER_ORIGIN } from './fixtures'
import type { Page } from '@playwright/test'

const ADMIN_ORIGIN = 'http://localhost:5175'

// A solid-colour RGB PNG, built here so the spec needs no binary fixture.
// Large enough to clear the 128px minimum the /edit panel enforces.
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}

const RED = { name: 'red.png', mimeType: 'image/png', buffer: png(300, 200, [200, 30, 30]) }
const BLUE = { name: 'blue.png', mimeType: 'image/png', buffer: png(240, 240, [30, 60, 200]) }

async function memberRow(page: Page, email: string) {
  const res = await page.request.get(`${WORKER_ORIGIN}/__test/kv?key=${encodeURIComponent('member:' + email)}`)
  return JSON.parse((await res.json()).value)
}

async function uploadFromEdit(page: Page, file: typeof RED) {
  await page.locator('.av-pick input[type=file]').setInputFiles(file)
  await expect(page.locator('.av-hint')).toContainText('Preview')
  await page.getByRole('button', { name: 'Use this photo' }).click()
}

test.describe('profile photo', () => {
  test('upload from /edit shows a preview, saves, and replaces the avatar in the directory', async ({ page }) => {
    const email = 'photo-up@example.com'
    await signInAs(page, email, { id: 'photoUp01', name: 'Photo Uploader' })

    await expect(page.getByRole('heading', { name: 'Profile photo' })).toBeVisible()
    await expect(page.locator('.av-photo.-letter')).toHaveText('P')
    await uploadFromEdit(page, RED)
    await expect(page.locator('.av-panel .ok')).toContainText('Saved')
    await expect(page.locator('img.av-photo')).toHaveAttribute('src', /\/av\/photoUp01\/[a-f0-9]{64}\.(webp|jpg)$/)
    await expect(page.getByRole('button', { name: 'Replace photo' })).toBeVisible()

    const saved = await memberRow(page, email)
    expect(saved.avatar.file).toMatch(/^[a-f0-9]{64}\.(webp|jpg)$/)
    // The browser re-encoded it: square, and no longer the PNG that was picked.
    const img = await page.request.get(`${WORKER_ORIGIN}/av/photoUp01/${saved.avatar.file}`)
    expect(img.ok()).toBeTruthy()
    expect(img.headers()['content-type']).toMatch(/image\/(webp|jpeg)/)

    await page.goto('/members')
    const card = page.locator('.member-card', { hasText: 'Photo Uploader' })
    await expect(card.locator('.avatar img')).toHaveAttribute('src', new RegExp(`/av/photoUp01/${saved.avatar.file}$`))
  })

  test('cancel discards the preview, and remove goes back to the letter avatar', async ({ page }) => {
    page.on('dialog', d => d.accept())
    const email = 'photo-rm@example.com'
    await signInAs(page, email, { id: 'photoRm01', name: 'Remy' })

    await page.locator('.av-pick input[type=file]').setInputFiles(RED)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('.av-photo.-letter')).toHaveText('R')
    expect((await memberRow(page, email)).avatar).toBeUndefined()

    await uploadFromEdit(page, RED)
    await expect(page.locator('.av-panel .ok')).toContainText('Saved')
    await page.getByRole('button', { name: 'Remove photo' }).click()
    await expect(page.locator('.av-panel .ok')).toContainText('Photo removed')
    await expect(page.locator('.av-photo.-letter')).toHaveText('R')
    expect((await memberRow(page, email)).avatar).toBeUndefined()
  })

  test('an admin flag hides the photo, tells the member why, and requires a different one', async ({ page }) => {
    const email = 'photo-flag@example.com'
    await signInAs(page, email, { id: 'photoFlag1', name: 'Flagged Member' })
    await uploadFromEdit(page, RED)
    await expect(page.locator('.av-panel .ok')).toContainText('Saved')

    // Admin dashboard: the reason typed into the prompt is what the member sees.
    page.once('dialog', d => d.accept('Not a photo of you'))
    await page.goto(`${ADMIN_ORIGIN}/`)
    const row = page.locator('#members-table tbody tr', { hasText: email })
    await row.getByRole('button', { name: 'flag photo' }).click()
    await expect(row.locator('.stat-flag')).toHaveText('flagged')
    await expect(row.getByRole('button', { name: 'unflag photo' })).toBeVisible()
    expect((await memberRow(page, email)).avatar.flagged.reason).toBe('Not a photo of you')

    // Gone from the public directory at once.
    await page.goto('/members')
    const card = page.locator('.member-card', { hasText: 'Flagged Member' })
    await expect(card.locator('.avatar b')).toHaveText('F')

    // The member sees the notice on /edit, and the same photo is refused.
    await page.goto('/edit')
    await expect(page.locator('.av-flag')).toContainText('An organizer removed your photo')
    await expect(page.locator('.av-flag')).toContainText('Not a photo of you')
    await uploadFromEdit(page, RED)
    await expect(page.locator('.av-panel .err:not(.av-flag)')).toContainText('removed by a moderator')

    // A different photo clears the notice.
    await page.getByRole('button', { name: 'Cancel' }).click()
    await uploadFromEdit(page, BLUE)
    await expect(page.locator('.av-panel .ok')).toContainText('Saved')
    await expect(page.locator('.av-flag')).toHaveCount(0)
    const saved = await memberRow(page, email)
    expect(saved.avatar.flagged).toBeUndefined()
    expect(saved.avatar.blocked).toHaveLength(1)
  })
})
