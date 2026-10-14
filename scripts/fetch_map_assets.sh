#!/usr/bin/env bash
# Rebuild the self-hosted map assets behind /map (docs/features/map.md).
#
# Everything the map loads is served from jxnfilm.club itself, so a visitor's
# browser never talks to a tile, font or CDN company — the same promise as the
# self-hosted web fonts. This script is how those committed files were made:
#
#   tiles/jxn.pmtiles     Jackson-metro extract of the Protomaps OSM basemap
#   tiles/fonts/**.pbf    label glyphs (Noto Sans), Latin ranges only
#   vendor/maplibre/*     MapLibre GL JS, pinned
#   vendor/pmtiles/*      the pmtiles:// protocol reader (BSD-3; the npm
#                         package ships no LICENSE file) plus fflate, its
#                         one dependency, both pinned. ESM builds on purpose:
#                         the site build minifies every .js file and renames
#                         its globals, but passes .mjs through untouched.
#
# Run it rarely (new roads, a MapLibre bump). The style is separate:
# scripts/build_map_style.mjs. Needs the pmtiles CLI (brew install pmtiles).
set -euo pipefail
cd "$(dirname "$0")/.."

MAPLIBRE_VERSION=6.11.2
PMTILES_VERSION=4.5.0
FFLATE_VERSION=0.8.2
# A dated daily planet build; see https://maps.protomaps.com/builds/
PLANET_BUILD=${PLANET_BUILD:-20261013}
# Covers Ridgeland/Madison to the north and Pearl to the east, with margin.
BBOX=-90.42,32.15,-89.92,32.60
FONTS_BASE=https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts
# 0-255 + 256-511 cover Latin and Latin Extended; 8192-8447 is punctuation
# such as curly quotes and dashes. A label outside these ranges renders
# without that glyph rather than failing.
RANGES=(0-255 256-511 8192-8447)
FONTSTACKS=("Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic")

mkdir -p tiles/fonts vendor/maplibre vendor/pmtiles

pmtiles extract "https://build.protomaps.com/${PLANET_BUILD}.pmtiles" tiles/jxn.pmtiles \
  --bbox="$BBOX" --maxzoom=15

for stack in "${FONTSTACKS[@]}"; do
  mkdir -p "tiles/fonts/$stack"
  for r in "${RANGES[@]}"; do
    curl -fsSL "$FONTS_BASE/${stack// /%20}/$r.pbf" -o "tiles/fonts/$stack/$r.pbf"
  done
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack "maplibre-gl@$MAPLIBRE_VERSION" >/dev/null && tar xzf ./*.tgz)
for f in maplibre-gl.mjs maplibre-gl-shared.mjs maplibre-gl-worker.mjs maplibre-gl.css; do
  cp "$tmp/package/dist/$f" vendor/maplibre/
done
cp "$tmp/package/LICENSE.txt" vendor/maplibre/
rm -rf "$tmp/package" "$tmp"/*.tgz
(cd "$tmp" && npm pack "pmtiles@$PMTILES_VERSION" >/dev/null && tar xzf ./*.tgz)
# Point the bare fflate import at the vendored copy: no import map needed.
sed 's|from"fflate"|from"./fflate.mjs"|' "$tmp/package/dist/esm/index.js" > vendor/pmtiles/pmtiles.mjs
grep -q 'from"./fflate.mjs"' vendor/pmtiles/pmtiles.mjs || { echo "pmtiles import rewrite failed" >&2; exit 1; }
rm -rf "$tmp/package" "$tmp"/*.tgz
(cd "$tmp" && npm pack "fflate@$FFLATE_VERSION" >/dev/null && tar xzf ./*.tgz)
cp "$tmp/package/esm/browser.js" vendor/pmtiles/fflate.mjs
cp "$tmp/package/LICENSE" vendor/pmtiles/fflate-LICENSE.txt

echo "map assets refreshed (planet build $PLANET_BUILD, maplibre-gl $MAPLIBRE_VERSION, pmtiles $PMTILES_VERSION, fflate $FFLATE_VERSION)"
