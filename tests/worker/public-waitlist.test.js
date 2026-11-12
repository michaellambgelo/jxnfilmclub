import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

// GET /events/attendance also carries `waitlist`: who is waiting on each
// upcoming RSVP event, in order. Public like the RSVP list beside it, so a
// member can see where they stand. Names only, and never attendance.

const ADMIN_TOKEN = 'test-admin-token'
const entry = (n, extra = {}) => ({ memberId: `m${n}`, name: `Member ${n}`, email: `m${n}@example.com`, at: n, ...extra })

async function seedEvents(events) {
  for (const e of events) await env.ATTENDANCE_KV.put(`event:${e.id}`, JSON.stringify(e))
  await env.ATTENDANCE_KV.put('events:all', JSON.stringify(events))
  await env.ATTENDANCE_KV.put('events:bootstrapped', '1')
}
const seedRsvp = (id, confirmed, waitlist) =>
  env.ATTENDANCE_KV.put(`rsvp:${id}`, JSON.stringify({ confirmed, waitlist }))

async function read() {
  const res = await SELF.fetch('https://join.jxnfilm.club/events/attendance')
  expect(res.status).toBe(200)
  const text = await res.text()
  return { text, data: JSON.parse(text) }
}

const presaleEvent = (extra = {}) => ({
  id: 'clay', title: 'CLAYFACE Preview', date: '2099-10-22', venue: 'Capri Theater',
  rsvp: true, ticketed: true, ...extra,
})

afterEach(() => { vi.restoreAllMocks() })

describe('GET /events/attendance — waitlist', () => {
  it('lists the names on a pre-sale list, in order, with no email anywhere', async () => {
    await seedEvents([presaleEvent()])
    await seedRsvp('clay', [], [
      entry(1), entry(2),
      { memberId: 'guest:abc12345', name: 'Gwen Guest', email: 'gwen@example.com', at: 3 },
    ])
    const { text, data } = await read()
    expect(data.waitlist).toEqual({
      clay: [
        { id: 'm1', name: 'Member 1' }, { id: 'm2', name: 'Member 2' },
        { id: 'guest:abc12345', name: 'Gwen Guest' },
      ],
    })
    expect(text).not.toContain('@example.com')
    // Nobody on it has attended anything.
    expect(data.attendance.clay).toBeUndefined()
    expect(await env.ATTENDANCE_KV.get('attend:clay')).toBeNull()
  })

  it('uses a member\'s current name, like every other public list', async () => {
    await seedEvents([presaleEvent()])
    await seedRsvp('clay', [], [entry(1)])
    await env.MEMBERS_KV.put('members:all', JSON.stringify([{ id: 'm1', name: 'Renamed Since' }]))
    expect((await read()).data.waitlist.clay).toEqual([{ id: 'm1', name: 'Renamed Since' }])
  })

  it('gives an empty pre-sale event an empty list', async () => {
    await seedEvents([presaleEvent()])
    expect((await read()).data.waitlist).toEqual({ clay: [] })
  })

  it('lists the waitlist behind a full event too, house screenings included', async () => {
    await seedEvents([
      { id: 'full', title: 'Full club night', date: '2099-10-01', venue: 'Capri Theater', rsvp: true, capacity: 1 },
      { id: 'house', title: 'Living room', date: '2099-10-03', kind: 'house', hostId: 'h1', hostName: 'Host', capacity: 1 },
      { id: 'onsale', title: 'On sale', date: '2099-10-02', venue: 'Capri Theater', rsvp: true, ticketed: true,
        ticketUrl: 'https://tickets.example/x', capacity: 1 },
    ])
    await seedRsvp('full', [entry(1)], [entry(2), entry(5)])
    await seedRsvp('house', [entry(6)], [entry(7)])
    await seedRsvp('onsale', [entry(3)], [entry(4)])
    const { text, data } = await read()
    expect(data.waitlist).toEqual({
      full: [{ id: 'm2', name: 'Member 2' }, { id: 'm5', name: 'Member 5' }],
      house: [{ id: 'm7', name: 'Member 7' }],
      onsale: [{ id: 'm4', name: 'Member 4' }],
    })
    expect(text).not.toContain('@example.com')
    // Waiting is not attending.
    expect((data.attendance.full || []).map(a => a.name)).not.toContain('Member 2')
  })

  it('leaves out an event nobody is waiting on, unless it is a pre-sale', async () => {
    await seedEvents([
      { id: 'roomy', title: 'Room to spare', date: '2099-10-01', venue: 'Capri Theater', rsvp: true, capacity: 5 },
    ])
    await seedRsvp('roomy', [entry(1)], [])
    expect((await read()).data.waitlist).toEqual({})
  })

  it('skips past events and events with RSVPs off', async () => {
    await seedEvents([
      presaleEvent({ id: 'past', date: '2020-01-01' }),
      presaleEvent({ id: 'off', rsvp: false }),
    ])
    for (const id of ['past', 'off']) await seedRsvp(id, [], [entry(1)])
    const { text, data } = await read()
    expect(data.waitlist).toEqual({})
    expect(text).not.toContain('Member 1')
  })

  it('moves the names to attendance once the ticket link lands', async () => {
    await seedEvents([presaleEvent()])
    await seedRsvp('clay', [], [entry(1), entry(2)])
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ id: 'ok' }), { status: 200 }))
    const res = await SELF.fetch('https://join.jxnfilm.club/admin/events/clay', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ event: { ...presaleEvent(), ticketUrl: 'https://tickets.example/clay' }, notify: false }),
    })
    expect(res.status).toBe(200)
    const { data } = await read()
    expect(data.waitlist).toEqual({})
    expect(data.attendance.clay.map(a => a.name)).toEqual(['Member 1', 'Member 2'])
  })
})
