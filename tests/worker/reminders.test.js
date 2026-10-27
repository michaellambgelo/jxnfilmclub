import { SELF, env, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../worker/src/index.js'

// 48-hour event reminders (sendEventReminders in worker/src/index.js). The
// contract: every confirmed RSVP with an email gets one reminder, 48 hours
// before the start in Central time (09:00 two days before when there is no
// showtime); never the waitlist; never twice for the same date.

const HOUR = 3600_000
const ADMIN_TOKEN = 'test-admin-token'
const REMINDER_CRON = '7 * * * *'

function captureResend() {
  const sent = []
  globalThis.fetch = vi.fn(async (url, init) => {
    if (String(url) === 'https://api.resend.com/emails') sent.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ id: 'ok' }), { status: 200 })
  })
  return sent
}

afterEach(() => { vi.restoreAllMocks() })

const alice = { memberId: 'm-alice', name: 'Alice', email: 'alice@example.com', at: Date.UTC(2099, 0, 1) }
const bob = { memberId: 'm-bob', name: 'Bob', email: 'bob@example.com', at: Date.UTC(2099, 0, 1) }
const guest = { memberId: 'guest:abcd1234', name: 'Gus', email: 'gus@example.com', at: Date.UTC(2099, 0, 1), addedBy: 'h1' }

// 19:30 CDT on 2099-07-15 is 00:30 UTC on the 16th; the reminder is due 48h earlier.
const JULY = { id: 'ev-july', title: 'House Night', date: '2099-07-15', time: '19:30', kind: 'house', capacity: 4,
  address: '9 Private Rd, Jackson', notes: 'Buzzer 5', hostId: 'h1', hostName: 'Hana', rsvp: true }
const JULY_DUE = Date.UTC(2099, 6, 14, 0, 30)

async function seed(events, rsvps) {
  await env.ATTENDANCE_KV.put('events:bootstrapped', '1')
  await env.ATTENDANCE_KV.put('events:all', JSON.stringify(events.map(({ address, notes, ...pub }) => pub)))
  for (const e of events) await env.ATTENDANCE_KV.put(`event:${e.id}`, JSON.stringify(e))
  for (const [id, r] of Object.entries(rsvps)) await env.ATTENDANCE_KV.put(`rsvp:${id}`, JSON.stringify(r))
}

async function tick(now) {
  const ctx = createExecutionContext()
  await worker.scheduled(createScheduledController({ cron: REMINDER_CRON, scheduledTime: now }), env, ctx)
  await waitOnExecutionContext(ctx)
}

