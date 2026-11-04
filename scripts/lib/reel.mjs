// Pure helpers for make_reel.mjs (and make_audiogram's --words mode): word-pop
// captions and the Instagram Reel encode. No child processes, no filesystem,
// no Chromium — everything here is unit-tested in tests/scripts/reel.test.js.
//
// Word-pop needs whisper's WORD timestamps, which scripts/lib/srt.mjs explains
// are not always trustworthy (they drifted on the audiogram launch clip). Two
// things bound that here: every caption group is re-anchored to its own cue
// span when a reviewer edits it (alignEdits), and the operator checks sync on
// the rendered reel before posting. The phrase-caption path stays segment-timed.

import { escapeHtml, FORMATS } from './audiogram.mjs'
import { formatSrt } from './srt.mjs'

export const REEL = { width: FORMATS['9x16'].width, height: FORMATS['9x16'].height, fps: 30 }
export const INTRO_SECONDS = 2
export const MAX_WORDS = 4      // per on-screen group
export const MAX_CHARS = 18     // per group — big Oswald caps, two lines at most
export const GAP_SECONDS = 0.35 // a pause this long starts a new group
export const HOLD_SECONDS = 0.25 // the last word lingers this long, unless the next group starts
export const LOW_CONFIDENCE = 0.5
export const DEFAULT_KICKER = 'JXN Film Club · Reactions'

const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi'])
const AUDIO_EXT = new Set(['m4a', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'weba'])

// 'video' | 'audio' by extension; ffprobe settles the ambiguous ones in the CLI.
export function mediaKind(path) {
  const ext = String(path).split('.').pop().toLowerCase()
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return null
}

// whisper JSON ({ segments: [{ words: [{ word, start, end, probability }] }] })
// → flat [{ text, start, end, p }]. Whisper splits hyphenated words
// ("two-part" → "two" + "-part"); those are glued back together.
export function wordsFromWhisper(json) {
  const out = []
  for (const seg of json?.segments || []) {
    for (const w of seg.words || []) {
      const text = String(w.word ?? '').trim()
      if (!text) continue
      const word = { text, start: Number(w.start), end: Number(w.end), p: Number(w.probability ?? 1) }
      const prev = out[out.length - 1]
      if (prev && text.startsWith('-')) {
        prev.text += text
        prev.end = word.end
        prev.p = Math.min(prev.p, word.p)
      } else {
        out.push(word)
      }
    }
  }
  return out
}

// Words → on-screen groups of 2–4. A group closes at MAX_WORDS, at MAX_CHARS,
// at a pause longer than GAP_SECONDS, or after sentence/clause punctuation.
export function chunkWords(words, opts = {}) {
  const maxWords = opts.maxWords ?? MAX_WORDS
  const maxChars = opts.maxChars ?? MAX_CHARS
  const gap = opts.gap ?? GAP_SECONDS
  const groups = []
  let cur = []
  for (const w of words) {
    if (cur.length) {
      const last = cur[cur.length - 1]
      const chars = [...cur, w].map(x => x.text).join(' ').length
      if (cur.length >= maxWords || chars > maxChars || w.start - last.end > gap || /[.,!?…;:]$/.test(last.text)) {
        groups.push(cur)
        cur = []
      }
    }
    cur.push(w)
  }
  if (cur.length) groups.push(cur)
  return groups
}

// Groups → the review SRT: one cue per on-screen group.
export function groupsToSrt(groups) {
  return formatSrt(groups.map(g => ({ start: g[0].start, end: g[g.length - 1].end, text: g.map(w => w.text).join(' ') })))
}

// Words whisper was unsure of, for the reviewer to look at first. Proper nouns
// (names, film titles) are what it gets wrong, and they're usually in here.
export function lowConfidence(words, threshold = LOW_CONFIDENCE) {
  return words.filter(w => w.p < threshold)
}

// Reviewed SRT cues + whisper words → final caption groups.
// Each cue is one group. If the cue still has as many words as whisper heard
// inside its span, the words keep whisper's timings with the edited text;
// otherwise the cue span is split across the edited words by length. Either
// way an edit can only move timing inside its own cue — it can't drift later
// captions.
export function alignEdits(cues, words) {
  return cues.map(cue => {
    const text = cue.text.split(/\s+/).filter(Boolean)
    const inside = words.filter(w => {
      const mid = (w.start + w.end) / 2
      return mid >= cue.start - 0.01 && mid <= cue.end + 0.01
    })
    if (inside.length === text.length) {
      return { retimed: false, words: text.map((t, i) => ({ text: t, start: inside[i].start, end: inside[i].end })) }
    }
    const weights = text.map(t => t.length + 2)
    const total = weights.reduce((a, b) => a + b, 0)
    let at = cue.start
    return {
      retimed: true,
      words: text.map((t, i) => {
        const end = at + (cue.end - cue.start) * weights[i] / total
        const w = { text: t, start: at, end }
        at = end
        return w
      }),
    }
  })
}

