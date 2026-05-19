import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Cross-cutting security tests (Origin/Referer gating, rate limits, revocation).
// Per-endpoint behavior lives with its endpoint test file; this file proves
// the defense-in-depth layers fire regardless of which route is hit.

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Origin/Referer gate (S5 defense-in-depth)', () => {
  it('rejects POSTs with a mismatched Origin header even when CORS allows the request', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Browser-style attacker origin: CORS would block the *response*, but
        // a tracker can fire-and-forget the request anyway. The gate must
        // reject before any KV write happens.
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ email: 'attacker@example.com', name: 'X' }),
    })
    expect(res.status).toBe(403)
    expect(await env.MEMBERS_KV.get('pending:attacker@example.com')).toBeNull()
  })

  it('allows POSTs that omit Origin (curl, server-to-server, unit tests)', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'noOrigin@example.com', name: 'NoOrigin' }),
    })
    expect(res.status).toBe(200)
  })

  it('allows POSTs whose Origin matches SITE_ORIGIN', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: env.SITE_ORIGIN,
      },
      body: JSON.stringify({ email: 'good@example.com', name: 'Good' }),
    })
    expect(res.status).toBe(200)
  })

  it('allows same-origin POSTs (Worker-served signup form posting back to itself)', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The signup form lives at the Worker's own root and posts to /signup.
        // The browser sends Origin = the Worker's origin, NOT the site's.
        Origin: 'https://join.jxnfilm.club',
      },
      body: JSON.stringify({ email: 'sameorigin@example.com', name: 'SO' }),
    })
    expect(res.status).toBe(200)
  })

  it('does not gate GETs (public endpoints stay reachable from any embed)', async () => {
    const res = await SELF.fetch('https://join.jxnfilm.club/privacy', {
      headers: { Origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(200)
  })
})

function post(path, body) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('OTP send throttle (S1)', () => {
  it('second /signup within the throttle window returns 429 without sending an email', async () => {
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 200 }) })

    const first = await post('/signup', { email: 'throttle1@example.com', name: 'T' })
    expect(first.status).toBe(200)
    const emailsBefore = calls.filter(c => c.url.includes('resend')).length

    const second = await post('/signup', { email: 'throttle1@example.com', name: 'T' })
    expect(second.status).toBe(429)
    const emailsAfter = calls.filter(c => c.url.includes('resend')).length
    expect(emailsAfter).toBe(emailsBefore)
  })

  it('second /otp/request within the throttle window silently 200s but does NOT send an email (enumeration-resistant)', async () => {
    await env.MEMBERS_KV.put('member:throttled@example.com', JSON.stringify({ id: 'x', email: 'throttled@example.com', name: 'T' }))
    const calls = []
    mockFetch(async (url) => { calls.push(String(url)); return new Response('', { status: 200 }) })

    await post('/otp/request', { email: 'throttled@example.com' })
    const emailsBefore = calls.filter(u => u.includes('resend')).length
    expect(emailsBefore).toBe(1)

    const res = await post('/otp/request', { email: 'throttled@example.com' })
    expect(res.status).toBe(200) // silent — no 429 leak
    const emailsAfter = calls.filter(u => u.includes('resend')).length
    expect(emailsAfter).toBe(1) // no new email sent
  })
})

