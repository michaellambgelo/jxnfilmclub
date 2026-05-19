import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Public read endpoints — Worker is the live source of truth for the SPA.
// `/members` reads from MEMBERS_KV (members:all aggregate). `/events` reads
// from ATTENDANCE_KV (events:all aggregate). Both bootstrap from
// data/{members,events}.json on cold KV; tests run in E2E_MODE so the
// baseline fetch returns [] and we exercise the live KV path directly.

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

async function getMembers() {
  const res = await SELF.fetch('https://join.jxnfilm.club/members')
  expect(res.status).toBe(200)
  return res.json()
}

async function getEvents() {
  const res = await SELF.fetch('https://join.jxnfilm.club/events')
  expect(res.status).toBe(200)
  return res.json()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GET /members', () => {
  it('returns [] on a fresh KV (E2E_MODE skips the GitHub baseline fetch)', async () => {
    expect(await getMembers()).toEqual([])
  })

  it('reflects a /signup/verify in the next read — no redeploy required', async () => {
    mockFetch(async () => new Response('', { status: 204 }))
    // Seed pending + OTP directly, then verify.
    await env.MEMBERS_KV.put('pending:newbie@example.com', JSON.stringify({
      name: 'Newbie', handle: null, code: '111111',
    }), { expirationTtl: 600 })
    const verify = await fetchWith('/signup/verify', 'POST', {
      email: 'newbie@example.com', code: '111111',
    })
    expect(verify.status).toBe(200)

    const list = await getMembers()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'Newbie' })
    // Public projection: no email field, ever.
    expect(list[0].email).toBeUndefined()
  })

  it('reflects /member/update edits: name + pronouns + handle land in the aggregate', async () => {
    // Seed an existing member + the aggregate row.
    const member = { id: 'm1', email: 'u@example.com', name: 'Old', pronouns: null, handle: null, joined: '2026-01-01' }
    await env.MEMBERS_KV.put('member:u@example.com', JSON.stringify(member))
    await env.MEMBERS_KV.put('members:all', JSON.stringify([
      { id: 'm1', name: 'Old', joined: '2026-01-01' },
    ]))
    await env.MEMBERS_KV.put('members:bootstrapped', '1')
    // Get an authed token via the OTP path.
    await env.MEMBERS_KV.put('otp:u@example.com', '222222', { expirationTtl: 600 })
    mockFetch(async () => new Response('', { status: 200 }))
    const otpRes = await fetchWith('/otp/verify', 'POST', { email: 'u@example.com', code: '222222' })
    const { token } = await otpRes.json()

    mockFetch(async () => new Response('', { status: 204 }))
    const upd = await fetchWith('/member/update', 'POST', {
      name: 'New Name', pronouns: 'they/them', handle: 'newhandle',
    }, token)
    expect(upd.status).toBe(200)

    const list = await getMembers()
    const row = list.find(m => m.id === 'm1')
    expect(row).toMatchObject({ id: 'm1', name: 'New Name', pronouns: 'they/them', handle: 'newhandle' })
    expect(row.email).toBeUndefined()
  })

  it('reflects /member/delete: the row disappears from the aggregate immediately', async () => {
    const member = { id: 'gone1', email: 'gone@example.com', name: 'Going', joined: '2026-01-01' }
    await env.MEMBERS_KV.put('member:gone@example.com', JSON.stringify(member))
    await env.MEMBERS_KV.put('members:all', JSON.stringify([
      { id: 'gone1', name: 'Going', joined: '2026-01-01' },
      { id: 'stay1', name: 'Stays', joined: '2026-02-02' },
    ]))
    await env.MEMBERS_KV.put('members:bootstrapped', '1')
    // Authed token.
    await env.MEMBERS_KV.put('otp:gone@example.com', '333333', { expirationTtl: 600 })
    mockFetch(async () => new Response('', { status: 200 }))
    const otpRes = await fetchWith('/otp/verify', 'POST', { email: 'gone@example.com', code: '333333' })
    const { token } = await otpRes.json()

    mockFetch(async () => new Response('', { status: 204 }))
    const del = await fetchWith('/member/delete', 'POST', {}, token)
    expect(del.status).toBe(200)

    const list = await getMembers()
    expect(list.find(m => m.id === 'gone1')).toBeUndefined()
    expect(list.find(m => m.id === 'stay1')).toBeTruthy()
  })

  it('reflects /letterboxd/unlink: the handle field disappears from the aggregate row', async () => {
    const member = { id: 'unlink1', email: 'u2@example.com', name: 'Unlinker', handle: 'oldhandle', joined: '2026-01-01' }
    await env.MEMBERS_KV.put('member:u2@example.com', JSON.stringify(member))
    await env.MEMBERS_KV.put('members:all', JSON.stringify([
      { id: 'unlink1', name: 'Unlinker', handle: 'oldhandle', joined: '2026-01-01' },
    ]))
    await env.MEMBERS_KV.put('members:bootstrapped', '1')
    await env.MEMBERS_KV.put('otp:u2@example.com', '444444', { expirationTtl: 600 })
    mockFetch(async () => new Response('', { status: 200 }))
    const otpRes = await fetchWith('/otp/verify', 'POST', { email: 'u2@example.com', code: '444444' })
    const { token } = await otpRes.json()

    mockFetch(async () => new Response('', { status: 204 }))
    await fetchWith('/letterboxd/unlink', 'POST', {}, token)

    const list = await getMembers()
    const row = list.find(m => m.id === 'unlink1')
    expect(row).toBeTruthy()
    expect(row.handle).toBeUndefined()
  })

  it('does not leak email field even when the canonical member row has it', async () => {
    // Seed a member directly and force a bootstrap by clearing the aggregate.
    const m = { id: 'leaktest', email: 'leak@example.com', name: 'Leakcheck', joined: '2026-03-01' }
    await env.MEMBERS_KV.put('member:leak@example.com', JSON.stringify(m))
    await env.MEMBERS_KV.delete('members:all')
    await env.MEMBERS_KV.delete('members:bootstrapped')

    const list = await getMembers()
    const row = list.find(r => r.id === 'leaktest')
    expect(row).toBeTruthy()
    expect(Object.keys(row)).toEqual(expect.arrayContaining(['id', 'name', 'joined']))
    expect(row.email).toBeUndefined()
  })
})