// Groups → frame-snapped timeline covering [0, duration]. Each segment is one
// still: `text` is the still's identity ('' = the blank frame, shared by every
// gap), so concatPlaylist() from srt.mjs can play it. `offset` shifts every
// word (seconds the audio clock trails the video clock); 0 when the audio was
// already put on the video's clock at extraction.
export function wordPopTimeline(groups, duration, opts = {}) {
  const fps = opts.fps ?? REEL.fps
  const hold = opts.hold ?? HOLD_SECONDS
  const offset = opts.offset ?? 0
  const snap = t => Math.min(duration, Math.max(0, Math.round((t + offset) * fps) / fps))
  const states = []
  groups.forEach((g, gi) => {
    const nextStart = groups[gi + 1]?.[0].start ?? Infinity
    g.forEach((w, wi) => {
      // A word's state runs from its own start to the next word's start, so the
      // group never blinks off between words; the last word holds briefly.
      const start = w.start
      const end = wi < g.length - 1 ? g[wi + 1].start : Math.min(w.end + hold, nextStart)
      states.push({ text: `${gi}:${wi}`, words: g.map(x => x.text), on: wi, start: snap(start), end: snap(end) })
    })
  })
  const out = []
  let at = 0
  for (const s of states) {
    const start = Math.max(at, s.start)
    if (start > at + 1e-3) out.push({ text: '', start: at, end: start })
    if (s.end > start + 1e-3) {
      out.push({ ...s, start, end: s.end })
      at = s.end
    }
  }
  if (duration > at + 1e-3) out.push({ text: '', start: at, end: duration })
  return out
}

// One group as markup, the active word marked. Every word is escaped; the
// only tags are the ones built here.
export function wordPopHtml(words, on) {
  return words.map((w, i) => `<span class="w${i === on ? ' on' : ''}">${escapeHtml(w)}</span>`).join(' ')
}

