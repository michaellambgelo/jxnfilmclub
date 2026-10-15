#!/usr/bin/env node
// Writes tiles/style.json, the MapLibre style behind /map (docs/features/map.md).
//
// Starts from the Protomaps dark flavor and repaints it in the Night Shift
// palette (css/tokens.css): warm ink instead of neutral grey, and no red
// anywhere in the basemap, so the venue pins are the only red on the page.
//
// The style carries no sprite. The layers that need one (POI icons, highway
// shields, one-way arrows) are dropped, and the town-dot icon is stripped from
// the place labels. That leaves nothing to fetch beyond the tiles and glyphs,
// and no shop or restaurant icons competing with the venues.
//
// Source and glyph URLs are left as placeholders: the map view fills in the
// page origin at load time, so the same file works on localhost and in prod.
//
// Re-run after changing the palette or bumping @protomaps/basemaps:
//   node scripts/build_map_style.mjs

import { writeFileSync } from 'node:fs'
import { layers, namedFlavor } from '@protomaps/basemaps'

const dark = namedFlavor('dark')

// Night Shift tokens, named for what they paint here.
const INK_BG = '#100f0e'      // --bg
const SURFACE = '#16140f'     // --surface
const SURFACE_2 = '#1d1a15'   // --surface-2
const LINE = '#26221b'        // --line
const LINE_2 = '#3a352d'      // --line-2
const INK_6 = '#55524a'       // --ink-6
const INK_5 = '#6e6a60'       // --ink-5
const INK_4 = '#8f897d'       // --ink-4

const flavor = {
  ...dark,
  background: INK_BG,
  earth: SURFACE,
  // Water and green are the only cool notes, kept dark enough to read as
  // ground rather than decoration.
  water: '#141b1f',
  park_a: '#18201a',
  park_b: '#18201a',
  wood_a: '#171c17',
  wood_b: '#171c17',
  scrub_a: '#191b16',
  scrub_b: '#191b16',
  hospital: SURFACE_2,
  industrial: SURFACE_2,
  school: SURFACE_2,
  zoo: SURFACE_2,
  military: SURFACE_2,
  aerodrome: SURFACE_2,
  pedestrian: SURFACE_2,
  beach: SURFACE_2,
  sand: SURFACE_2,
  runway: LINE,
  pier: LINE,
  buildings: '#1a1813',
  railway: LINE_2,
  boundaries: INK_6,

  minor_service_casing: SURFACE, minor_casing: SURFACE, link_casing: SURFACE,
  major_casing_early: SURFACE, major_casing_late: SURFACE,
  highway_casing_early: SURFACE, highway_casing_late: SURFACE,
  other: LINE, minor_service: LINE, minor_a: '#2c2820', minor_b: LINE,
  link: '#2c2820', major: '#332e26', highway: LINE_2,

  tunnel_other_casing: INK_BG, tunnel_minor_casing: INK_BG, tunnel_link_casing: INK_BG,
  tunnel_major_casing: INK_BG, tunnel_highway_casing: INK_BG,
  tunnel_other: LINE, tunnel_minor: LINE, tunnel_link: LINE, tunnel_major: LINE, tunnel_highway: LINE,

  bridges_other_casing: SURFACE, bridges_minor_casing: SURFACE, bridges_link_casing: SURFACE,
  bridges_major_casing: SURFACE, bridges_highway_casing: SURFACE,
  bridges_other: LINE, bridges_minor: LINE, bridges_link: '#2c2820', bridges_major: '#332e26', bridges_highway: LINE_2,

  roads_label_minor: INK_6, roads_label_minor_halo: INK_BG,
  roads_label_major: INK_5, roads_label_major_halo: INK_BG,
  subplace_label: INK_5, subplace_label_halo: INK_BG,
  city_label: INK_4, city_label_halo: INK_BG,
  state_label: INK_6, state_label_halo: INK_BG,
  country_label: INK_6,
  address_label: INK_6, address_label_halo: INK_BG,
  ocean_label: INK_5,

  landcover: {
    grassland: '#181d17', barren: SURFACE_2, urban_area: SURFACE,
    farmland: '#191c16', glacier: SURFACE_2, scrub: '#191b16', forest: '#161c17',
  },
}

const DROP = new Set(['pois', 'roads_shields', 'roads_oneway'])

const styled = layers('protomaps', flavor, { lang: 'en' })
  .filter(l => !DROP.has(l.id))
  .map(l => {
    if (!l.layout || !('icon-image' in l.layout)) return l
    const { 'icon-image': _drop, 'icon-size': _size, ...layout } = l.layout
    return { ...l, layout }
  })

const leftover = styled.filter(l => l.layout && 'icon-image' in l.layout)
if (leftover.length) {
  console.error('layers still reference a sprite:', leftover.map(l => l.id).join(', '))
  process.exit(1)
}

const style = {
  version: 8,
  name: 'JXN Film Club — Night Shift',
  glyphs: '{origin}/tiles/fonts/{fontstack}/{range}.pbf',
  sources: {
    protomaps: {
      type: 'vector',
      url: 'pmtiles://{origin}/tiles/jxn.pmtiles',
      attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> · <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>',
    },
  },
  layers: styled,
}

writeFileSync('tiles/style.json', JSON.stringify(style) + '\n')
console.log(`tiles/style.json: ${styled.length} layers`)
