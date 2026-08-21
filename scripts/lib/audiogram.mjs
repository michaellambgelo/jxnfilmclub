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
  // 9x16 is posted to Instagram, whose action rail sits over the right edge
  // from about x=958 and whose story header covers the top ~210px. The wave is
  // held to x 140..876 so it clears the rail; see the safe-area block in
  // scripts/assets/audiogram.html for the rest.
  '9x16': { width: 1080, height: 1920, wave: { x: 140, y: 1210, w: 736, h: 260 } },
}
export const FORMAT_KEYS = Object.keys(FORMATS)

// Brand colors handed to ffmpeg (0xRRGGBB). The HTML template gets its colors
// from css/tokens.css directly; these are the only hardcoded copies and are
// guarded against tokens.css by tests/scripts/audiogram.test.js.
export const COLORS = {
  bg: '0x100f0e', // --bg
  // The wave is drawn through a vertical ramp, so a bar's color is a function
  // of its own height: at rest it sits in the deep red, at full travel it hits
  // the bright one. Red therefore tracks the AUDIO rather than sitting in a
  // fixed band of columns, which is what made it look parked while the shape
  // around it moved.
  wavePeak: '0xe8604f', // --brand-tint-fg — a bar at full travel
  waveBase: '0x7a2014', // --brand held down to ~57% — a bar at rest
}

// Push the analysis branch up so bars use the window instead of hugging the
// floor. Safe to hold constant: every clip reaching the renderer has already
// been through the two-pass EBU R128 loudnorm in normalizeClip, so a quiet
// speaker and a loud one arrive at the same loudness.
export const WAVE_GAIN_DB = 8

// Where the ramp reaches wavePeak, as a fraction of the window height. Speech
// peaks rarely exceed ~60% of the window, so a ramp that only saturated at the
// very top would never actually show its brightest tone.
export const WAVE_RAMP_KNEE = 0.5

