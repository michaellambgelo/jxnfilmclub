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

beforeEach(async () => {
  // Wipe attendance KV between tests (singleWorker shares state).
  const list = await env.ATTENDANCE_KV.list({ prefix: 'attend:' })
  await Promise.all(list.keys.map(k => env.ATTENDANCE_KV.delete(k.name)))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const EVENT_ID = '2026-05-01-whiplash'

describe('GET /events/:id/attendance', () => {
  it('returns empty list for unknown event', async () => {
    const res = await fetchWith(`/events/${EVENT_ID}/attendance`, 'GET')
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual([])
  })

  it('returns stored attendees', async () => {
    await env.ATTENDANCE_KV.put(`attend:${EVENT_ID}`, JSON.stringify(['alice', 'bob']))
    const res = await fetchWith(`/events/${EVENT_ID}/attendance`, 'GET')
    expect((await res.json()).attendees).toEqual(['alice', 'bob'])
  })
})

describe('POST /events/:id/attend', () => {
  it('returns 401 without a token', async () => {
    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST')
    expect(res.status).toBe(401)
  })

  it('appends name, writes KV, dispatches update-attendance', async () => {
    const { token, member } = await getTokenFor('attend@example.com', { name: 'Alice Test' })
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, token)
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual(['Alice Test'])

    const stored = JSON.parse(await env.ATTENDANCE_KV.get(`attend:${EVENT_ID}`))
    expect(stored).toEqual(['Alice Test'])

    const gh = calls.find(c => c.url.includes('api.github.com'))
    const dispatch = JSON.parse(gh.init.body)
    expect(dispatch.event_type).toBe('update-attendance')
    expect(dispatch.client_payload).toEqual({ event_id: EVENT_ID, name: 'Alice Test', action: 'add' })
    expect(member.id).toBeTruthy()
  })

  it('works for members without a Letterboxd handle', async () => {
    const { token } = await getTokenFor('nohandle@example.com', { name: 'No Handle' })
    mockFetch(async () => new Response('', { status: 204 }))

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, token)
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual(['No Handle'])
  })

  it('is idempotent — second attend does not duplicate or re-dispatch', async () => {
    const { token } = await getTokenFor('idem@example.com', { name: 'Bob Test' })
    await env.ATTENDANCE_KV.put(`attend:${EVENT_ID}`, JSON.stringify(['Bob Test']))
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'POST', {}, token)
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual(['Bob Test'])
    expect(calls.find(c => c.url.includes('api.github.com'))).toBeUndefined()
  })
})

describe('DELETE /events/:id/attend', () => {
  it('removes name and dispatches when present', async () => {
    const { token } = await getTokenFor('rem@example.com', { name: 'Cara Test' })
    await env.ATTENDANCE_KV.put(`attend:${EVENT_ID}`, JSON.stringify(['Cara Test', 'Dan Test']))
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'DELETE', undefined, token)
    expect(res.status).toBe(200)
    expect((await res.json()).attendees).toEqual(['Dan Test'])

    const stored = JSON.parse(await env.ATTENDANCE_KV.get(`attend:${EVENT_ID}`))
    expect(stored).toEqual(['Dan Test'])

    const dispatch = JSON.parse(calls.find(c => c.url.includes('api.github.com')).init.body)
    expect(dispatch.client_payload).toEqual({ event_id: EVENT_ID, name: 'Cara Test', action: 'remove' })
  })

  it('is a no-op (no dispatch) when name was not attending', async () => {
    const { token } = await getTokenFor('noop@example.com', { name: 'Eve Test' })
    const calls = []
    mockFetch(async (url, init) => { calls.push({ url: String(url), init }); return new Response('', { status: 204 }) })

    const res = await fetchWith(`/events/${EVENT_ID}/attend`, 'DELETE', undefined, token)
    expect(res.status).toBe(200)
    expect(calls.find(c => c.url.includes('api.github.com'))).toBeUndefined()
  })
})
