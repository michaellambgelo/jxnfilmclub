import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

// Default: any fetch the worker makes (Resend, GitHub dispatch, raw JSON baseline)
// 404s unless the test overrides. Individual tests install richer handlers.
function defaultFetch(url) {
  const s = String(url)
  if (s.startsWith('https://raw.githubusercontent.com/')) {
    return new Response('', { status: 404 })
  }
  return new Response('', { status: 204 })
}

beforeEach(async () => {
  const list = await env.ATTENDANCE_KV.list({ prefix: 'attend' })
  await Promise.all(list.keys.map(k => env.ATTENDANCE_KV.delete(k.name)))
  await env.ATTENDANCE_KV.delete('attendance:all')
  await env.ATTENDANCE_KV.delete('attendance:bootstrapped')
  mockFetch(defaultFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const EVENT_ID = '2026-05-01-whiplash'

// Attendance entries are { id, name } keyed on the member id. Most assertions
// here care about who is listed and in what order, not the ids, so they read
// the names off the entries; the tests that are specifically about the id
// keying assert the whole entry.
const names = (attendees) => (attendees || []).map(a => a.name)
const legacy = (id) => ({ id: null, name: id })

describe('GET /events/:id/attendance', () => {
  it('returns empty list for unknown event when baseline is empty', async () => {
    const res = await fetchWith(`/events/${EVENT_ID}/attendance`, 'GET')
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual([])
  })

  it('returns stored attendees from KV', async () => {
    await env.ATTENDANCE_KV.put(`attend:${EVENT_ID}`, JSON.stringify([
      { id: 'm-alice', name: 'alice' }, { id: 'm-bob', name: 'bob' },
    ]))
    const res = await fetchWith(`/events/${EVENT_ID}/attendance`, 'GET')
    expect((await res.json()).attendees).toEqual([
      { id: 'm-alice', name: 'alice' }, { id: 'm-bob', name: 'bob' },
    ])
  })

  it('normalizes legacy name-only rows, and renames what it can resolve', async () => {
    await env.MEMBERS_KV.put('members:all', JSON.stringify([
      { id: 'm-renamed', name: 'New Name' },
    ]))
    await env.ATTENDANCE_KV.put(`attend:${EVENT_ID}`, JSON.stringify([
      'Never A Member', { id: 'm-renamed', name: 'Old Name' },
    ]))
    const res = await fetchWith(`/events/${EVENT_ID}/attendance`, 'GET')
    expect((await res.json()).attendees).toEqual([
      legacy('Never A Member'),
      // Resolved off the id — this is the whole point of the id keying.
      { id: 'm-renamed', name: 'New Name' },
    ])
    await env.MEMBERS_KV.delete('members:all')
  })

  it('bootstraps KV from data/attendance.json on first read', async () => {
    mockFetch(async (url) => {
      if (String(url).startsWith('https://raw.githubusercontent.com/')) {
        return new Response(JSON.stringify({ [EVENT_ID]: ['Seeded Member'] }), { status: 200 })
      }
      return new Response('', { status: 204 })
    })

    const res = await fetchWith(`/events/${EVENT_ID}/attendance`, 'GET')
    expect((await res.json()).attendees).toEqual([legacy('Seeded Member')])

    // Bootstrap writes the aggregate, the per-event key, and the marker —
    // normalizing the legacy name-only baseline into entries as it goes.
    const cached = JSON.parse(await env.ATTENDANCE_KV.get(`attend:${EVENT_ID}`))
    expect(cached).toEqual([legacy('Seeded Member')])
    expect(await env.ATTENDANCE_KV.get('attendance:bootstrapped')).toBe('1')
    const all = JSON.parse(await env.ATTENDANCE_KV.get('attendance:all'))
    expect(all).toEqual({ [EVENT_ID]: [legacy('Seeded Member')] })
  })

  it('bootstrap only runs once per namespace', async () => {
    let baselineCalls = 0
    mockFetch(async (url) => {
      if (String(url).startsWith('https://raw.githubusercontent.com/')) {
        baselineCalls++
        return new Response(JSON.stringify({ [EVENT_ID]: ['Seeded Member'] }), { status: 200 })
      }
      return new Response('', { status: 204 })
    })

    await fetchWith(`/events/${EVENT_ID}/attendance`, 'GET')
    await fetchWith(`/events/${EVENT_ID}/attendance`, 'GET')
    await fetchWith('/events/attendance', 'GET')

    expect(baselineCalls).toBe(1)
  })
})

describe('GET /events/attendance (bulk)', () => {
  it('preserves live per-event KV entries during bootstrap; baseline fills the rest', async () => {
    await env.ATTENDANCE_KV.put('attend:2026-06-01-live', JSON.stringify(['Live Only']))
    mockFetch(async (url) => {
      if (String(url).startsWith('https://raw.githubusercontent.com/')) {
        return new Response(JSON.stringify({
          '2026-06-01-live': ['Stale Baseline'],
          '2020-01-01-historic': ['Historic Member'],
        }), { status: 200 })
      }
      return new Response('', { status: 204 })
    })

    const res = await fetchWith('/events/attendance', 'GET')
    expect(res.status).toBe(200)
    const { attendance } = await res.json()
    expect(attendance['2026-06-01-live']).toEqual([legacy('Live Only')])    // live KV wins
    expect(attendance['2020-01-01-historic']).toEqual([legacy('Historic Member')]) // baseline fills gap
  })

  it('serves subsequent bulk reads from the aggregate without re-fetching baseline', async () => {
    await env.ATTENDANCE_KV.put('attendance:all', JSON.stringify({ foo: ['A'] }))
    await env.ATTENDANCE_KV.put('attendance:bootstrapped', '1')
    let baselineCalls = 0
    mockFetch(async (url) => {
      if (String(url).startsWith('https://raw.githubusercontent.com/')) {
        baselineCalls++
      }
      return new Response('', { status: 204 })
    })

    const res = await fetchWith('/events/attendance', 'GET')
    expect(res.status).toBe(200)
    expect((await res.json()).attendance).toEqual({ foo: [legacy('A')] })
    expect(baselineCalls).toBe(0)
  })

  it('falls back gracefully when the baseline fetch fails', async () => {
    await env.ATTENDANCE_KV.put('attend:x', JSON.stringify(['A']))
    const res = await fetchWith('/events/attendance', 'GET')
    expect(res.status).toBe(200)
    const { attendance } = await res.json()
    expect(attendance.x).toEqual([legacy('A')])
  })
})

describe('POST /events/:id/attend', () => {
  it('returns 401 without a token', async () => {
    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST')
    expect(res.status).toBe(401)
  })

  it('appends name, writes KV + aggregate, does NOT dispatch (snapshot workflow handles persistence)', async () => {
    const { token, member } = await getTokenFor('attend@example.com', { name: 'Alice Test' })
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, token)
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual([{ id: member.id, name: 'Alice Test' }])

    // Stored keyed on the member id, not the display name.
    const stored = JSON.parse(await env.ATTENDANCE_KV.get(`attend:${EVENT_ID}`))
    expect(stored).toEqual([{ id: member.id, name: 'Alice Test' }])
    // Aggregate overlay is updated write-through so the next bulk read is O(1).
    const all = JSON.parse(await env.ATTENDANCE_KV.get('attendance:all'))
    expect(all[EVENT_ID]).toEqual([{ id: member.id, name: 'Alice Test' }])

    expect(calls.find(c => c.url.includes('api.github.com'))).toBeUndefined()
    expect(member.id).toBeTruthy()
  })

  it('merges with a seeded baseline so existing attendees are preserved', async () => {
    const { token } = await getTokenFor('merge@example.com', { name: 'New Attendee' })
    mockFetch(async (url) => {
      if (String(url).startsWith('https://raw.githubusercontent.com/')) {
        return new Response(JSON.stringify({ [EVENT_ID]: ['Existing Member'] }), { status: 200 })
      }
      return new Response('', { status: 204 })
    })

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, token)
    expect(res.status).toBe(200)
    expect(names((await res.json()).attendees)).toEqual(['Existing Member', 'New Attendee'])
  })

  it('works for members without a Letterboxd handle', async () => {
    const { token } = await getTokenFor('nohandle@example.com', { name: 'No Handle' })
    mockFetch(async () => new Response('', { status: 204 }))

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, token)
    expect(res.status).toBe(200)
    expect(names((await res.json()).attendees)).toEqual(['No Handle'])
  })

  it('is idempotent — second attend does not duplicate', async () => {
    const { token, member } = await getTokenFor('idem@example.com', { name: 'Bob Test' })
    await env.ATTENDANCE_KV.put(`attend:${EVENT_ID}`, JSON.stringify([
      { id: member.id, name: 'Bob Test' },
    ]))
    mockFetch(async () => new Response('', { status: 204 }))

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, token)
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual([{ id: member.id, name: 'Bob Test' }])
  })

  it('does not re-add a member whose row predates the id backfill', async () => {
    const { token } = await getTokenFor('pre@example.com', { name: 'Pre Migration' })
    await env.ATTENDANCE_KV.put(`attend:${EVENT_ID}`, JSON.stringify(['Pre Migration']))
    mockFetch(async () => new Response('', { status: 204 }))

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, token)
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual([legacy('Pre Migration')])
  })

  it('lists two members who share a display name separately', async () => {
    const a = await getTokenFor('twin-a@example.com', { name: 'Same Name' })
    const b = await getTokenFor('twin-b@example.com', { name: 'Same Name' })
    mockFetch(async () => new Response('', { status: 204 }))

    await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, a.token)
    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, b.token)
    expect((await res.json()).attendees).toEqual([
      { id: a.member.id, name: 'Same Name' },
      { id: b.member.id, name: 'Same Name' },
    ])
  })
})