function rgb(color) {
  const n = parseInt(String(color).replace(/^0x/, ''), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
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
// with the ffmpeg overlay geometry; title/name/caption are user text — the
// caption especially, since it comes back from a hand-edited SRT — and are
// escaped.
export function instantiateTemplate(tpl, { format, title, name, caption }) {
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
    .replaceAll('{{CAPTION}}', escapeHtml(caption))
}

// The -filter_complex graph: the speech ENVELOPE, drawn as bottom-anchored
// bars through a vertical color ramp, upscaled into the wave window of the
// branded frame, which sits on top with transparent slots.
//
// Envelope, not spectrum. showfreqs answers "which frequencies are present",
// which for one person talking is a nearly static shape — and with the display
// spanning 0..Nyquist, the top of it was structurally dead (voice codecs
// lowpass; a clip measures ~-91 dB above 8 kHz). showwaves in p2p mode answers
// "how loud, right now", so the bars track syllables, stress and pauses.
//
// Bottom-anchored via a double-height render cropped to its lower half and
// flipped, which keeps the silhouette of the .speak-wave motif exactly.
// Coloring is an alpha mask over a ramp rather than per-bar colors, because
// showwaves takes one color per channel and cannot vary by height.
//
// Inputs: 0 = normalized WAV, 1 = frame PNG, 2 = lavfi color base.
export function buildFiltergraph(format, opts = {}) {
  const f = FORMATS[format]
  if (!f) throw new Error(`unknown format: ${format}`)
  const { x, y, w, h } = f.wave
  const fps = opts.fps ?? 30
  const gain = opts.gainDb ?? WAVE_GAIN_DB
  const knee = Math.max(1, Math.round(h * (opts.rampKnee ?? WAVE_RAMP_KNEE)))
  const [br, bg, bb] = rgb(COLORS.waveBase)
  const [pr, pg, pb] = rgb(COLORS.wavePeak)
  // Commas inside a geq expression must be escaped or the filtergraph parser
  // reads them as filter separators.
  const t = `min(1\\,max(0\\,(${h - 1}-Y)/${knee}))`
  const ramp = `geq=r='${br}+(${pr - br})*${t}':g='${bg}+(${pg - bg})*${t}':b='${bb}+(${pb - bb})*${t}'`
  return [
    // Double height, lower half, flipped → bars grow from the baseline.
    `[0:a]volume=${gain}dB,showwaves=s=${WAVE_SRC_W}x${h * 2}:mode=p2p:rate=${fps}:colors=0xffffff:draw=full,` +
      `crop=${WAVE_SRC_W}:${h}:0:${h},vflip,format=gray[mask]`,
    // rgb24 for the geq math, then rgba: alphamerge has to have somewhere to
    // WRITE the alpha, and on an alpha-less format it silently yields no
    // frames at all — the encoder then dies with an opaque internal error.
    `color=c=black:s=${WAVE_SRC_W}x${h}:r=${fps},format=rgb24,${ramp},format=rgba[ramp]`,
    `[ramp][mask]alphamerge[wave]`,
    `[wave]scale=${w}:${h}:flags=neighbor[wavebig]`,
    // Both overlays blend in RGB so the ink base, the PNG frame, and the wave
    // hit yuv420p through ONE conversion at the encoder — blending in the
    // default yuv420 rounds the base and the PNG differently for the same
    // #100f0e, leaving faint stripes where the grill slots meet the panels.
    `[2:v][wavebig]overlay=${x}:${y}:shortest=1:format=rgb[base]`,
    // Rate normalization is needed only for the concat form: a playlist of
    // stills arrives at whatever rate its durations imply, and the overlay
    // wants a steady one. The looped-PNG form already arrives at -framerate,
    // so fps= there is a no-op and is skipped rather than carried.
    ...(opts.frameSequence ? [`[1:v]fps=${fps}[frames]`] : []),
    `[base][${opts.frameSequence ? 'frames' : '1:v'}]overlay=0:0:format=rgb[out]`,
  ].join(';')
}

// Full ffmpeg argument list for one render.
//
// The frame layer is input 1 and comes in two shapes. Without captions it is a
// single looped PNG. With captions it is an ffconcat playlist of stills whose
// durations are the cue timings — one input, rather than one overlay filter
// per cue with an enable= window, which for a 50-cue clip is a filtergraph
// nobody can read and ffmpeg is slow to build.
export function buildRenderArgs({ format, audioPath, framePath, framePlaylist, outPath, fps = 30 }) {
  const f = FORMATS[format]
  if (!f) throw new Error(`unknown format: ${format}`)
  if (!framePath && !framePlaylist) throw new Error('a frame PNG or a frame playlist is required')
  const frameInput = framePlaylist
    ? ['-f', 'concat', '-safe', '0', '-i', framePlaylist]
    : ['-framerate', String(fps), '-loop', '1', '-i', framePath]
  return [
    '-i', audioPath,
    ...frameInput,
    // format=rgb24 makes the color source emit exact RGB — left to negotiate
    // it goes yuv-first and lands ~2/255 off the PNG's identical ink, which
    // shows as faint stripes at the grill slots.
    '-f', 'lavfi', '-i', `color=c=${COLORS.bg}:s=${f.width}x${f.height}:r=${fps},format=rgb24`,
    '-filter_complex', buildFiltergraph(format, { fps, frameSequence: Boolean(framePlaylist) }),
    '-map', '[out]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', '-shortest', outPath,
  ]
}

// Narrow an approved-clip list to the members named by --member.
// Accepts a memberId or a full `voice:{promptId}:{memberId}` KV key, so a key
// copied out of the admin dashboard or the TUI works as-is. Returns the
// selection IN SUBMISSION ORDER (not the order the flags were typed) — a
// segment built from a subset must still play in the order the round did.
export function selectClips(clips, members) {
  const wanted = members.map(m => String(m).trim()).filter(Boolean)
  const matched = new Set()
  const selected = clips.filter(c => {
    const hit = wanted.find(w => w === c.memberId || w === c.key)
    if (hit) matched.add(hit)
    return Boolean(hit)
  })
  return { selected, missing: wanted.filter(w => !matched.has(w)) }
}

// Every .mp4 a render would write, given the stems and formats it will use.
// Pure, so the pre-flight overwrite check is provably the same set of paths
// the render loop later produces — a guard computed a different way would
// eventually drift and start missing conflicts.
export function plannedRenderPaths(dir, stems, formats) {
  const paths = []
  for (const stem of stems) {
    for (const format of formats) {
      if (!FORMATS[format]) throw new Error(`unknown format: ${format}`)
      paths.push(`${dir}/${safeName(stem)}-${format}.mp4`)
    }
  }
  return paths
}

// Fold one run's manifest into whatever the round already had.
//
// manifest.json is the one file a run rewrites, because it is a derived INDEX
// of the directory rather than an artifact: rendering 16x9 and then 1x1, or
// Alice and then Bo, should leave one manifest describing everything present —
// not a refusal, and not a manifest that forgot the earlier half.
//
// The merge is append-only in effect: no clip, format, file or run record is
// ever dropped. A clip skipped this time keeps the files an earlier run made
// for it, and a null segment never erases a real one.
export function mergeManifest(existing, next) {
  const run = {
    generatedAt: next.generatedAt,
    formats: next.formats,
    ...(next.members?.length ? { members: next.members } : {}),
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return { ...next, runs: [run] }
  }

  const byKey = new Map()
  for (const clip of existing.clips || []) byKey.set(clip.key || clip.memberId, { ...clip })
  for (const clip of next.clips || []) {
    const key = clip.key || clip.memberId
    const prev = byKey.get(key)
    if (!prev) { byKey.set(key, { ...clip }); continue }
    const files = { ...(prev.files || {}), ...(clip.files || {}) }
    byKey.set(key, {
      ...prev,
      ...clip,
      ...(Object.keys(files).length ? { files } : {}),
      // A clip that aged out since the last run keeps the renders it already
      // has; the skip is recorded alongside them, not instead of them.
      ...(clip.skipped ? { skipped: clip.skipped } : {}),
      ...(clip.seconds == null && prev.seconds != null ? { seconds: prev.seconds } : {}),
    })
  }

  const clips = [...byKey.values()]
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) ||
                    String(a.key || '').localeCompare(String(b.key || '')))
    .map((clip, i) => ({ ...clip, order: i + 1 }))

  return {
    ...next,
    formats: [...new Set([...(existing.formats || []), ...(next.formats || [])])],
    clips,
    segment: next.segment || existing.segment || null,
    runs: [...(existing.runs || []), run],
  }
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
  node scripts/make_audiogram.mjs <audio-file> [--format 16x9|1x1|9x16|all] [--title T] [--name N]
  [--captions --srt FILE] [--force] [--out DIR]
  node scripts/make_audiogram.mjs --prompt <promptId> [--env production|staging] [--format ...] [--with-prompt] [--member ID[,ID]] [--segment-only|--clips-only] [--force] [--out DIR]

  --member narrows the round to specific approved clips (repeatable, or comma-
  separated; takes a memberId or a full voice:{promptId}:{memberId} key). With
  --member and no scope flag the default is --clips-only, since a "segment" of
  one clip is just that clip; pass --segment-only or drop --clips-only to build
  a segment from the subset.

  --captions burns in the clip's transcript. In prompt mode that is the copy
  reviewed in the admin panel; a clip whose row is not marked reviewed is
  refused, so nothing unread reaches a video. File mode takes --srt.

  Existing output is never overwritten or deleted: a run that would land on top
  of files already in --out stops and names them. --force is the only override.

  Pulled source audio is KEPT at out/archive/<promptId>/, so re-rendering a
  round costs no R2 requests. The 60-day retention promise governs the service
  (KV + R2), not an operator's local export. --no-keep-audio pulls to a temp
  dir that is deleted on exit instead.`

// Parse make_audiogram argv (everything after `node script`). Throws on any
// invalid combination; env-name validation stays in the CLI (BUCKETS lives in
// voices.mjs and this module stays dependency-free for tests).
export function parseArgs(argv) {
  const opts = {
    audioPath: null, promptId: null, envName: 'production', format: '16x9',
    title: null, name: null, outDir: 'out', segmentOnly: false, clipsOnly: false,
    withPrompt: false, members: [], force: false, keepAudio: true,
    captions: false, srtPath: null,
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
    else if (a === '--member') {
      opts.members.push(...flagValue(a, argv[++i]).split(',').map(m => m.trim()).filter(Boolean))
    }
    else if (a === '--segment-only') opts.segmentOnly = true
    else if (a === '--clips-only') opts.clipsOnly = true
    else if (a === '--with-prompt') opts.withPrompt = true
    else if (a === '--force') opts.force = true
    else if (a === '--no-keep-audio') opts.keepAudio = false
    else if (a === '--captions') opts.captions = true
    else if (a === '--srt') opts.srtPath = flagValue(a, argv[++i])
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}\n${USAGE}`)
    else if (!opts.audioPath) opts.audioPath = a
    else throw new Error(`unexpected argument: ${a}\n${USAGE}`)
  }
  if (!opts.audioPath && !opts.promptId) throw new Error(USAGE)
  if (opts.audioPath && opts.promptId) throw new Error(`pass either an audio file or --prompt, not both\n${USAGE}`)
  if (!opts.promptId && (opts.segmentOnly || opts.clipsOnly || opts.withPrompt || opts.members.length)) {
    throw new Error(`--segment-only/--clips-only/--with-prompt/--member only apply to --prompt mode\n${USAGE}`)
  }
  if (opts.segmentOnly && opts.clipsOnly) throw new Error(`--segment-only and --clips-only are mutually exclusive\n${USAGE}`)
  if (opts.srtPath && opts.promptId) {
    // In prompt mode the transcript's location is derived from the clip, and
    // captions require the REVIEWED copy — letting an arbitrary file in would
    // walk straight around that gate.
    throw new Error(`--srt only applies to file mode; --prompt reads the reviewed transcript\n${USAGE}`)
  }
  // Rendering a one-clip "segment" duplicates the clip video byte for byte, so
  // --member on its own means the per-clip files and nothing else. An explicit
  // scope flag always wins.
  if (opts.members.length && !opts.segmentOnly && !opts.clipsOnly) opts.clipsOnly = true
  // The frame is logo + name by default; --title (file mode) / --with-prompt
  // (prompt mode) opt into the big display line.
  if (opts.title === null) opts.title = ''
  opts.formats = resolveFormats(opts.format)
  return opts
}
