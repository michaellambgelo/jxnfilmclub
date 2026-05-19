import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Handle setting now lives in /member/update — see member-update.test.js.
// This file covers only the dedicated unlink endpoint, which keeps its own
// route because the cascade is distinct (reverse-index cleanup + JSON
// projection update with handle: null).

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

describe('POST /letterboxd/unlink', () => {
  it('clears KV links, nulls member.handle, dispatches update-member with handle:null', async () => {
    const { token, member } = await signedInMember('unlink@example.com', 'unlinkuser')
    await env.MEMBERS_KV.put('email:unlinkuser', 'unlink@example.com')
    await env.MEMBERS_KV.put('handle:unlink@example.com', 'unlinkuser')

    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response('', { status: 204 })
    })

    const res = await fetchWith('/letterboxd/unlink', 'POST', {}, token)
    expect(res.status).toBe(200)

    expect(await env.MEMBERS_KV.get('email:unlinkuser')).toBeNull()
    expect(await env.MEMBERS_KV.get('handle:unlink@example.com')).toBeNull()
    const saved = JSON.parse(await env.MEMBERS_KV.get('member:unlink@example.com'))
    expect(saved.handle).toBeNull()

    // session:{id} refreshed with handle: null after unlink.
    const session = JSON.parse(await env.MEMBERS_KV.get(`session:${member.id}`))
    expect(session.handle).toBeNull()

    const gh = calls.find(c => c.url.includes('api.github.com'))
    const dispatch = JSON.parse(gh.init.body)
    expect(dispatch.event_type).toBe('update-member')
    expect(dispatch.client_payload.id).toBe(member.id)
    expect(dispatch.client_payload.updates).toEqual({ handle: null })
  })

  it('400 when no Letterboxd is linked', async () => {
    const { token } = await signedInMember('nolink@example.com') // no handle
    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/letterboxd/unlink', 'POST', {}, token)
    expect(res.status).toBe(400)
  })

  it('401 without token', async () => {
    const res = await fetchWith('/letterboxd/unlink', 'POST', {})
    expect(res.status).toBe(401)
  })
})
