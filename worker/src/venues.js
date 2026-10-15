// Map venues: the public places on /map (docs/features/map.md).
//
// Deliberately SEPARATE from config:theaters. That list is what a member may
// pick when hosting a meetup; this one is where the club has gathered, so it
// also carries museums, a music hall and a brewery that nobody should be
// hosting a member meetup at. A venue on this list gets a pin. Nothing else
// ever does: an event whose venue text matches no entry is left off the map,
// which is what keeps every house screening off it by construction.
//
// Pure module, no imports from index.js (same rule as giveaways.js), so the
// matcher is unit-testable on its own. venueKey() is MIRRORED in admin/lib.js
// for the Config tab's unmatched-names list; keep the two in lockstep
// (tests/admin/venues-sync.test.js).

// The fallback when config:venues is missing or invalid. MIRRORED as
// DEFAULT_VENUES in admin/admin.js (the Config tab's reset target); the same
// sync test guards it.
//
// Coordinates are from OpenStreetMap. Two are approximate and worth checking
// in the admin portal: B&B Northpark (the mall, not the theater entrance) and
// Malco Renaissance (the cinema building inside the Renaissance complex).
export const DEFAULT_VENUES = [
  { name: 'The Capri Theatre', address: '3023 N State St, Jackson, MS 39216', lat: 32.33554, lng: -90.17678, aliases: [] },
  { name: 'Duling Hall', address: '622 Duling Ave, Jackson, MS 39216', lat: 32.33620, lng: -90.17523, aliases: [] },
  { name: 'Fertile Ground Beer Co.', address: '800 Manship St, Jackson, MS 39202', lat: 32.31417, lng: -90.17575, aliases: [] },
  { name: 'Urban Foxes', address: '826 North St, Jackson, MS 39202', lat: 32.30873, lng: -90.17681, aliases: [] },
  { name: 'Patton House & Gallery', address: '512 N State St, Jackson, MS 39201', lat: 32.30367, lng: -90.17947, aliases: [] },
  { name: 'Two Mississippi Museums', address: '222 North St, Jackson, MS 39201', lat: 32.30058, lng: -90.17948, aliases: [] },
  { name: 'Mississippi Museum of Art', address: '380 S Lamar St, Jackson, MS 39201', lat: 32.29631, lng: -90.18562, aliases: [] },
  { name: 'Malco Grandview & IMAX', address: '221 Grandview Blvd, Madison, MS 39110', lat: 32.46329, lng: -90.13812, aliases: ['Malco Grandview & IMAX in Madison'] },
  { name: 'Malco Renaissance Cinema Grill', address: '1000 Highland Colony Pkwy, Ridgeland, MS 39157', lat: 32.43659, lng: -90.14663, aliases: ['Malco Renaissance', 'Malco Renaissance in Ridgeland'] },
  { name: 'B&B Theatres Northpark 14', address: '250 Ring Rd, Ridgeland, MS 39157', lat: 32.40278, lng: -90.12921, aliases: ['B&B Theaters at Northpark in Ridgeland'] },
  { name: 'Legacy Theaters Parkway', address: '1075 Parkway Blvd, Flowood, MS 39232', lat: 32.33733, lng: -90.09068, aliases: ['Legacy Parkway Theaters'] },
  { name: 'Cinemark Pearl and XD', address: '411 Riverwind Dr, Pearl, MS 39208', lat: 32.26810, lng: -90.14061, aliases: ['Cinemark Pearl', 'Cinemark XD in Pearl'] },
]

const MAX_VENUES = 100
const MAX_FIELD = 200
const MAX_ALIASES = 20

// Normalized form for matching free-text venue names. Folds the spellings the
// club's own history actually uses: case, punctuation, a leading article,
// & vs and, theatre vs theater. So The Capri Theater, Capri Theatre and
// Capri Theater are one key, but word order still matters, which is what
// aliases are for.
export function venueKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/theatre/g, 'theater')
    .replace(/^[^a-z0-9]*the\s+/, '')
    .replace(/[^a-z0-9]+/g, '')
}

export function venueSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

// Shape-validate a config:venues value. A valid list comes back trimmed and
// normalized; ANY bad entry makes the whole value invalid (null), and the
// caller falls back to DEFAULT_VENUES, the same rule config:theaters follows.
// The admin editor validates before saving, so this is the backstop.
export function validVenueList(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_VENUES) return null
  const out = []
  for (const v of value) {
    if (!v || typeof v !== 'object') return null
    const name = typeof v.name === 'string' ? v.name.trim() : ''
    if (!name || name.length > MAX_FIELD) return null
    const lat = v.lat, lng = v.lng
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) return null
    if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) return null
    if (v.address !== undefined && typeof v.address !== 'string') return null
    const address = (v.address || '').trim()
    if (address.length > MAX_FIELD) return null
    if (v.aliases !== undefined && !Array.isArray(v.aliases)) return null
    const aliases = (v.aliases || []).map(a => typeof a === 'string' ? a.trim() : null)
    if (aliases.some(a => a === null || a.length > MAX_FIELD) || aliases.length > MAX_ALIASES) return null
    out.push({ name, address, lat, lng, aliases: aliases.filter(Boolean) })
  }
  return out
}

// A house screening never gets a pin, even if somebody aliased its venue.
// Same reading as isMembersOnly() in index.js; repeated here so this module
// stays import-free. The caller also passes only the anonymous event list.
function privateEvent(e) {
  return e.kind === 'house' || (!e.kind && !!e.hostId)
}

// Group public events under the venue they happened at. Returns only venues
// with at least one event, each with its events oldest first; the view
// splits upcoming from past against its own clock.
export function buildVenueMap(events, venues) {
  const byKey = new Map()
  const pins = venues.map(v => ({
    id: venueSlug(v.name),
    name: v.name,
    address: v.address || '',
    lat: v.lat,
    lng: v.lng,
    events: [],
  }))
  venues.forEach((v, i) => {
    for (const label of [v.name, ...(v.aliases || [])]) {
      const k = venueKey(label)
      // First venue to claim a key keeps it: list order is the tiebreak.
      if (k && !byKey.has(k)) byKey.set(k, pins[i])
    }
  })
  for (const e of events || []) {
    if (!e || !e.venue || privateEvent(e)) continue
    const pin = byKey.get(venueKey(e.venue))
    if (!pin) continue
    const row = { id: e.id }
    for (const f of ['title', 'film', 'year', 'date', 'time', 'poster']) {
      if (e[f] !== undefined && e[f] !== null && e[f] !== '') row[f] = e[f]
    }
    pin.events.push(row)
  }
  return pins
    .filter(p => p.events.length)
    .map(p => ({ ...p, events: p.events.sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))) }))
}
