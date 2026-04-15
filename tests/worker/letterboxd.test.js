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

async function signedInMember(email, handle) {
  const member = { id: 'id-' + email, email, name: 'M', handle: handle || null, joined: '2026-01-01' }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await fetchWith('/otp/verify', 'POST', { email, code: '111111' })
  return { token: (await res.json()).token, member }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /letterboxd/status', () => {
  it('reports verified when handle is linked on the member row', async () => {
    const { token } = await signedInMember('done@example.com', 'donehandle')
    const res = await fetchWith('/letterboxd/status', 'GET', undefined, token)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.verified).toBe(true)
    expect(body.handle).toBe('donehandle')
  })

  it('reports pending when an lb_token exists', async () => {
    const { token } = await signedInMember('pend@example.com')
    await env.MEMBERS_KV.put(`lb_token:pend@example.com`, JSON.stringify({
      token: 'jxnfc-verify-AAAAAAAA', handle: 'penduser', exp: Date.now() + 1000,
    }))
    const res = await fetchWith('/letterboxd/status', 'GET', undefined, token)
    const body = await res.json()
    expect(body.pending).toBe(true)
    expect(body.handle).toBe('penduser')
    expect(body.token).toBe('jxnfc-verify-AAAAAAAA')
  })

  it('reports none when neither', async () => {
    const { token } = await signedInMember('none@example.com')
    const res = await fetchWith('/letterboxd/status', 'GET', undefined, token)
    expect((await res.json()).none).toBe(true)
  })

  it('401 without token', async () => {
    const res = await fetchWith('/letterboxd/status', 'GET')
    expect(res.status).toBe(401)
  })
})

describe('POST /letterboxd/request', () => {
  it('issues a fresh 48h token tied to the given handle', async () => {
    const { token } = await signedInMember('req@example.com')
    const res = await fetchWith('/letterboxd/request', 'POST', { handle: 'requser' }, token)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.token).toMatch(/^jxnfc-verify-/)
    expect(body.handle).toBe('requser')

    const stored = JSON.parse(await env.MEMBERS_KV.get('lb_token:req@example.com'))
    expect(stored.token).toBe(body.token)
    expect(stored.handle).toBe('requser')
  })

  it('409 when the handle is claimed by someone else', async () => {
    const { token } = await signedInMember('req2@example.com')
    await env.MEMBERS_KV.put('email:taken', 'other@example.com')
    const res = await fetchWith('/letterboxd/request', 'POST', { handle: 'taken' }, token)
    expect(res.status).toBe(409)
  })

  it('400 on bad handle format', async () => {
    const { token } = await signedInMember('bad@example.com')
    const res = await fetchWith('/letterboxd/request', 'POST', { handle: 'has spaces' }, token)
    expect(res.status).toBe(400)
  })
})

describe('POST /letterboxd/verify', () => {
  it('happy path: RSS contains token → dispatch update-member, write KV, clear lb_token', async () => {
    const { token, member } = await signedInMember('verify@example.com')
    const lb = { token: 'jxnfc-verify-ZZZZZZZZ', handle: 'verifyuser', exp: Date.now() + 1000 }
    await env.MEMBERS_KV.put('lb_token:verify@example.com', JSON.stringify(lb))

    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/rss/')) {
        return new Response(`<rss><item><category>${lb.token}</category></item></rss>`, { status: 200 })
      }
      if (String(url).includes('api.github.com')) return new Response('', { status: 204 })
      return new Response('', { status: 200 })
    })

    const res = await fetchWith('/letterboxd/verify', 'POST', {}, token)
    expect(res.status).toBe(200)
    expect((await res.json()).handle).toBe('verifyuser')

    expect(await env.MEMBERS_KV.get('lb_token:verify@example.com')).toBeNull()
    expect(await env.MEMBERS_KV.get('email:verifyuser')).toBe('verify@example.com')
    expect(await env.MEMBERS_KV.get('handle:verify@example.com')).toBe('verifyuser')
    const saved = JSON.parse(await env.MEMBERS_KV.get('member:verify@example.com'))
    expect(saved.handle).toBe('verifyuser')

    const gh = calls.find(c => c.url.includes('api.github.com'))
    const dispatch = JSON.parse(gh.init.body)
    expect(dispatch.event_type).toBe('update-member')
    expect(dispatch.client_payload.id).toBe(member.id)
    expect(dispatch.client_payload.updates).toEqual({ handle: 'verifyuser' })
  })

  it('422 when token not found on RSS', async () => {
    const { token } = await signedInMember('notfound@example.com')
    await env.MEMBERS_KV.put('lb_token:notfound@example.com', JSON.stringify({
      token: 'jxnfc-verify-MISSING1', handle: 'nfuser', exp: Date.now() + 1000,
    }))
    mockFetch(async () => new Response('<rss><channel/></rss>', { status: 200 }))

    const res = await fetchWith('/letterboxd/verify', 'POST', {}, token)
    expect(res.status).toBe(422)
    expect(await env.MEMBERS_KV.get('lb_token:notfound@example.com')).toBeTruthy()
  })

  it('410 when there is no pending lb_token', async () => {
    const { token } = await signedInMember('orph@example.com')
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await fetchWith('/letterboxd/verify', 'POST', {}, token)
    expect(res.status).toBe(410)
  })

  it('400 when lb_token exists but has no handle assigned yet', async () => {
    const { token } = await signedInMember('nohandle@example.com')
    await env.MEMBERS_KV.put('lb_token:nohandle@example.com', JSON.stringify({
      token: 'jxnfc-verify-XXXXXXXX', handle: null, exp: Date.now() + 1000,
    }))
    mockFetch(async () => new Response('', { status: 200 }))
    const res = await fetchWith('/letterboxd/verify', 'POST', {}, token)
    expect(res.status).toBe(400)
  })

  it('401 without token', async () => {
    const res = await fetchWith('/letterboxd/verify', 'POST', {})
    expect(res.status).toBe(401)
  })
})