describe('OTP brute-force lockout (S1)', () => {
  async function seedMember(email) {
    await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify({ id: 'id-' + email, email, name: 'M' }))
    await env.MEMBERS_KV.put(`otp:${email}`, '123456', { expirationTtl: 600 })
  }

  it('locks /otp/verify after 5 failed code attempts with 429 (correct code afterward is also rejected)', async () => {
    await seedMember('lock@example.com')
    mockFetch(async () => new Response('', { status: 200 }))

    for (let i = 0; i < 5; i++) {
      const r = await post('/otp/verify', { email: 'lock@example.com', code: '000000' })
      expect(r.status).toBe(401)
    }
    // 6th attempt is locked regardless of code correctness — even the real code.
    const locked = await post('/otp/verify', { email: 'lock@example.com', code: '123456' })
    expect(locked.status).toBe(429)
    // Critical: the real OTP must still be intact (we did NOT delete it).
    expect(await env.MEMBERS_KV.get('otp:lock@example.com')).toBe('123456')
  })

  it('a successful verify clears the failure counter so a returning user starts fresh', async () => {
    await seedMember('reset@example.com')
    mockFetch(async () => new Response('', { status: 200 }))

    // Two wrong attempts, then one correct.
    await post('/otp/verify', { email: 'reset@example.com', code: '000000' })
    await post('/otp/verify', { email: 'reset@example.com', code: '000000' })
    const ok = await post('/otp/verify', { email: 'reset@example.com', code: '123456' })
    expect(ok.status).toBe(200)
    // Counter cleared — must not survive a successful login.
    expect(await env.MEMBERS_KV.get('rate:otp_verify_fail:reset@example.com')).toBeNull()
  })

  it('/signup/verify locks after 5 failed attempts independently from /otp/verify', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    await post('/signup', { email: 'siglock@example.com', name: 'S' })

    for (let i = 0; i < 5; i++) {
      const r = await post('/signup/verify', { email: 'siglock@example.com', code: '000000' })
      expect(r.status).toBe(401)
    }
    const locked = await post('/signup/verify', { email: 'siglock@example.com', code: '999999' })
    expect(locked.status).toBe(429)
  })
})

describe('Session revocation (S2)', () => {
  function decodeClaims(token) {
    const [payload] = token.split('.')
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
  }

  async function getToken(email) {
    await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify({ id: 'id-' + email, email, name: 'M' }))
    await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: '111111' }),
    })
    return (await res.json()).token
  }

  it('issued tokens carry a random jti so individual sessions are addressable', async () => {
    const a = await getToken('jti-a@example.com')
    const b = await getToken('jti-b@example.com')
    const claimsA = decodeClaims(a)
    const claimsB = decodeClaims(b)
    expect(claimsA.jti).toMatch(/^[a-z0-9]{16}$/)
    expect(claimsB.jti).toMatch(/^[a-z0-9]{16}$/)
    expect(claimsA.jti).not.toBe(claimsB.jti)
  })

  it('POST /session/revoke writes revoked:{jti} and subsequent authed requests with the same token are 401', async () => {
    const token = await getToken('revoke-me@example.com')
    const { jti } = decodeClaims(token)

    // Before revocation: authed reads succeed.
    const before = await SELF.fetch('https://join.jxnfilm.club/member/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(before.status).toBe(200)

    const revoke = await SELF.fetch('https://join.jxnfilm.club/session/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    })
    expect(revoke.status).toBe(200)
    expect(await env.MEMBERS_KV.get(`revoked:${jti}`)).toBe('1')

    // After revocation: same token is dead even though exp hasn't lapsed.
    const after = await SELF.fetch('https://join.jxnfilm.club/member/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(after.status).toBe(401)
  })

  it('revocation also evicts session:{id} so cached snapshots can\'t be replayed', async () => {
    const token = await getToken('evict@example.com')
    const { id } = decodeClaims(token)
    // Sanity: the session snapshot was seeded at /otp/verify time.
    expect(await env.MEMBERS_KV.get(`session:${id}`)).toBeTruthy()

    await SELF.fetch('https://join.jxnfilm.club/session/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    })
    expect(await env.MEMBERS_KV.get(`session:${id}`)).toBeNull()
  })

  it('revoking different sessions does NOT affect a second session on the same email', async () => {
    const a = await getToken('multi@example.com')
    const b = await getToken('multi@example.com')
    expect(decodeClaims(a).jti).not.toBe(decodeClaims(b).jti)

    await SELF.fetch('https://join.jxnfilm.club/session/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a}` },
      body: '{}',
    })

    // Token A is dead; token B should still work.
    const aRes = await SELF.fetch('https://join.jxnfilm.club/member/me', {
      headers: { Authorization: `Bearer ${a}` },
    })
    expect(aRes.status).toBe(401)
    const bRes = await SELF.fetch('https://join.jxnfilm.club/member/me', {
      headers: { Authorization: `Bearer ${b}` },
    })
    expect(bRes.status).toBe(200)
  })

  it('returns 401 when no bearer token is supplied', async () => {
    const res = await post('/session/revoke', {})
    expect(res.status).toBe(401)
  })
})