describe('DELETE /events/:id/attend', () => {
  it('removes the member from KV when present', async () => {
    const { token, member } = await getTokenFor('rem@example.com', { name: 'Cara Test' })
    await env.ATTENDANCE_KV.put(`attend:${EVENT_ID}`, JSON.stringify([
      { id: member.id, name: 'Cara Test' }, { id: 'm-dan', name: 'Dan Test' },
    ]))
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'DELETE', undefined, token)
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual([{ id: 'm-dan', name: 'Dan Test' }])

    const stored = JSON.parse(await env.ATTENDANCE_KV.get(`attend:${EVENT_ID}`))
    expect(stored).toEqual([{ id: 'm-dan', name: 'Dan Test' }])

    // Snapshot workflow (not this request) commits to data/attendance.json.
    expect(calls.find(c => c.url.includes('api.github.com'))).toBeUndefined()
  })

  it('is a no-op when the member was not attending', async () => {
    const { token } = await getTokenFor('noop@example.com', { name: 'Eve Test' })
    mockFetch(async () => new Response('', { status: 204 }))

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'DELETE', undefined, token)
    expect(res.status).toBe(200)
  })

  it('a removed legacy row does not resurrect on subsequent reads (no stale-baseline bleed)', async () => {
    const { token } = await getTokenFor('ghost@example.com', { name: 'Ghost Test' })
    // Stale repo baseline still lists Ghost Test as attending.
    mockFetch(async (url) => {
      if (String(url).startsWith('https://raw.githubusercontent.com/')) {
        return new Response(JSON.stringify({ [EVENT_ID]: ['Ghost Test'] }), { status: 200 })
      }
      return new Response('', { status: 204 })
    })

    const del = await fetchWith(`/events/${EVENT_ID}/attend`, 'DELETE', undefined, token)
    expect(del.status).toBe(200)
    expect((await del.json()).attendees).toEqual([])

    const bulk = await fetchWith('/events/attendance', 'GET')
    expect((await bulk.json()).attendance[EVENT_ID]).toEqual([])

    const single = await fetchWith(`/events/${EVENT_ID}/attendance`, 'GET')
    expect((await single.json()).attendees).toEqual([])
  })
})
