import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

function fetchWith(path, method, body, token) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function getTokenFor(email, memberOverrides = {}) {
  const member = {
    id: 'id-' + email, email, name: 'M', handle: null, joined: '2026-01-01', ...memberOverrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await fetchWith('/otp/verify', 'POST', { email, code: '111111' })
  return { token: (await res.json()).token, member }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /member/update', () => {
  it('returns 401 without a token', async () => {
    const res = await fetchWith('/member/update', 'POST', { name: 'X' })
    expect(res.status).toBe(401)
  })

  it('applies name + pronouns and dispatches update-member keyed by id', async () => {
    const { token, member } = await getTokenFor('auth@example.com')
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    const res = await fetchWith('/member/update', 'POST',
      { name: 'New Name', pronouns: 'they/them' }, token)
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe(member.id)

    const saved = JSON.parse(await env.MEMBERS_KV.get('member:auth@example.com'))
    expect(saved.name).toBe('New Name')
    expect(saved.pronouns).toBe('they/them')

    // session:{id} refreshes in-band so the next /member/me read sees the
    // new values without waiting on the update-member workflow.
    const session = JSON.parse(await env.MEMBERS_KV.get(`session:${member.id}`))
    expect(session.name).toBe('New Name')
    expect(session.pronouns).toBe('they/them')

    const gh = calls.find(c => c.url.includes('api.github.com'))
    const dispatch = JSON.parse(gh.init.body)
    expect(dispatch.event_type).toBe('update-member')
    expect(dispatch.client_payload.id).toBe(member.id)
    expect(dispatch.client_payload.updates).toEqual({ name: 'New Name', pronouns: 'they/them' })
  })

  it('ignores client-supplied handle — only name/pronouns are editable here', async () => {
    const { token } = await getTokenFor('ignore@example.com')
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    await fetchWith('/member/update', 'POST',
      { handle: 'someoneelse', pronouns: 'x' }, token)
    const dispatch = JSON.parse(calls.find(c => c.url.includes('api.github.com')).init.body)
    expect(dispatch.client_payload.updates.handle).toBeUndefined()
  })

  it('rejects tampered or expired tokens with 401', async () => {
    const { token } = await getTokenFor('tamper@example.com')
    const [_p, sig] = token.split('.')
    const evil = btoa(JSON.stringify({ email: 'attacker@example.com', id: 'x', exp: Date.now() + 3600_000 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/update', 'POST', { name: 'X' }, `${evil}.${sig}`)
    expect(res.status).toBe(401)
  })

  it('rejects empty update body with 400', async () => {
    const { token } = await getTokenFor('empty@example.com')
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/update', 'POST', {}, token)
    expect(res.status).toBe(400)
  })
})

describe('GET /member/me', () => {
  it('reads from session:{id} when present', async () => {
    const { token, member } = await getTokenFor('me-session@example.com')
    // Replace the session snapshot with a deliberately divergent payload to
    // prove /member/me reads session:{id}, not member:{email}.
    await env.MEMBERS_KV.put(
      `session:${member.id}`,
      JSON.stringify({ ...member, name: 'From Session' }),
      { expirationTtl: 3600 },
    )
    const res = await fetchWith('/member/me', 'GET', undefined, token)
    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe('From Session')
  })

  it('falls back to member:{email} on session miss and reseeds', async () => {
    const { token, member } = await getTokenFor('me-fallback@example.com')
    // Wipe the session KV entry seeded by /otp/verify; /member/me should
    // re-read member:{email} and write the snapshot back.
    await env.MEMBERS_KV.delete(`session:${member.id}`)

    const res = await fetchWith('/member/me', 'GET', undefined, token)
    expect(res.status).toBe(200)
    expect((await res.json()).email).toBe(member.email)

    const reseeded = await env.MEMBERS_KV.get(`session:${member.id}`)
    expect(reseeded).toBeTruthy()
  })

  it('401 when no bearer token is supplied', async () => {
    const res = await fetchWith('/member/me', 'GET')
    expect(res.status).toBe(401)
  })

  it('404 when neither session:{id} nor member:{email} exist', async () => {
    // Build a valid token for an email that has no member row so that
    // authorize() succeeds but readSession finds nothing to fall back to.
    const { token, member } = await getTokenFor('ghost-session@example.com')
    await env.MEMBERS_KV.delete(`session:${member.id}`)
    await env.MEMBERS_KV.delete(`member:${member.email}`)

    const res = await fetchWith('/member/me', 'GET', undefined, token)
    expect(res.status).toBe(404)
  })
})

describe('session:{id} KV overlay — snapshot semantics', () => {
  it('stale session is overwritten (not merged) after /member/update', async () => {
    const { token, member } = await getTokenFor('stale@example.com', {
      name: 'Stale Name', pronouns: 'stale/them',
    })
    // Seed a deliberately outdated snapshot with a bogus field that should
    // NOT survive — /member/update writes a fresh snapshot from member:{email}
    // rather than merging on top of whatever was in session:{id}.
    await env.MEMBERS_KV.put(
      `session:${member.id}`,
      JSON.stringify({ ...member, name: 'Outdated', phantomField: 'leak' }),
      { expirationTtl: 3600 },
    )

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/update', 'POST',
      { name: 'Fresh Name', pronouns: 'they/them' }, token)
    expect(res.status).toBe(200)

    const session = JSON.parse(await env.MEMBERS_KV.get(`session:${member.id}`))
    expect(session.name).toBe('Fresh Name')
    expect(session.pronouns).toBe('they/them')
    // The stale `phantomField` must not survive a refresh — proves the
    // snapshot was overwritten from the canonical member row, not merged.
    expect(session.phantomField).toBeUndefined()
  })

  it('writes session:{id} with the 1h (3600s) TTL via expirationTtl', async () => {
    // Miniflare doesn't expose time travel cleanly here, so we verify the
    // snapshot is immediately readable after a write and matches the member
    // row — shape check rather than expiry check. The TTL itself is asserted
    // via KV metadata below.
    const { member } = await getTokenFor('ttl@example.com', { name: 'TTL User' })
    const session = JSON.parse(await env.MEMBERS_KV.get(`session:${member.id}`))
    expect(session.name).toBe('TTL User')
    expect(session.email).toBe('ttl@example.com')
    expect(session.id).toBe(member.id)

    // getWithMetadata exposes KV's internal expiration. In miniflare this is
    // an absolute unix-seconds timestamp; we assert it's ~3600s from now
    // (SESSION_TTL), allowing generous slack for test timing.
    const { metadata, value } = await env.MEMBERS_KV.getWithMetadata(`session:${member.id}`)
    expect(value).toBeTruthy()
    // Miniflare surfaces expiration via a separate list/list API; as a
    // cross-check, list the key and inspect its `expiration` field.
    const list = await env.MEMBERS_KV.list({ prefix: `session:${member.id}` })
    const entry = list.keys.find(k => k.name === `session:${member.id}`)
    expect(entry).toBeTruthy()
    const nowSec = Math.floor(Date.now() / 1000)
    // Expect the expiration to be within [now+3400, now+3700] — gives us a
    // 300s window for clock skew while still proving TTL is ~3600s, not
    // something wildly different like 60s or 86400s.
    expect(entry.expiration).toBeGreaterThan(nowSec + 3400)
    expect(entry.expiration).toBeLessThan(nowSec + 3700)
    // Silence the unused-var lint (metadata is intentionally unused).
    void metadata
  })
})
