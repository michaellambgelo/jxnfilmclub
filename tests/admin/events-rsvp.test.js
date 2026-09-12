import { describe, expect, it } from 'vitest'
import { rsvpEnabled, sanitizeAdminEvent } from '../../admin/lib.js'

// rsvpEnabled is the switch that replaced `hostId` for deciding whether an
// event collects RSVPs or takes the post-hoc "I was there" toggle. It is
// mirrored in worker/src/index.js and model/index.ts; this suite is the one
// place the semantics are pinned, so a drift in any copy has a reference.
describe('rsvpEnabled', () => {
  it('falls back to hostId when no rsvp field is present', () => {
    // Every member-hosted screening ever created: RSVPs.
    expect(rsvpEnabled({ hostId: 'm1' })).toBe(true)
    // Every one of the curated rows in data/events.json: attendance.
    expect(rsvpEnabled({ id: '2021-01-13-whiplash' })).toBe(false)
  })

  it('lets an explicit boolean win over the hostId fallback', () => {
    expect(rsvpEnabled({ rsvp: true })).toBe(true)
    expect(rsvpEnabled({ rsvp: false, hostId: 'm1' })).toBe(false)
  })

  it('short-circuits to false when a ticket link is present', () => {
    // The theater sells the seats; taking an RSVP as well would imply we hold
    // one we do not hold.
    expect(rsvpEnabled({ rsvp: true, ticketUrl: 'https://tix.example.com/a' })).toBe(false)
    expect(rsvpEnabled({ hostId: 'm1', ticketUrl: 'https://tix.example.com/a' })).toBe(false)
  })

  it('never throws on a missing or empty row', () => {
    expect(rsvpEnabled(null)).toBe(false)
    expect(rsvpEnabled(undefined)).toBe(false)
    expect(rsvpEnabled({})).toBe(false)
  })
})

// sanitizeAdminEvent coerces the one thing the Worker cannot see — a form
// checkbox. Every other rule (https ticket links, the kind allowlist, the
// ticket/RSVP exclusivity) is enforced Worker-side by validAdminEvent, and
// is covered in tests/worker/admin-events.test.js. Duplicating it here was
// how `kind: ""` and `ticketUrl: ""` got silently dropped before reaching
// the endpoint, so a clear never took effect.
describe('sanitizeAdminEvent', () => {
  it('coerces the checkbox string "on" into a real boolean', () => {
    // A checkbox's .value is "on" whether or not it is ticked, so a row that
    // stored the string would read truthy forever but never equal true.
    expect(sanitizeAdminEvent({ id: 'e', rsvp: 'on' }).rsvp).toBe(true)
    expect(sanitizeAdminEvent({ id: 'e', rsvp: true }).rsvp).toBe(true)
    expect(sanitizeAdminEvent({ id: 'e', rsvp: false }).rsvp).toBe(false)
  })

  it('drops rsvp entirely when it is absent or blank, so absence keeps meaning legacy', () => {
    expect('rsvp' in sanitizeAdminEvent({ id: 'e' })).toBe(false)
    expect('rsvp' in sanitizeAdminEvent({ id: 'e', rsvp: '' })).toBe(false)
    expect('rsvp' in sanitizeAdminEvent({ id: 'e', rsvp: null })).toBe(false)
  })

  // A PUT merges over the stored row, so '' is the dashboard saying "clear
  // this". Dropping it client-side would turn a clear into a no-op.
  it('passes empty strings through so a cleared field can actually clear', () => {
    const out = sanitizeAdminEvent({ id: 'e', capacity: '', kind: '', ticketUrl: '', notes: '' })
    expect(out.capacity).toBe('')
    expect(out.kind).toBe('')
    expect(out.ticketUrl).toBe('')
    expect(out.notes).toBe('')
  })

  it('leaves every other field untouched', () => {
    const row = { id: 'e', title: 'T', film: 'F', year: 1999, date: '2099-01-01', venue: 'V' }
    expect(sanitizeAdminEvent(row)).toMatchObject(row)
  })
})
