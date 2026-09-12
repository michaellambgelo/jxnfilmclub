import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

// PUT/DELETE /admin/events/:id — the path the admin dashboard writes through.
// It exists because a raw KV write cannot promote a waitlist, cannot honour
// the capacity guard, and cannot tell anyone the date moved.

const ADMIN_TOKEN = 'test-admin-token'

function req(path, { method = 'GET', body, token, headers = {} } = {}) {
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// Resend takes `to` as an array; flatten it to the single recipient these
// senders always use, so assertions read as addresses rather than arrays.
function captureEmails() {
  const sent = []
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url) === 'https://api.resend.com/emails') {
      const msg = JSON.parse(init.body)
      sent.push({ ...msg, to: Array.isArray(msg.to) ? msg.to[0] : msg.to })
    }
    return new Response(JSON.stringify({ id: 'ok' }), { status: 200 })
  })
  return sent
}

const put = (id, event, notify = false) =>
  req(`/admin/events/${id}`, { method: 'PUT', token: ADMIN_TOKEN, body: { event, notify } })

async function seedRsvp(id, confirmed, waitlist = []) {
  await env.ATTENDANCE_KV.put(`rsvp:${id}`, JSON.stringify({ confirmed, waitlist }))
}

const rsvper = (n) => ({ memberId: `m${n}`, name: `Member ${n}`, email: `m${n}@example.com`, at: n })

afterEach(() => { vi.restoreAllMocks() })

describe('PUT /admin/events/:id — auth + validation', () => {
  it('401s without the admin token, and with a wrong one', async () => {
    expect((await req('/admin/events/x', { method: 'PUT', body: { event: {} } })).status).toBe(401)
    expect((await req('/admin/events/x', { method: 'PUT', token: 'nope', body: { event: {} } })).status).toBe(401)
  })

  it('creates a club event with no film and no host', async () => {
    captureEmails()
    const res = await put('club-social', {
      title: 'Drinks at Banner Hall', date: '2099-08-01', venue: 'Banner Hall', kind: 'social', rsvp: true,
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.created).toBe(true)
    expect(data.event.kind).toBe('social')
    expect(data.event.rsvp).toBe(true)
    expect(data.event.film).toBeUndefined()

    // Visible on the public read, and in the aggregate the snapshot commits.
    const all = await (await req('/events')).json()
    expect(all.map(e => e.id)).toContain('club-social')
  })

  it('rejects the shape mistakes an admin form can actually make', async () => {
    captureEmails()
    expect((await put('bad', { date: '2099-08-01' })).status).toBe(400)
    expect((await put('bad', { title: 'T', date: 'next tuesday' })).status).toBe(400)
    expect((await put('bad', { title: 'T', date: '2099-08-01', capacity: 'lots' })).status).toBe(400)
    expect((await put('bad', { title: 'T', date: '2099-08-01', time: '7pm' })).status).toBe(400)
    expect((await put('bad', { title: 'T', date: '2099-08-01', kind: 'party' })).status).toBe(400)
    // http would downgrade whoever clicks it out of a public projection.
    expect((await put('bad', { title: 'T', date: '2099-08-01', ticketUrl: 'http://tix.test' })).status).toBe(400)
  })

  it('accepts a past date — admins backfill the club back catalogue', async () => {
    captureEmails()
    expect((await put('old', { title: '2021 Screening', date: '2021-01-13' })).status).toBe(200)
  })

  it('never takes id or hostId from the body', async () => {
    captureEmails()
    await put('real-id', { id: 'spoofed', hostId: 'not-mine', title: 'T', date: '2099-08-01' })
    const row = JSON.parse(await env.ATTENDANCE_KV.get('event:real-id'))
    expect(row.id).toBe('real-id')
    expect(row.hostId).toBeUndefined()
    expect(await env.ATTENDANCE_KV.get('event:spoofed')).toBeNull()
  })

  it('preserves hostId/hostName on a member-hosted row and refuses a kind change', async () => {
    captureEmails()
    await env.ATTENDANCE_KV.put('event:hosted', JSON.stringify({
      id: 'hosted', title: 'House Screening', date: '2099-08-01', kind: 'house',
      address: '1 Secret St', capacity: 4, hostId: 'h1', hostName: 'Hosty',
    }))
    const ok = await put('hosted', { title: 'House Screening (moved)', date: '2099-08-02', address: '2 Secret St', capacity: 4, kind: 'house' })
    expect(ok.status).toBe(200)
    const row = JSON.parse(await env.ATTENDANCE_KV.get('event:hosted'))
    expect(row.hostId).toBe('h1')
    expect(row.hostName).toBe('Hosty')

    const bad = await put('hosted', { title: 'House Screening', date: '2099-08-02', kind: 'meetup', venue: 'The Capri Theater' })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/kind cannot be changed/)
  })

  it('keeps the private address out of the public aggregate', async () => {
    captureEmails()
    await put('addr', { title: 'T', date: '2099-08-01', address: '9 Private Rd', notes: 'gate code' })
    const agg = await env.ATTENDANCE_KV.get('events:all')
    expect(agg).not.toContain('9 Private Rd')
    expect(agg).not.toContain('gate code')
    expect(JSON.parse(await env.ATTENDANCE_KV.get('event:addr')).address).toBe('9 Private Rd')
  })
})

