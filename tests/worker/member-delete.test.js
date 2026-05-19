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

function decodeClaims(token) {
  const [payload] = token.split('.')
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
}

async function getTokenFor(email, overrides = {}) {
  const member = {
    id: 'id-' + email, email, name: 'M', handle: null, joined: '2026-01-01', ...overrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  if (member.handle) {
    await env.MEMBERS_KV.put(`email:${member.handle}`, email)
    await env.MEMBERS_KV.put(`handle:${email}`, member.handle)
  }
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await fetchWith('/otp/verify', 'POST', { email, code: '111111' })
  return { token: (await res.json()).token, member }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /member/delete', () => {
  it('401 without a token', async () => {
    const res = await fetchWith('/member/delete', 'POST', {})
    expect(res.status).toBe(401)
  })

  it('cascades all KV state for a member with no Letterboxd link', async () => {
    const { token, member } = await getTokenFor('plain@example.com')
    // Stash some auxiliary state that should also be wiped.
    await env.MEMBERS_KV.put(`lb_token:${member.email}`, JSON.stringify({
      token: 'jxnfc-verify-LEFTOVER', handle: null, exp: Date.now() + 1000,
    }))

    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response('', { status: 204 })
    })

    const res = await fetchWith('/member/delete', 'POST', {}, token)
    expect(res.status).toBe(200)

    expect(await env.MEMBERS_KV.get(`member:${member.email}`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`session:${member.id}`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`lb_token:${member.email}`)).toBeNull()

    const gh = calls.find(c => c.url.includes('api.github.com'))
    expect(gh).toBeTruthy()
    const dispatch = JSON.parse(gh.init.body)
    expect(dispatch.event_type).toBe('remove-member')
    expect(dispatch.client_payload).toEqual({ id: member.id })
  })

  it('also clears handle reverse indices when the member had Letterboxd linked', async () => {
    const { token, member } = await getTokenFor('lblinked@example.com', { handle: 'lbhandle' })
    expect(await env.MEMBERS_KV.get('email:lbhandle')).toBe('lblinked@example.com')

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/delete', 'POST', {}, token)
    expect(res.status).toBe(200)

    expect(await env.MEMBERS_KV.get(`member:${member.email}`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`email:${member.handle}`)).toBeNull()
    expect(await env.MEMBERS_KV.get(`handle:${member.email}`)).toBeNull()
    // Handle becomes claimable again immediately after delete.
  })

  it('revokes the current jti so a copied token is dead even within the 1h JWT exp', async () => {
    const { token } = await getTokenFor('revoke-on-delete@example.com')
    const { jti } = decodeClaims(token)
    mockFetch(async () => new Response('', { status: 204 }))

    await fetchWith('/member/delete', 'POST', {}, token)
    expect(await env.MEMBERS_KV.get(`revoked:${jti}`)).toBe('1')

    // Sanity: the (now-revoked) token can no longer hit an authed endpoint.
    const replay = await fetchWith('/member/me', 'GET', undefined, token)
    expect(replay.status).toBe(401)
  })

  it('404 when the member row is already gone (idempotency edge — second delete from a stale tab)', async () => {
    const { token, member } = await getTokenFor('gone@example.com')
    await env.MEMBERS_KV.delete(`member:${member.email}`)
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/delete', 'POST', {}, token)
    expect(res.status).toBe(404)
  })

  it('does NOT dispatch when no token (auth gate trips first)', async () => {
    const calls = []
    mockFetch(async (url) => { calls.push(String(url)); return new Response('', { status: 204 }) })
    await fetchWith('/member/delete', 'POST', {})
    expect(calls.some(u => u.includes('api.github.com'))).toBe(false)
  })

  it('rejects tampered tokens with 401 (signature mismatch path)', async () => {
    const { token } = await getTokenFor('tamper-delete@example.com')
    const [, sig] = token.split('.')
    const evil = btoa(JSON.stringify({
      email: 'someone-else@example.com', id: 'x', exp: Date.now() + 3600_000, jti: 'forged',
    })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/delete', 'POST', {}, `${evil}.${sig}`)
    expect(res.status).toBe(401)
  })
})
