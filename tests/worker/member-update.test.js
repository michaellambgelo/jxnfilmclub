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

async function getTokenFor(email, memberOverrides = {}) {
  const member = {
    id: 'id-' + email, email, name: 'M', handle: null, joined: '2026-01-01', ...memberOverrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await fetchWith('/otp/verify', 'POST', { email, code: '111111' })
  return { token: (await res.json()).token, member }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /member/update', () => {
  it('returns 401 without a token', async () => {
    const res = await fetchWith('/member/update', 'POST', { name: 'X' })
    expect(res.status).toBe(401)
  })

  it('applies name + pronouns and dispatches update-member keyed by id', async () => {
    const { token, member } = await getTokenFor('auth@example.com')
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    const res = await fetchWith('/member/update', 'POST',
      { name: 'New Name', pronouns: 'they/them' }, token)
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe(member.id)

    const saved = JSON.parse(await env.MEMBERS_KV.get('member:auth@example.com'))
    expect(saved.name).toBe('New Name')
    expect(saved.pronouns).toBe('they/them')

    const gh = calls.find(c => c.url.includes('api.github.com'))
    const dispatch = JSON.parse(gh.init.body)
    expect(dispatch.event_type).toBe('update-member')
    expect(dispatch.client_payload.id).toBe(member.id)
    expect(dispatch.client_payload.updates).toEqual({ name: 'New Name', pronouns: 'they/them' })
  })

  it('ignores client-supplied handle — only name/pronouns are editable here', async () => {
    const { token } = await getTokenFor('ignore@example.com')
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    await fetchWith('/member/update', 'POST',
      { handle: 'someoneelse', pronouns: 'x' }, token)
    const dispatch = JSON.parse(calls.find(c => c.url.includes('api.github.com')).init.body)
    expect(dispatch.client_payload.updates.handle).toBeUndefined()
  })

  it('rejects tampered or expired tokens with 401', async () => {
    const { token } = await getTokenFor('tamper@example.com')
    const [_p, sig] = token.split('.')
    const evil = btoa(JSON.stringify({ email: 'attacker@example.com', id: 'x', exp: Date.now() + 3600_000 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/update', 'POST', { name: 'X' }, `${evil}.${sig}`)
    expect(res.status).toBe(401)
  })

  it('rejects empty update body with 400', async () => {
    const { token } = await getTokenFor('empty@example.com')
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/member/update', 'POST', {}, token)
    expect(res.status).toBe(400)
  })
})
