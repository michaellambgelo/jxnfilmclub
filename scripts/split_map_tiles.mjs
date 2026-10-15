// Split a PMTiles extract into static tiles/jxn/{z}/{x}/{y}.pbf files for
// /map (docs/features/map.md). Called by scripts/fetch_map_assets.sh.
//
// Why not serve the .pmtiles archive itself: a PMTiles reader fetches byte
// ranges, and GitHub Pages' CDN keeps a gzipped copy of the file and applies
// Range to the compressed bytes (or ignores Range on a cache miss). One file
// per tile needs no Range at all, and nue serve handles it too.
//
// Tiles are written decompressed: the archive stores gzipped MVT, and Pages
// would serve those bytes without a Content-Encoding header.
//
// Usage: node scripts/split_map_tiles.mjs <extract.pmtiles> <west,south,east,north> <maxzoom>
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'

const run = promisify(execFile)
const [archive, bboxArg, maxzoomArg] = process.argv.slice(2)
if (!archive || !bboxArg || !maxzoomArg) {
  console.error('usage: node scripts/split_map_tiles.mjs <extract.pmtiles> <w,s,e,n> <maxzoom>')
  process.exit(2)
}
const [west, south, east, north] = bboxArg.split(',').map(Number)
const maxzoom = Number(maxzoomArg)
const OUT = 'tiles/jxn'

function tileXY(lng, lat, z) {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const r = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n)
  return [Math.min(n - 1, x), Math.min(n - 1, y)]
}

const jobs = []
for (let z = 0; z <= maxzoom; z++) {
  const [x0, y0] = tileXY(west, north, z)
  const [x1, y1] = tileXY(east, south, z)
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push([z, x, y])
}

await rm(OUT, { recursive: true, force: true })
let written = 0
let empty = 0
async function one([z, x, y]) {
  const { stdout } = await run('pmtiles', ['tile', archive, String(z), String(x), String(y)], {
    encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
  })
  if (!stdout.length) { empty++; return }
  const body = stdout[0] === 0x1f && stdout[1] === 0x8b ? gunzipSync(stdout) : stdout
  await mkdir(`${OUT}/${z}/${x}`, { recursive: true })
  await writeFile(`${OUT}/${z}/${x}/${y}.pbf`, body)
  written++
}
const queue = jobs.slice()
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) await one(queue.shift())
}))
console.log(`${written} tiles written to ${OUT}/ (${empty} empty, ${jobs.length} in range)`)