describe('hourly reminder sweep', () => {
  it('reminds every confirmed RSVP, and only them, once the 48h mark passes', async () => {
    await seed([JULY], { 'ev-july': { confirmed: [alice, guest], waitlist: [bob] } })
    const sent = captureResend()

    await tick(JULY_DUE - HOUR)
    expect(sent).toHaveLength(0)

    await tick(JULY_DUE + 7 * 60_000)
    expect(sent.map(m => m.to[0]).sort()).toEqual(['alice@example.com', 'gus@example.com'])
    const mail = sent.find(m => m.to[0] === 'alice@example.com')
    expect(mail.subject).toBe('Reminder: House Night on 2099-07-15 at 7:30 pm')
    // A confirmed seat gets the address, as in the confirmation.
    expect(mail.text).toContain('9 Private Rd, Jackson')
    expect(mail.text).toContain('Buzzer 5')
    expect(mail.text).toContain('https://join.jxnfilm.club/rsvp/cancel?token=')
    expect(mail.html).toContain('Reminder')
    expect(mail.html).toContain('See you at House Night')
    expect(mail.html).toContain('9 Private Rd, Jackson')
  })

  it('frames the guest copy as a removal, naming who added them', async () => {
    await seed([JULY], { 'ev-july': { confirmed: [guest], waitlist: [] } })
    const sent = captureResend()
    await tick(JULY_DUE)
    expect(sent).toHaveLength(1)
    expect(sent[0].html).toContain('Remove me from the list')
    expect(sent[0].html).toContain('Hana added this address to the guest list')
  })

  it('never sends twice for the same date, but does again after a reschedule', async () => {
    await seed([JULY], { 'ev-july': { confirmed: [alice], waitlist: [] } })
    const sent = captureResend()
    await tick(JULY_DUE)
    await tick(JULY_DUE + HOUR)
    expect(sent).toHaveLength(1)

    const moved = { ...JULY, date: '2099-07-22' }
    await seed([moved], {})
    await tick(JULY_DUE + 7 * 24 * HOUR)
    expect(sent).toHaveLength(2)
    expect(sent[1].subject).toContain('2099-07-22')
  })

  it('retries a failed send on the next tick without re-sending the rest', async () => {
    await seed([JULY], { 'ev-july': { confirmed: [alice, bob], waitlist: [] } })
    const sent = []
    globalThis.fetch = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.to[0] === 'bob@example.com' && !sent.some(m => m.failed)) {
        sent.push({ failed: true })
        return new Response('boom', { status: 500 })
      }
      sent.push(body)
      return new Response('{}', { status: 200 })
    })
    await tick(JULY_DUE)
    await tick(JULY_DUE + HOUR)
    const delivered = sent.filter(m => !m.failed).map(m => m.to[0])
    expect(delivered).toEqual(['alice@example.com', 'bob@example.com'])
  })

  it('skips an RSVP placed after the reminder was due — its confirmation was the reminder', async () => {
    const late = { ...bob, at: JULY_DUE + 10 * 60_000 }
    await seed([JULY], { 'ev-july': { confirmed: [alice, late], waitlist: [] } })
    const sent = captureResend()
    await tick(JULY_DUE + HOUR)
    expect(sent.map(m => m.to[0])).toEqual(['alice@example.com'])
  })

  it('closes the window a day after it opens, and skips a past event', async () => {
    await seed([JULY], { 'ev-july': { confirmed: [alice], waitlist: [] } })
    const sent = captureResend()
    await tick(JULY_DUE + 24 * HOUR)
    await tick(JULY_DUE + 72 * HOUR)
    expect(sent).toHaveLength(0)
  })

  it('counts back in standard time in winter', async () => {
    // 19:30 CST on 2099-01-15 is 01:30 UTC on the 16th.
    const jan = { ...JULY, id: 'ev-jan', date: '2099-01-15' }
    await seed([jan], { 'ev-jan': { confirmed: [alice], waitlist: [] } })
    const sent = captureResend()
    await tick(Date.UTC(2099, 0, 14, 1, 29))
    expect(sent).toHaveLength(0)
    await tick(Date.UTC(2099, 0, 14, 1, 30))
    expect(sent).toHaveLength(1)
  })

  it('sends at 09:00 Central two days before an event with no showtime', async () => {
    const meetup = { id: 'ev-meet', title: 'Meetup', date: '2099-07-15', kind: 'meetup', venue: 'The Capri Theatre', rsvp: true }
    await seed([meetup], { 'ev-meet': { confirmed: [alice], waitlist: [] } })
    const sent = captureResend()
    // 09:00 CDT on the 13th is 14:00 UTC.
    await tick(Date.UTC(2099, 6, 13, 13, 59))
    expect(sent).toHaveLength(0)
    await tick(Date.UTC(2099, 6, 13, 14, 7))
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toBe('Reminder: Meetup on 2099-07-15')
    expect(sent[0].text).toContain('Venue: The Capri Theatre')
    expect(sent[0].text).toContain('self-organized')
  })

  it('leaves events that take no RSVPs, and cancelled (deleted) ones, alone', async () => {
    const curated = { ...JULY, id: 'ev-curated', rsvp: false }
    await seed([JULY, curated], { 'ev-curated': { confirmed: [alice], waitlist: [] } })
    await env.ATTENDANCE_KV.delete('event:ev-july')
    await env.ATTENDANCE_KV.put('rsvp:ev-july', JSON.stringify({ confirmed: [bob], waitlist: [] }))
    const sent = captureResend()
    await tick(JULY_DUE)
    expect(sent).toHaveLength(0)
  })

  it('stays out of the daily tick', async () => {
    await seed([JULY], { 'ev-july': { confirmed: [alice], waitlist: [] } })
    const sent = captureResend()
    const ctx = createExecutionContext()
    await worker.scheduled(createScheduledController({ cron: '17 8 * * *', scheduledTime: JULY_DUE }), env, ctx)
    await waitOnExecutionContext(ctx)
    expect(sent.filter(m => m.subject?.startsWith('Reminder:'))).toHaveLength(0)
  })
})

