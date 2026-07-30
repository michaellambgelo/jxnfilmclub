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

async function seedMember(email, overrides = {}) {
  const member = { id: 'id-' + email, email, name: 'M', handle: null, joined: '2026-01-01', ...overrides }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  return member
}

// Full OTP login, optionally with remember: true.
async function login(email, remember) {
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await fetchWith('/otp/verify', 'POST', { email, code: '111111', remember })
  return res.json()
}

// KV key for a refresh credential — secret is the segment after the LAST
// dot (test member ids contain dots).
function kvKeyOf(refresh) {
  const dot = refresh.lastIndexOf('.')
  return 'refresh:' + refresh.slice(0, dot) + ':' + refresh.slice(dot + 1)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('remember-this-device refresh tokens', () => {
  it('/otp/verify with remember: true returns a refresh token backed by KV', async () => {
    const member = await seedMember('rem1@example.com')
    const body = await login(member.email, true)

    expect(body.refresh).toBeTruthy()
    const dot = body.refresh.lastIndexOf('.')
    const [id, secret] = [body.refresh.slice(0, dot), body.refresh.slice(dot + 1)]
    expect(id).toBe(member.id)
    expect(secret).toMatch(/^[a-z0-9]{32}$/)
    const record = JSON.parse(await env.MEMBERS_KV.get(`refresh:${id}:${secret}`))
    expect(record.email).toBe(member.email)
  })

  it('/otp/verify without remember issues no refresh token', async () => {
    const member = await seedMember('rem2@example.com')
    const body = await login(member.email)
    expect(body.refresh).toBeUndefined()
    const list = await env.MEMBERS_KV.list({ prefix: `refresh:${member.id}:` })
    expect(list.keys.length).toBe(0)
  })

  it('/signup/verify with remember: true returns a refresh token', async () => {
    await env.MEMBERS_KV.put('pending:new@example.com', JSON.stringify({ name: 'New', code: '222222' }))
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await fetchWith('/signup/verify', 'POST', { email: 'new@example.com', code: '222222', remember: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.refresh).toBeTruthy()
    expect(await env.MEMBERS_KV.get(kvKeyOf(body.refresh))).toBeTruthy()
  })

  it('/session/refresh trades a device token for a working session token', async () => {
    const member = await seedMember('rem3@example.com', { handle: 'rem3lb' })
    const { refresh } = await login(member.email, true)

    const res = await fetchWith('/session/refresh', 'POST', { refresh })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.email).toBe(member.email)
    expect(body.id).toBe(member.id)
    expect(body.handle).toBe('rem3lb')

    // The refresh token survives (sliding window, no rotation) …
    expect(await env.MEMBERS_KV.get(kvKeyOf(refresh))).toBeTruthy()

    // … and the minted token authenticates against /member/me.
    const me = await fetchWith('/member/me', 'GET', undefined, body.token)
    expect(me.status).toBe(200)
    expect((await me.json()).email).toBe(member.email)
  })

  it('/session/refresh rejects unknown and malformed tokens with 401', async () => {
    // Well-formed (32-char alnum secret) but not in KV.
    expect((await fetchWith('/session/refresh', 'POST', { refresh: 'someid.' + 'a'.repeat(32) })).status).toBe(401)
    expect((await fetchWith('/session/refresh', 'POST', { refresh: 'no-dot-here' })).status).toBe(401)
    expect((await fetchWith('/session/refresh', 'POST', {})).status).toBe(401)
    expect((await fetchWith('/session/refresh', 'POST', { refresh: '../../etc.passwd' })).status).toBe(401)
  })

  it('/session/refresh for a deleted member 401s and drops the orphaned record', async () => {
    const member = await seedMember('rem4@example.com')
    const { refresh } = await login(member.email, true)
    await env.MEMBERS_KV.delete(`member:${member.email}`)

    const res = await fetchWith('/session/refresh', 'POST', { refresh })
    expect(res.status).toBe(401)
    expect(await env.MEMBERS_KV.get(kvKeyOf(refresh))).toBeNull()
  })

  it('/session/revoke with refresh in the body revokes the device token', async () => {
    const member = await seedMember('rem5@example.com')
    const { token, refresh } = await login(member.email, true)

    const revoke = await fetchWith('/session/revoke', 'POST', { refresh }, token)
    expect(revoke.status).toBe(200)

    expect(await env.MEMBERS_KV.get(kvKeyOf(refresh))).toBeNull()
    expect((await fetchWith('/session/refresh', 'POST', { refresh })).status).toBe(401)
  })

  it('/member/delete purges every remembered device', async () => {
    const member = await seedMember('rem6@example.com')
    const first = await login(member.email, true)
    const second = await login(member.email, true)
    expect((await env.MEMBERS_KV.list({ prefix: `refresh:${member.id}:` })).keys.length).toBe(2)

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/delete', 'POST', {}, second.token)
    expect(res.status).toBe(200)

    expect((await env.MEMBERS_KV.list({ prefix: `refresh:${member.id}:` })).keys.length).toBe(0)
    expect((await fetchWith('/session/refresh', 'POST', { refresh: first.refresh })).status).toBe(401)
  })
})
