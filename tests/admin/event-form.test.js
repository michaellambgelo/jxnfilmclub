import { describe, expect, it } from 'vitest'
import {
  applyEventDiff, duplicateSeed, eventFormValues, eventPutDiff, eventSearchText, groupEvents,
} from '../../admin/lib.js'

// The pure half of the Events tab: how the list is ordered, and what a save
// actually sends. The second is the one that matters — the Worker merges a PUT
// over the stored row, so anything the form sends that the operator did not
// change is a silent rewrite of an old event.

describe('groupEvents', () => {
  const today = '2026-11-12'
  const ev = (id, date, time) => ({ id, date, ...(time ? { time } : {}) })

  it('puts upcoming soonest-first and past newest-first', () => {
    const { upcoming, past } = groupEvents([
      ev('p-old', '2021-01-13'), ev('u-far', '2026-12-17'), ev('p-new', '2026-10-24'), ev('u-near', '2026-11-20'),
    ], today)
    expect(upcoming.map(e => e.id)).toEqual(['u-near', 'u-far'])
    expect(past.map(e => e.id)).toEqual(['p-new', 'p-old'])
  })

  it('counts today as upcoming, and orders a shared day by showtime', () => {
    const { upcoming } = groupEvents([
      ev('late', today, '21:00'), ev('early', today, '18:00'), ev('untimed', today),
    ], today)
    expect(upcoming.map(e => e.id)).toEqual(['untimed', 'early', 'late'])
  })

  it('drops an undated row into the past group, at the bottom', () => {
    const { upcoming, past } = groupEvents([ev('undated', ''), ev('p', '2020-01-01')], today)
    expect(upcoming).toEqual([])
    expect(past.map(e => e.id)).toEqual(['p', 'undated'])
  })

  it('survives an empty or missing list', () => {
    expect(groupEvents(null, today)).toEqual({ upcoming: [], past: [] })
  })
})

describe('eventSearchText', () => {
  it('covers title, film, venue, id, date, host and kind, lowercased', () => {
    const text = eventSearchText({
      id: '2026-10-22-clayface', title: 'CLAYFACE Preview', film: 'Clayface', venue: 'Capri Theater',
      date: '2026-10-22', hostName: 'Sam', kind: 'meetup', notes: 'door code 1234', address: '1 Main St',
    })
    for (const hit of ['clayface preview', 'capri', '2026-10-22', 'sam', 'meetup']) expect(text).toContain(hit)
    // Private fields are not searchable text: they would end up in a
    // data-attribute on every row.
    expect(text).not.toContain('1234')
    expect(text).not.toContain('main st')
  })
})

describe('eventFormValues', () => {
  it('shows the effective RSVP mode but only the STORED admission', () => {
    // A hosted row with no rsvp field takes RSVPs; a legacy ticketed row has
    // never been asked the admission question.
    const v = eventFormValues({ id: 'x', title: 'T', date: '2021-01-13', hostId: 'm1', ticketed: true, capacity: 8 })
    expect(v.rsvp).toBe(true)
    expect(v.admission).toBe('')
    expect(v.capacity).toBe('8')
    expect(v.film).toBe('')
  })
})