describe('PUT /admin/events/:id — the postponement workflow', () => {
  it('does not email anyone unless notify is set', async () => {
    await env.ATTENDANCE_KV.put('event:p1', JSON.stringify({ id: 'p1', title: 'Night', date: '2099-08-01', venue: 'Banner Hall', rsvp: true }))
    await seedRsvp('p1', [rsvper(1)])
    const sent = captureEmails()

    const res = await put('p1', { title: 'Night', date: '2099-09-01', venue: 'Banner Hall', rsvp: true })
    expect((await res.json()).notified).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('emails confirmed AND waitlisted members when notify is set, with the diff', async () => {
    await env.ATTENDANCE_KV.put('event:p2', JSON.stringify({ id: 'p2', title: 'Night', date: '2099-08-01', venue: 'Banner Hall', kind: 'social', rsvp: true, capacity: 1 }))
    await seedRsvp('p2', [rsvper(1)], [rsvper(2), rsvper(3)])
    const sent = captureEmails()

    const res = await put('p2', { title: 'Night', date: '2099-09-01', venue: 'Banner Hall', kind: 'social', rsvp: true, capacity: 1 }, true)
    const data = await res.json()
    expect(data.notified).toBe(3)
    expect(data.changes).toEqual([{ field: 'date', from: '2099-08-01', to: '2099-09-01' }])

    const to = sent.map(e => e.to)
    expect(to).toContain('m1@example.com')
    expect(to).toContain('m2@example.com')
    expect(to).toContain('m3@example.com')

    const confirmedMail = sent.find(e => e.to === 'm1@example.com')
    expect(confirmedMail.text).toContain('2099-08-01 → 2099-09-01')
    // A social club event is not "the screening", and has no host.
    expect(confirmedMail.text).toContain('Jackson Film Club updated the event')
    expect(confirmedMail.text).not.toContain('the host')

    const waitMail = sent.find(e => e.to === 'm2@example.com')
    expect(waitMail.text).toContain('#1 on the waitlist')
  })

  it('never mails the private address to a waitlisted member', async () => {
    await env.ATTENDANCE_KV.put('event:p3', JSON.stringify({
      id: 'p3', title: 'House', date: '2099-08-01', kind: 'house', capacity: 1,
      address: '9 Private Rd', venue: 'A house', rsvp: true,
    }))
    await seedRsvp('p3', [rsvper(1)], [rsvper(2)])
    const sent = captureEmails()

    await put('p3', { title: 'House', date: '2099-09-01', kind: 'house', capacity: 1, address: '9 Private Rd', venue: 'A house', rsvp: true }, true)
    const waitMail = sent.find(e => e.to === 'm2@example.com')
    expect(waitMail.text).not.toContain('9 Private Rd')
    // ...while the confirmed member, who holds a seat, still gets it.
    expect(sent.find(e => e.to === 'm1@example.com').text).toContain('9 Private Rd')
  })

  it('sends a details re-send with no change section when nothing changed', async () => {
    await env.ATTENDANCE_KV.put('event:p4', JSON.stringify({ id: 'p4', title: 'Night', date: '2099-08-01', venue: 'Banner Hall', rsvp: true }))
    await seedRsvp('p4', [rsvper(1)])
    const sent = captureEmails()

    const res = await put('p4', { title: 'Night', date: '2099-08-01', venue: 'Banner Hall', rsvp: true }, true)
    expect((await res.json()).notified).toBe(1)
    expect(sent[0].text).not.toContain('What changed:')
    expect(sent[0].text).toContain('Current details:')
  })

  it('promotes the waitlist on a capacity increase regardless of notify', async () => {
    await env.ATTENDANCE_KV.put('event:p5', JSON.stringify({ id: 'p5', title: 'Night', date: '2099-08-01', venue: 'Banner Hall', rsvp: true, capacity: 1 }))
    await seedRsvp('p5', [rsvper(1)], [rsvper(2)])
    const sent = captureEmails()

    // notify is false: the promotion email still goes, because m2 now holds a seat.
    await put('p5', { title: 'Night', date: '2099-08-01', venue: 'Banner Hall', rsvp: true, capacity: 2 })
    const rsvp = JSON.parse(await env.ATTENDANCE_KV.get('rsvp:p5'))
    expect(rsvp.confirmed.map(r => r.memberId)).toEqual(['m1', 'm2'])
    expect(rsvp.waitlist).toHaveLength(0)
    expect(sent.map(e => e.to)).toContain('m2@example.com')
  })

  it('refuses a capacity cut below the already-confirmed', async () => {
    await env.ATTENDANCE_KV.put('event:p6', JSON.stringify({ id: 'p6', title: 'Night', date: '2099-08-01', venue: 'Banner Hall', rsvp: true, capacity: 3 }))
    await seedRsvp('p6', [rsvper(1), rsvper(2)])
    captureEmails()

    const res = await put('p6', { title: 'Night', date: '2099-08-01', venue: 'Banner Hall', rsvp: true, capacity: 1 })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/cannot reduce capacity below the 2/)
  })
})

describe('PUT /admin/events/:id — a PUT merges, it does not replace', () => {
  // The dashboard sends the whole form, so this is invisible from the UI. It
  // matters because the endpoint mails people: a body missing `capacity` read
  // as "uncapped", which promoted the entire waitlist and told each of them
  // they had a seat.
  it('an omitted field keeps its stored value instead of being wiped', async () => {
    await env.ATTENDANCE_KV.put('event:m1', JSON.stringify({
      id: 'm1', title: 'Night', date: '2099-08-01', venue: 'V', rsvp: true,
      capacity: 1, notes: 'parking round back', poster: 'https://img.test/a.jpg',
    }))
    await seedRsvp('m1', [rsvper(1)], [rsvper(2), rsvper(3)])
    const sent = captureEmails()

    // Title-only edit: the body carries nothing else.
    await put('m1', { title: 'Night (renamed)', date: '2099-08-01', venue: 'V', rsvp: true })

    const row = JSON.parse(await env.ATTENDANCE_KV.get('event:m1'))
    expect(row.title).toBe('Night (renamed)')
    expect(row.capacity).toBe(1)
    expect(row.notes).toBe('parking round back')
    expect(row.poster).toBe('https://img.test/a.jpg')

    // And nobody was promoted or mailed.
    const rsvp = JSON.parse(await env.ATTENDANCE_KV.get('rsvp:m1'))
    expect(rsvp.confirmed.map(r => r.memberId)).toEqual(['m1'])
    expect(rsvp.waitlist).toHaveLength(2)
    expect(sent).toHaveLength(0)
  })

  it('an explicit empty string clears the field', async () => {
    await env.ATTENDANCE_KV.put('event:m2', JSON.stringify({
      id: 'm2', title: 'Night', date: '2099-08-01', venue: 'V',
      time: '19:30', notes: 'gate code', capacity: 4, letterboxd_uri: 'https://boxd.it/abc',
    }))
    captureEmails()

    await put('m2', { title: 'Night', date: '2099-08-01', venue: 'V', time: '', notes: '', capacity: '', letterboxd_uri: '' })

    const row = JSON.parse(await env.ATTENDANCE_KV.get('event:m2'))
    expect(row.time).toBeUndefined()
    expect(row.notes).toBeUndefined()
    expect(row.capacity).toBeUndefined()
    expect(row.letterboxd_uri).toBeUndefined()
    expect(row.venue).toBe('V')
  })

  it('clearing capacity uncaps the event and promotes the whole waitlist', async () => {
    await env.ATTENDANCE_KV.put('event:m3', JSON.stringify({
      id: 'm3', title: 'Night', date: '2099-08-01', venue: 'V', rsvp: true, capacity: 1,
    }))
    await seedRsvp('m3', [rsvper(1)], [rsvper(2), rsvper(3)])
    const sent = captureEmails()

    await put('m3', { title: 'Night', date: '2099-08-01', venue: 'V', rsvp: true, capacity: '' })

    const rsvp = JSON.parse(await env.ATTENDANCE_KV.get('rsvp:m3'))
    expect(rsvp.confirmed.map(r => r.memberId)).toEqual(['m1', 'm2', 'm3'])
    expect(rsvp.waitlist).toHaveLength(0)
    // Each promoted member is told they are in, notify or not.
    expect(sent.map(e => e.to).sort()).toEqual(['m2@example.com', 'm3@example.com'])
  })

  it('an unrelated edit to an over-capacity event still goes through', async () => {
    // A host force-added a guest past the cap; editing the title must not 400.
    await env.ATTENDANCE_KV.put('event:m4', JSON.stringify({
      id: 'm4', title: 'Night', date: '2099-08-01', venue: 'V', rsvp: true, capacity: 1,
    }))
    await seedRsvp('m4', [rsvper(1), rsvper(2)])
    captureEmails()

    const res = await put('m4', { title: 'Night (renamed)', date: '2099-08-01', venue: 'V', rsvp: true, capacity: 1 })
    expect(res.status).toBe(200)
  })
})

describe('DELETE /admin/events/:id', () => {
  it('401s without the admin token', async () => {
    expect((await req('/admin/events/x', { method: 'DELETE' })).status).toBe(401)
  })

  it('emails every RSVP, then tears down every key', async () => {
    await env.ATTENDANCE_KV.put('event:d1', JSON.stringify({ id: 'd1', title: 'Doomed', date: '2099-08-01', venue: 'Banner Hall', kind: 'social', rsvp: true }))
    await seedRsvp('d1', [rsvper(1)], [rsvper(2)])
    await env.ATTENDANCE_KV.put('events:all', JSON.stringify([{ id: 'd1', title: 'Doomed', date: '2099-08-01' }]))
    await env.ATTENDANCE_KV.put('events:bootstrapped', '1')
    const sent = captureEmails()

    const res = await req('/admin/events/d1', { method: 'DELETE', token: ADMIN_TOKEN })
    expect((await res.json()).notified).toBe(2)
    expect(sent.map(e => e.to).sort()).toEqual(['m1@example.com', 'm2@example.com'])
    expect(sent[0].subject).toMatch(/^Cancelled: Doomed/)
    expect(sent[0].text).toContain('Jackson Film Club cancelled the event')

    expect(await env.ATTENDANCE_KV.get('event:d1')).toBeNull()
    expect(await env.ATTENDANCE_KV.get('rsvp:d1')).toBeNull()
    expect(JSON.parse(await env.ATTENDANCE_KV.get('events:all'))).toEqual([])
  })

  it('mails nobody for a past event, but still cleans up', async () => {
    await env.ATTENDANCE_KV.put('event:d2', JSON.stringify({ id: 'd2', title: 'Over', date: '2020-01-01', venue: 'Banner Hall' }))
    await seedRsvp('d2', [rsvper(1)])
    const sent = captureEmails()

    const res = await req('/admin/events/d2', { method: 'DELETE', token: ADMIN_TOKEN })
    expect((await res.json()).notified).toBe(0)
    expect(sent).toHaveLength(0)
    expect(await env.ATTENDANCE_KV.get('event:d2')).toBeNull()
  })

  it('404s an event that is not there', async () => {
    captureEmails()
    expect((await req('/admin/events/ghost', { method: 'DELETE', token: ADMIN_TOKEN })).status).toBe(404)
  })
})
