import { describe, expect, it } from 'vitest'
import { eventIdFrom, newEventIssues, editEventIssues } from '../../admin/lib.js'

// Creating an event used to be a prompt() for a slug that immediately wrote an
// "Untitled" row dated today — live on the public site until somebody finished
// it. These back the form that replaced it: the id it derives, and the reasons
// it refuses to write.

describe('eventIdFrom', () => {
  it('matches the convention the existing rows already follow', () => {
    expect(eventIdFrom('2026-10-22', 'Clayface')).toBe('2026-10-22-clayface')
    expect(eventIdFrom('2023-08-25', 'Bar Snakes')).toBe('2023-08-25-bar-snakes')
    expect(eventIdFrom('2021-01-13', 'Whiplash')).toBe('2021-01-13-whiplash')
  })

  it('strips punctuation and collapses runs, like the Worker slugifier', () => {
    expect(eventIdFrom('2026-01-01', 'Hal & Mal-- s  Trivia!')).toBe('2026-01-01-hal-mal-s-trivia')
    expect(eventIdFrom('2026-01-01', "Don't Look Up")).toBe('2026-01-01-don-t-look-up')
  })

  it('caps the slug so an essay of a title cannot make an unusable id', () => {
    const id = eventIdFrom('2026-01-01', 'A'.repeat(20) + ' ' + 'B'.repeat(60))
    expect(id.length).toBeLessThanOrEqual('2026-01-01-'.length + 40)
    expect(id.endsWith('-')).toBe(false)
  })

  it('returns empty rather than a dangling stub when it has too little to work with', () => {
    // The form shows "ID is required" instead of offering "2026-10-22-".
    expect(eventIdFrom('2026-10-22', '')).toBe('')
    expect(eventIdFrom('', 'Clayface')).toBe('')
    expect(eventIdFrom('next tuesday', 'Clayface')).toBe('')
    expect(eventIdFrom('2026-10-22', '!!!')).toBe('')
  })
})

describe('newEventIssues', () => {
  const ok = {
    id: '2026-10-22-clayface', title: 'CLAYFACE Preview Screening', date: '2026-10-22',
    film: 'Clayface', year: '2026', venue: 'Capri Theater', kind: 'meetup',
    time: '20:30', capacity: '40', poster: 'https://img.test/a.jpg',
    letterboxd_uri: 'https://boxd.it/abc', ticketUrl: 'https://tix.test/a',
    admission: 'ticketed',
  }

  it('passes a fully filled event', () => {
    expect(newEventIssues(ok, ['2021-01-13-whiplash'])).toEqual([])
  })

  it('requires a title and a date — the two the Worker also demands', () => {
    expect(newEventIssues({ ...ok, title: '' })).toContain('Title is required.')
    expect(newEventIssues({ ...ok, date: '' })).toContain('Date is required (YYYY-MM-DD).')
    expect(newEventIssues({ ...ok, date: 'next tuesday' })).toContain('Date is required (YYYY-MM-DD).')
  })

  it('catches a duplicate id before anything is written', () => {
    const out = newEventIssues(ok, ['2026-10-22-clayface'])
    expect(out[0]).toMatch(/already exists/)
  })

  it('rejects an id that is not a usable slug', () => {
    for (const id of ['', 'Has Spaces', 'UPPER', '-leading', 'has/slash']) {
      expect(newEventIssues({ ...ok, id })).toContain('ID must be lowercase letters, numbers and hyphens.')
    }
  })

  it('rejects the shapes the Worker would 400 on, so the operator sees them first', () => {
    expect(newEventIssues({ ...ok, year: '26' })).toContain('Year must be four digits.')
    expect(newEventIssues({ ...ok, time: '7pm' })).toContain('Time must be HH:MM.')
    expect(newEventIssues({ ...ok, capacity: 'lots' })).toContain('Capacity must be a whole number, 1 or more.')
    expect(newEventIssues({ ...ok, kind: 'party' })).toContain('Unknown kind.')
    expect(newEventIssues({ ...ok, ticketUrl: 'http://tix.test' })).toContain('Ticket link must be an https link.')
    expect(newEventIssues({ ...ok, letterboxd_uri: 'https://example.com/x' }))
      .toContain('Letterboxd URI must be a letterboxd.com or boxd.it link.')
  })

  it('treats every optional field as optional', () => {
    expect(newEventIssues({ id: 'x-1', title: 'T', date: '2026-01-01', admission: 'free' })).toEqual([])
  })

  // How people get in is the one question a new event cannot skip: skipping
  // it is exactly how 39 of the first 48 rows ended up unlabelled.
  it('requires an admission on a new event', () => {
    const msg = 'Choose an admission: Free, Ticketed or Buy your own.'
    expect(newEventIssues({ ...ok, admission: '' })).toContain(msg)
    expect(newEventIssues({ ...ok, admission: 'donation' })).toContain(msg)
    for (const admission of ['free', 'ticketed', 'own']) {
      expect(newEventIssues({ ...ok, admission })).toEqual([])
    }
  })

  it('refuses a ticketed or buy-your-own house screening', () => {
    const msg = 'A house screening cannot be ticketed — choose Free.'
    expect(newEventIssues({ ...ok, kind: 'house', admission: 'ticketed' })).toContain(msg)
    expect(newEventIssues({ ...ok, kind: 'house', admission: 'own' })).toContain(msg)
    expect(newEventIssues({ ...ok, kind: 'house', admission: 'free' })).toEqual([])
  })

  it('reports every problem at once, not just the first', () => {
    const out = newEventIssues({ id: 'x-1', title: '', date: '', year: '26', admission: '' })
    expect(out).toHaveLength(4)
  })
})

describe('editEventIssues', () => {
  it('needs neither a free id nor an admission — a legacy row may stay unanswered', () => {
    expect(editEventIssues({ title: 'Whiplash', date: '2021-01-13', admission: '' })).toEqual([])
  })

  it('still holds the shapes the Worker would 400 on', () => {
    expect(editEventIssues({ title: '', date: '2021-01-13' })).toContain('Title is required.')
    expect(editEventIssues({ title: 'T', date: '2021-01-13', capacity: '0' }))
      .toContain('Capacity must be a whole number, 1 or more.')
    expect(editEventIssues({ title: 'T', date: '2021-01-13', kind: 'house', admission: 'own' }))
      .toContain('A house screening cannot be ticketed — choose Free.')
  })
})
