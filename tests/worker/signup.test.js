import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

beforeEach(() => {
  // Clear KV between tests
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /signup', () => {
  it('happy path: valid handle, stores KV and dispatches add-member', async () => {
    const calls = []
    mockFetch(async (url, init) => {
      const u = String(url)
      calls.push({ url: u, init })
      if (u.startsWith('https://letterboxd.com/')) {
        return new Response('<html>ok</html>', { status: 200 })
      }
      if (u.includes('api.github.com')) {
        return new Response('', { status: 204 })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })

    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'alice', name: 'Alice', email: 'alice@example.com' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })

    const stored = await env.MEMBERS_KV.get('email:alice')
    expect(stored).toBe('alice@example.com')

    const lb = calls.find(c => c.url.startsWith('https://letterboxd.com/'))
    expect(lb).toBeTruthy()
    expect(lb.url).toContain('alice')

    const gh = calls.find(c => c.url.includes('api.github.com'))
    expect(gh).toBeTruthy()
    expect(gh.url).toBe('https://api.github.com/repos/testowner/jxnfilmclub/dispatches')
    expect(gh.init.headers.Authorization).toBe('Bearer test-gh-token')
    const ghBody = JSON.parse(gh.init.body)
    expect(ghBody.event_type).toBe('add-member')
    expect(ghBody.client_payload).toEqual({ handle: 'alice', name: 'Alice' })
  })

  it('defaults name to handle when name omitted', async () => {
    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response('', { status: 200 })
    })

    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'bob', email: 'bob@example.com' }),
    })
    expect(res.status).toBe(200)

    const gh = calls.find(c => c.url.includes('api.github.com'))
    const ghBody = JSON.parse(gh.init.body)
    expect(ghBody.client_payload.name).toBe('bob')
  })

  it('returns 400 when email is missing', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'alice' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/email and handle required/)
  })

  it('returns 400 when handle is missing', async () => {
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'x@example.com' }),
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
    const body = await res.json()
    expect(body.error).toBe('Letterboxd profile not found')
  })
})
