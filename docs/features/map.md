# Venue Map

A public page at `/map` that pins every theater and public venue the club has screened at, with each venue's upcoming and past screenings. It's in the main nav between Events and Speak.

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
| `tiles/jxn/{z}/{x}/{y}.pbf` | Jackson-metro extract (Ridgeland/Madison to Pearl/Flowood) of the Protomaps OpenStreetMap basemap, zoom 0–15: 3,146 uncompressed vector tiles, ~11 MB in all, of which a visitor loads only what is on screen | `scripts/fetch_map_assets.sh` (`pmtiles extract`, then `scripts/split_map_tiles.mjs`) |
| `tiles/fonts/<stack>/<range>.pbf` | Noto Sans label glyphs, Latin ranges only | same |
| `tiles/style.json` | MapLibre style: the Protomaps dark flavor repainted in Night Shift, with no sprite (POI icons, shields and one-way arrows dropped) and no red, so the pins are the only red on the page | `node scripts/build_map_style.mjs` |
| `vendor/maplibre/` | MapLibre GL JS 6.11.2 (ESM: `maplibre-gl.mjs` + `-shared` + `-worker`, plus its CSS) | `scripts/fetch_map_assets.sh` |

The style keeps `{origin}` placeholders in its glyph and tile URLs; the view substitutes `location.origin`, so one file serves localhost and production. Credit ("© OpenStreetMap contributors · Protomaps") is in the map's attribution control, which ODbL requires.

The tile source carries the extract's `bounds` and `maxzoom: 15`, so MapLibre never requests a tile that was not written and overzooms z15 beyond it. Plain files work under `nue serve` too, so the basemap draws locally and in e2e.

### Build gotchas

- **GitHub Pages cannot serve a PMTiles archive.** The first release shipped `tiles/jxn.pmtiles` read through the pmtiles protocol, which fetches byte ranges. In production the basemap stayed blank: Pages' CDN keeps a gzipped copy of the file and applies `Range` to the *compressed* bytes (`Content-Range: …/8075143` for an 8,134,743-byte file; `bytes=0-99` returned 90 inflated bytes), and on a cache miss it ignores `Range` and sends the whole file with a 200. `Accept-Encoding: identity` does not help. Only a full-file GET is reliable there, hence one file per tile. A HEAD with `-r` is no test either: it answered 200 while a GET answered 206. Check with a ranged **GET** and compare the bytes.
- **The site build minifies every `.js` file and renames its globals** (Bun). An IIFE build's global comes out renamed (pmtiles' `pmtiles` became `H1` in the first cut). `.mjs` files pass through byte-for-byte, which is why MapLibre is vendored as ES modules loaded with `import()`.
- **Nue's CSS minifier rewrites `data:` URLs** (`data:` becomes `data;`), which would break MapLibre's control icons. `postbuild` copies `vendor/maplibre/maplibre-gl.css` over the minified one.
- **`maxBounds` must be looser than the extract.** The extract box is shorter than the view needed to fit every pin with padding; a `maxBounds` that tight forces the map to zoom in and clips Madison and Pearl. Panning stops a little past the extract instead, where the map shows plain ground.
- MapLibre's stylesheet is lazy-loaded and **awaited** before the map is created; a map built before it lands sizes its canvas wrong.

## The view (`ui/map.html`)

Rendered **imperatively**: the template is a static skeleton and `mounted()` never calls `update()`, because MapLibre owns its container and nuedom replaces a component root on update. MapLibre (~1 MB) loads only when someone opens `/map`. One live map per page: remounting removes the previous map first, since browsers cap live WebGL contexts.

- The venue list renders **before** the map, so it works without WebGL; if the map cannot be created (no WebGL, MapLibre or the style fails to load) the box hides and a line says so. Failed *tiles* do not trigger that: MapLibre reports them per tile and keeps the pins on a blank basemap.
- Venues with something coming up sort first (soonest first) and get a filled red pin and red card border; the rest sort by how often the club has been there and get an outlined pin. Upcoming pins are added last so they draw on top where pins overlap.
- **Venues close together share one group pin.** Pins closer than 34px on screen (`JM_GROUP_PX`, a pin is 30px) are grouped by `jmGroupVenues` and replaced with one stacked pin (`.jm-pin-group`, a second ring offset behind the dot) showing the combined screening count, filled red if any venue in it has something coming up. Its popup lists each venue (name, next screening or count, Details, Directions; the address is left out to keep it short) and a **Zoom in to separate** button that fits the group's bounds. Groups are recomputed on every `zoomend`, so they split as you zoom in: the Capri and Duling Hall, about 160 m apart, share a pin at zoom 14 and below, which includes the default view. Downtown Jackson's venues group the same way. Clicking a venue card's map link flies there and opens whichever pin owns the venue at the zoom it lands on.
- An opening popup pans the map just far enough to fit inside it (`jmKeepInView`); MapLibre anchors popups to their pin but does not keep their far edge in view, and the group popup is tall enough to run off a short map.
- A pin's popup links **Details** to its venue card: the page scrolls the card to the middle of the screen and pulses a red outline around it for two seconds (`jmFlash`, `.jm-flash` in `css/map.css`). It's an outline, not the border, so nothing shifts; with reduced motion the scroll is instant and the outline holds without pulsing.
- `cooperativeGestures` is on: two fingers to pan on a phone and Ctrl+scroll to zoom on desktop, so the page still scrolls past the map.
- Each event links to `/events?query=<film>`.

## Admin: Config → Map venues

One row per venue: name, street address, coordinates as `lat, lng` (the form a map app copies), a **check** link that opens the coordinates on OpenStreetMap, and aliases separated by semicolons. Save validates every row with `buildVenueList()` (the same rules as the Worker's `validVenueList()`, so a save can never silently void the list); reset deletes the key. Below the list, **Not on the map** lists public event venue names that match nothing, with counts.

`venueKey()` and `DEFAULT_VENUES` are mirrored in `admin/lib.js` and `admin/admin.js`; `tests/admin/venues-sync.test.js` fails on drift.

Two default coordinates are approximate and worth a **check**: B&B Theatres Northpark 14 (the mall, not the theater entrance) and Malco Renaissance (the cinema inside the Renaissance complex).

## Tests

- `tests/worker/map.test.js`: matcher, validation, house exclusion (including for a signed-in caller), `config:venues` override and fallback.
- `tests/admin/venues-sync.test.js`: admin/worker mirrors, coordinate parsing, the editor's list builder, the unmatched hint (and that the real history has no unmatched public venues).
- `tests/e2e/map.spec.ts`: nav link, Capri card, popup Details highlight (skipped without WebGL), no home screenings listed, config override.