describe('GET /events', () => {
  it('returns [] on a fresh KV', async () => {
    expect(await getEvents()).toEqual([])
  })

  it('reflects an event written to events:all aggregate (admin-dashboard write path)', async () => {
    const ev = { id: '2026-04-screening', title: 'April Screening', film: 'Past Lives', year: 2023, date: '2026-04-15', venue: 'Capri' }
    await env.ATTENDANCE_KV.put('event:2026-04-screening', JSON.stringify(ev))
    await env.ATTENDANCE_KV.put('events:all', JSON.stringify([ev]))
    await env.ATTENDANCE_KV.put('events:bootstrapped', '1')

    const list = await getEvents()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: '2026-04-screening', title: 'April Screening', film: 'Past Lives', date: '2026-04-15' })
  })

  it('bootstraps from per-event KV rows when the aggregate is missing but events exist', async () => {
    const ev1 = { id: 'e1', title: 'One', date: '2026-01-01' }
    const ev2 = { id: 'e2', title: 'Two', date: '2026-02-02' }
    await env.ATTENDANCE_KV.put('event:e1', JSON.stringify(ev1))
    await env.ATTENDANCE_KV.put('event:e2', JSON.stringify(ev2))
    // Aggregate intentionally not seeded; bootstrap should build it.
    await env.ATTENDANCE_KV.delete('events:all')
    await env.ATTENDANCE_KV.delete('events:bootstrapped')

    const list = await getEvents()
    expect(list).toHaveLength(2)
    expect(list.map(e => e.id).sort()).toEqual(['e1', 'e2'])
    // Aggregate is written as a side effect of the bootstrap.
    const aggRaw = await env.ATTENDANCE_KV.get('events:all')
    expect(JSON.parse(aggRaw)).toHaveLength(2)
  })
})

describe('CORS posture', () => {
  it('GET /members returns Access-Control-Allow-Origin matching SITE_ORIGIN', async () => {
    const res = await SELF.fetch('https://join.jxnfilm.club/members')
    expect(res.headers.get('access-control-allow-origin')).toBe(env.SITE_ORIGIN)
  })
  it('GET /events also returns CORS headers', async () => {
    const res = await SELF.fetch('https://join.jxnfilm.club/events')
    expect(res.headers.get('access-control-allow-origin')).toBe(env.SITE_ORIGIN)
  })
})