// The intro hook, escaped, with *starred* words set in the red italic.
export function hookHtml(hook) {
  return escapeHtml(hook).replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

// scripts/assets/reel.html → one still. mode: caption | bug | card.
export function instantiateReel(tpl, { mode, captionHtml = '', kicker = DEFAULT_KICKER, hook = '', photo = '' }) {
  if (!['caption', 'bug', 'card'].includes(mode)) throw new Error(`unknown reel frame mode: ${mode}`)
  return tpl
    .replaceAll('{{MODE}}', mode)
    .replaceAll('{{CAPTION_HTML}}', captionHtml)
    .replaceAll('{{KICKER}}', escapeHtml(kicker))
    .replaceAll('{{HOOK_HTML}}', hookHtml(hook))
    // photo is a data: URI built by the CLI; quotes would break out of url("…")
    .replaceAll('{{PHOTO}}', String(photo).replace(/["\\\n]/g, ''))
}

// Phone recordings routinely start audio a fraction of a second after video
// (0.475s on the first reel). Decoding with first_pts=0 pads that gap with
// silence, so the WAV — and therefore whisper's word times and the render's
// audio input — run on the VIDEO's clock. Drop this and every caption and
// every word of audio lands early by the offset.
export function alignedAudioArgs(src, dest) {
  return ['-i', src, '-vn', '-af', 'aresample=async=1:first_pts=0', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', dest]
}

// ffprobe stream start_time → seconds audio trails video (informational).
export function audioOffset(audioStart, videoStart) {
  const a = Number(audioStart), v = Number(videoStart)
  return Number.isFinite(a) && Number.isFinite(v) ? Math.round((a - v) * 1e6) / 1e6 : 0
}

const X264 = ['-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2', '-preset', 'slow',
  '-b:v', '10M', '-maxrate', '12M', '-bufsize', '20M', '-pix_fmt', 'yuv420p']
const AAC = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']

// The intro card is joined with the concat FILTER in the same encode. Never
// stream-copy-concat separately encoded clips: their SPS/level differ, and
// QuickTime (and Instagram) freeze on the second clip's first frame.
function introChain(introIdx, silenceIdx, fps) {
  return `[${introIdx}:v]fps=${fps},format=yuv420p,setsar=1,fade=in:st=0:d=0.35[intro];` +
    `[${silenceIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo[introa]`
}

// Video reel: source video (autorotated by ffmpeg) scaled to 1080x1920, logo
// bug on top, word-pop stills on top of that, optional intro card first.
// `audio` is the aligned (and usually loudness-normalized) WAV — input 1, NOT
// the source's own audio track, which still carries the clock offset.
export function buildVideoReelArgs({ video, audio, bug, playlist, intro, out, fps = REEL.fps }) {
  const { width, height } = REEL
  const inputs = ['-i', video, '-i', audio, '-loop', '1', '-framerate', String(fps), '-i', bug,
    '-f', 'concat', '-safe', '0', '-i', playlist]
  const main = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height},setsar=1,fps=${fps}[v];` +
    `[3:v]fps=${fps},format=rgba[cap];` +
    `[v][2:v]overlay=0:0:shortest=1[vb];[vb][cap]overlay=0:0:eof_action=pass,format=yuv420p[main];` +
    `[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a]`
  if (!intro) {
    return [...inputs, '-filter_complex', main, '-map', '[main]', '-map', '[a]',
      ...X264, ...AAC, '-shortest', '-movflags', '+faststart', out]
  }
  return [...inputs,
    '-loop', '1', '-framerate', String(fps), '-t', String(INTRO_SECONDS), '-i', intro,
    '-f', 'lavfi', '-t', String(INTRO_SECONDS), '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', `${main};${introChain(4, 5, fps)};[intro][introa][main][a]concat=n=2:v=1:a=1[outv][outa]`,
    '-map', '[outv]', '-map', '[outa]', ...X264, ...AAC, '-shortest', '-movflags', '+faststart', out]
}

// Audio reel: make_audiogram's 9x16 render (already captioned) with the intro
// card in front, re-encoded once to the reel's delivery settings.
export function buildPrependIntroArgs({ body, intro, out, fps = REEL.fps }) {
  return ['-i', body,
    '-loop', '1', '-framerate', String(fps), '-t', String(INTRO_SECONDS), '-i', intro,
    '-f', 'lavfi', '-t', String(INTRO_SECONDS), '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex', `${introChain(1, 2, fps)};[0:v]fps=${fps},format=yuv420p,setsar=1[main];` +
      `[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a];[intro][introa][main][a]concat=n=2:v=1:a=1[outv][outa]`,
    '-map', '[outv]', '-map', '[outa]', ...X264, ...AAC, '-movflags', '+faststart', out]
}

export const USAGE = `usage:
  node scripts/make_reel.mjs draft  <file...> [--model small|medium|large-v3] [--out DIR] [--force]
  node scripts/make_reel.mjs render <file...> --hook "Line with *red italic* words" [--kicker K]
       [--name N] [--cover-at SECONDS] [--no-intro] [--no-normalize] [--out DIR] [--force]

  Video or audio in, one 1080x1920 Instagram Reel out per file.

  draft   transcribes with word timestamps and writes, per file,
          <out>/reel/<stem>/{words.json, captions.srt}. Review captions.srt —
          one cue per on-screen group — before rendering.
  render  burns the reviewed captions in as word-pop: 2–4 words at a time, the
          spoken word in signal red. Video gets the logo bug; audio gets the
          9x16 audiogram frame (--name is its speaker credit). Both get a 2s
          intro card (--hook, --kicker) unless --no-intro, and a cover.jpg
          (video: frame at --cover-at, default 20% in).

  Audio is loudness-normalized (two-pass EBU R128) unless --no-normalize.
  Existing output is never overwritten; --force is the only override.`

export function parseReelArgs(argv) {
  const opts = {
    command: argv[0], files: [], model: 'small', outDir: 'out', force: false,
    hook: null, kicker: DEFAULT_KICKER, name: null, coverAt: null, intro: true, normalize: true,
  }
  if (!['draft', 'render'].includes(opts.command)) throw new Error(USAGE)
  const flagValue = (flag, v) => {
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value\n${USAGE}`)
    return v
  }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--model') opts.model = flagValue(a, argv[++i])
    else if (a === '--out') opts.outDir = flagValue(a, argv[++i])
    else if (a === '--hook') opts.hook = flagValue(a, argv[++i])
    else if (a === '--kicker') opts.kicker = flagValue(a, argv[++i])
    else if (a === '--name') opts.name = flagValue(a, argv[++i])
    else if (a === '--cover-at') {
      opts.coverAt = Number(flagValue(a, argv[++i]))
      if (!Number.isFinite(opts.coverAt) || opts.coverAt < 0) throw new Error('--cover-at must be seconds ≥ 0')
    }
    else if (a === '--no-intro') opts.intro = false
    else if (a === '--no-normalize') opts.normalize = false
    else if (a === '--force') opts.force = true
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}\n${USAGE}`)
    else opts.files.push(a)
  }
  if (!opts.files.length) throw new Error(`no input files\n${USAGE}`)
  if (opts.command === 'render' && opts.intro && !opts.hook) throw new Error('render needs --hook (or --no-intro)')
  return opts
}
