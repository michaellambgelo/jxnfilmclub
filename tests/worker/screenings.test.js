import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

// --- Test plumbing ---

function mockFetch(handler) {
  globalThis.fetch = vi.fn(handler)
}

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

async function seedMember(email, overrides = {}) {
  const member = {
    id: 'id-' + email, email, name: 'M-' + email.split('@')[0], handle: null,
    pronouns: null, newsletter: false, joined: '2026-01-01', ...overrides,
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  return member
}

// Issue a real bearer through the OTP verify path so handlers downstream see a
// valid `claims` (including the member's id, which host-only routes check).
async function getTokenFor(email, overrides = {}) {
  const member = await seedMember(email, overrides)
  await env.MEMBERS_KV.put(`otp:${email}`, '111111', { expirationTtl: 600 })
  mockFetch(async () => new Response('', { status: 200 }))
  const res = await req('/otp/verify', { method: 'POST', body: { email, code: '111111' } })
  return { token: (await res.json()).token, member }
}

// Capture all outgoing transactional sendEmail() requests so tests can
// assert the address only leaves the Worker through Resend.
function captureEmails() {
  const sent = []
  mockFetch(async (url, init) => {
    if (String(url) === 'https://api.resend.com/emails') {
      sent.push(JSON.parse(init.body))
    }
    return new Response(JSON.stringify({ id: 'ok' }), { status: 200 })
  })
  return sent
}

async function createScreening(token, overrides = {}) {
  return req('/events', {
    method: 'POST', token,
    body: {
      title: 'Test Screening',
      film: 'Crash',
      year: 1996,
      date: '2099-01-15',
      address: '123 Main St, Jackson, MS 39201',
      capacity: 2,
      notes: 'Buzzer 5',
      ...overrides,
    },
  })
}

// Theater meetup: public venue from the THEATERS allowlist, no address, no
// capacity by default (uncapped), optional showtime.
async function createMeetup(token, overrides = {}) {
  return req('/events', {
    method: 'POST', token,
    body: {
      kind: 'meetup',
      title: 'Capri Meetup',
      film: 'In the Mood for Love',
      year: 2000,
      date: '2099-02-20',
      venue: 'The Capri Theater',
      time: '19:30',
      ...overrides,
    },
  })
}

afterEach(() => { vi.restoreAllMocks() })

// --- Tests ---

describe('POST /events — create hosted screening', () => {
  it('requires auth', async () => {
    const res = await req('/events', { method: 'POST', body: { title: 'X' } })
    expect(res.status).toBe(401)
  })

  it('creates an event with host stamp, returns projection WITHOUT address', async () => {
    const { token, member } = await getTokenFor('host@example.com')
    captureEmails()
    const res = await createScreening(token, { title: 'May Screening' })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.id).toMatch(/^2099-01-15-may-screening-[a-z0-9]{4}$/)
    // Public response is the projection — never includes the address.
    expect(JSON.stringify(data)).not.toContain('123 Main St')
    expect(data.event.hostId).toBe(member.id)
    expect(data.event.hostName).toBe(member.name)
    expect(data.event.address).toBeUndefined()

    // Canonical KV row DOES carry the address (private, internal-only).
    const raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${data.id}`))
    expect(raw.address).toBe('123 Main St, Jackson, MS 39201')

    // Public events:all aggregate is the projection — no address ever.
    const agg = JSON.parse(await env.ATTENDANCE_KV.get('events:all'))
    expect(JSON.stringify(agg)).not.toContain('123 Main St')

    // GET /events likewise has no address.
    const list = await (await req('/events')).json()
    expect(JSON.stringify(list)).not.toContain('123 Main St')
  })

  it('stamps a public-friendly default venue ("{name}\'s house") when none given; keeps a custom label', async () => {
    const { token, member } = await getTokenFor('host@example.com')
    captureEmails()
    const d1 = await (await createScreening(token)).json()
    expect(d1.event.venue).toBe(`${member.name}'s house`)

    const d2 = await (await createScreening(token, { venue: 'The Red Door house' })).json()
    expect(d2.event.venue).toBe('The Red Door house')
  })

  it('host notes are private: in the RSVP email and canonical row, never in public reads', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: rTok } = await getTokenFor('rsvper@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { notes: 'Gate code 4321' })).json()
    expect(JSON.stringify(created)).not.toContain('Gate code')

    const raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${created.id}`))
    expect(raw.notes).toBe('Gate code 4321')

    const agg = await env.ATTENDANCE_KV.get('events:all')
    expect(agg).not.toContain('Gate code')
    const list = await (await req('/events')).json()
    expect(JSON.stringify(list)).not.toContain('Gate code')

    const sent = captureEmails()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: rTok })
    expect(sent[0].text).toContain('Gate code 4321')
  })

  it('rejects past dates', async () => {
    const { token } = await getTokenFor('host@example.com')
    const res = await createScreening(token, { date: '2000-01-01' })
    expect(res.status).toBe(400)
  })

  it('rejects missing required fields (address, capacity)', async () => {
    const { token } = await getTokenFor('host@example.com')
    const r1 = await createScreening(token, { address: '' })
    expect(r1.status).toBe(400)
    const r2 = await createScreening(token, { capacity: 0 })
    expect(r2.status).toBe(400)
  })

  it('house screenings take an optional showtime; malformed times rejected', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: rTok } = await getTokenFor('rsvper@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { time: '19:00' })).json()
    expect(created.event.time).toBe('19:00')
    const raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${created.id}`))
    expect(raw.time).toBe('19:00')
    const list = await (await req('/events')).json()
    expect(list.find(e => e.id === created.id).time).toBe('19:00')

    const bad1 = await createScreening(hostTok, { time: '7pm' })
    expect(bad1.status).toBe(400)
    const bad2 = await createScreening(hostTok, { time: '25:00' })
    expect(bad2.status).toBe(400)

    // RSVP email carries both the showtime and the private address.
    const sent = captureEmails()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: rTok })
    expect(sent[0].subject).toContain('at 7:00 pm')
    expect(sent[0].text).toContain('Showtime: 7:00 pm')
    expect(sent[0].text).toContain('Address:')
  })

  it('house showtime PATCH notifies confirmed RSVPs; empty time clears it', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: rTok } = await getTokenFor('rsvper@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { time: '19:00' })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: rTok })

    let sent = captureEmails()
    const res = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { time: '20:00' } })
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('time: 19:00 → 20:00')

    const cleared = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { time: '' } })
    expect(cleared.status).toBe(200)
    const raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${created.id}`))
    expect(raw.time).toBeUndefined()
    const list = await (await req('/events')).json()
    expect(list.find(e => e.id === created.id).time).toBeUndefined()
  })
})

describe('POST /events/:id/rsvp + waitlist', () => {
  it('confirmed under cap → emails the address; over cap → waitlisted no email', async () => {
    // Issue ALL tokens first — each getTokenFor() clobbers mockFetch, so we
    // must install the capture handler AFTER the last token is minted.
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('member1@example.com')
    const { token: t2 } = await getTokenFor('member2@example.com')

    captureEmails() // active during create (no emails sent on create)
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    const eventId = created.id

    // First member RSVPs → confirmed, gets address email.
    let sent = captureEmails()
    const r1 = await req(`/events/${eventId}/rsvp`, { method: 'POST', token: t1 })
    expect((await r1.json()).status).toBe('confirmed')
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['member1@example.com'])
    expect(sent[0].text).toContain('123 Main St')
    expect(sent[0].text).toContain('Buzzer 5')        // host notes included
    expect(sent[0].text).toContain('/rsvp/cancel?token=')

    // Second member RSVPs → waitlisted, no email yet.
    sent = captureEmails()
    const r2 = await req(`/events/${eventId}/rsvp`, { method: 'POST', token: t2 })
    const d2 = await r2.json()
    expect(d2.status).toBe('waitlisted')
    expect(d2.position).toBe(1)
    expect(sent).toHaveLength(0)

    // Confirmed list is mirrored to the public attend:{id}.
    const att = await (await req(`/events/${eventId}/attendance`)).json()
    expect(att.attendees).toEqual(['M-member1'])
  })

  it('re-RSVP is idempotent', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 2 })).json()
    const { token } = await getTokenFor('again@example.com')
    captureEmails()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token })
    const r2 = await req(`/events/${created.id}/rsvp`, { method: 'POST', token })
    expect((await r2.json()).status).toBe('confirmed')
  })
})

describe('DELETE /events/:id/rsvp — auto-promote waitlist', () => {
  it('cancel of confirmed promotes the waitlist head + emails them the address', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    const eventId = created.id

    captureEmails()
    const { token: t1 } = await getTokenFor('first@example.com')
    await req(`/events/${eventId}/rsvp`, { method: 'POST', token: t1 })  // confirmed
    const { token: t2 } = await getTokenFor('second@example.com')
    await req(`/events/${eventId}/rsvp`, { method: 'POST', token: t2 })  // waitlisted

    const sent = captureEmails()
    const cancelRes = await req(`/events/${eventId}/rsvp`, { method: 'DELETE', token: t1 })
    const cd = await cancelRes.json()
    expect(cd.status).toBe('cancelled')
    expect(cd.promoted).toBe(true)
    // Promoted member receives the same address email a fresh RSVP would get.
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['second@example.com'])
    expect(sent[0].text).toContain('123 Main St')

    // Public attendees array now shows the promoted member, not the canceller.
    const att = await (await req(`/events/${eventId}/attendance`)).json()
    expect(att.attendees).toEqual(['M-second'])
  })

  it('cancel of waitlisted does NOT promote (silent)', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    const eventId = created.id
    captureEmails()
    const { token: t1 } = await getTokenFor('a@example.com')
    await req(`/events/${eventId}/rsvp`, { method: 'POST', token: t1 })
    const { token: t2 } = await getTokenFor('b@example.com')
    await req(`/events/${eventId}/rsvp`, { method: 'POST', token: t2 })

    const sent = captureEmails()
    await req(`/events/${eventId}/rsvp`, { method: 'DELETE', token: t2 })
    expect(sent).toHaveLength(0)
  })
})

describe('PATCH /events/:id — host edits + smart notify', () => {
  it('only the host can edit', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok)).json()
    const { token: intruder } = await getTokenFor('intruder@example.com')
    const res = await req(`/events/${created.id}`, { method: 'PATCH', token: intruder, body: { title: 'pwned' } })
    expect(res.status).toBe(403)
  })

  it('address change notifies confirmed RSVPs; title-only change does not', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 2 })).json()
    const eventId = created.id
    captureEmails()
    const { token: rTok } = await getTokenFor('rsvper@example.com')
    await req(`/events/${eventId}/rsvp`, { method: 'POST', token: rTok })

    // Title-only edit → silent.
    let sent = captureEmails()
    await req(`/events/${eventId}`, { method: 'PATCH', token: hostTok, body: { title: 'New Title' } })
    expect(sent).toHaveLength(0)

    // Address change → notifies the 1 confirmed RSVP.
    sent = captureEmails()
    const res = await req(`/events/${eventId}`, { method: 'PATCH', token: hostTok, body: { address: '999 New Address' } })
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['rsvper@example.com'])
    expect(sent[0].subject).toMatch(/Update:/)
    expect(sent[0].text).toContain('999 New Address')
  })

  it('capacity decrease below confirmed → 400', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 2 })).json()
    captureEmails()
    const { token: t1 } = await getTokenFor('one@example.com')
    const { token: t2 } = await getTokenFor('two@example.com')
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t2 })
    const res = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { capacity: 1 } })
    expect(res.status).toBe(400)
  })

  it('capacity INCREASE auto-promotes from waitlist + emails the promoted', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    captureEmails()
    const { token: t1 } = await getTokenFor('a@example.com')
    const { token: t2 } = await getTokenFor('b@example.com')
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })  // confirmed
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t2 })  // waitlisted

    const sent = captureEmails()
    await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { capacity: 2 } })
    // Exactly one new email — the promotion to the waitlisted person.
    // (Capacity isn't an address/date change so no update email is sent.)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['b@example.com'])
  })
})

describe('DELETE /events/:id — host cancels screening', () => {
  it('only the host can cancel; sends cancellation email to confirmed RSVPs; tears down state', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    captureEmails()
    const { token: rTok } = await getTokenFor('rsvper@example.com')
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: rTok })

    const { token: intruder } = await getTokenFor('intruder@example.com')
    const forbid = await req(`/events/${created.id}`, { method: 'DELETE', token: intruder })
    expect(forbid.status).toBe(403)

    const sent = captureEmails()
    const res = await req(`/events/${created.id}`, { method: 'DELETE', token: hostTok })
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toMatch(/Cancelled:/)

    // KV is torn down.
    expect(await env.ATTENDANCE_KV.get(`event:${created.id}`)).toBeNull()
    expect(await env.ATTENDANCE_KV.get(`rsvp:${created.id}`)).toBeNull()
    expect(await env.ATTENDANCE_KV.get(`attend:${created.id}`)).toBeNull()
  })
})

describe('/attend on a hosted screening → 409', () => {
  it('rejects POST/DELETE on hosted events so the SPA can render the right affordance', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok)).json()
    const { token } = await getTokenFor('other@example.com')
    const pres = await req(`/events/${created.id}/attend`, { method: 'POST', token })
    expect(pres.status).toBe(409)
    const dres = await req(`/events/${created.id}/attend`, { method: 'DELETE', token })
    expect(dres.status).toBe(409)
  })
})

describe('GET /events/:id/host — host-only view', () => {
  it('returns confirmed + waitlist NAMES (no emails) and the address for the host', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    captureEmails()
    const { token: t1 } = await getTokenFor('one@example.com')
    const { token: t2 } = await getTokenFor('two@example.com')
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t2 })

    const intruderRes = await req(`/events/${created.id}/host`, { token: t1 })
    expect(intruderRes.status).toBe(403)

    const res = await req(`/events/${created.id}/host`, { token: hostTok })
    const data = await res.json()
    expect(data.confirmed).toEqual(['M-one'])
    expect(data.waitlist).toEqual(['M-two'])
    expect(data.address).toBe('123 Main St, Jackson, MS 39201')
    // Emails are NEVER surfaced to the host per the chosen design.
    expect(JSON.stringify(data)).not.toContain('@example.com')
  })
})

describe('theater meetups (kind: meetup)', () => {
  it('creates a meetup; projection carries kind/venue/time; no address anywhere', async () => {
    const { token, member } = await getTokenFor('host@example.com')
    captureEmails()
    const res = await createMeetup(token)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.event.kind).toBe('meetup')
    expect(data.event.venue).toBe('The Capri Theater')
    expect(data.event.time).toBe('19:30')
    expect(data.event.hostId).toBe(member.id)
    expect(data.event.capacity).toBeUndefined()
    expect(data.event.address).toBeUndefined()

    const raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${data.id}`))
    expect(raw.kind).toBe('meetup')
    expect(raw.address).toBeUndefined()

    const agg = JSON.parse(await env.ATTENDANCE_KV.get('events:all'))
    const mine = agg.find(e => e.id === data.id)
    expect(mine.kind).toBe('meetup')
    expect(mine.venue).toBe('The Capri Theater')
    expect(mine.time).toBe('19:30')

    const list = await (await req('/events')).json()
    const pub = list.find(e => e.id === data.id)
    expect(pub.kind).toBe('meetup')
    expect(pub.address).toBeUndefined()
  })

  it('rejects a venue not on the allowlist, and a missing venue', async () => {
    const { token } = await getTokenFor('host@example.com')
    const r1 = await createMeetup(token, { venue: 'Duling Hall' })
    expect(r1.status).toBe(400)
    expect((await r1.json()).error).toMatch(/listed theaters/)
    const r2 = await createMeetup(token, { venue: undefined })
    expect(r2.status).toBe(400)
  })

  it('ignores a submitted address on a meetup — never stored', async () => {
    const { token } = await getTokenFor('host@example.com')
    captureEmails()
    const res = await createMeetup(token, { address: '123 Secret St' })
    expect(res.status).toBe(200)
    const data = await res.json()
    const raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${data.id}`))
    expect(raw.address).toBeUndefined()
    expect(JSON.stringify(data)).not.toContain('123 Secret St')
  })

  it('rejects malformed times, accepts HH:MM', async () => {
    const { token } = await getTokenFor('host@example.com')
    expect((await createMeetup(token, { time: '7pm' })).status).toBe(400)
    expect((await createMeetup(token, { time: '25:00' })).status).toBe(400)
    captureEmails()
    expect((await createMeetup(token, { time: '19:30' })).status).toBe(200)
    expect((await createMeetup(token, { time: undefined })).status).toBe(200)  // optional
  })

  it('no capacity → every RSVP confirms, nobody waitlists', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    const { token: t2 } = await getTokenFor('m2@example.com')
    const { token: t3 } = await getTokenFor('m3@example.com')
    captureEmails()
    const created = await (await createMeetup(hostTok)).json()
    for (const t of [t1, t2, t3]) {
      const r = await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t })
      expect((await r.json()).status).toBe('confirmed')
    }
    const att = await (await req(`/events/${created.id}/attendance`)).json()
    expect(att.attendees).toHaveLength(3)
  })

  it('with capacity set → waitlists past the cap like house screenings', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    const { token: t2 } = await getTokenFor('m2@example.com')
    captureEmails()
    const created = await (await createMeetup(hostTok, { capacity: 1 })).json()
    expect(created.event.capacity).toBe(1)
    const r1 = await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })
    expect((await r1.json()).status).toBe('confirmed')
    const r2 = await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t2 })
    expect((await r2.json()).status).toBe('waitlisted')
  })

  it('confirmation email has venue + showtime + self-organized line, and NO address', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    captureEmails()
    const created = await (await createMeetup(hostTok)).json()
    const sent = captureEmails()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('Venue: The Capri Theater')
    expect(sent[0].text).toContain('Showtime: 7:30 pm')
    expect(sent[0].text).toContain('self-organized')
    expect(sent[0].text).not.toContain('Address:')
    expect(sent[0].subject).toContain('2099-02-20 at 7:30 pm')
  })

  it('PATCH time change notifies confirmed RSVPs; kind change → 400', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    captureEmails()
    const created = await (await createMeetup(hostTok)).json()
    captureEmails()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })

    let sent = captureEmails()
    const res = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { time: '21:00' } })
    expect(res.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('time: 19:30 → 21:00')
    expect(sent[0].text).toContain('Venue: The Capri Theater')
    expect(sent[0].text).not.toContain('Address:')

    const kindRes = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { kind: 'house' } })
    expect(kindRes.status).toBe(400)
    expect((await kindRes.json()).error).toMatch(/kind cannot be changed/)
  })

  it('PATCH clearing capacity promotes the whole waitlist', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    const { token: t2 } = await getTokenFor('m2@example.com')
    const { token: t3 } = await getTokenFor('m3@example.com')
    captureEmails()
    const created = await (await createMeetup(hostTok, { capacity: 1 })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })  // confirmed
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t2 })  // waitlisted
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t3 })  // waitlisted

    const sent = captureEmails()
    const res = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { capacity: '' } })
    expect(res.status).toBe(200)
    // Both waitlisted members promoted + emailed; capacity gone from the row.
    expect(sent.map(e => e.to[0]).sort()).toEqual(['m2@example.com', 'm3@example.com'])
    const raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${created.id}`))
    expect(raw.capacity).toBeUndefined()
    const att = await (await req(`/events/${created.id}/attendance`)).json()
    expect(att.attendees).toHaveLength(3)
  })

  it('host can PATCH a Letterboxd diary link; non-Letterboxd URLs rejected', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createMeetup(hostTok)).json()

    const bad = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok,
      body: { letterboxd_uri: 'https://evil.example.com/phish' } })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/letterboxd/)

    const sent = captureEmails()
    const ok = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok,
      body: { letterboxd_uri: 'https://letterboxd.com/qa/film/the-matrix/' } })
    expect(ok.status).toBe(200)
    expect((await ok.json()).event.letterboxd_uri).toBe('https://letterboxd.com/qa/film/the-matrix/')
    // Not a where/when change — nobody gets emailed.
    expect(sent).toHaveLength(0)

    const list = await (await req('/events')).json()
    const pub = list.find(e => e.id === created.id)
    expect(pub.letterboxd_uri).toBe('https://letterboxd.com/qa/film/the-matrix/')
  })

  it('PATCH with empty or null letterboxd_uri unlinks, on both kinds', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const meetup = await (await createMeetup(hostTok)).json()
    const house = await (await createScreening(hostTok)).json()

    // '' is what the Unlink Diary Entry button sends; null covers API callers.
    for (const [id, clear] of [[meetup.id, ''], [house.id, null]]) {
      await req(`/events/${id}`, { method: 'PATCH', token: hostTok,
        body: { letterboxd_uri: 'https://boxd.it/abc123' } })
      const sent = captureEmails()
      const res = await req(`/events/${id}`, { method: 'PATCH', token: hostTok,
        body: { letterboxd_uri: clear } })
      expect(res.status).toBe(200)
      expect((await res.json()).event.letterboxd_uri).toBeUndefined()
      const raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${id}`))
      expect(raw.letterboxd_uri).toBeUndefined()
      const list2 = await (await req('/events')).json()
      expect(list2.find(e => e.id === id).letterboxd_uri).toBeUndefined()
      // Not a where/when change — nobody gets emailed.
      expect(sent).toHaveLength(0)
    }
  })

  it('host view returns kind/venue/time, null address', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createMeetup(hostTok)).json()
    const res = await req(`/events/${created.id}/host`, { token: hostTok })
    const data = await res.json()
    expect(data.kind).toBe('meetup')
    expect(data.venue).toBe('The Capri Theater')
    expect(data.time).toBe('19:30')
    expect(data.address).toBeNull()
    expect(data.capacity).toBeNull()
  })
})

describe('/rsvp/cancel?token=… — one-click cancel from email', () => {
  it('valid token POST cancels + promotes; tampered token → 400', async () => {
    // Issue ALL tokens first so the capture handler installed below isn't
    // clobbered by getTokenFor()'s internal mockFetch reset.
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: rTok } = await getTokenFor('cancel@example.com')
    const { token: t2 } = await getTokenFor('next@example.com')

    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()

    // RSVP and grab the cancel URL out of the captured email.
    let sent = captureEmails()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: rTok })
    const url = sent[0].text.match(/\/rsvp\/cancel\?token=([^\s]+)/)
    expect(url).toBeTruthy()
    const cancelToken = url[1]

    // Add a 2nd member to the waitlist so we can prove auto-promotion.
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t2 })

    // Tampered token → 400.
    const bad = await req('/rsvp/cancel?token=not.a.token', { method: 'POST' })
    expect(bad.status).toBe(400)

    // GET renders a confirm page (does NOT mutate state).
    const getRes = await req(`/rsvp/cancel?token=${cancelToken}`)
    expect(getRes.status).toBe(200)
    expect((await getRes.text()).toLowerCase()).toContain('cancel my rsvp')

    // POST performs the cancel and promotes.
    const promoSent = captureEmails()
    const ok = await req(`/rsvp/cancel?token=${cancelToken}`, { method: 'POST' })
    expect(ok.status).toBe(200)
    expect(promoSent.find(e => e.to[0] === 'next@example.com')).toBeTruthy()
  })
})
