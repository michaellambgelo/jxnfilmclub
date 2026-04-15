import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /signup (request)', () => {
  it('happy path: valid + unclaimed handle returns a verify token, stores pending KV, no GH dispatch yet', async () => {
    const calls = []
    mockFetch(async (url) => {
      calls.push(String(url))
      if (String(url).startsWith('https://letterboxd.com/')) {
        return new Response('<html>ok</html>', { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'alice', name: 'Alice', email: 'alice@example.com' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.token).toMatch(/^jxnfc-verify-[A-Za-z0-9]{8}$/)

    // Pending verification stored in KV
    const stored = await env.MEMBERS_KV.get('verify:alice')
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored)
    expect(parsed.token).toBe(body.token)
    expect(JSON.parse(parsed.pending)).toEqual({
      email: 'alice@example.com',
      handle: 'alice',
      name: 'Alice',
    })

    // Real KV mappings NOT yet written, no GH dispatch
    expect(await env.MEMBERS_KV.get('email:alice')).toBeNull()
    expect(calls.some(u => u.includes('api.github.com'))).toBe(false)
  })

  it('returns 409 if the handle is already claimed', async () => {
    await env.MEMBERS_KV.put('email:taken', 'someone@example.com')
    mockFetch(async () => new Response('ok', { status: 200 }))

    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'taken', email: 'me@example.com' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/already claimed/)
  })

  it('returns 400 for invalid handle format', async () => {
    mockFetch(async () => new Response('ok', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'has spaces', email: 'x@y.com' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 when email is missing', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'alice' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 400 "Letterboxd profile not found" on LB 404', async () => {
    mockFetch(async (url) => {
      if (String(url).startsWith('https://letterboxd.com/')) {
        return new Response('not found', { status: 404 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'ghost', email: 'g@example.com' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /signup/verify', () => {
  async function startSignup(handle, email, name = 'X') {
    mockFetch(async () => new Response('ok', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, email, name }),
    })
    return (await res.json()).token
  }

  it('verifies via diary RSS containing the token, dispatches add-member, writes both KV directions', async () => {
    const token = await startSignup('rssuser', 'rss@example.com', 'RSS User')

    const calls = []
    mockFetch(async (url) => {
      const u = String(url)
      calls.push(u)
      if (u.endsWith('/rss/')) {
        return new Response(`<rss><item><category>${token}</category></item></rss>`, { status: 200 })
      }
      if (u.endsWith('/lists/')) {
        return new Response('<html>nothing</html>', { status: 200 })
      }
      if (u.includes('api.github.com')) return new Response('', { status: 204 })
      throw new Error(`unexpected fetch: ${u}`)
    })

    const res = await SELF.fetch('https://join.jxnfilm.club/signup/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'rssuser', email: 'rss@example.com' }),
    })
    expect(res.status).toBe(200)

    expect(await env.MEMBERS_KV.get('email:rssuser')).toBe('rss@example.com')
    expect(await env.MEMBERS_KV.get('handle:rss@example.com')).toBe('rssuser')
    expect(await env.MEMBERS_KV.get('verify:rssuser')).toBeNull()

    const gh = calls.find(u => u.includes('api.github.com'))
    expect(gh).toBeTruthy()
  })

  it('verifies via lists page containing the token', async () => {
    const token = await startSignup('listuser', 'list@example.com')
    mockFetch(async (url) => {
      const u = String(url)
      if (u.endsWith('/rss/')) return new Response('<rss/>', { status: 200 })
      if (u.endsWith('/lists/')) return new Response(`<html>list named ${token}</html>`, { status: 200 })
      if (u.includes('api.github.com')) return new Response('', { status: 204 })
      throw new Error(`unexpected fetch: ${u}`)
    })

    const res = await SELF.fetch('https://join.jxnfilm.club/signup/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'listuser', email: 'list@example.com' }),
    })
    expect(res.status).toBe(200)
  })

  it('returns 422 when token is not present anywhere on the profile', async () => {
    await startSignup('forgetful', 'forget@example.com')
    mockFetch(async (url) => {
      if (String(url).endsWith('/rss/'))   return new Response('<rss/>', { status: 200 })
      if (String(url).endsWith('/lists/')) return new Response('<html/>', { status: 200 })
      throw new Error(`unexpected fetch: ${url}`)
    })

    const res = await SELF.fetch('https://join.jxnfilm.club/signup/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'forgetful', email: 'forget@example.com' }),
    })
    expect(res.status).toBe(422)

    // No KV writes, no dispatch
    expect(await env.MEMBERS_KV.get('email:forgetful')).toBeNull()
  })

  it('returns 404 when there is no pending verification', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'nobody', email: 'x@y.com' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns 403 if a different email tries to verify a pending claim', async () => {
    await startSignup('contested', 'first@example.com')
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'contested', email: 'attacker@example.com' }),
    })
    expect(res.status).toBe(403)
  })
})
