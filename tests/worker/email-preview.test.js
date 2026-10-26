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
      'rsvp', 'guest', 'tickets-pending', 'tickets-on-sale', 'update', 'waitlist-update', 'cancelled', 'signup', 'login',
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
