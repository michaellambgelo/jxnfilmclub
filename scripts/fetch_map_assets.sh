#!/usr/bin/env bash
# Rebuild the self-hosted map assets behind /map (docs/features/map.md).
#
# Everything the map loads is served from jxnfilm.club itself, so a visitor's
# browser never talks to a tile, font or CDN company — the same promise as the
# self-hosted web fonts. This script is how those committed files were made:
#
#   tiles/jxn/{z}/{x}/{y}.pbf  Jackson-metro extract of the Protomaps OSM
#                         basemap, one static file per tile (see
#                         scripts/split_map_tiles.mjs for why not one archive)
#   tiles/fonts/**.pbf    label glyphs (Noto Sans), Latin ranges only
#   vendor/maplibre/*     MapLibre GL JS, pinned. The ESM build on purpose:
#                         the site build minifies every .js file and renames
#                         its globals, but passes .mjs through untouched.
#
# Run it rarely (new roads, a MapLibre bump). The style is separate:
# scripts/build_map_style.mjs. Needs the pmtiles CLI (brew install pmtiles).
set -euo pipefail
cd "$(dirname "$0")/.."

MAPLIBRE_VERSION=6.11.2
# A dated daily planet build; see https://maps.protomaps.com/builds/
PLANET_BUILD=${PLANET_BUILD:-20261013}
# Covers Ridgeland/Madison to the north and Pearl to the east, with margin.
BBOX=-90.42,32.15,-89.92,32.60
MAXZOOM=15
FONTS_BASE=https://raw.githubusercontent.com/protomaps/basemaps-assets/main/fonts
# 0-255 + 256-511 cover Latin and Latin Extended; 8192-8447 is punctuation
# such as curly quotes and dashes. A label outside these ranges renders
# without that glyph rather than failing.
RANGES=(0-255 256-511 8192-8447)
FONTSTACKS=("Noto Sans Regular" "Noto Sans Medium" "Noto Sans Italic")

mkdir -p tiles/fonts vendor/maplibre

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# BBOX and MAXZOOM are repeated in the style's source (build_map_style.mjs).
pmtiles extract "https://build.protomaps.com/${PLANET_BUILD}.pmtiles" "$tmp/jxn.pmtiles" \
  --bbox="$BBOX" --maxzoom="$MAXZOOM"
node scripts/split_map_tiles.mjs "$tmp/jxn.pmtiles" "$BBOX" "$MAXZOOM"

for stack in "${FONTSTACKS[@]}"; do
  mkdir -p "tiles/fonts/$stack"
  for r in "${RANGES[@]}"; do
    curl -fsSL "$FONTS_BASE/${stack// /%20}/$r.pbf" -o "tiles/fonts/$stack/$r.pbf"
  done
done

(cd "$tmp" && npm pack "maplibre-gl@$MAPLIBRE_VERSION" >/dev/null && tar xzf ./*.tgz)
for f in maplibre-gl.mjs maplibre-gl-shared.mjs maplibre-gl-worker.mjs maplibre-gl.css; do
  cp "$tmp/package/dist/$f" vendor/maplibre/
done
cp "$tmp/package/LICENSE.txt" vendor/maplibre/

echo "map assets refreshed (planet build $PLANET_BUILD, maplibre-gl $MAPLIBRE_VERSION)"
