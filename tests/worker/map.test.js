import { SELF, env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildVenueMap, DEFAULT_VENUES, validVenueList, venueKey } from '../../worker/src/venues.js'

// GET /map — venue pins for the public /map page (docs/features/map.md).
// Contract: only events whose venue matches a configured venue get a pin;
// house screenings never do, whatever their venue text and whoever asks.

async function seedEvents(events) {
  await env.ATTENDANCE_KV.put('events:all', JSON.stringify(events))
  await env.ATTENDANCE_KV.put('events:bootstrapped', '1')
}

function getMap(headers) {
  return SELF.fetch('https://join.jxnfilm.club/map', headers ? { headers } : undefined)
}

const CAPRI = { name: 'The Capri Theatre', address: '3023 N State St, Jackson, MS 39216', lat: 32.33554, lng: -90.17678, aliases: [] }

describe('venueKey', () => {
  it('folds the spellings the club history actually uses', () => {
    const k = venueKey('The Capri Theater')
    expect(venueKey('Capri Theatre')).toBe(k)
    expect(venueKey('capri theater')).toBe(k)
    expect(venueKey('B&B Theaters')).toBe(venueKey('B and B Theatres'))
  })

  it('keeps word order, which is what aliases are for', () => {
    expect(venueKey('Legacy Theaters Parkway')).not.toBe(venueKey('Legacy Parkway Theaters'))
  })

  it('only strips a leading article', () => {
    expect(venueKey('Bathe Theater')).toBe('bathetheater')
  })
})

describe('validVenueList', () => {
  it('accepts the defaults unchanged', () => {
    expect(validVenueList(DEFAULT_VENUES)).toEqual(DEFAULT_VENUES)
  })

  it('trims, and defaults address/aliases', () => {
    expect(validVenueList([{ name: '  Duling Hall ', lat: 32.3, lng: -90.1 }]))
      .toEqual([{ name: 'Duling Hall', address: '', lat: 32.3, lng: -90.1, aliases: [] }])
  })

  it.each([
    ['not an array', { name: 'x' }],
    ['empty', []],
    ['missing name', [{ lat: 1, lng: 1 }]],
    ['string coordinates', [{ name: 'x', lat: '32.3', lng: '-90.1' }]],
    ['latitude out of range', [{ name: 'x', lat: 91, lng: 1 }]],
    ['aliases not an array', [{ name: 'x', lat: 1, lng: 1, aliases: 'y' }]],
    ['one bad entry voids the list', [CAPRI, { name: '', lat: 1, lng: 1 }]],
  ])('rejects %s', (_label, value) => {
    expect(validVenueList(value)).toBeNull()
  })
})

describe('buildVenueMap', () => {
  it('drops a house screening even when its venue text matches', () => {
    const pins = buildVenueMap([
      { id: 'a', venue: 'Capri Theater', date: '2026-01-01' },
      { id: 'b', venue: 'Capri Theater', date: '2026-02-01', kind: 'house', hostId: 'm1' },
      { id: 'c', venue: 'Capri Theater', date: '2026-03-01', hostId: 'm1' },
    ], [CAPRI])
    expect(pins).toHaveLength(1)
    expect(pins[0].events.map(e => e.id)).toEqual(['a'])
  })

  it('keeps a theater meetup, which is public', () => {
    const pins = buildVenueMap([{ id: 'm', venue: 'The Capri Theater', kind: 'meetup', hostId: 'm1', date: '2026-05-01' }], [CAPRI])
    expect(pins[0].events.map(e => e.id)).toEqual(['m'])
  })

  it('omits venues with no events and events with no venue match', () => {
    const pins = buildVenueMap([{ id: 'x', venue: 'Somewhere Else' }], DEFAULT_VENUES)
    expect(pins).toEqual([])
  })

  it('sorts events oldest first and copies only display fields', () => {
    const pins = buildVenueMap([
      { id: 'late', venue: 'Capri Theatre', date: '2026-09-01', film: 'B', hostName: 'Someone', capacity: 10 },
      { id: 'early', venue: 'Capri Theatre', date: '2025-01-01', film: 'A' },
    ], [CAPRI])
    expect(pins[0].events).toEqual([
      { id: 'early', date: '2025-01-01', film: 'A' },
      { id: 'late', date: '2026-09-01', film: 'B' },
    ])
    expect(pins[0]).toMatchObject({ id: 'the-capri-theatre', name: CAPRI.name, address: CAPRI.address, lat: CAPRI.lat, lng: CAPRI.lng })
  })

  it('matches aliases, and the first venue to claim a name keeps it', () => {
    const a = { name: 'A', lat: 1, lng: 1, aliases: ['Shared'] }
    const b = { name: 'B', lat: 2, lng: 2, aliases: ['Shared'] }
    const pins = buildVenueMap([{ id: 'e', venue: 'shared', date: '2026-01-01' }], [a, b])
    expect(pins.map(p => p.name)).toEqual(['A'])
  })
})

describe('GET /map', () => {
  it('pins public events at default venues, with CORS like the other public GETs', async () => {
    await seedEvents([
      { id: '2025-01-01-a', venue: 'Capri Theatre', date: '2025-01-01', film: 'A' },
      { id: '2025-02-01-b', venue: 'Malco Grandview & IMAX in Madison', date: '2025-02-01', film: 'B' },
      { id: '2025-03-01-c', venue: "Someone's house", date: '2025-03-01', film: 'C' },
    ])
    const res = await getMap()
    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://jxnfilm.club')
    const { venues } = await res.json()
    expect(venues.map(v => v.name).sort()).toEqual(['Malco Grandview & IMAX', 'The Capri Theatre'])
  })

  it('never shows a house screening, even to a signed-in caller', async () => {
    await seedEvents([
      { id: '2026-11-01-h', venue: 'The Capri Theatre', date: '2026-11-01', kind: 'house', hostId: 'm1', address: '1 Secret Ln' },
    ])
    const res = await getMap({ Authorization: 'Bearer anything' })
    const body = await res.text()
    expect(JSON.parse(body).venues).toEqual([])
    expect(body).not.toContain('Secret')
  })

  it('config:venues overrides the defaults', async () => {
    await seedEvents([{ id: 'e', venue: 'Pop-up Lot', date: '2026-01-01' }])
    await env.MEMBERS_KV.put('config:venues', JSON.stringify([{ name: 'Pop-up Lot', address: '1 Lot St', lat: 32.3, lng: -90.2 }]))
    const { venues } = await (await getMap()).json()
    expect(venues).toHaveLength(1)
    expect(venues[0]).toMatchObject({ name: 'Pop-up Lot', address: '1 Lot St' })
  })

  it('an invalid config:venues falls back to the defaults, no 500', async () => {
    await seedEvents([{ id: 'e', venue: 'Duling Hall', date: '2026-01-01' }])
    await env.MEMBERS_KV.put('config:venues', 'not json {')
    const res = await getMap()
    expect(res.status).toBe(200)
    expect((await res.json()).venues.map(v => v.name)).toEqual(['Duling Hall'])
  })
})
