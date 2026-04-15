import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

async function getToken(email) {
  mockFetch(async () => new Response('', { status: 202 }))
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  const res = await SELF.fetch('https://join.jxnfilm.club/otp/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: '111111' }),
  })
  const body = await res.json()
  return body.token
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /member/update auth', () => {
  it('returns 401 when no Authorization header is sent', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/member/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pronouns: 'she/her' }),
    })
    expect(res.status).toBe(401)
  })

  it('accepts a valid bearer token and dispatches update-member with server-resolved handle', async () => {
    const email = 'authed@example.com'
    // The member must already be linked in KV (would have been done at /signup).
    await env.MEMBERS_KV.put(`handle:${email}`, 'authedhandle')

    const token = await getToken(email)
    expect(token).toBeTruthy()

    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response('', { status: 204 })
    })

    const res = await SELF.fetch('https://join.jxnfilm.club/member/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pronouns: 'she/her', name: 'Authed User' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).handle).toBe('authedhandle')

    const gh = calls.find(c => c.url.includes('api.github.com'))
    expect(gh).toBeTruthy()
    const body = JSON.parse(gh.init.body)
    expect(body.event_type).toBe('update-member')
    // Handle comes from KV, not the request body.
    expect(body.client_payload.email).toBe(email)
    expect(body.client_payload.updates).toEqual({
      handle: 'authedhandle',
      name: 'Authed User',
      pronouns: 'she/her',
    })
  })

  it('ignores a client-supplied handle and uses the KV-linked one', async () => {
    const email = 'spoofer@example.com'
    await env.MEMBERS_KV.put(`handle:${email}`, 'realhandle')
    const token = await getToken(email)

    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response('', { status: 204 })
    })

    const res = await SELF.fetch('https://join.jxnfilm.club/member/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ handle: 'someoneelse', pronouns: 'they/them' }),
    })
    expect(res.status).toBe(200)
    const gh = calls.find(c => c.url.includes('api.github.com'))
    const body = JSON.parse(gh.init.body)
    expect(body.client_payload.updates.handle).toBe('realhandle')
  })

  it('returns 403 when the token email has no linked handle', async () => {
    const email = 'orphan@example.com'
    const token = await getToken(email) // no handle:${email} seeded
    mockFetch(async () => new Response('', { status: 204 }))

    const res = await SELF.fetch('https://join.jxnfilm.club/member/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pronouns: 'x' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects a tampered token with 401', async () => {
    const email = 'tamper@example.com'
    const token = await getToken(email)
    const [payload, sig] = token.split('.')
    // Tamper: flip payload to claim a different email
    const evil = btoa(JSON.stringify({ email: 'attacker@example.com', exp: Date.now() + 3600_000 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const tampered = `${evil}.${sig}`

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/member/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tampered}`,
      },
      body: JSON.stringify({ pronouns: 'x' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects a token with bad signature', async () => {
    const email = 'badsig@example.com'
    const token = await getToken(email)
    const [payload] = token.split('.')
    const bad = `${payload}.AAAAAAAAAA`
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/member/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bad}`,
      },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(401)
  })

  it('rejects an expired token', async () => {
    // Craft an expired token by requesting one, then wait conceptually:
    // We can't travel forward in time easily, so build one with Date.now mocked.
    const email = 'exp@example.com'
    // Use the /otp/verify flow but stub Date.now so exp is in the past.
    const realNow = Date.now
    try {
      Date.now = () => 1_000_000
      await env.MEMBERS_KV.put(`otp:${email}`, '222222', { expirationTtl: 600 })
      mockFetch(async () => new Response('', { status: 202 }))
      const vres = await SELF.fetch('https://join.jxnfilm.club/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: '222222' }),
      })
      const { token } = await vres.json()

      // Restore real time — token exp=1_000_000 + 3600_000 is far in the past now (2026+)
      Date.now = realNow

      const res = await SELF.fetch('https://join.jxnfilm.club/member/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(401)
    } finally {
      Date.now = realNow
    }
  })
})