describe('eventPutDiff — edit', () => {
  const legacy = { id: '2021-01-13-whiplash', title: 'Whiplash', film: 'Whiplash', year: 2014, date: '2021-01-13', venue: 'Capri' }

  it('sends nothing when nothing was changed', () => {
    expect(eventPutDiff(legacy, eventFormValues(legacy))).toEqual({})
  })

  it('never stamps rsvp, ticketed or admission onto a row that had none', () => {
    const diff = eventPutDiff(legacy, { ...eventFormValues(legacy), title: 'Whiplash (35mm)' })
    expect(diff).toEqual({ title: 'Whiplash (35mm)' })
  })

  it('compares RSVP against what the row already meant, not against absence', () => {
    const hosted = { id: 'h', title: 'T', date: '2099-01-01', hostId: 'm1' }
    // Box still ticked on a hosted row: no change, so no rsvp:true stamp.
    expect(eventPutDiff(hosted, eventFormValues(hosted))).toEqual({})
    expect(eventPutDiff(hosted, { ...eventFormValues(hosted), rsvp: false })).toEqual({ rsvp: false })
    expect(eventPutDiff(legacy, { ...eventFormValues(legacy), rsvp: true })).toEqual({ rsvp: true })
  })

  it('sends an admission only when it differs from the stored one, and never ticketed', () => {
    const tix = { ...legacy, ticketed: true }
    expect(eventPutDiff(tix, eventFormValues(tix))).toEqual({})
    expect(eventPutDiff(tix, { ...eventFormValues(tix), admission: 'free' })).toEqual({ admission: 'free' })
    const free = { ...legacy, admission: 'free', ticketed: false }
    expect(eventPutDiff(free, eventFormValues(free))).toEqual({})
    expect(eventPutDiff(free, { ...eventFormValues(free), admission: 'own' })).toEqual({ admission: 'own' })
  })

  it('clears with an empty string, and types numbers', () => {
    const e = { ...legacy, capacity: 40, time: '20:30' }
    const diff = eventPutDiff(e, { ...eventFormValues(e), capacity: '', time: '', year: '2015' })
    expect(diff).toEqual({ capacity: '', time: '', year: 2015 })
  })

  it('leaves a field that was not on the form alone', () => {
    const e = { ...legacy, address: '1 Main St' }
    const values = eventFormValues(e)
    delete values.address
    expect(eventPutDiff(e, values)).toEqual({})
  })

  it('ignores surrounding whitespace rather than reporting it as a change', () => {
    expect(eventPutDiff(legacy, { ...eventFormValues(legacy), venue: '  Capri ' })).toEqual({})
  })
})

describe('eventPutDiff — create', () => {
  it('sends every field that has a value, plus rsvp and admission', () => {
    const diff = eventPutDiff(null, {
      ...eventFormValues({}), title: 'Night', date: '2099-01-01', year: '2026', capacity: '40',
      rsvp: true, admission: 'free',
    }, { create: true })
    expect(diff).toEqual({ title: 'Night', date: '2099-01-01', year: 2026, capacity: 40, rsvp: true, admission: 'free' })
  })

  it('always states rsvp on a new event, even when off', () => {
    const diff = eventPutDiff(null, { title: 'T', date: '2099-01-01', rsvp: false, admission: 'own' }, { create: true })
    expect(diff.rsvp).toBe(false)
  })
})

describe('applyEventDiff', () => {
  it('applies changes and removes cleared fields', () => {
    expect(applyEventDiff({ id: 'x', title: 'A', time: '20:00' }, { title: 'B', time: '' }))
      .toEqual({ id: 'x', title: 'B' })
  })
})

describe('duplicateSeed', () => {
  const source = {
    id: '2026-10-22-clayface', title: 'CLAYFACE Preview', film: 'Clayface', year: 2026, date: '2026-10-22',
    time: '20:30', venue: 'Capri Theater', kind: 'meetup', capacity: 40, poster: 'https://img.test/a.jpg',
    letterboxd_uri: 'https://boxd.it/abc', ticketed: true, ticketUrl: 'https://tix.test/a', rsvp: true,
    address: '1 Main St', notes: 'door code 1234', hostId: 'm1', hostName: 'Sam', scrubbedAt: '2026-11-01',
  }

  it('carries the editorial fields and what the source meant for RSVP and admission', () => {
    const seed = duplicateSeed(source)
    expect(seed).toMatchObject({
      title: 'CLAYFACE Preview', film: 'Clayface', year: '2026', time: '20:30', venue: 'Capri Theater',
      kind: 'meetup', capacity: '40', poster: 'https://img.test/a.jpg', letterboxd_uri: 'https://boxd.it/abc',
      rsvp: true, admission: 'ticketed',
    })
  })

  it('leaves the date blank and never copies private, host or ticket-link fields', () => {
    const seed = duplicateSeed(source)
    expect(seed.date).toBe('')
    expect(seed.address).toBe('')
    expect(seed.notes).toBe('')
    expect(seed.ticketUrl).toBe('')
    for (const k of ['id', 'hostId', 'hostName', 'scrubbedAt', 'ticketed']) expect(k in seed).toBe(false)
  })

  it('answers the admission question for a legacy meetup, and keeps a house copy free', () => {
    expect(duplicateSeed({ title: 'T', kind: 'meetup' }).admission).toBe('own')
    expect(duplicateSeed({ title: 'T', kind: 'house', hostId: 'm1' }).admission).toBe('free')
    // A legacy club screening was never asked, so the copy must be.
    expect(duplicateSeed({ title: 'T' }).admission).toBe('')
  })
})