describe('POST /admin/reminders', () => {
  const run = (body, token = ADMIN_TOKEN) => SELF.fetch('https://join.jxnfilm.club/admin/reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

  it('401s without the admin token', async () => {
    expect((await run({}, null)).status).toBe(401)
  })

  it('runs the sweep now; a dry run reports without sending or marking', async () => {
    // Due an hour ago, by the real clock.
    const soon = new Date(Date.now() + 47 * HOUR)
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(soon)
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(soon)
    await seed([{ ...JULY, date, time }], { 'ev-july': { confirmed: [{ ...alice, at: Date.now() - 24 * HOUR }], waitlist: [] } })
    const sent = captureResend()

    const dry = await (await run({ dryRun: true })).json()
    expect(dry.events).toEqual([{ id: 'ev-july', title: 'House Night', recipients: 1 }])
    expect(dry.sent).toBe(0)
    expect(sent).toHaveLength(0)

    expect((await (await run({})).json()).sent).toBe(1)
    expect((await (await run({})).json()).sent).toBe(0)
    expect(sent).toHaveLength(1)
  })
})

describe('POST /admin/reminders/schedule', () => {
  const schedule = (token = ADMIN_TOKEN) => SELF.fetch('https://join.jxnfilm.club/admin/reminders/schedule', {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  it('401s without the admin token', async () => {
    expect((await schedule(null)).status).toBe(401)
  })

  it('lists upcoming reminders with due time, status, and who each is for — names, never emails', async () => {
    const past = Date.now() - 24 * HOUR
    const lateAt = Date.now() + 365 * 24 * HOUR
    const curated = { ...JULY, id: 'ev-curated', rsvp: false }
    const meetup = { id: 'ev-meet', title: 'Meetup', date: '2099-07-15', kind: 'meetup', venue: 'The Capri Theatre', rsvp: true }
    await seed([JULY, curated, meetup], {
      'ev-july': { confirmed: [{ ...alice, at: past }, { ...guest, at: past }, { memberId: 'guest:noemail1', name: 'Nora', at: past }], waitlist: [bob] },
    })
    // Sent already to Alice, and a member who RSVP'd after the due time.
    await env.ATTENDANCE_KV.put('reminded:ev-july:2099-07-15', JSON.stringify(['m-alice']))
    await env.ATTENDANCE_KV.put('rsvp:ev-meet', JSON.stringify({ confirmed: [{ ...bob, at: lateAt }], waitlist: [] }))

    const body = await (await schedule()).json()
    expect(body.events.map(e => e.id)).toEqual(['ev-meet', 'ev-july']) // by due time; no RSVP-less event
    const [meet, july] = body.events
    expect(meet.dueAt).toBe('2099-07-13T14:00:00.000Z')
    expect(meet.status).toBe('scheduled')
    expect(july.dueAt).toBe(new Date(JULY_DUE).toISOString())
    expect(july.status).toBe('scheduled')
    expect(july.recipients).toEqual([
      { name: 'Alice', guest: false, state: 'sent' },
      { name: 'Gus', guest: true, state: 'pending' },
      { name: 'Nora', guest: true, state: 'no-email' },
    ])
    expect(JSON.stringify(body)).not.toContain('@example.com')
    expect(JSON.stringify(body)).not.toContain('9 Private Rd')
  })

  it('agrees with the sweep: what the schedule calls pending is what gets sent', async () => {
    const soon = new Date(Date.now() + 47 * HOUR)
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(soon)
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).format(soon)
    await seed([{ ...JULY, date, time }], { 'ev-july': { confirmed: [{ ...alice, at: Date.now() - 24 * HOUR }], waitlist: [] } })
    const sent = captureResend()

    let [ev] = (await (await schedule()).json()).events
    expect(ev.status).toBe('sending')
    await SELF.fetch('https://join.jxnfilm.club/admin/reminders', { method: 'POST', headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })
    expect(sent).toHaveLength(1)
    ;[ev] = (await (await schedule()).json()).events
    expect(ev.status).toBe('sent')
    expect(ev.recipients[0].state).toBe('sent')
  })
})
