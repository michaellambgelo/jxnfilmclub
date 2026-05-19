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

describe('POST /signup', () => {
  it('stores pending row, sends OTP-only email, no GH dispatch, no LB token', async () => {
    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ id: 'x' }), { status: 200 })
    })

    const res = await post('/signup', {
      email: 'alice@example.com', name: 'Alice', handle: 'alice',
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const pending = JSON.parse(await env.MEMBERS_KV.get('pending:alice@example.com'))
    expect(pending.name).toBe('Alice')
    expect(pending.handle).toBe('alice')
    expect(pending.code).toMatch(/^\d{6}$/)

    // Tag verification was removed — handle ownership is self-asserted now.
    expect(await env.MEMBERS_KV.get('lb_token:alice@example.com')).toBeNull()

    const resend = calls.find(c => c.url === 'https://api.resend.com/emails')
    expect(resend).toBeTruthy()
    const body = JSON.parse(resend.init.body)
    expect(body.to).toEqual(['alice@example.com'])
    expect(body.text).toContain(pending.code)
    expect(body.text).not.toMatch(/jxnfc-verify-/)
    expect(body.text).not.toMatch(/diary entry/)

    expect(calls.some(c => c.url.includes('api.github.com'))).toBe(false)
  })

  it('signup with no handle stores a pending row with handle:null and no LB token', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    await post('/signup', { email: 'nolb@example.com', name: 'Charlie' })

    const pending = JSON.parse(await env.MEMBERS_KV.get('pending:nolb@example.com'))
    expect(pending.handle).toBeNull()
    expect(await env.MEMBERS_KV.get('lb_token:nolb@example.com')).toBeNull()
  })

  it('rejects when email is already a member', async () => {
    await env.MEMBERS_KV.put('member:existing@example.com', JSON.stringify({ id: 'x' }))
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/signup', { email: 'existing@example.com', name: 'X' })
    expect(res.status).toBe(409)
  })

  it('rejects when handle is claimed by a different email', async () => {
    await env.MEMBERS_KV.put('email:taken', 'someone@example.com')
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/signup', {
      email: 'me@example.com', name: 'Me', handle: 'taken',
    })
    expect(res.status).toBe(409)
  })

  it('rejects invalid handle format', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/signup', {
      email: 'x@y.com', name: 'X', handle: 'has spaces',
    })
    expect(res.status).toBe(400)
  })

  it('rejects missing fields', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    expect((await post('/signup', { email: 'a@b.com' })).status).toBe(400)
    expect((await post('/signup', { name: 'X' })).status).toBe(400)
  })

  it('rejects malformed email format', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/signup', { email: 'not-an-email', name: 'X' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/email/)
    expect(await env.MEMBERS_KV.get('pending:not-an-email')).toBeNull()
  })

  it('rejects overlong name (DoS guard on the public members.json projection)', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/signup', { email: 'long@example.com', name: 'A'.repeat(200) })
    expect(res.status).toBe(400)
    expect(await env.MEMBERS_KV.get('pending:long@example.com')).toBeNull()
  })

  it('rejects overlong handle (Letterboxd handles max ~15 chars)', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/signup', { email: 'h@example.com', name: 'X', handle: 'a'.repeat(50) })
    expect(res.status).toBe(400)
  })
})

describe('POST /signup/verify', () => {
  async function startSignup(email, name, handle) {
    mockFetch(async () => new Response('', { status: 200 }))
    await post('/signup', { email, name, handle })
    return JSON.parse(await env.MEMBERS_KV.get(`pending:${email}`)).code
  }

  it('valid code promotes pending → member, dispatches add-member, issues token', async () => {
    const code = await startSignup('bob@example.com', 'Bob')

    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).includes('api.github.com')) return new Response('', { status: 204 })
      return new Response('', { status: 200 })
    })

    const res = await post('/signup/verify', { email: 'bob@example.com', code })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token.split('.').length).toBe(2)
    expect(body.id).toMatch(/^[A-Za-z0-9]{10}$/)
    expect(body.handle).toBeNull()

    const member = JSON.parse(await env.MEMBERS_KV.get('member:bob@example.com'))
    expect(member.name).toBe('Bob')
    expect(member.handle).toBeNull()
    expect(member.id).toBe(body.id)
    expect(await env.MEMBERS_KV.get('pending:bob@example.com')).toBeNull()

    // session:{id} snapshot is seeded on verify so /member/me is fast
    // without waiting on the add-member workflow.
    const session = JSON.parse(await env.MEMBERS_KV.get(`session:${body.id}`))
    expect(session.id).toBe(body.id)
    expect(session.email).toBe('bob@example.com')
    expect(session.name).toBe('Bob')

    // Tag verification was removed — no lb_token row should exist.
    expect(await env.MEMBERS_KV.get('lb_token:bob@example.com')).toBeNull()

    const gh = calls.find(c => c.url.includes('api.github.com'))
    expect(gh).toBeTruthy()
    const dispatch = JSON.parse(gh.init.body)
    expect(dispatch.event_type).toBe('add-member')
    expect(dispatch.client_payload.id).toBe(body.id)
    expect(dispatch.client_payload.name).toBe('Bob')
  })

  it('rejects wrong code with 401 and leaves pending intact', async () => {
    await startSignup('wrong@example.com', 'W')
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/signup/verify', { email: 'wrong@example.com', code: '000000' })
    expect(res.status).toBe(401)
    expect(await env.MEMBERS_KV.get('pending:wrong@example.com')).toBeTruthy()
    expect(await env.MEMBERS_KV.get('member:wrong@example.com')).toBeNull()
  })

  it('returns 404 when there is no pending signup', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await post('/signup/verify', { email: 'nobody@example.com', code: '123456' })
    expect(res.status).toBe(404)
  })

  it('promotes the pending handle onto the member row and writes reverse indices', async () => {
    const code = await startSignup('linked@example.com', 'Linda', 'lindahandle')

    mockFetch(async (url) => {
      if (String(url).includes('api.github.com')) return new Response('', { status: 204 })
      return new Response('', { status: 200 })
    })

    const res = await post('/signup/verify', { email: 'linked@example.com', code })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.handle).toBe('lindahandle')

    const member = JSON.parse(await env.MEMBERS_KV.get('member:linked@example.com'))
    expect(member.handle).toBe('lindahandle')

    // Reverse indices written in the same pass so the handle isn't claimable
    // by anyone else immediately.
    expect(await env.MEMBERS_KV.get('email:lindahandle')).toBe('linked@example.com')
    expect(await env.MEMBERS_KV.get('handle:linked@example.com')).toBe('lindahandle')
  })

  it('strips the handle from the verified row if someone else claimed it during the OTP window', async () => {
    const code = await startSignup('loser@example.com', 'Loser', 'racedhandle')
    // Simulate a winner claiming the handle between /signup and /signup/verify.
    await env.MEMBERS_KV.put('email:racedhandle', 'winner@example.com')

    mockFetch(async (url) => {
      if (String(url).includes('api.github.com')) return new Response('', { status: 204 })
      return new Response('', { status: 200 })
    })

    const res = await post('/signup/verify', { email: 'loser@example.com', code })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Membership still confirmed; just no handle attached.
    expect(body.handle).toBeNull()
    const member = JSON.parse(await env.MEMBERS_KV.get('member:loser@example.com'))
    expect(member.handle).toBeNull()
    // Loser did NOT overwrite the winner's reverse index.
    expect(await env.MEMBERS_KV.get('email:racedhandle')).toBe('winner@example.com')
  })
})
