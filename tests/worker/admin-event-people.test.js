import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The two admin actions on an event's RSVP list that are not an event edit:
// moving one waitlisted person to confirmed, and sending everyone a note.
// Both are ADMIN_TOKEN routes under /admin/events/:id.

const ADMIN_TOKEN = 'test-admin-token'

function req(path, { method = 'POST', body, token = ADMIN_TOKEN } = {}) {
  const headers = { Origin: 'https://jxnfilm.club' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  return SELF.fetch(`https://join.jxnfilm.club${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

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

const person = (n, extra = {}) => ({ memberId: `m${n}`, name: `Member ${n}`, email: `m${n}@example.com`, at: n, ...extra })

async function seed(id, event = {}, rsvp = { confirmed: [], waitlist: [] }) {
  const row = { id, title: 'Night at the Capri', date: '2099-09-01', time: '19:00', venue: 'Capri Theater', rsvp: true, ...event }
  await env.ATTENDANCE_KV.put(`event:${id}`, JSON.stringify(row))
  await env.ATTENDANCE_KV.put(`rsvp:${id}`, JSON.stringify(rsvp))
  return row
}
const readRsvp = async (id) => JSON.parse(await env.ATTENDANCE_KV.get(`rsvp:${id}`))

afterEach(() => { vi.restoreAllMocks() })

describe('POST /admin/events/:id/promote', () => {
  it('401s without the admin token, and 404s an unknown event or person', async () => {
    await seed('p-auth', {}, { confirmed: [], waitlist: [person(1)] })
    expect((await req('/admin/events/p-auth/promote', { token: null, body: { memberId: 'm1' } })).status).toBe(401)
    expect((await req('/admin/events/p-auth/promote', { token: 'nope', body: { memberId: 'm1' } })).status).toBe(401)
    expect((await req('/admin/events/p-missing/promote', { body: { memberId: 'm1' } })).status).toBe(404)
    expect((await req('/admin/events/p-auth/promote', { body: { memberId: 'm9' } })).status).toBe(404)
    expect((await readRsvp('p-auth')).waitlist).toHaveLength(1)
  })

  it('moves one person to confirmed, out of order, and sends the normal confirmation', async () => {
    await seed('p-ok', { capacity: 5 }, { confirmed: [person(1)], waitlist: [person(2), person(3)] })
    const sent = captureEmails()
    const res = await req('/admin/events/p-ok/promote', { body: { memberId: 'm3' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'confirmed', emailed: true })

    const rsvp = await readRsvp('p-ok')
    expect(rsvp.confirmed.map(r => r.memberId)).toEqual(['m1', 'm3'])
    expect(rsvp.waitlist.map(r => r.memberId)).toEqual(['m2'])
    expect(typeof rsvp.confirmed[1].promotedAt).toBe('number')
    // The attendance mirror follows, as for any other RSVP write.
    expect(JSON.parse(await env.ATTENDANCE_KV.get('attend:p-ok')).map(a => a.id)).toContain('m3')

    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('m3@example.com')
    expect(sent[0].text).toContain("You're confirmed for Night at the Capri")
  })

  it('refuses a full event unless forced', async () => {
    await seed('p-full', { capacity: 1 }, { confirmed: [person(1)], waitlist: [person(2)] })
    const sent = captureEmails()
    const refused = await req('/admin/events/p-full/promote', { body: { memberId: 'm2' } })
    expect(refused.status).toBe(409)
    expect((await refused.json()).full).toBe(true)
    expect((await readRsvp('p-full')).confirmed).toHaveLength(1)
    expect(sent).toHaveLength(0)

    const forced = await req('/admin/events/p-full/promote', { body: { memberId: 'm2', force: true } })
    expect(forced.status).toBe(200)
    expect((await readRsvp('p-full')).confirmed.map(r => r.memberId)).toEqual(['m1', 'm2'])
  })

  // The waitlist of a pre-sale event is the queue the on-sale mail goes to.
  it('refuses to pull someone out of a pre-sale queue', async () => {
    await seed('p-presale', { ticketed: true }, { confirmed: [], waitlist: [person(1)] })
    const sent = captureEmails()
    const res = await req('/admin/events/p-presale/promote', { body: { memberId: 'm1', force: true } })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/not on sale/)
    expect((await readRsvp('p-presale')).waitlist).toHaveLength(1)
    expect(sent).toHaveLength(0)
  })

  it('refuses a past event and one that takes no RSVPs', async () => {
    await seed('p-past', { date: '2001-01-01' }, { confirmed: [], waitlist: [person(1)] })
    expect((await req('/admin/events/p-past/promote', { body: { memberId: 'm1' } })).status).toBe(409)
    await seed('p-norsvp', { rsvp: false }, { confirmed: [], waitlist: [person(1)] })
    expect((await req('/admin/events/p-norsvp/promote', { body: { memberId: 'm1' } })).status).toBe(409)
  })

  it('promotes a name-only guest without trying to mail them', async () => {
    await seed('p-guest', {}, { confirmed: [], waitlist: [{ memberId: 'guest:abc', name: 'Plus One', at: 1 }] })
    const sent = captureEmails()
    const res = await req('/admin/events/p-guest/promote', { body: { memberId: 'guest:abc' } })
    expect(await res.json()).toEqual({ ok: true, status: 'confirmed', emailed: false })
    expect(sent).toHaveLength(0)
  })
})

describe('POST /admin/events/:id/message', () => {
  it('401s without the admin token and validates the note', async () => {
    await seed('m-auth', {}, { confirmed: [person(1)], waitlist: [] })
    captureEmails()
    expect((await req('/admin/events/m-auth/message', { token: null, body: { message: 'hi' } })).status).toBe(401)
    expect((await req('/admin/events/m-missing/message', { body: { message: 'hi' } })).status).toBe(404)
    expect((await req('/admin/events/m-auth/message', { body: { message: '   ' } })).status).toBe(400)
    expect((await req('/admin/events/m-auth/message', { body: { message: 'x'.repeat(2001) } })).status).toBe(400)
    expect((await req('/admin/events/m-auth/message', { body: { message: 'hi', subject: 's'.repeat(121) } })).status).toBe(400)
  })

  it('sends to confirmed only by default: address and a cancel link, and stores nothing', async () => {
    await seed('m-conf', { kind: 'house', address: '1 Main St', capacity: 4, notes: 'door code 1234' },
      { confirmed: [person(1), person(2)], waitlist: [person(3)] })
    const before = (await env.ATTENDANCE_KV.list()).keys.map(k => k.name).sort()
    const sent = captureEmails()
    const res = await req('/admin/events/m-conf/message', { body: { message: 'Doors at 6:30.\nPark out back.' } })
    expect(await res.json()).toEqual({ ok: true, sent: 2, failed: 0 })

    expect(sent.map(m => m.to)).toEqual(['m1@example.com', 'm2@example.com'])
    const mail = sent[0]
    expect(mail.subject).toBe('A note about Night at the Capri')
    expect(mail.text).toContain('Doors at 6:30.\nPark out back.')
    expect(mail.text).toContain('1 Main St')
    expect(mail.text).toContain('/rsvp/cancel?token=')
    expect(mail.html).toContain('Doors at 6:30.')
    // Private notes are for the confirmation mail; a note is its own message.
    expect(mail.text).not.toContain('door code 1234')
    // Nothing about the note is kept in the event store.
    expect((await env.ATTENDANCE_KV.list()).keys.map(k => k.name).sort()).toEqual(before)
  })

  it('includes the waitlist when asked, without the address or a cancel link', async () => {
    await seed('m-wait', { kind: 'house', address: '1 Main St', capacity: 1 },
      { confirmed: [person(1)], waitlist: [person(2)] })
    const sent = captureEmails()
    const res = await req('/admin/events/m-wait/message', { body: { message: 'Moved to the porch.', subject: 'Change of plan', waitlist: true } })
    expect((await res.json()).sent).toBe(2)
    const waiting = sent.find(m => m.to === 'm2@example.com')
    expect(waiting.subject).toBe('Change of plan')
    expect(waiting.text).toContain('Moved to the porch.')
    expect(waiting.text).not.toContain('1 Main St')
    expect(waiting.html).not.toContain('1 Main St')
    expect(waiting.text).not.toContain('/rsvp/cancel')
    expect(waiting.text).toContain('not confirmed')
  })

  it('reaches a pre-sale queue only when the waitlist is included', async () => {
    await seed('m-presale', { ticketed: true }, { confirmed: [], waitlist: [person(1), person(2)] })
    const sent = captureEmails()
    const none = await req('/admin/events/m-presale/message', { body: { message: 'Soon.' } })
    expect(none.status).toBe(400)
    expect(sent).toHaveLength(0)
    const res = await req('/admin/events/m-presale/message', { body: { message: 'Soon.', waitlist: true } })
    expect((await res.json()).sent).toBe(2)
  })

  it('sends one copy per address, skips people with none, and flattens a multi-line subject', async () => {
    await seed('m-dedupe', {}, {
      confirmed: [person(1), { memberId: 'guest:x', name: 'No Email', at: 2 }],
      waitlist: [person(9, { email: 'M1@example.com' })],
    })
    const sent = captureEmails()
    const res = await req('/admin/events/m-dedupe/message', { body: { message: 'Hi', subject: 'Line one\r\nBcc: x@example.com', waitlist: true } })
    expect((await res.json()).sent).toBe(1)
    expect(sent[0].subject).toBe('Line one Bcc: x@example.com')
  })

  it('will not send the same event a second note within a minute', async () => {
    await seed('m-twice', {}, { confirmed: [person(1)], waitlist: [] })
    const sent = captureEmails()
    expect((await req('/admin/events/m-twice/message', { body: { message: 'One' } })).status).toBe(200)
    const again = await req('/admin/events/m-twice/message', { body: { message: 'One' } })
    expect(again.status).toBe(429)
    expect(sent).toHaveLength(1)
    // A rejected note does not arm the guard for someone else's event.
    await seed('m-other', {}, { confirmed: [person(1)], waitlist: [] })
    expect((await req('/admin/events/m-other/message', { body: { message: 'Two' } })).status).toBe(200)
  })

  it('says Free on a free public event, like every other event mail', async () => {
    await seed('m-free', { admission: 'free' }, { confirmed: [person(1)], waitlist: [] })
    const sent = captureEmails()
    await req('/admin/events/m-free/message', { body: { message: 'Hi' } })
    expect(sent[0].html).toMatch(/Admission<\/td>\s*<td[^>]*>Free</)
  })
})
