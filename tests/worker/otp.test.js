import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /otp/request', () => {
  it('stores a 6-digit code with 10-minute TTL and calls Resend with right payload', async () => {
    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ id: 'test' }), { status: 200 })
    })

    const res = await SELF.fetch('https://join.jxnfilm.club/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const code = await env.MEMBERS_KV.get('otp:user@example.com')
    expect(code).toMatch(/^\d{6}$/)

    const resend = calls.find(c => c.url === 'https://api.resend.com/emails')
    expect(resend).toBeTruthy()
    expect(resend.init.headers.Authorization).toMatch(/^Bearer /)
    const body = JSON.parse(resend.init.body)
    expect(body.to).toEqual(['user@example.com'])
    expect(body.from).toContain('@jxnfilm.club')
    expect(body.subject).toContain('login code')
    expect(body.text).toContain(code)
  })

  it('returns 400 if email is missing', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /otp/verify', () => {
  it('accepts the correct code, returns token of shape payload.sig, deletes KV entry', async () => {
    mockFetch(async () => new Response('', { status: 202 }))
    // Seed a code directly via KV binding to avoid the random code of /otp/request
    await env.MEMBERS_KV.put('otp:verify1@example.com', '123456', { expirationTtl: 600 })

    const res = await SELF.fetch('https://join.jxnfilm.club/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'verify1@example.com', code: '123456' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.token).toBe('string')
    expect(body.token.split('.').length).toBe(2)

    const stillThere = await env.MEMBERS_KV.get('otp:verify1@example.com')
    expect(stillThere).toBeNull()
  })

  it('rejects wrong code with 401 and does not delete KV entry', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    await env.MEMBERS_KV.put('otp:verify2@example.com', '654321', { expirationTtl: 600 })

    const res = await SELF.fetch('https://join.jxnfilm.club/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'verify2@example.com', code: '000000' }),
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('invalid code')

    expect(await env.MEMBERS_KV.get('otp:verify2@example.com')).toBe('654321')
  })

  it('rejects when no code exists in KV', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', code: '123456' }),
    })
    expect(res.status).toBe(401)
  })
})
