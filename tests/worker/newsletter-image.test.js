import { SELF, env } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'

const ADMIN = 'test-admin-token'
const ORIGIN = 'https://join.jxnfilm.club'

// A one-pixel PNG, as bytes and as the base64 the admin actually posts.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function upload(body, { token = ADMIN } = {}) {
  return SELF.fetch(`${ORIGIN}/admin/newsletter/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

const fetchImg = (name, method = 'GET') => SELF.fetch(`${ORIGIN}/nl/img/${name}`, { method })

describe('POST /admin/newsletter/image', () => {
  it('401s without the admin token', async () => {
    expect((await upload({ contentType: 'image/png', b64: PNG_B64 }, { token: null })).status).toBe(401)
    expect((await upload({ contentType: 'image/png', b64: PNG_B64 }, { token: 'wrong' })).status).toBe(401)
  })

  it('415s a type outside the allowlist', async () => {
    // SVG in particular: it can carry script, and no client here produces one.
    for (const contentType of ['image/svg+xml', 'image/gif', 'text/html', '']) {
      expect((await upload({ contentType, b64: PNG_B64 })).status).toBe(415)
    }
  })

  it('400s empty or non-base64 payloads', async () => {
    expect((await upload({ contentType: 'image/png', b64: '' })).status).toBe(400)
    expect((await upload({ contentType: 'image/png', b64: '!!!not base64!!!' })).status).toBe(400)
  })

  it('413s on the declared length, before decoding anything', async () => {
    // 3MB of base64 carries ~2.25MB — over the 1.5MB cap, so it is rejected
    // without ever allocating the decoded buffer.
    const huge = 'A'.repeat(3 * 1024 * 1024)
    expect((await upload({ contentType: 'image/jpeg', b64: huge })).status).toBe(413)
  })

  it('allows a payload exactly at the cap', async () => {
    // Boundary: 2MB of base64 decodes to precisely 1.5MB. "1.5MB max" means
    // 1.5MB is fine — this pins that the check is > and not >=.
    const exact = 'A'.repeat(2 * 1024 * 1024)
    expect((await upload({ contentType: 'image/jpeg', b64: exact })).status).toBe(200)
  })

  it('stores the image and returns a URL on this origin', async () => {
    const res = await upload({ contentType: 'image/png', b64: PNG_B64 })
    expect(res.status).toBe(200)
    const { url, key } = await res.json()
    expect(key).toMatch(/^[a-f0-9]{64}\.png$/)
    expect(url).toBe(`${ORIGIN}/nl/img/${key}`)
    // Consume the body. An R2 get whose stream is never read leaves the
    // connection open, and miniflare's isolated-storage snapshot then trips on
    // the resulting .sqlite-shm sidecar with an opaque "Isolated storage
    // failed". Reading it also makes this a real round-trip assertion.
    const obj = await env.NEWS.get(`newsletter/${key}`)
    expect(obj).not.toBeNull()
    expect((await obj.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('is content-addressed, so the same image twice is the same object', async () => {
    // Makes re-inserting a flyer idempotent, and makes an undone insert leave
    // an orphan the next identical upload reuses rather than duplicating.
    const a = await (await upload({ contentType: 'image/png', b64: PNG_B64 })).json()
    const b = await (await upload({ contentType: 'image/png', b64: PNG_B64 })).json()
    expect(a.key).toBe(b.key)
  })
})

describe('GET /nl/img/:name — public', () => {
  let key
  beforeEach(async () => {
    key = (await (await upload({ contentType: 'image/png', b64: PNG_B64 })).json()).key
  })

  it('serves the bytes with no auth at all', async () => {
    // Email clients send no cookies and no bearer token, and Gmail fetches
    // through its own proxy — if this ever required auth the images die.
    const res = await fetchImg(key)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0)
  })

  it('sets immutable caching and nosniff', async () => {
    const res = await fetchImg(key)
    expect(res.headers.get('Cache-Control')).toMatch(/immutable/)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('answers HEAD, which some clients and scanners send first', async () => {
    const res = await fetchImg(key, 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
  })

  it('404s a malformed name without reading R2', async () => {
    // The key regex is what stops this route being walked into another prefix.
    for (const bad of ['../voice/x.mp3', 'notahash.jpg', `${'a'.repeat(64)}.svg`, `${'a'.repeat(63)}.jpg`, 'x']) {
      expect((await fetchImg(bad)).status).toBe(404)
    }
  })

  it('404s a well-formed name that was never uploaded', async () => {
    expect((await fetchImg(`${'b'.repeat(64)}.jpg`)).status).toBe(404)
  })

  it('takes its content type from the validated extension, not stored metadata', async () => {
    // A future writer setting the wrong httpMetadata must not be able to make
    // this route serve something else.
    await env.NEWS.put(`newsletter/${'c'.repeat(64)}.jpg`, new Uint8Array([1, 2, 3]),
      { httpMetadata: { contentType: 'text/html' } })
    const res = await fetchImg(`${'c'.repeat(64)}.jpg`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
  })
})
