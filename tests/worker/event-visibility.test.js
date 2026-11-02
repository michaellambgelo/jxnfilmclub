import { describe, expect, it } from 'vitest'
import { isMembersOnly } from '../../worker/src/event-visibility.js'

// isMembersOnly() — the single rule for which events the open internet may
// see, shared by the join API (GET /events, the anonymous join pages) and
// the site's link previews (site-meta.js). Contract: kind === 'house' is
// members-only; 'meetup' and club screenings (no host) are public; a legacy
// row with no kind but a hostId is a house screening; a missing event is
// never members-only (callers 404 it separately).

describe('isMembersOnly', () => {
  it('house screenings are members-only, with or without a host', () => {
    expect(isMembersOnly({ id: 'e1', kind: 'house', hostId: 'm1' })).toBe(true)
    expect(isMembersOnly({ id: 'e1', kind: 'house' })).toBe(true)
  })

  it('theater meetups stay public even when hosted by a member', () => {
    expect(isMembersOnly({ id: 'e2', kind: 'meetup', hostId: 'm1' })).toBe(false)
    expect(isMembersOnly({ id: 'e2', kind: 'meetup' })).toBe(false)
  })

  it("the club's own screenings (no host, no kind) are public", () => {
    expect(isMembersOnly({ id: 'e3', title: 'Club night' })).toBe(false)
  })

  it('legacy hosted rows without a kind read as house screenings', () => {
    expect(isMembersOnly({ id: 'e4', hostId: 'm1' })).toBe(true)
  })

  it('an empty hostId does not make a legacy row private', () => {
    expect(isMembersOnly({ id: 'e5', hostId: '' })).toBe(false)
    expect(isMembersOnly({ id: 'e5', hostId: null })).toBe(false)
  })

  it('an explicit non-house kind wins over a hostId', () => {
    expect(isMembersOnly({ id: 'e6', kind: 'screening', hostId: 'm1' })).toBe(false)
  })

  it('missing events are not members-only', () => {
    expect(isMembersOnly(undefined)).toBe(false)
    expect(isMembersOnly(null)).toBe(false)
  })

  it('always returns a boolean', () => {
    for (const e of [null, {}, { hostId: 'm1' }, { kind: 'house' }, { kind: 'meetup' }]) {
      expect(typeof isMembersOnly(e)).toBe('boolean')
    }
  })
})
