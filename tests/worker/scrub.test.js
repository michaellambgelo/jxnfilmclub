import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ADMIN_TOKEN = 'test-admin-token'

const daysFromNow = (n) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10)

function scrub(token = ADMIN_TOKEN) {
  return SELF.fetch('https://join.jxnfilm.club/admin/scrub', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

async function seedEvent(id, date, extra = {}) {
  const event = {
    id, title: 'Scrub Test', film: 'F', date, kind: 'house',
    address: '1 Secret St', notes: 'gate code 1234', capacity: 4,
    hostId: 'host-1', hostName: 'Host', ...extra,
  }
  await env.ATTENDANCE_KV.put(`event:${id}`, JSON.stringify(event))
  // Mirror what writeEvent maintains: a public projection in events:all.
  const allRaw = await env.ATTENDANCE_KV.get('events:all')
  const all = allRaw ? JSON.parse(allRaw) : []
  const proj = { id, title: event.title, film: event.film, date, kind: event.kind }
  if (event.hostId) { proj.hostId = event.hostId; proj.hostName = event.hostName }
  all.push(proj)
  await env.ATTENDANCE_KV.put('events:all', JSON.stringify(all))
  await env.ATTENDANCE_KV.put('events:bootstrapped', '1')
  return event
}

async function seedRsvp(id, confirmed) {
  await env.ATTENDANCE_KV.put(`rsvp:${id}`, JSON.stringify({ confirmed, waitlist: [] }))
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /admin/scrub', () => {
  it('401 without the admin token', async () => {
    expect((await scrub(null)).status).toBe(401)
    expect((await scrub('wrong-token')).status).toBe(401)
  })

  it('scrubs address/notes + deletes rsvp for events >30 days past; leaves recent and attend untouched', async () => {
    await seedEvent('evt-old', daysFromNow(-40))
    await seedRsvp('evt-old', [{ memberId: 'm1', name: 'Alice', email: 'alice@example.com', at: 1 }])
    await env.ATTENDANCE_KV.put('attend:evt-old', JSON.stringify(['Alice']))

    await seedEvent('evt-recent', daysFromNow(-5))
    await seedRsvp('evt-recent', [{ memberId: 'm2', name: 'Bob', email: 'bob@example.com', at: 2 }])

    await seedEvent('evt-future', daysFromNow(7))
    await seedRsvp('evt-future', [{ memberId: 'm3', name: 'Cara', email: 'cara@example.com', at: 3 }])

    const res = await scrub()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.scrubbedEvents).toBe(1)
    expect(body.deletedRsvps).toBe(1)

    // Old event: private fields gone, public fields + scrub marker present.
    const old = JSON.parse(await env.ATTENDANCE_KV.get('event:evt-old'))
    expect(old.address).toBeUndefined()
    expect(old.notes).toBeUndefined()
    expect(old.scrubbedAt).toBeTruthy()
    expect(old.title).toBe('Scrub Test')
    expect(old.hostId).toBe('host-1')

    // Its rsvp record (the emails) is deleted; names-only history stays.
    expect(await env.ATTENDANCE_KV.get('rsvp:evt-old')).toBeNull()
    expect(JSON.parse(await env.ATTENDANCE_KV.get('attend:evt-old'))).toEqual(['Alice'])

    // events:all still lists the old event (public history).
    const all = JSON.parse(await env.ATTENDANCE_KV.get('events:all'))
    expect(all.some(e => e.id === 'evt-old')).toBe(true)
    expect(all.find(e => e.id === 'evt-old').address).toBeUndefined()

    // Recent + future events untouched.
    expect(JSON.parse(await env.ATTENDANCE_KV.get('event:evt-recent')).address).toBe('1 Secret St')
    expect(await env.ATTENDANCE_KV.get('rsvp:evt-recent')).not.toBeNull()
    expect(JSON.parse(await env.ATTENDANCE_KV.get('event:evt-future')).address).toBe('1 Secret St')
    expect(await env.ATTENDANCE_KV.get('rsvp:evt-future')).not.toBeNull()
  })

  it('guest entries (guest: memberIds, host-entered emails) scrub with the record', async () => {
    // Backs the privacy-policy claim that guest emails inherit the 30-day
    // deletion: the wholesale rsvp:{id} delete never inspects entry shapes.
    await seedEvent('evt-guests', daysFromNow(-40))
    await seedRsvp('evt-guests', [
      { memberId: 'm1', name: 'Alice', email: 'alice@example.com', at: 1 },
      { memberId: 'guest:abc12345', name: 'Gwen Guest', email: 'gwen@example.com', at: 2, addedBy: 'host-1' },
      { memberId: 'guest:def67890', name: 'Quiet Sam', at: 3, addedBy: 'admin' },
    ])

    const res = await scrub()
    expect(res.status).toBe(200)
    expect(await env.ATTENDANCE_KV.get('rsvp:evt-guests')).toBeNull()
  })

  it('deletes orphaned rsvp records whose event row is gone', async () => {
    // Keep events:all present (bootstrapped) so the scrub doesn't try to seed.
    await seedEvent('evt-live', daysFromNow(3))
    await seedRsvp('evt-ghost', [{ memberId: 'mX', name: 'Ghost', email: 'ghost@example.com', at: 1 }])

    const res = await scrub()
    expect(res.status).toBe(200)
    expect(await env.ATTENDANCE_KV.get('rsvp:evt-ghost')).toBeNull()
  })

  it('is idempotent — a second run scrubs nothing new', async () => {
    await seedEvent('evt-twice', daysFromNow(-45))
    await seedRsvp('evt-twice', [{ memberId: 'm1', name: 'Alice', email: 'a@example.com', at: 1 }])

    const first = await (await scrub()).json()
    expect(first.scrubbedEvents).toBe(1)

    const second = await (await scrub()).json()
    expect(second.scrubbedEvents).toBe(0)
    expect(second.deletedRsvps).toBe(0)
  })

  it('POST /events/:id/rsvp rejects a past-date screening (scrub can\'t be undone by a late RSVP)', async () => {
    // Authenticated member.
    const email = 'late@example.com'
    await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify({
      id: 'id-late', email, name: 'Late', joined: '2026-01-01',
    }))
    await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 }))
    const verify = await SELF.fetch('https://join.jxnfilm.club/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code: '111111' }),
    })
    const { token } = await verify.json()

    await seedEvent('evt-done', daysFromNow(-2))
    const res = await SELF.fetch('https://join.jxnfilm.club/events/evt-done/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/already happened/)
  })
})
