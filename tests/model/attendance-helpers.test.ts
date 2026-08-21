import { describe, expect, it } from 'vitest'
import {
  normalizeAttendees, namesById, resolveAttendees, attendeeKey, attendanceTally,
} from '../../model/index.ts'

// Attendance is keyed on member id; the stored name is only a fallback. These
// pin the semantics the SPA shares with resolveAttendees() in
// worker/src/index.js and attendanceWithHosts() in admin/lib.js — a rename has
// to land the same way in all three or the site contradicts itself.

const MEMBERS = [
  { id: 'm1', name: 'Current Name' },
  { id: 'm2', name: 'Bob Buff' },
]

describe('normalizeAttendees', () => {
  it('accepts the current entry shape unchanged', () => {
    expect(normalizeAttendees([{ id: 'm1', name: 'A' }]))
      .toEqual([{ id: 'm1', name: 'A' }])
  })

  it('lifts legacy name-only rows into id-less entries', () => {
    expect(normalizeAttendees(['A', 'B']))
      .toEqual([{ id: null, name: 'A' }, { id: null, name: 'B' }])
  })

  it('tolerates a mixed array, junk entries, and a non-array', () => {
    expect(normalizeAttendees(['A', { id: 'm1', name: 'B' }, null, '', { }, 7]))
      .toEqual([{ id: null, name: 'A' }, { id: 'm1', name: 'B' }])
    expect(normalizeAttendees(undefined)).toEqual([])
    expect(normalizeAttendees({} as any)).toEqual([])
  })
})

describe('resolveAttendees', () => {
  const names = namesById(MEMBERS)

  it('renames an entry off its member id', () => {
    expect(resolveAttendees([{ id: 'm1', name: 'Old Name' }], names))
      .toEqual([{ id: 'm1', name: 'Current Name' }])
  })

  it('keeps the stored name when the id resolves to nothing', () => {
    // Guests, deleted members, and the "former member" label all land here.
    expect(resolveAttendees([
      { id: 'guest:abc12345', name: 'Plus One' },
      { id: null, name: 'former member' },
    ], names)).toEqual([
      { id: 'guest:abc12345', name: 'Plus One' },
      { id: null, name: 'former member' },
    ])
  })

  it('drops an id-less legacy row the resolved list already covers', () => {
    // A half-backfilled event: the same person twice, once with an id.
    expect(resolveAttendees([
      { id: null, name: 'Current Name' },
      { id: 'm1', name: 'Current Name' },
    ], names)).toEqual([{ id: 'm1', name: 'Current Name' }])
  })

  it('keeps two different members who share a display name', () => {
    expect(resolveAttendees([
      { id: 'm1', name: 'Twin' },
      { id: 'm9', name: 'Twin' },
    ], {})).toEqual([{ id: 'm1', name: 'Twin' }, { id: 'm9', name: 'Twin' }])
  })

  it('drops a repeated id', () => {
    expect(resolveAttendees([
      { id: 'm1', name: 'Current Name' },
      { id: 'm1', name: 'Current Name' },
    ], names)).toEqual([{ id: 'm1', name: 'Current Name' }])
  })
})

describe('attendeeKey', () => {
  it('prefers the id, falls back to the name', () => {
    expect(attendeeKey({ id: 'm1', name: 'X' })).toBe('id:m1')
    expect(attendeeKey({ id: null, name: 'X' })).toBe('name:X')
  })
})

describe('attendanceTally', () => {
  it('counts a renamed member once, under their current name', () => {
    const tally = attendanceTally({
      e1: [{ id: 'm1', name: 'Old Name' }],
      e2: [{ id: 'm1', name: 'Current Name' }],
      e3: ['Current Name'],   // legacy row, same person, no id
    }, MEMBERS)
    expect(tally.get('id:m1')).toEqual({ id: 'm1', name: 'Current Name', count: 3 })
    expect(tally.size).toBe(1)
  })

  it('counts guests and unmatched names on their own', () => {
    const tally = attendanceTally({
      e1: [{ id: 'guest:abc12345', name: 'Plus One' }, 'Walk In'],
      e2: ['Walk In'],
    }, MEMBERS)
    expect(tally.get('id:guest:abc12345')?.count).toBe(1)
    expect(tally.get('name:Walk In')?.count).toBe(2)
  })

  it('is empty for empty or missing input', () => {
    expect(attendanceTally({}, MEMBERS).size).toBe(0)
    expect(attendanceTally(null, MEMBERS).size).toBe(0)
  })
})
