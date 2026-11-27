import { SELF, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ADMIN_TOKEN = 'test-admin-token'

function preview(body, token = ADMIN_TOKEN) {
  return SELF.fetch('https://join.jxnfilm.club/admin/email/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

function captureResend() {
  const sent = []
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url) === 'https://api.resend.com/emails') sent.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ id: 'ok' }), { status: 200 })
  })
  return sent
}

afterEach(() => { vi.restoreAllMocks() })

describe('POST /admin/email/preview', () => {
  it('401s without the admin token', async () => {
    expect((await preview({}, null)).status).toBe(401)
    expect((await preview({}, 'nope')).status).toBe(401)
  })

  it('renders every transactional email for the sample event without sending any', async () => {
    const sent = captureResend()
    const res = await preview({})
    expect(res.status).toBe(200)
    const { event, emails } = await res.json()
    expect(event.id).toBe('preview-sample')
    expect(emails.map(e => e.type)).toEqual([
      'rsvp', 'guest', 'tickets-pending', 'tickets-on-sale', 'update', 'waitlist-update', 'cancelled', 'reminder', 'attendee-message', 'signup', 'login',
    ])
    for (const e of emails) {
      expect(e.subject, e.type).toBeTruthy()
      expect(e.text, e.type).toBeTruthy()
      expect(e.html, e.type).toContain('https://jxnfilm.club/img/logo.png')
    }
    expect(sent).toHaveLength(0)
  })

  it('renders a real event, keeping the address rules of each mail', async () => {
    await env.ATTENDANCE_KV.put('event:pv1', JSON.stringify({
      id: 'pv1', title: 'House Night', date: '2099-03-01', kind: 'house', capacity: 4,
      address: '9 Private Rd', hostId: 'h1', hostName: 'Hana', rsvp: true,
    }))
    const { emails } = await (await preview({ eventId: 'pv1' })).json()
    const by = Object.fromEntries(emails.map(e => [e.type, e]))
    expect(by.rsvp.html).toContain('9 Private Rd')
    expect(by['waitlist-update'].html).not.toContain('9 Private Rd')
    expect(by.cancelled.html).not.toContain('9 Private Rd')
  })

  it('flags a calendar file on exactly the mails a confirmed RSVP gets', async () => {
    const { emails } = await (await preview({})).json()
    expect(emails.filter(e => e.calendar).map(e => e.type)).toEqual(['rsvp', 'guest', 'update', 'cancelled', 'reminder'])
    for (const e of emails.filter(e => e.calendar)) expect(e.text, e.type).toContain('calendar file')
    for (const e of emails.filter(e => !e.calendar)) expect(e.text, e.type).not.toContain('calendar file')
  })

  it('a test send carries the same calendar file the real mail would', async () => {
    const sent = captureResend()
    await preview({ type: 'rsvp', testTo: 'me@example.com' })
    expect(sent[0].attachments).toHaveLength(1)
    const [file] = sent[0].attachments
    expect(file.filename).toBe('event.ics')
    const ics = atob(file.content)
    expect(ics).toContain('UID:preview-sample@jxnfilm.club')
    // 19:30 in Jackson in January is 01:30 UTC the next day; three hours long.
    expect(ics).toContain('DTSTART:20990116T013000Z')
    expect(ics).toContain('DTEND:20990116T043000Z')

    await preview({ type: 'waitlist-update', testTo: 'me@example.com' })
    expect(sent[1].attachments).toBeUndefined()
  })

  // The decoded calendar file of a test send, unfolded.
  const icsOfSend = async (sent, body) => {
    await preview({ ...body, testTo: 'me@example.com' })
    const file = sent.at(-1).attachments?.[0]
    if (!file) return ''
    return new TextDecoder().decode(Uint8Array.from(atob(file.content), c => c.charCodeAt(0))).replace(/\r\n /g, '')
  }

  it('keeps the address rules of each mail in its calendar file, and never the notes', async () => {
    await env.ATTENDANCE_KV.put('event:pv2', JSON.stringify({
      id: 'pv2', title: 'House Night', date: '2099-03-01', time: '19:30', kind: 'house', capacity: 4,
      address: '9 Private Rd', notes: 'Buzzer 5', hostId: 'h1', hostName: 'Hana', rsvp: true,
    }))
    const sent = captureResend()
    for (const type of ['rsvp', 'guest', 'reminder', 'update']) {
      const ics = await icsOfSend(sent, { eventId: 'pv2', type })
      expect(ics, type).toContain('LOCATION:9 Private Rd')
      expect(ics, type).toContain('METHOD:PUBLISH')
      expect(ics, type).not.toContain('Buzzer 5')
    }
    const cancel = await icsOfSend(sent, { eventId: 'pv2', type: 'cancelled' })
    expect(cancel).toContain('STATUS:CANCELLED')
    expect(cancel).not.toContain('9 Private Rd')
    expect(cancel).not.toContain('Buzzer 5')
    for (const type of ['tickets-pending', 'tickets-on-sale', 'waitlist-update', 'attendee-message']) {
      expect(await icsOfSend(sent, { eventId: 'pv2', type }), type).toBe('')
    }
  })

  it('a rescheduled event keeps its UID, moves its start, and never lowers SEQUENCE', async () => {
    const row = { id: 'pv3', title: 'Night', date: '2099-03-01', time: '19:30', venue: 'Banner Hall', rsvp: true }
    await env.ATTENDANCE_KV.put('event:pv3', JSON.stringify(row))
    const sent = captureResend()
    const first = await icsOfSend(sent, { eventId: 'pv3', type: 'rsvp' })
    await env.ATTENDANCE_KV.put('event:pv3', JSON.stringify({ ...row, date: '2099-03-08' }))
    const second = await icsOfSend(sent, { eventId: 'pv3', type: 'update' })
    const cancel = await icsOfSend(sent, { eventId: 'pv3', type: 'cancelled' })

    const field = (ics, name) => ics.match(new RegExp(`^${name}:(.*)$`, 'm'))[1].trim()
    for (const ics of [first, second, cancel]) expect(field(ics, 'UID')).toBe('pv3@jxnfilm.club')
    expect(field(first, 'DTSTART')).toBe('20990302T013000Z')
    // The 8th is after the spring change: 19:30 CDT is 00:30 UTC.
    expect(field(second, 'DTSTART')).toBe('20990309T003000Z')
    expect(+field(second, 'SEQUENCE')).toBeGreaterThanOrEqual(+field(first, 'SEQUENCE'))
    expect(+field(cancel, 'SEQUENCE')).toBeGreaterThanOrEqual(+field(second, 'SEQUENCE'))
  })

  it('404s an unknown event', async () => {
    expect((await preview({ eventId: 'nope' })).status).toBe(404)
  })

  it('test-sends exactly one rendering to testTo, marked [Test]', async () => {
    const sent = captureResend()
    const res = await preview({ type: 'cancelled', testTo: 'me@example.com' })
    expect(res.status).toBe(200)
    expect((await res.json()).sent).toBe('cancelled')
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toEqual(['me@example.com'])
    expect(sent[0].subject).toMatch(/^\[Test\] Cancelled:/)
    expect(sent[0].html).toContain('is cancelled')
  })

  it('refuses a test send with a bad address or no type', async () => {
    const sent = captureResend()
    expect((await preview({ type: 'rsvp', testTo: 'not-an-email' })).status).toBe(400)
    expect((await preview({ testTo: 'me@example.com' })).status).toBe(400)
    expect(sent).toHaveLength(0)
  })
})
