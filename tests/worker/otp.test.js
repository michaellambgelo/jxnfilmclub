import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

function post(path, body) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

async function seedMember(email, overrides = {}) {
  const member = { id: 'id-' + email, email, name: 'M', handle: null, joined: '2026-01-01', ...overrides }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  return member
}

describe('POST /otp/request (returning members only)', () => {
  it('issues a 6-digit code + sends a login-only email for members', async () => {
    await seedMember('user@example.com')
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 200 }) })

    const res = await post('/otp/request', { email: 'user@example.com' })
    expect(res.status).toBe(200)

    const code = await env.MEMBERS_KV.get('otp:user@example.com')
    expect(code).toMatch(/^\d{6}$/)

    const resend = calls.find(c => c.url === 'https://api.resend.com/emails')
    expect(resend).toBeTruthy()
    const body = JSON.parse(resend.init.body)
    expect(body.subject).toContain('login code')
    expect(body.text).toContain(code)
    // Sign-in email must NOT include Letterboxd tag copy — that's signup-only.
    expect(body.text).not.toMatch(/jxnfc-verify-/)
  })

  it('silently 200s for an unknown email (no enumeration)', async () => {
    const calls = []
    mockFetch(async (url) => { calls.push(String(url)); return new Response('', { status: 200 }) })
    const res = await post('/otp/request', { email: 'ghost@example.com' })
    expect(res.status).toBe(200)
    expect(await env.MEMBERS_KV.get('otp:ghost@example.com')).toBeNull()
    expect(calls.some(u => u.includes('resend'))).toBe(false)
  })

  it('400 when email missing', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    expect((await post('/otp/request', {})).status).toBe(400)
  })
})

describe('POST /otp/verify', () => {
  it('accepts correct code, deletes KV, returns token + member id/handle', async () => {
    const member = await seedMember('verify1@example.com', { handle: 'v1user' })
    await env.MEMBERS_KV.put(`otp:${member.email}`, '123456', { expirationTtl: 600 })
    mockFetch(async () => new Response('', { status: 200 }))

    const res = await post('/otp/verify', { email: member.email, code: '123456' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token.split('.').length).toBe(2)
    expect(body.id).toBe(member.id)
    expect(body.handle).toBe('v1user')
    expect(await env.MEMBERS_KV.get(`otp:${member.email}`)).toBeNull()
  })

  it('rejects wrong code with 401 and keeps KV entry', async () => {
    await seedMember('v2@example.com')
    await env.MEMBERS_KV.put('otp:v2@example.com', '654321', { expirationTtl: 600 })
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/otp/verify', { email: 'v2@example.com', code: '000000' })
    expect(res.status).toBe(401)
    expect(await env.MEMBERS_KV.get('otp:v2@example.com')).toBe('654321')
  })

  it('rejects when no code exists', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/otp/verify', { email: 'nobody@example.com', code: '123456' })
    expect(res.status).toBe(401)
  })

  it('403 when the code is valid but no member exists (orphan OTP)', async () => {
    await env.MEMBERS_KV.put('otp:orphan@example.com', '111111', { expirationTtl: 600 })
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/otp/verify', { email: 'orphan@example.com', code: '111111' })
    expect(res.status).toBe(403)
  })
})
