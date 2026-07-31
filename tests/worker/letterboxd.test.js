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

// Admin moderation path — same cascade as the self-service endpoint, but
// bearer-gated with ADMIN_TOKEN and with no no-handle guard: it doubles as
// the idempotent repair for canonical-vs-aggregate drift (member row already
// unlinked while members:all still shows the handle).
describe('POST /admin/member/unlink', () => {
  const ADMIN = 'test-admin-token' // tests/worker/vitest.config.ts

  it('runs the full cascade: member row, indices, lb_token, members:all, watched cache, session, dispatch', async () => {
    const member = { id: 'adm1', email: 'adm@example.com', name: 'Mod Target', handle: 'modhandle', joined: '2026-01-01' }
    await env.MEMBERS_KV.put('member:adm@example.com', JSON.stringify(member))
    await env.MEMBERS_KV.put('email:modhandle', 'adm@example.com')
    await env.MEMBERS_KV.put('handle:adm@example.com', 'modhandle')
    await env.MEMBERS_KV.put('lb_token:adm@example.com', 'tok')
    await env.MEMBERS_KV.put('members:all', JSON.stringify([
      { id: 'adm1', name: 'Mod Target', handle: 'modhandle', joined: '2026-01-01' },
    ]))
    await env.MEMBERS_KV.put('members:bootstrapped', '1')
    await env.MEMBERS_KV.put('watched:cache', '{}')

    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response('', { status: 204 })
    })

    const res = await fetchWith('/admin/member/unlink', 'POST', { email: 'adm@example.com' }, ADMIN)
    expect(res.status).toBe(200)
    expect((await res.json()).unlinked).toBe('modhandle')

    const saved = JSON.parse(await env.MEMBERS_KV.get('member:adm@example.com'))
    expect(saved.handle).toBeNull()
    expect(await env.MEMBERS_KV.get('email:modhandle')).toBeNull()
    expect(await env.MEMBERS_KV.get('handle:adm@example.com')).toBeNull()
    expect(await env.MEMBERS_KV.get('lb_token:adm@example.com')).toBeNull()
    expect(await env.MEMBERS_KV.get('watched:cache')).toBeNull()

    // The public aggregate row loses its handle — the invariant the old
    // admin-SPA raw-KV unlink violated (members-events.test.js asserts the
    // same for the self-service path).
    const agg = JSON.parse(await env.MEMBERS_KV.get('members:all'))
    const row = agg.find(m => m.id === 'adm1')
    expect(row).toBeTruthy()
    expect(row.handle).toBeUndefined()

    const session = JSON.parse(await env.MEMBERS_KV.get('session:adm1'))
    expect(session.handle).toBeNull()

    const gh = calls.find(c => c.url.includes('api.github.com'))
    const dispatch = JSON.parse(gh.init.body)
    expect(dispatch.event_type).toBe('update-member')
    expect(dispatch.client_payload).toEqual({ id: 'adm1', updates: { handle: null } })
  })

  it('repairs drifted state: canonical row already unlinked, aggregate + stray index still carry the handle', async () => {
    const member = { id: 'drift1', email: 'drift@example.com', name: 'Drifted', handle: null, joined: '2026-01-01' }
    await env.MEMBERS_KV.put('member:drift@example.com', JSON.stringify(member))
    // The exact production bad state left by the old admin-SPA unlink … plus
    // a stray reverse index to prove the stale-handle cleanup path.
    await env.MEMBERS_KV.put('members:all', JSON.stringify([
      { id: 'drift1', name: 'Drifted', handle: 'stalehandle', joined: '2026-01-01' },
    ]))
    await env.MEMBERS_KV.put('members:bootstrapped', '1')
    await env.MEMBERS_KV.put('email:stalehandle', 'drift@example.com')

    const calls = []
    mockFetch(async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response('', { status: 204 })
    })

    const res = await fetchWith('/admin/member/unlink', 'POST', { email: 'drift@example.com' }, ADMIN)
    expect(res.status).toBe(200)
    expect((await res.json()).unlinked).toBe('stalehandle')

    const agg = JSON.parse(await env.MEMBERS_KV.get('members:all'))
    expect(agg.find(m => m.id === 'drift1').handle).toBeUndefined()
    expect(await env.MEMBERS_KV.get('email:stalehandle')).toBeNull()

    const gh = calls.find(c => c.url.includes('api.github.com'))
    expect(JSON.parse(gh.init.body).event_type).toBe('update-member')
  })

  it('leaves a stale-handle reverse index alone when another member now owns it', async () => {
    const member = { id: 'drift2', email: 'old@example.com', name: 'Old Owner', handle: null, joined: '2026-01-01' }
    await env.MEMBERS_KV.put('member:old@example.com', JSON.stringify(member))
    await env.MEMBERS_KV.put('members:all', JSON.stringify([
      { id: 'drift2', name: 'Old Owner', handle: 'sharedhandle', joined: '2026-01-01' },
    ]))
    await env.MEMBERS_KV.put('members:bootstrapped', '1')
    // Handle since legitimately claimed by someone else.
    await env.MEMBERS_KV.put('email:sharedhandle', 'new@example.com')

    mockFetch(async () => new Response('', { status: 204 }))
    const res = await fetchWith('/admin/member/unlink', 'POST', { email: 'old@example.com' }, ADMIN)
    expect(res.status).toBe(200)

    expect(await env.MEMBERS_KV.get('email:sharedhandle')).toBe('new@example.com')
  })

  it('401 without or with a wrong token', async () => {
    mockFetch(async () => new Response('', { status: 204 }))
    expect((await fetchWith('/admin/member/unlink', 'POST', { email: 'x@example.com' })).status).toBe(401)
    expect((await fetchWith('/admin/member/unlink', 'POST', { email: 'x@example.com' }, 'nope')).status).toBe(401)
  })

  it('404 for an unknown member, 400 for a malformed email', async () => {
    mockFetch(async () => new Response('', { status: 204 }))
    expect((await fetchWith('/admin/member/unlink', 'POST', { email: 'ghost@example.com' }, ADMIN)).status).toBe(404)
    expect((await fetchWith('/admin/member/unlink', 'POST', { email: 'not-an-email' }, ADMIN)).status).toBe(400)
    expect((await fetchWith('/admin/member/unlink', 'POST', {}, ADMIN)).status).toBe(400)
  })
})
