// Pure helpers for make_audiogram.mjs — no child processes, no filesystem,
// no Chromium. Everything here is unit-tested in tests/scripts/ without
// ffmpeg or Playwright installed.

// Output formats. `wave` is the window (in CSS pixels of the frame) where the
// ffmpeg waveform shows through the branded PNG's transparent slots. Widths
// are exact multiples of WAVE_SRC_W so the neighbor upscale stays pixel-crisp.
export const WAVE_SRC_W = 32
export const FORMATS = {
  '16x9': { width: 1920, height: 1080, wave: { x: 320, y: 700, w: 1280, h: 240 } },
  '1x1': { width: 1080, height: 1080, wave: { x: 140, y: 660, w: 800, h: 220 } },
  '9x16': { width: 1080, height: 1920, wave: { x: 140, y: 1210, w: 800, h: 260 } },
}
export const FORMAT_KEYS = Object.keys(FORMATS)

// Brand colors handed to ffmpeg (0xRRGGBB). The HTML template gets its colors
// from css/tokens.css directly; these three are the only hardcoded copies and
// are guarded against tokens.css by tests/scripts/audiogram.test.js.
export const COLORS = {
  bg: '0x100f0e', // --bg
  bar: '0x3a352d', // --line-2 — the .speak-wave bar grey
  brand: '0xd7321f', // --brand — bars 3/4/5 of the motif
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// Substitute template slots. `format` becomes the body class (f-16x9 …) and
// the wave-window rect is injected from FORMATS so the CSS can never disagree
// with the ffmpeg overlay geometry; title/name are user text and are escaped.
export function instantiateTemplate(tpl, { format, title, name }) {
  const f = FORMATS[format]
  if (!f) throw new Error(`unknown format: ${format}`)
  return tpl
    .replaceAll('{{FORMAT}}', `f-${format}`)
    .replaceAll('{{WX}}', String(f.wave.x))
    .replaceAll('{{WY}}', String(f.wave.y))
    .replaceAll('{{WW}}', String(f.wave.w))
    .replaceAll('{{WH}}', String(f.wave.h))
    .replaceAll('{{TITLE}}', escapeHtml(title))
    .replaceAll('{{NAME}}', escapeHtml(name))
}

// The -filter_complex graph: grey showfreqs bars + a brand-red band overlaid
// at the low-mid frequencies (echoing .speak-wave's red bars 3/4/5), upscaled
// with nearest-neighbor into the wave window of the branded frame, which sits
// on top with transparent slots. Inputs: 0 = normalized WAV, 1 = frame PNG,
// 2 = lavfi color base.
export function buildFiltergraph(format, opts = {}) {
  const f = FORMATS[format]
  if (!f) throw new Error(`unknown format: ${format}`)
  const { x, y, w, h } = f.wave
  const fps = opts.fps ?? 30
  const freqs = `showfreqs=s=${WAVE_SRC_W}x${h}:mode=bar:ascale=cbrt:fscale=log:win_size=64:rate=${fps}`
  // Red band: 2 of the 32 source columns starting at column 2 → ~3 grill bars
  // after the upscale, echoing .speak-wave's red bars 3/4/5. The colorkey
  // knocks out showfreqs' opaque black background so the grill slots show the
  // ink base (#100f0e), not a slightly-blacker stripe; similarity 0.1 is far
  // below the bar grey's distance from black (~0.2), so bars are untouched.
  return [
    `[0:a]asplit=2[a1][a2]`,
    `[a1]${freqs}:colors=${COLORS.bar}[wg]`,
    `[a2]${freqs}:colors=${COLORS.brand}[wr]`,
    `[wr]crop=2:${h}:2:0[wrc]`,
    `[wg][wrc]overlay=2:0[wave]`,
    `[wave]colorkey=0x000000:0.1:0.0[wavekey]`,
    `[wavekey]scale=${w}:${h}:flags=neighbor[wavebig]`,
    // Both overlays blend in RGB so the ink base, the PNG frame, and the wave
    // hit yuv420p through ONE conversion at the encoder — blending in the
    // default yuv420 rounds the base and the PNG differently for the same
    // #100f0e, leaving faint stripes where the grill slots meet the panels.
    `[2:v][wavebig]overlay=${x}:${y}:shortest=1:format=rgb[base]`,
    `[base][1:v]overlay=0:0:format=rgb[out]`,
  ].join(';')
}

// Full ffmpeg argument list for one render.
export function buildRenderArgs({ format, audioPath, framePath, outPath, fps = 30 }) {
  const f = FORMATS[format]
  if (!f) throw new Error(`unknown format: ${format}`)
  return [
    '-i', audioPath,
    '-framerate', String(fps), '-loop', '1', '-i', framePath,
    // format=rgb24 makes the color source emit exact RGB — left to negotiate
    // it goes yuv-first and lands ~2/255 off the PNG's identical ink, which
    // shows as faint stripes at the grill slots.
    '-f', 'lavfi', '-i', `color=c=${COLORS.bg}:s=${f.width}x${f.height}:r=${fps},format=rgb24`,
    '-filter_complex', buildFiltergraph(format, { fps }),
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', '-shortest', outPath,
  ]
}

// Filesystem-safe file stem (memberIds, audio basenames).
export function safeName(s) {
  const clean = String(s ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  return clean || 'clip'
}

// Resolve the --format flag ('all' → every format) with validation.
export function resolveFormats(flag) {
  if (flag === 'all') return [...FORMAT_KEYS]
  if (FORMATS[flag]) return [flag]
  throw new Error(`--format must be one of ${FORMAT_KEYS.join('|')}|all (got: ${flag})`)
}

export const USAGE = `usage:
  node scripts/make_audiogram.mjs <audio-file> [--format 16x9|1x1|9x16|all] [--title T] [--name N] [--out DIR]
  node scripts/make_audiogram.mjs --prompt <promptId> [--env production|staging] [--format ...] [--with-prompt] [--segment-only|--clips-only] [--out DIR]`

// Parse make_audiogram argv (everything after `node script`). Throws on any
// invalid combination; env-name validation stays in the CLI (BUCKETS lives in
// voices.mjs and this module stays dependency-free for tests).
export function parseArgs(argv) {
  const opts = {
    audioPath: null, promptId: null, envName: 'production', format: '16x9',
    title: null, name: null, outDir: 'out', segmentOnly: false, clipsOnly: false,
    withPrompt: false,
  }
  const flagValue = (flag, v) => {
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--prompt') opts.promptId = flagValue(a, argv[++i])
    else if (a === '--env') opts.envName = flagValue(a, argv[++i])
    else if (a === '--format') opts.format = flagValue(a, argv[++i])
    else if (a === '--title') opts.title = flagValue(a, argv[++i])
    else if (a === '--name') opts.name = flagValue(a, argv[++i])
    else if (a === '--out') opts.outDir = flagValue(a, argv[++i])
    else if (a === '--segment-only') opts.segmentOnly = true
    else if (a === '--clips-only') opts.clipsOnly = true
    else if (a === '--with-prompt') opts.withPrompt = true
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}\n${USAGE}`)
    else if (!opts.audioPath) opts.audioPath = a
    else throw new Error(`unexpected argument: ${a}\n${USAGE}`)
  }
  if (!opts.audioPath && !opts.promptId) throw new Error(USAGE)
  if (opts.audioPath && opts.promptId) throw new Error(`pass either an audio file or --prompt, not both\n${USAGE}`)
  if (!opts.promptId && (opts.segmentOnly || opts.clipsOnly || opts.withPrompt)) {
    throw new Error(`--segment-only/--clips-only/--with-prompt only apply to --prompt mode\n${USAGE}`)
  }
  if (opts.segmentOnly && opts.clipsOnly) throw new Error(`--segment-only and --clips-only are mutually exclusive\n${USAGE}`)
  // The frame is logo + name by default; --title (file mode) / --with-prompt
  // (prompt mode) opt into the big display line.
  if (opts.title === null) opts.title = ''
  opts.formats = resolveFormats(opts.format)
  return opts
}
