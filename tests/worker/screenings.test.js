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
