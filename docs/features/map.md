# Venue Map

A public page at `/map` that pins every theater and public venue the club has screened at, with each venue's upcoming and past screenings. It's in the main nav between Events and Watched.

## What gets a pin

A venue is pinned when it is on the **map venue list** and at least one public event happened there. Nothing else ever gets a pin:

- The list is `config:venues` (MEMBERS_KV), edited in the admin portal's Config tab, falling back to `DEFAULT_VENUES` in `worker/src/venues.js` when the key is missing or invalid (any bad entry voids the whole value, the same rule `config:theaters` follows).
- It is **separate from `config:theaters`**. That list is what a member may pick when hosting a meetup; this one is where the club has gathered, so it also carries the museums, Duling Hall, Fertile Ground and Urban Foxes. Adding a venue here does not offer it in the host form.
- Events are joined to venues by their free-text `venue`, normalized by `venueKey()`: case, punctuation, a leading "The", `&`/`and` and `theatre`/`theater` are ignored. So The Capri Theater, Capri Theatre and Capri Theater are one venue. Word order still matters ("Legacy Theaters Parkway" vs "Legacy Parkway Theaters"), which is what **aliases** are for. When two venues claim the same name, the first in list order keeps it.

### House screenings never appear

Three independent layers:

1. `GET /map` takes **no auth at all** and filters `isMembersOnly()` events before matching, so it is always the anonymous view.
2. `buildVenueMap()` drops `kind === 'house'` (and the legacy hosted-without-kind reading) again, so a house screening stays off the map even if someone aliases its venue name.
3. Only listed venues are pinned. The curated history's home screenings ("Michael Lamb's house" and so on) predate the `kind` field, but they match no venue, so they are simply absent.

The admin's "Not on the map" hint (`unmatchedVenueNames` in `admin/lib.js`) also skips names ending in house, apartment or home, so the tool never suggests aliasing a member's home onto a public map.

## `GET /map`

```json
{ "venues": [
  { "id": "the-capri-theatre", "name": "The Capri Theatre",
    "address": "3023 N State St, Jackson, MS 39216", "lat": 32.33554, "lng": -90.17678,
    "events": [ { "id": "…", "film": "Halloween", "year": 1978, "date": "2022-10-27", "time": "19:00", "poster": "…" } ] }
] }
```

Only venues with at least one event are returned; events are oldest first and carry display fields only (`id`, `title`, `film`, `year`, `date`, `time`, `poster`). The view splits upcoming from past against today in Central, compared as `YYYY-MM-DD` strings (never parsed as a `Date`).

## Self-hosted map

Every request the page makes goes to `jxnfilm.club` (or the join Worker for `/map`). No tile, font or CDN company sees a visitor, which is the same promise the self-hosted web fonts make. The only outside link is the user-clicked **Directions** link (Google Maps directions).

| Path | What | Made by |
|------|------|---------|
| `tiles/jxn.pmtiles` | ~8 MB Jackson-metro extract (Ridgeland/Madison to Pearl/Flowood) of the Protomaps OpenStreetMap basemap, zoom 0–15 | `scripts/fetch_map_assets.sh` |
| `tiles/fonts/<stack>/<range>.pbf` | Noto Sans label glyphs, Latin ranges only | same |
| `tiles/style.json` | MapLibre style: the Protomaps dark flavor repainted in Night Shift, with no sprite (POI icons, shields and one-way arrows dropped) and no red, so the pins are the only red on the page | `node scripts/build_map_style.mjs` |
| `vendor/maplibre/` | MapLibre GL JS 6.11.2 (ESM: `maplibre-gl.mjs` + `-shared` + `-worker`, plus its CSS) | `scripts/fetch_map_assets.sh` |
| `vendor/pmtiles/` | pmtiles 4.5.0 ESM reader + fflate 0.8.2, its one dependency, with the bare import rewritten to `./fflate.mjs` | same |

The style keeps `{origin}` placeholders in its glyph and source URLs; the view substitutes `location.origin`, so one file serves localhost and production. Credit ("© OpenStreetMap contributors · Protomaps") is in the map's attribution control, which ODbL requires.

The tiles are read with **HTTP Range requests**. GitHub Pages behind Cloudflare serves them (206 verified on 2026-10-14). `nue serve` and `nue preview` do **not**, so locally the basemap stays blank while pins and the venue list still work. To see tiles locally, serve `.dist/` with any Range-capable static server.

### Build gotchas

- **The site build minifies every `.js` file and renames its globals** (Bun). The first cut used pmtiles' IIFE build, whose `pmtiles` global came out as `H1`. `.mjs` files pass through byte-for-byte, which is why every vendored script is an ES module loaded with `import()`.
- **Nue's CSS minifier rewrites `data:` URLs** (`data:` becomes `data;`), which would break MapLibre's control icons. `postbuild` copies `vendor/maplibre/maplibre-gl.css` over the minified one.
- **`maxBounds` must be looser than the extract.** The extract box is shorter than the view needed to fit every pin with padding; a `maxBounds` that tight forces the map to zoom in and clips Madison and Pearl. Panning stops a little past the extract instead, where the map shows plain ground.
- MapLibre's stylesheet is lazy-loaded and **awaited** before the map is created; a map built before it lands sizes its canvas wrong.

## The view (`ui/map.html`)

Rendered **imperatively**: the template is a static skeleton and `mounted()` never calls `update()`, because MapLibre owns its container and nuedom replaces a component root on update. MapLibre (~1 MB) loads only when someone opens `/map`. One live map per page: remounting removes the previous map first, since browsers cap live WebGL contexts.

- The venue list renders **before** the map, so it works without WebGL; if the map cannot be drawn the box hides and a line says so.
- Venues with something coming up sort first (soonest first) and get a filled red pin and red card border; the rest sort by how often the club has been there and get an outlined pin. Upcoming pins are added last so they draw on top where pins overlap (the Capri and Duling Hall are a block apart).
- `cooperativeGestures` is on: two fingers to pan on a phone and Ctrl+scroll to zoom on desktop, so the page still scrolls past the map.
- Each event links to `/events?query=<film>`.

## Admin: Config → Map venues

One row per venue: name, street address, coordinates as `lat, lng` (the form a map app copies), a **check** link that opens the coordinates on OpenStreetMap, and aliases separated by semicolons. Save validates every row with `buildVenueList()` (the same rules as the Worker's `validVenueList()`, so a save can never silently void the list); reset deletes the key. Below the list, **Not on the map** lists public event venue names that match nothing, with counts.

`venueKey()` and `DEFAULT_VENUES` are mirrored in `admin/lib.js` and `admin/admin.js`; `tests/admin/venues-sync.test.js` fails on drift.

Two default coordinates are approximate and worth a **check**: B&B Theatres Northpark 14 (the mall, not the theater entrance) and Malco Renaissance (the cinema inside the Renaissance complex).

## Tests

- `tests/worker/map.test.js`: matcher, validation, house exclusion (including for a signed-in caller), `config:venues` override and fallback.
- `tests/admin/venues-sync.test.js`: admin/worker mirrors, coordinate parsing, the editor's list builder, the unmatched hint (and that the real history has no unmatched public venues).
- `tests/e2e/map.spec.ts`: nav link, Capri card, no home screenings listed, config override.
