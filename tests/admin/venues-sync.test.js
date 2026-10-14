import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildVenueList, parseCoords, unmatchedVenueNames, venueKey } from '../../admin/lib.js'
import { DEFAULT_VENUES, validVenueList, venueKey as workerVenueKey } from '../../worker/src/venues.js'

// The admin Config tab mirrors two things from worker/src/venues.js: the
// venueKey() matcher (for the unmatched-names hint) and DEFAULT_VENUES (the
// editor's reset target). Drift in either makes the tab disagree with /map.

describe('admin ↔ worker venue mirrors', () => {
  it('venueKey agrees on every spelling the club history uses', () => {
    const events = JSON.parse(readFileSync('data/events.json', 'utf8'))
    const samples = [...events.map(e => e.venue), 'The Capri Theater', 'B&B Theaters', '  The  Odd—Name  ']
    for (const s of samples) expect(venueKey(s)).toBe(workerVenueKey(s))
  })

  it('DEFAULT_VENUES in admin/admin.js matches the worker literal', () => {
    // admin.js is a browser module (DOM at import time), so read the literal
    // out of the source rather than importing it.
    const src = readFileSync('admin/admin.js', 'utf8')
    const m = src.match(/const DEFAULT_VENUES = (\[[\s\S]*?\n\])/)
    expect(m).not.toBeNull()
    const adminDefaults = Function(`return ${m[1]}`)()
    expect(adminDefaults).toEqual(DEFAULT_VENUES)
  })
})

describe('parseCoords', () => {
  it('reads the pair a map app copies', () => {
    expect(parseCoords('32.33554, -90.17678')).toEqual({ lat: 32.33554, lng: -90.17678 })
    expect(parseCoords(' 32.3 -90.1 ')).toEqual({ lat: 32.3, lng: -90.1 })
  })

  it.each(['', '32.3', 'north, west', '95, 10', '32.3, -190'])('rejects %j', (s) => {
    expect(parseCoords(s)).toBeNull()
  })
})

describe('buildVenueList', () => {
  it('produces exactly what the worker accepts', () => {
    const { venues, errors } = buildVenueList([
      { name: ' Duling Hall ', address: '622 Duling Ave', coords: '32.3362, -90.17523', aliases: 'Duling; The Duling Hall ;' },
      { name: '', address: '', coords: '', aliases: '' },
    ])
    expect(errors).toEqual([])
    expect(venues).toEqual([{ name: 'Duling Hall', address: '622 Duling Ave', lat: 32.3362, lng: -90.17523, aliases: ['Duling', 'The Duling Hall'] }])
    expect(validVenueList(venues)).toEqual(venues)
  })

  it('reports a missing name and bad coordinates per row', () => {
    const { errors } = buildVenueList([{ name: '', address: 'x', coords: 'nope', aliases: '' }])
    expect(errors.join(' ')).toMatch(/name is required/)
    expect(errors.join(' ')).toMatch(/coordinates/)
  })

  it('refuses to save an empty list', () => {
    expect(buildVenueList([]).errors).toHaveLength(1)
  })

  it('round-trips the defaults', () => {
    const rows = DEFAULT_VENUES.map(v => ({ name: v.name, address: v.address, coords: `${v.lat}, ${v.lng}`, aliases: v.aliases.join('; ') }))
    expect(buildVenueList(rows)).toEqual({ venues: DEFAULT_VENUES, errors: [] })
  })
})

describe('unmatchedVenueNames', () => {
  it('lists public venues the map misses, most used first, never a house', () => {
    const out = unmatchedVenueNames([
      { venue: 'Capri Theatre' },
      { venue: 'Pop-up Lot' },
      { venue: 'Pop-up Lot' },
      { venue: 'Old Bar' },
      { venue: "Somebody's house", kind: 'house', hostId: 'm1' },
      { venue: 'Legacy house', hostId: 'm2' },
      { venue: "Michael Lamb's house" },
      { venue: "Jack Mazza's apartment" },
    ], DEFAULT_VENUES)
    expect(out).toEqual([{ name: 'Pop-up Lot', count: 2 }, { name: 'Old Bar', count: 1 }])
  })

  it('finds nothing missing in the real history with the defaults', () => {
    const events = JSON.parse(readFileSync('data/events.json', 'utf8'))
    expect(unmatchedVenueNames(events, DEFAULT_VENUES)).toEqual([])
  })
})
