// SRT for audiogram captions: parse, tidy, serialize. Pure — no processes, no
// filesystem — so every rule below is unit-tested without whisper or ffmpeg.
//
// Why cues are derived from whisper's SEGMENTS rather than its words:
// whisper's word-level timestamps are not reliable enough to caption with. On
// the launch clip, `--word-timestamps True --max-words-per-line 8` claimed
// 10.4s -> 18.1s for eight words, while silencedetect showed the longest pause
// anywhere in that stretch was 0.85s. The words were not where it said, and
// every later cue inherited the drift. Segment timestamps from the same model
// are sound (contiguous 8-12s blocks whose gaps land on real breaths), so a
// segment is split into cues by CHARACTER PROPORTION inside its own span.
// That assumes an even speaking rate within a segment, which is approximately
// true — and, more importantly, bounds the error to one segment instead of
// letting it accumulate across the clip.

export const MAX_CHARS = 42      // per cue; the browser wraps within the frame
export const MAX_SECONDS = 6     // a cue should clear, not linger through a tail
export const MIN_SECONDS = 0.9   // below this it flashes and can't be read

const TS = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/

export function parseTimestamp(text) {
  const m = TS.exec(String(text).trim())
  if (!m) throw new Error(`bad SRT timestamp: ${text}`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
}

export function formatTimestamp(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`
}

// SRT text → [{ start, end, text }]. Tolerant of CRLF, a BOM, and blank runs;
// a block whose timing line won't parse is skipped rather than killing the
// file, because this parses HUMAN-EDITED input.
export function parseSrt(text) {
  const cues = []
  const blocks = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim() !== '')
    if (!lines.length) continue
    // The index line is optional — editors drop it, and it carries no meaning.
    const arrowAt = lines.findIndex(l => l.includes('-->'))
    if (arrowAt === -1) continue
    const [from, to] = lines[arrowAt].split('-->')
    let start, end
    try {
      start = parseTimestamp(from)
      end = parseTimestamp(to)
    } catch { continue }
    const body = lines.slice(arrowAt + 1).join(' ').replace(/\s+/g, ' ').trim()
    if (body) cues.push({ start, end, text: body })
  }
  return cues
}

export function formatSrt(cues) {
  return cues.map((c, i) =>
    `${i + 1}\n${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${c.text}`
  ).join('\n\n') + '\n'
}

// Break one cue's text into <= maxChars pieces at word boundaries. A single
// word longer than maxChars is never chopped mid-word; it gets its own piece.
export function chunkText(text, maxChars = MAX_CHARS) {
  const words = String(text).trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const out = []
  let line = ''
  for (const word of words) {
    if (!line) line = word
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`
    else { out.push(line); line = word }
  }
  if (line) out.push(line)
  return out
}

// One segment → cues, timed by character proportion within the segment's span.
export function splitCue(cue, maxChars = MAX_CHARS) {
  const pieces = chunkText(cue.text, maxChars)
  if (pieces.length <= 1) return pieces.length ? [{ ...cue, text: pieces[0] }] : []
  const total = pieces.reduce((n, p) => n + p.length, 0)
  const span = Math.max(0, cue.end - cue.start)
  const out = []
  let at = cue.start
  pieces.forEach((piece, i) => {
    // Last piece ends exactly on the segment end so rounding can't drift past it.
    const end = i === pieces.length - 1 ? cue.end : at + span * (piece.length / total)
    out.push({ start: at, end, text: piece })
    at = end
  })
  return out
}

// Display hygiene, applied after splitting:
//   - a cue too short to read is MERGED into its neighbour, not stretched.
//     Stretching cannot work: cues out of splitCue are contiguous, so the
//     room ahead of a short cue is always exactly zero. (An earlier version
//     tried to extend, and its test passed only because the fixture left a
//     gap between cues — which real transcripts never contain.)
//   - a cue never shows longer than maxSeconds; it clears rather than
//     lingering through a tail. Capping shortens, it never shifts, so the
//     following cue still appears when the words were actually spoken.
//   - cues never overlap and never run backwards.
export function tidyCues(cues, opts = {}) {
  const maxSeconds = opts.maxSeconds ?? MAX_SECONDS
  const minSeconds = opts.minSeconds ?? MIN_SECONDS
  // A merge may exceed the per-cue character target — a slightly long line
  // beats a line nobody can read.
  const mergeChars = opts.mergeChars ?? Math.round((opts.maxChars ?? MAX_CHARS) * 1.6)

  const sorted = [...cues]
    .filter(c => c.text && String(c.text).trim() && c.end > c.start)
    .sort((a, b) => a.start - b.start)
    .map(c => ({ start: c.start, end: c.end, text: String(c.text).trim() }))

  const merged = []
  for (const cue of sorted) {
    const prev = merged[merged.length - 1]
    const tooShort = cue.end - cue.start < minSeconds
    const fits = prev && (prev.text.length + 1 + cue.text.length) <= mergeChars
    // Merge backwards into the line already on screen: it keeps reading order
    // and never delays a cue past when it was spoken.
    if (tooShort && prev && fits && prev.end >= cue.start - 0.001) {
      prev.end = cue.end
      prev.text = `${prev.text} ${cue.text}`
      continue
    }
    merged.push({ ...cue })
  }

  return merged.map((cue, i) => {
    const next = merged[i + 1]
    const ceiling = next ? next.start : Infinity
    return { start: cue.start, end: Math.min(cue.end, cue.start + maxSeconds, ceiling), text: cue.text }
  }).filter(c => c.end > c.start)
}

// whisper's SRT → caption-shaped cues. The one entry point callers need.
export function captionCues(srtText, opts = {}) {
  const maxChars = opts.maxChars ?? MAX_CHARS
  const split = parseSrt(srtText).flatMap(cue => splitCue(cue, maxChars))
  return tidyCues(split, opts)
}

// Total seconds a caption is on screen — used to report coverage, since a
// transcript that covers 40% of a clip usually means something went wrong.
export function coverage(cues) {
  return cues.reduce((n, c) => n + (c.end - c.start), 0)
}

// Cues → a gap-free timeline covering the whole clip, so the frame layer can
// be a SEQUENCE of stills rather than N overlay filters with enable=
// expressions. A 3-minute clip is ~50 cues; fifty overlays makes a filtergraph
// that is slow to build and miserable to debug, while a concat of stills is
// one input whose timing ffmpeg handles.
//
// Every gap becomes an explicit uncaptioned segment ('' text), because the
// frame still has to be on screen while nobody is speaking.
export function captionTimeline(cues, duration) {
  const out = []
  let at = 0
  for (const cue of [...cues].sort((a, b) => a.start - b.start)) {
    const start = Math.max(at, cue.start)
    if (start > at + 1e-3) out.push({ text: '', start: at, end: start })
    const end = Math.min(cue.end, duration)
    if (end > start + 1e-3) out.push({ text: cue.text, start, end })
    at = Math.max(at, end)
  }
  if (duration > at + 1e-3) out.push({ text: '', start: at, end: duration })
  return out
}

// An ffconcat playlist over those segments. `pathFor(text)` resolves a
// segment's text to the PNG that shows it — the uncaptioned frame is one file
// reused for every gap, so a clip needs one screenshot per CUE plus one, not
// one per segment.
//
// The final entry is repeated deliberately: the concat demuxer drops the last
// `duration` directive, and without the repeat the closing segment collapses
// to a single frame.
export function concatPlaylist(segments, pathFor) {
  const lines = ['ffconcat version 1.0']
  for (const seg of segments) {
    lines.push(`file '${pathFor(seg.text)}'`)
    lines.push(`duration ${(seg.end - seg.start).toFixed(3)}`)
  }
  const last = segments[segments.length - 1]
  if (last) lines.push(`file '${pathFor(last.text)}'`)
  return lines.join('\n') + '\n'
}

// Per-clip cue tracks → one track for the compiled segment.
//
// A segment is the clips concatenated with a fixed silence between them, so
// each clip's cues shift by everything that plays before it: the durations of
// the preceding clips plus one gap each. Cues are clamped to their own clip's
// length first — a cue that overran its slot would appear while the NEXT
// member is speaking, and caption them with someone else's words.
//
// `tracks` is [{ cues, duration }] in playback order; gapSeconds must be the
// same value the audio concatenation used (voices.mjs CONCAT_GAP_SECONDS).
export function joinCueTracks(tracks, gapSeconds) {
  if (!Number.isFinite(gapSeconds)) throw new Error('joinCueTracks needs the gap used by the audio concat')
  const out = []
  let at = 0
  tracks.forEach((track, i) => {
    if (i > 0) at += gapSeconds
    const duration = Number(track.duration)
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`track ${i + 1} has no usable duration`)
    }
    for (const cue of track.cues || []) {
      const start = Math.max(0, Math.min(cue.start, duration))
      const end = Math.min(cue.end, duration)
      if (end > start + 1e-3) out.push({ start: at + start, end: at + end, text: cue.text })
    }
    at += duration
  })
  return out
}
