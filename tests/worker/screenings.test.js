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

  it('update-email diff always matches the stored row (no phantom changes)', async () => {
    // Regression: pre-a95211b the diff was computed from the validator
    // output, which dropped house showtimes — so a diary-link PATCH emailed
    // every RSVP "time: 20:00 → (blank)" while KV kept the time.
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: rTok } = await getTokenFor('rsvper@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { time: '20:00' })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: rTok })

    // PATCH that touches nothing diffable → no update email, time intact.
    let sent = captureEmails()
    const link = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { letterboxd_uri: 'https://letterboxd.com/host/film/halloween-1978/' } })
    expect(link.status).toBe(200)
    expect(sent).toHaveLength(0)
    let raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${created.id}`))
    expect(raw.time).toBe('20:00')

    // Real clear → the email's diff and the stored row agree: both blank.
    sent = captureEmails()
    const cleared = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { time: '' } })
    expect(cleared.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('time: 20:00 → (blank)')
    expect(sent[0].text).not.toContain('Showtime:')
    raw = JSON.parse(await env.ATTENDANCE_KV.get(`event:${created.id}`))
    expect(raw.time).toBeUndefined()
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

    // Confirmed list is mirrored to the public attend:{id} — behind the host,
    // who attends their own screening without holding an RSVP slot.
    const att = await (await req(`/events/${eventId}/attendance`)).json()
    expect(att.attendees).toEqual(['M-host', 'M-member1'])
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

    // Public attendees array now shows the host + promoted member, not the canceller.
    const att = await (await req(`/events/${eventId}/attendance`)).json()
    expect(att.attendees).toEqual(['M-host', 'M-second'])
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

  it('past screening → 409; nothing deleted, nobody emailed', async () => {
    const { token: hostTok, member: host } = await getTokenFor('host@example.com')
    // Seed directly: the create API rightly rejects past dates. A confirmed
    // RSVP proves the cancellation-email loop never runs.
    await env.ATTENDANCE_KV.put('event:past-del', JSON.stringify({
      id: 'past-del', title: 'Past', date: '2000-01-01', hostId: host.id,
    }))
    await env.ATTENDANCE_KV.put('rsvp:past-del', JSON.stringify({
      confirmed: [{ memberId: 'm-1', name: 'Rita', email: 'rita@example.com', at: 1 }],
      waitlist: [],
    }))

    const sent = captureEmails()
    const res = await req('/events/past-del', { method: 'DELETE', token: hostTok })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already happened/)
    expect(sent).toHaveLength(0)
    expect(await env.ATTENDANCE_KV.get('event:past-del')).not.toBeNull()
    expect(await env.ATTENDANCE_KV.get('rsvp:past-del')).not.toBeNull()
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
    expect(att.attendees).toEqual(['M-host', 'M-m1', 'M-m2', 'M-m3'])
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
    expect(att.attendees).toEqual(['M-host', 'M-m1', 'M-m2', 'M-m3'])
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

describe('meetup venue allowlist — KV config:theaters overrides the literal', () => {
  it('accepts a venue present only in KV; the list REPLACES the literal (not a merge)', async () => {
    const { token } = await getTokenFor('host@example.com')
    await env.MEMBERS_KV.put('config:theaters', JSON.stringify(['Duling Hall']))
    captureEmails()
    const ok = await createMeetup(token, { venue: 'Duling Hall' })
    expect(ok.status).toBe(200)
    expect((await ok.json()).event.venue).toBe('Duling Hall')
    // A literal theater not in the valid KV list is no longer accepted.
    const literal = await createMeetup(token, { venue: 'The Capri Theater' })
    expect(literal.status).toBe(400)
  })

  it('rejects a venue in neither the KV list nor the literal', async () => {
    const { token } = await getTokenFor('host@example.com')
    await env.MEMBERS_KV.put('config:theaters', JSON.stringify(['Duling Hall']))
    const res = await createMeetup(token, { venue: 'Some Random Bar' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/listed theaters/)
  })

  it('KV entries are trimmed when comparing, matching the venue-trim behavior', async () => {
    const { token } = await getTokenFor('host@example.com')
    await env.MEMBERS_KV.put('config:theaters', JSON.stringify(['  Duling Hall  ']))
    captureEmails()
    const res = await createMeetup(token, { venue: ' Duling Hall ' })
    expect(res.status).toBe(200)
    expect((await res.json()).event.venue).toBe('Duling Hall')
  })

  it('invalid config:theaters content falls back to the literal list', async () => {
    const { token } = await getTokenFor('host@example.com')
    captureEmails()
    for (const bad of ['not json {', '[]', '[1,2]', '["  "]', '{"a":1}']) {
      await env.MEMBERS_KV.put('config:theaters', bad)
      // A literal theater is still accepted (createMeetup defaults to The
      // Capri Theater), and a non-literal venue is still rejected.
      const ok = await createMeetup(token)
      expect(ok.status).toBe(200)
      const nope = await createMeetup(token, { venue: 'Duling Hall' })
      expect(nope.status).toBe(400)
    }
  })

  it('PATCH revalidates against the KV allowlist too', async () => {
    const { token } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createMeetup(token)).json()  // literal venue
    await env.MEMBERS_KV.put('config:theaters', JSON.stringify(['Duling Hall', 'The Capri Theater']))
    const res = await req(`/events/${created.id}`, { method: 'PATCH', token, body: { venue: 'Duling Hall' } })
    expect(res.status).toBe(200)
    expect((await res.json()).event.venue).toBe('Duling Hall')
    const bad = await req(`/events/${created.id}`, { method: 'PATCH', token, body: { venue: 'Some Random Bar' } })
    expect(bad.status).toBe(400)
  })
})

describe('POST/DELETE /events/:id/rsvp/guest — manual guest RSVPs', () => {
  const ADMIN = 'test-admin-token'  // tests/worker/vitest.config.ts

  it('auth matrix: anon 401, non-host 403, host 200, admin token 200; 404/409 guards', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: other } = await getTokenFor('other@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok)).json()

    const anon = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', body: { name: 'G' } })
    expect(anon.status).toBe(401)
    const nonHost = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: other, body: { name: 'G' } })
    expect(nonHost.status).toBe(403)
    const missing = await req('/events/nope/rsvp/guest', { method: 'POST', token: hostTok, body: { name: 'G' } })
    expect(missing.status).toBe(404)

    // Curated (non-hosted) event → 409.
    await env.ATTENDANCE_KV.put('event:curated-1', JSON.stringify({ id: 'curated-1', title: 'Curated', date: '2099-01-01' }))
    const curated = await req('/events/curated-1/rsvp/guest', { method: 'POST', token: ADMIN, body: { name: 'G' } })
    expect(curated.status).toBe(409)

    // Past screening → 409 on BOTH verbs: removal routes through cancelRsvp,
    // whose promotion path would email an address for a finished screening.
    await env.ATTENDANCE_KV.put('event:past-1', JSON.stringify({ id: 'past-1', title: 'Past', date: '2000-01-01', hostId: 'someone' }))
    const past = await req('/events/past-1/rsvp/guest', { method: 'POST', token: ADMIN, body: { name: 'G' } })
    expect(past.status).toBe(409)
    const pastRm = await req('/events/past-1/rsvp/guest', { method: 'DELETE', token: ADMIN, body: { id: 'guest:abc12345' } })
    expect(pastRm.status).toBe(409)

    const byHost = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Guest One' } })
    expect(byHost.status).toBe(200)
    const byAdmin = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: ADMIN, body: { name: 'Guest Two' } })
    expect(byAdmin.status).toBe(200)
  })

  it('emailed guest → confirmed, one opt-out-framed email with address + cancel link; KV entry tagged', async () => {
    const { token: hostTok, member: host } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok)).json()

    const sent = captureEmails()
    const res = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Gwen Guest', email: 'gwen@example.com' } })
    const data = await res.json()
    expect(data.status).toBe('confirmed')
    expect(data.id).toMatch(/^guest:[a-z0-9]{8}$/)

    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['gwen@example.com'])
    expect(sent[0].text).toContain(`${host.name} added you to the guest list`)
    expect(sent[0].text).toContain('123 Main St')
    expect(sent[0].text).toContain('Buzzer 5')
    expect(sent[0].text).toContain('/rsvp/cancel?token=')
    expect(sent[0].text).toContain('30 days')

    const rsvp = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${created.id}`))
    expect(rsvp.confirmed).toHaveLength(1)
    expect(rsvp.confirmed[0].memberId).toBe(data.id)
    expect(rsvp.confirmed[0].email).toBe('gwen@example.com')
    expect(rsvp.confirmed[0].addedBy).toBe(host.id)

    // Public attend: mirror includes the host and the guest name.
    const att = await (await req(`/events/${created.id}/attendance`)).json()
    expect(att.attendees).toEqual(['M-host', 'Gwen Guest'])
  })

  it('admin add stamps addedBy: admin (never the operator email)', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok)).json()
    await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: ADMIN, body: { name: 'Ada' } })
    const rsvp = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${created.id}`))
    expect(rsvp.confirmed[0].addedBy).toBe('admin')
  })

  it('name-only guest → confirmed, zero emails, no email key stored', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok)).json()
    const sent = captureEmails()
    const res = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Sam' } })
    expect((await res.json()).status).toBe('confirmed')
    expect(sent).toHaveLength(0)
    const rsvp = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${created.id}`))
    expect('email' in rsvp.confirmed[0]).toBe(false)
  })

  it('validates name and email', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok)).json()
    const noName = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { email: 'x@example.com' } })
    expect(noName.status).toBe(400)
    const badEmail = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'G', email: 'not-an-email' } })
    expect(badEmail.status).toBe(400)
  })

  it('full event: no force → waitlisted (no email); force → confirmed over capacity', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })  // fills the room

    const sent = captureEmails()
    const wl = await (await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Waity', email: 'waity@example.com' } })).json()
    expect(wl.status).toBe('waitlisted')
    expect(wl.position).toBe(1)
    expect(sent).toHaveLength(0)

    const forced = await (await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Vip', email: 'vip@example.com', force: true } })).json()
    expect(forced.status).toBe('confirmed')
    const rsvp = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${created.id}`))
    expect(rsvp.confirmed).toHaveLength(2)  // capacity 1 + forced guest
    expect(rsvp.waitlist).toHaveLength(1)
    // Forced confirm sends the confirmation email.
    expect(sent.find(e => e.to[0] === 'vip@example.com')).toBeTruthy()
  })

  it('dedupes by email across lists and against members; name-only never dedupes', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 10 })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })

    // Same guest email twice → 409 (case-insensitive).
    const g1 = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'G', email: 'dupe@example.com' } })
    expect(g1.status).toBe(200)
    const g2 = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'G2', email: 'DUPE@example.com' } })
    expect(g2.status).toBe(409)

    // Guest email matching an existing member RSVP → 409.
    const g3 = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'M1 Again', email: 'm1@example.com' } })
    expect(g3.status).toBe(409)

    // Two name-only Sams both get in.
    const s1 = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Sam' } })
    const s2 = await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Sam' } })
    expect(s1.status).toBe(200)
    expect(s2.status).toBe(200)
    const rsvp = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${created.id}`))
    expect(rsvp.confirmed.filter(r => r.name === 'Sam')).toHaveLength(2)
  })

  it('member self-RSVP after being host-added with the same email → 409', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('walkin@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok)).json()
    await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Walk In', email: 'walkin@example.com' } })
    const res = await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })
    expect(res.status).toBe(409)
  })

  it('guest one-click cancel works; promotion only happens when there is real space', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    const { token: t2 } = await getTokenFor('m2@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })  // confirmed 1/1
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t2 })  // waitlisted

    // Force-add an emailed guest → confirmed 2/1.
    const sent = captureEmails()
    await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Gwen', email: 'gwen@example.com', force: true } })
    const url = sent[0].text.match(/\/rsvp\/cancel\?token=([^\s]+)/)
    expect(url).toBeTruthy()

    // Guest cancels via the email token: room goes 2/1 → 1/1, still full, so
    // the waitlisted member must NOT be promoted.
    const promoSent = captureEmails()
    const ok = await req(`/rsvp/cancel?token=${url[1]}`, { method: 'POST' })
    expect(ok.status).toBe(200)
    expect(promoSent).toHaveLength(0)
    let rsvp = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${created.id}`))
    expect(rsvp.confirmed).toHaveLength(1)
    expect(rsvp.waitlist).toHaveLength(1)

    // Now the confirmed member cancels: 1/1 → 0/1, real space → promotion.
    const promo2 = captureEmails()
    await req(`/events/${created.id}/rsvp`, { method: 'DELETE', token: t1 })
    expect(promo2.find(e => e.to[0] === 'm2@example.com')).toBeTruthy()
    rsvp = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${created.id}`))
    expect(rsvp.confirmed).toHaveLength(1)
    expect(rsvp.waitlist).toHaveLength(0)
  })

  it('DELETE removes a guest; conditional promotion; guests-only rule; idempotent', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    const { token: t2 } = await getTokenFor('m2@example.com')
    const { token: other } = await getTokenFor('other@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })  // confirmed 1/1
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t2 })  // waitlisted
    const forced = await (await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Over Cap', force: true } })).json()

    // Member ids are rejected — members keep their own agency.
    const rsvpBefore = JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${created.id}`))
    const memberId = rsvpBefore.confirmed.find(r => !r.memberId.startsWith('guest:')).memberId
    const memberRm = await req(`/events/${created.id}/rsvp/guest`, { method: 'DELETE', token: hostTok, body: { id: memberId } })
    expect(memberRm.status).toBe(400)

    // Non-host can't remove.
    const intruder = await req(`/events/${created.id}/rsvp/guest`, { method: 'DELETE', token: other, body: { id: forced.id } })
    expect(intruder.status).toBe(403)

    // Removing the forced guest (2/1 → 1/1, still full) promotes nobody.
    const sent = captureEmails()
    const rm = await (await req(`/events/${created.id}/rsvp/guest`, { method: 'DELETE', token: hostTok, body: { id: forced.id } })).json()
    expect(rm.status).toBe('cancelled')
    expect(rm.promoted).toBe(false)
    expect(sent).toHaveLength(0)

    // Unknown guest id → idempotent not-rsvped.
    const again = await (await req(`/events/${created.id}/rsvp/guest`, { method: 'DELETE', token: hostTok, body: { id: forced.id } })).json()
    expect(again.status).toBe('not-rsvped')

    // Removing a confirmed guest when a real slot frees → promotes + emails.
    await req(`/events/${created.id}/rsvp`, { method: 'DELETE', token: t1 })  // t2 promoted into the slot
    const g = await (await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Late', force: true } })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })    // t1 back on waitlist
    const promoSent = captureEmails()
    const rm2 = await (await req(`/events/${created.id}/rsvp/guest`, { method: 'DELETE', token: hostTok, body: { id: g.id } })).json()
    expect(rm2.promoted).toBe(false)  // 2/1 → 1/1: still no space
    // and finally a real cancel frees the slot for t1
    await req(`/events/${created.id}/rsvp`, { method: 'DELETE', token: t2 })
    expect(promoSent.find(e => e.to[0] === 'm1@example.com')).toBeTruthy()
  })

  it('regression: unrelated PATCH still works while over capacity; capacity guard still fires when touched', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })
    await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Extra', force: true } })  // 2/1

    const title = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { title: 'Still Editable' } })
    expect(title.status).toBe(200)

    const shrink = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { capacity: 1 } })
    expect(shrink.status).toBe(400)

    // Capacity increase to cover the overflow is fine and promotes nobody
    // (there is no waitlist).
    const grow = await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { capacity: 3 } })
    expect(grow.status).toBe(200)
  })

  it('name-only guests are skipped by update + cancellation email loops', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 3 })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })
    await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Quiet Sam' } })

    let sent = captureEmails()
    await req(`/events/${created.id}`, { method: 'PATCH', token: hostTok, body: { address: '999 New Address' } })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['m1@example.com'])

    sent = captureEmails()
    await req(`/events/${created.id}`, { method: 'DELETE', token: hostTok })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['m1@example.com'])
  })

  it('host view lists guests with ids for removal, still no member ids or emails', async () => {
    const { token: hostTok } = await getTokenFor('host@example.com')
    const { token: t1 } = await getTokenFor('m1@example.com')
    captureEmails()
    const created = await (await createScreening(hostTok, { capacity: 1 })).json()
    await req(`/events/${created.id}/rsvp`, { method: 'POST', token: t1 })
    const g = await (await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token: hostTok, body: { name: 'Gwen', email: 'gwen@example.com' } })).json()

    const data = await (await req(`/events/${created.id}/host`, { token: hostTok })).json()
    expect(data.guests).toEqual([{ id: g.id, name: 'Gwen', list: 'waitlist' }])
    expect(JSON.stringify(data)).not.toContain('@example.com')
    expect(JSON.stringify(data)).not.toContain('id-m1')
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

// The host is in the room. They are mirrored into attend:{id} on every RSVP
// write AND overlaid at read time, so screenings that predate this rule report
// the host without a KV backfill. Capacity still counts guest slots only.
describe('the host counts as an attendee', () => {
  it('a brand-new screening with zero RSVPs already lists the host', async () => {
    const { token, member } = await getTokenFor('solo-host@example.com')
    captureEmails()
    const created = await (await createScreening(token)).json()

    const att = await (await req(`/events/${created.id}/attendance`)).json()
    expect(att.attendees).toEqual([member.name])
    // Mirrored into KV, not only synthesized on read.
    expect(JSON.parse(await env.ATTENDANCE_KV.get(`attend:${created.id}`))).toEqual([member.name])
  })

  it('the bulk map carries the host too (this is what the leaderboard snapshot reads)', async () => {
    const { token, member } = await getTokenFor('bulk-host@example.com')
    captureEmails()
    const created = await (await createScreening(token)).json()

    const { attendance } = await (await req('/events/attendance')).json()
    expect(attendance[created.id]).toEqual([member.name])
  })

  it('overlays the host on legacy rows whose attend:{id} predates the rule', async () => {
    const { token, member } = await getTokenFor('legacy-host@example.com')
    captureEmails()
    const created = await (await createScreening(token)).json()
    // Simulate a pre-change mirror: confirmed names only, no host. Both the
    // per-event key and the aggregate, the way the old writeAttendees left them.
    await env.ATTENDANCE_KV.put(`attend:${created.id}`, JSON.stringify(['Old Guest']))
    const all = JSON.parse(await env.ATTENDANCE_KV.get('attendance:all'))
    all[created.id] = ['Old Guest']
    await env.ATTENDANCE_KV.put('attendance:all', JSON.stringify(all))

    const att = await (await req(`/events/${created.id}/attendance`)).json()
    expect(att.attendees).toEqual([member.name, 'Old Guest'])
    const { attendance } = await (await req('/events/attendance')).json()
    expect(attendance[created.id]).toEqual([member.name, 'Old Guest'])
  })

  it('never double-lists the host, and leaves non-hosted club events alone', async () => {
    const { token, member } = await getTokenFor('dedupe-host@example.com')
    captureEmails()
    const created = await (await createScreening(token)).json()
    await req(`/events/${created.id}/rsvp/guest`, { method: 'POST', token, body: { name: 'Plus One' } })

    const att = await (await req(`/events/${created.id}/attendance`)).json()
    expect(att.attendees).toEqual([member.name, 'Plus One'])

    // Admin-curated event (no hostId) keeps its exact stored list.
    await env.ATTENDANCE_KV.put('attend:club-night', JSON.stringify(['Someone']))
    const club = await (await req('/events/club-night/attendance')).json()
    expect(club.attendees).toEqual(['Someone'])
  })

  it('rejects a host RSVPing to their own screening — no self-eaten capacity slot', async () => {
    const { token } = await getTokenFor('no-self-rsvp@example.com')
    captureEmails()
    const created = await (await createScreening(token, { capacity: 1 })).json()

    const sent = captureEmails()
    const res = await req(`/events/${created.id}/rsvp`, { method: 'POST', token })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/hosting/i)
    expect(sent).toHaveLength(0)

    // The capacity-1 slot is still free for an actual guest.
    const { token: guestTok } = await getTokenFor('real-guest@example.com')
    captureEmails()
    const r2 = await req(`/events/${created.id}/rsvp`, { method: 'POST', token: guestTok })
    expect((await r2.json()).status).toBe('confirmed')
  })
})
