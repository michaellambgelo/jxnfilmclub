import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ORIGIN = 'https://join.jxnfilm.club'
const ADMIN = 'test-admin-token'

// Real headers, padded: the Worker sniffs the first bytes and never decodes.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
const jpeg = (seed = 0) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, seed, 1, 2, 3, 4, 5])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20])

async function sha(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function signIn(email, overrides = {}) {
  const member = { id: 'id' + email.split('@')[0], email, name: 'Avatar Tester', joined: '2026-01-01', ...overrides }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  globalThis.fetch = vi.fn(async () => new Response('', { status: 200 }))
  const res = await SELF.fetch(`${ORIGIN}/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: '111111' }),
  })
  return { token: (await res.json()).token, member }
}

// The Workers pool's isolated storage fails a suite that leaves any response
// body unread, so every helper drains its body and hands back a plain object.
async function drained(promise) {
  const res = await promise
  const text = await res.text()
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) }
}

const upload = (token, bytes, type = 'image/png') => drained(SELF.fetch(`${ORIGIN}/member/avatar`, {
  method: 'POST',
  headers: { 'Content-Type': type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: bytes,
}))
const remove = token => drained(SELF.fetch(`${ORIGIN}/member/avatar`, {
  method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
}))
const admin = (path, body, token = ADMIN) => drained(SELF.fetch(`${ORIGIN}/admin/member/avatar/${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}))
const row = async email => JSON.parse(await env.MEMBERS_KV.get(`member:${email}`))
const aggRow = async id => (JSON.parse(await env.MEMBERS_KV.get('members:all')) || []).find(m => m.id === id)

afterEach(() => { vi.restoreAllMocks() })

describe('POST /member/avatar', () => {
  it('401s without a session', async () => {
    expect((await upload(null, PNG)).status).toBe(401)
  })

  it('415s types outside the allowlist, and bytes that do not match the declared type', async () => {
    const { token } = await signIn('types@example.com')
    for (const type of ['image/svg+xml', 'image/gif', 'text/html', 'application/octet-stream']) {
      expect((await upload(token, PNG, type)).status).toBe(415)
    }
    // Declared PNG, actually JPEG; and a plain-text body calling itself WebP.
    expect((await upload(token, jpeg(), 'image/png')).status).toBe(415)
    expect((await upload(token, new TextEncoder().encode('<svg onload=alert(1)>'), 'image/webp')).status).toBe(415)
  })

  it('409s for a member id the /av/ route could not serve', async () => {
    const { token } = await signIn('oddid@example.com', { id: 'id-with@symbols.example' })
    expect((await upload(token, PNG)).status).toBe(409)
  })

  it('413s over 512KB and 400s an empty body', async () => {
    const { token } = await signIn('size@example.com')
    const big = new Uint8Array(512 * 1024 + 1); big.set(jpeg())
    expect((await upload(token, big, 'image/jpeg')).status).toBe(413)
    expect((await upload(token, new Uint8Array(0))).status).toBe(400)
  })

  it('stores the photo, publishes it on the member row, and serves it', async () => {
    const { token, member } = await signIn('happy@example.com')
    const res = await upload(token, PNG)
    expect(res.status).toBe(200)
    const file = `${await sha(PNG)}.png`
    expect(res.json().avatar).toBe(file)

    expect((await row('happy@example.com')).avatar.file).toBe(file)
    expect((await aggRow(member.id)).avatar).toBe(file)
    const session = JSON.parse(await env.MEMBERS_KV.get(`session:${member.id}`))
    expect(session.avatar.file).toBe(file)
    expect(await env.NEWS.head(`avatars/${member.id}/${file}`)).not.toBeNull()

    const img = await SELF.fetch(`${ORIGIN}/av/${member.id}/${file}`)
    expect(img.status).toBe(200)
    expect(img.headers.get('Content-Type')).toBe('image/png')
    expect(img.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(img.headers.get('Cache-Control')).toBe('public, max-age=3600')
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG)
    const head = await drained(SELF.fetch(`${ORIGIN}/av/${member.id}/${file}`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
  })

  it('accepts WebP and JPEG', async () => {
    const { token } = await signIn('formats@example.com')
    expect((await upload(token, WEBP, 'image/webp')).status).toBe(200)
    expect((await upload(token, jpeg(), 'image/jpeg; charset=binary')).status).toBe(200)
  })

  it('deletes the previous object on replace and is idempotent for the same bytes', async () => {
    const { token, member } = await signIn('replace@example.com')
    await upload(token, jpeg(1), 'image/jpeg')
    const first = `${await sha(jpeg(1))}.jpg`
    await upload(token, jpeg(2), 'image/jpeg')
    expect(await env.NEWS.head(`avatars/${member.id}/${first}`)).toBeNull()
    const second = (await row('replace@example.com')).avatar.file
    expect(await env.NEWS.head(`avatars/${member.id}/${second}`)).not.toBeNull()

    const again = await upload(token, jpeg(2), 'image/jpeg')
    expect(again.status).toBe(200)
    expect((await row('replace@example.com')).avatar.file).toBe(second)
  })

  it('rate-limits after 10 uploads in the window, counting only valid ones', async () => {
    const { token } = await signIn('rate@example.com')
    for (let i = 0; i < 3; i++) expect((await upload(token, PNG, 'image/gif')).status).toBe(415)
    for (let i = 0; i < 10; i++) expect((await upload(token, jpeg(i), 'image/jpeg')).status).toBe(200)
    expect((await upload(token, jpeg(99), 'image/jpeg')).status).toBe(429)
  })
})

describe('DELETE /member/avatar', () => {
  it('removes the object and the public field', async () => {
    const { token, member } = await signIn('remove@example.com')
    await upload(token, PNG)
    const file = (await row('remove@example.com')).avatar.file
    expect((await remove(token)).status).toBe(200)
    expect((await row('remove@example.com')).avatar).toBeUndefined()
    expect((await aggRow(member.id)).avatar).toBeUndefined()
    expect(await env.NEWS.head(`avatars/${member.id}/${file}`)).toBeNull()
  })

  it('400s when there is nothing to remove', async () => {
    const { token } = await signIn('nothing@example.com')
    expect((await remove(token)).status).toBe(400)
  })
})

describe('admin moderation', () => {
  it('requires the admin token and an existing photo', async () => {
    await signIn('mod401@example.com')
    expect((await admin('flag', { email: 'mod401@example.com' }, null)).status).toBe(401)
    expect((await admin('flag', { email: 'mod401@example.com' }, 'wrong')).status).toBe(401)
    expect((await admin('flag', { email: 'not-an-email' })).status).toBe(400)
    expect((await admin('flag', { email: 'ghost@example.com' })).status).toBe(404)
    expect((await admin('flag', { email: 'mod401@example.com' })).status).toBe(400)
  })

  it('flagging deletes the photo, hides it, tells the member why, and blocks the same bytes', async () => {
    const { token, member } = await signIn('flag@example.com')
    await upload(token, PNG)
    const file = `${await sha(PNG)}.png`

    const res = await admin('flag', { email: 'flag@example.com', reason: 'Not a photo of you' })
    expect(res.status).toBe(200)
    const saved = await row('flag@example.com')
    expect(saved.avatar.file).toBeUndefined()
    expect(saved.avatar.flagged).toMatchObject({ reason: 'Not a photo of you', file })
    expect(saved.avatar.blocked).toEqual([file.split('.')[0]])
    expect((await aggRow(member.id)).avatar).toBeUndefined()
    expect(await env.NEWS.head(`avatars/${member.id}/${file}`)).toBeNull()
    expect((await drained(SELF.fetch(`${ORIGIN}/av/${member.id}/${file}`))).status).toBe(404)
    // /member/me carries the notice so /edit can show it.
    const me = await drained(SELF.fetch(`${ORIGIN}/member/me`, { headers: { Authorization: `Bearer ${token}` } }))
    expect(me.json().avatar.flagged.reason).toBe('Not a photo of you')

    // The same photo again is refused; a different one replaces the notice.
    expect((await upload(token, PNG)).status).toBe(409)
    expect((await upload(token, jpeg(7), 'image/jpeg')).status).toBe(200)
    const after = await row('flag@example.com')
    expect(after.avatar.flagged).toBeUndefined()
    expect(after.avatar.blocked).toEqual([file.split('.')[0]])
    expect((await aggRow(member.id)).avatar).toBe(after.avatar.file)
  })

  it('uses a default reason and caps a long one', async () => {
    const { token } = await signIn('reason@example.com')
    await upload(token, PNG)
    await admin('flag', { email: 'reason@example.com' })
    expect((await row('reason@example.com')).avatar.flagged.reason).toBe('Removed by a moderator.')
    await upload(token, jpeg(3), 'image/jpeg')
    await admin('flag', { email: 'reason@example.com', reason: 'x'.repeat(500) })
    expect((await row('reason@example.com')).avatar.flagged.reason).toHaveLength(200)
    expect((await row('reason@example.com')).avatar.blocked).toHaveLength(2)
  })

  it('unflag clears the notice and lets the member upload that photo again', async () => {
    const { token } = await signIn('unflag@example.com')
    await upload(token, PNG)
    await admin('flag', { email: 'unflag@example.com' })
    expect((await admin('unflag', { email: 'unflag@example.com' })).status).toBe(200)
    expect((await row('unflag@example.com')).avatar).toBeUndefined()
    expect((await upload(token, PNG)).status).toBe(200)
    expect((await admin('unflag', { email: 'unflag@example.com' })).status).toBe(400)
  })

  it('a member can dismiss the notice by removing, and the block stays', async () => {
    const { token } = await signIn('dismiss@example.com')
    await upload(token, PNG)
    await admin('flag', { email: 'dismiss@example.com' })
    expect((await remove(token)).status).toBe(200)
    const saved = await row('dismiss@example.com')
    expect(saved.avatar.flagged).toBeUndefined()
    expect(saved.avatar.blocked).toHaveLength(1)
    expect((await upload(token, PNG)).status).toBe(409)
  })
})

describe('GET /av/*', () => {
  it('404s anything that is not {memberId}/{sha256}.{ext} before touching storage', async () => {
    for (const path of [
      'id1/abc.png',
      `id1/${'a'.repeat(64)}.gif`,
      `id1/${'a'.repeat(64)}.png/extra`,
      `../newsletter/${'a'.repeat(64)}.png`,
      `id1/../../${'a'.repeat(64)}.png`,
      `${'a'.repeat(64)}.png`,
    ]) {
      expect((await drained(SELF.fetch(`${ORIGIN}/av/${path}`))).status, path).toBe(404)
    }
  })
})

describe('account deletion', () => {
  it('deletes the photo with the account', async () => {
    const { token, member } = await signIn('leaving@example.com')
    await upload(token, PNG)
    const file = (await row('leaving@example.com')).avatar.file
    const res = await drained(SELF.fetch(`${ORIGIN}/member/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    }))
    expect(res.status).toBe(200)
    expect(await env.NEWS.head(`avatars/${member.id}/${file}`)).toBeNull()
  })
})
