import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

function post(path, body, { token, ip } = {}) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(ip ? { 'CF-Connecting-IP': ip } : {}),
    },
    body: JSON.stringify(body),
  })
}

async function getTokenFor(email, overrides = {}) {
  const member = {
    id: 'id-' + email, email, name: 'M', handle: null, joined: '2026-01-01', ...overrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await post('/otp/verify', { email, code: '111111' })
  return { token: (await res.json()).token, member }
}

async function listFeedback() {
  const list = await env.MEMBERS_KV.list({ prefix: 'feedback:' })
  const records = []
  for (const k of list.keys) {
    records.push({ key: k, value: JSON.parse(await env.MEMBERS_KV.get(k.name)) })
  }
  return records
}

const NINETY_DAYS = 90 * 24 * 3600

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /feedback', () => {
  it('stores an anonymous submission with a 90-day expiry', async () => {
    const res = await post('/feedback', { category: 'bug', message: '  The RSVP button overlaps the footer.  ', page: '/events' })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const [rec] = await listFeedback()
    expect(rec.value.category).toBe('bug')
    expect(rec.value.message).toBe('The RSVP button overlaps the footer.')
    expect(rec.value.page).toBe('/events')
    expect(rec.value.member).toBeNull()
    expect(rec.value.at).toBeTruthy()

    // TTL on the key itself, and the absolute expiry mirrored into the value
    // so identity-strip rewrites can preserve it.
    const now = Math.floor(Date.now() / 1000)
    expect(rec.key.expiration).toBeGreaterThan(now + NINETY_DAYS - 120)
    expect(rec.key.expiration).toBeLessThanOrEqual(now + NINETY_DAYS + 120)
    expect(Math.abs(rec.value.expiresAt - rec.key.expiration)).toBeLessThanOrEqual(120)
  })

  it('attaches server-resolved identity for a signed-in member', async () => {
    const { token, member } = await getTokenFor('alice@example.com', { name: 'Alice' })
    const res = await post('/feedback', { category: 'idea', message: 'Add a watchlist page.' }, { token })
    expect(res.status).toBe(200)

    const [rec] = await listFeedback()
    expect(rec.value.member).toEqual({ id: member.id, email: member.email, name: 'Alice' })
  })

  it('ignores body-supplied identity fields', async () => {
    const res = await post('/feedback', {
      category: 'other', message: 'hi',
      member: { id: 'spoofed', email: 'spoof@example.com', name: 'Spoof' },
    })
    expect(res.status).toBe(200)
    const [rec] = await listFeedback()
    expect(rec.value.member).toBeNull()
  })

  it('anonymous: true drops identity even with a valid token', async () => {
    const { token } = await getTokenFor('bob@example.com')
    const res = await post('/feedback', { category: 'bug', message: 'secret gripe', anonymous: true }, { token })
    expect(res.status).toBe(200)
    const [rec] = await listFeedback()
    expect(rec.value.member).toBeNull()
  })

  it('rejects invalid categories and out-of-range messages', async () => {
    expect((await post('/feedback', { category: 'praise', message: 'x' })).status).toBe(400)
    expect((await post('/feedback', { message: 'no category' })).status).toBe(400)
    expect((await post('/feedback', { category: 'bug', message: '' })).status).toBe(400)
    expect((await post('/feedback', { category: 'bug', message: '   ' })).status).toBe(400)
    expect((await post('/feedback', { category: 'bug', message: 'x'.repeat(2001) })).status).toBe(400)
    expect((await post('/feedback', { category: 'bug' })).status).toBe(400)
    expect(await listFeedback()).toHaveLength(0)
  })

  it('throttles per IP: second post within the window gets 429', async () => {
    expect((await post('/feedback', { category: 'bug', message: 'one' }, { ip: '1.2.3.4' })).status).toBe(200)
    expect((await post('/feedback', { category: 'bug', message: 'two' }, { ip: '1.2.3.4' })).status).toBe(429)
    // A different IP is unaffected.
    expect((await post('/feedback', { category: 'bug', message: 'three' }, { ip: '5.6.7.8' })).status).toBe(200)
    expect(await listFeedback()).toHaveLength(2)
  })

  it('invalid submissions do not consume the throttle slot', async () => {
    expect((await post('/feedback', { category: 'nope', message: 'x' }, { ip: '9.9.9.9' })).status).toBe(400)
    expect((await post('/feedback', { category: 'bug', message: 'valid' }, { ip: '9.9.9.9' })).status).toBe(200)
  })
})

describe('member delete strips feedback identity', () => {
  it('nulls member on their records, keeps text, preserves expiration', async () => {
    const { token, member } = await getTokenFor('carol@example.com', { name: 'Carol' })
    await post('/feedback', { category: 'bug', message: 'mine' }, { token, ip: '1.1.1.1' })
    await post('/feedback', { category: 'idea', message: 'someone elses' }, { ip: '2.2.2.2' })

    const before = await listFeedback()
    const mine = before.find(r => r.value.member)
    expect(mine.value.member.email).toBe(member.email)

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await post('/member/delete', {}, { token })
    expect(res.status).toBe(200)

    const after = await listFeedback()
    expect(after).toHaveLength(2)
    for (const rec of after) expect(rec.value.member).toBeNull()

    const mineAfter = after.find(r => r.key.name === mine.key.name)
    expect(mineAfter.value.message).toBe('mine')
    // The rewrite must carry the original absolute expiry — a bare put()
    // would clear the TTL and make the record permanent.
    expect(mineAfter.key.expiration).toBe(mine.key.expiration)
    expect(mineAfter.value.expiresAt).toBe(mine.value.expiresAt)
  })
})
