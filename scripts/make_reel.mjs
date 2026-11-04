#!/usr/bin/env node
// Instagram Reels from a video or audio file: word-pop captions, Night Shift
// branding, a 2s intro card and a cover image. One reel per input file.
//
//   node scripts/make_reel.mjs draft  <file...> [--model small] [--out DIR] [--force]
//   node scripts/make_reel.mjs render <file...> --hook "…" [--kicker K] [--name N]
//        [--cover-at S] [--no-intro] [--no-normalize] [--out DIR] [--force]
//
// Two phases with a human in between, like the audiogram's reviewed captions:
//   draft   whisper (word timestamps) → <out>/reel/<stem>/{words.json, captions.srt}
//           — one SRT cue per on-screen group. Fix names and titles there.
//   render  reviewed captions.srt + words.json → groups.json → reel.mp4 + cover.jpg
//
// Video: autorotated + scaled/cropped to 1080x1920, logo bug, word-pop stills,
// audio decoded onto the VIDEO's clock (phones start audio late — see
// alignedAudioArgs), then everything joined with the intro in ONE encode.
// Audio: rendered by make_audiogram.mjs (9x16 frame, --words) and the intro put
// in front. Pure logic lives in scripts/lib/reel.mjs (tested); this file only
// shells out.
//
// Output is append-only like the audiogram: a run that would land on existing
// files stops first and names them; --force is the only override. Inputs are
// local files only — no KV/R2 — so nothing here touches member voice data.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureWritable, ffmpeg, normalizeClip, probeSeconds, run } from './lib/voices.mjs'
import { concatPlaylist, parseSrt } from './lib/srt.mjs'
import { safeName } from './lib/audiogram.mjs'
import { wavArgs, whisperWordArgs, WORDS_JSON } from './lib/whisper.mjs'
import { launchChromium, screenshotHtml, startServer } from './lib/frames.mjs'
import {
  alignedAudioArgs, alignEdits, audioOffset, buildPrependIntroArgs, buildVideoReelArgs, chunkWords,
  groupsToSrt, instantiateReel, lowConfidence, mediaKind, parseReelArgs, REEL, wordPopHtml,
  wordPopTimeline, wordsFromWhisper,
} from './lib/reel.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE = readFileSync(join(REPO_ROOT, 'scripts', 'assets', 'reel.html'), 'utf8')

function fail(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

let tmp = null
process.on('exit', () => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

function probeStart(file, stream) {
  const r = run('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=start_time',
    '-of', 'default=nw=1:nk=1', file])
  return r.status === 0 ? r.stdout.trim().split('\n')[0] : null
}

function kindOf(file) {
  const byExt = mediaKind(file)
  if (byExt) return byExt
  const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file])
  return r.stdout.trim() ? 'video' : 'audio'
}

// The audio every later step agrees on: video → decoded onto the video clock;
// audio → decoded as-is. Returned as a WAV in tmp.
function decodeAudio(file, kind, dest) {
  if (kind === 'video') {
    const off = audioOffset(probeStart(file, 'a:0'), probeStart(file, 'v:0'))
    if (off) console.log(`  audio starts ${off}s after video — padding it onto the video clock`)
    ffmpeg(alignedAudioArgs(file, dest))
  } else {
    ffmpeg(['-i', file, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', dest])
  }
  return dest
}

const dirFor = (args, file) => join(args.outDir, 'reel', safeName(basename(file).replace(/\.[^.]+$/, '')))

// --- draft ---------------------------------------------------------------

function draft(args, file) {
  const kind = kindOf(file)
  const dir = dirFor(args, file)
  const wordsPath = join(dir, 'words.json')
  const srtPath = join(dir, 'captions.srt')
  ensureWritable([wordsPath, srtPath], { force: args.force })
  console.log(`\n${file} (${kind})`)

  const audio = decodeAudio(file, kind, join(tmp, `${safeName(basename(file))}.wav`))
  const w16 = join(tmp, 'w16.wav')
  ffmpeg(wavArgs(audio, w16))
  console.log(`  whisper ${args.model} (word timestamps)…`)
  const r = spawnSync('uvx', whisperWordArgs(w16, tmp, args.model), { stdio: 'inherit' })
  if (r.error?.code === 'ENOENT') throw new Error('uvx not found — install uv (https://docs.astral.sh/uv/) to run whisper locally')
  if (r.status !== 0) throw new Error(`whisper exited ${r.status}`)

  const words = wordsFromWhisper(JSON.parse(readFileSync(join(tmp, WORDS_JSON), 'utf8')))
  if (!words.length) throw new Error(`whisper heard no words in ${file}`)
  const groups = chunkWords(words)
  mkdirSync(dir, { recursive: true })
  writeFileSync(wordsPath, JSON.stringify({ source: resolve(file), kind, model: args.model, words }, null, 1) + '\n')
  writeFileSync(srtPath, groupsToSrt(groups))

  const unsure = lowConfidence(words)
  console.log(`  ${words.length} words → ${groups.length} caption groups`)
  console.log(`  review: ${srtPath}`)
  if (unsure.length) {
    console.log(`  whisper was unsure of ${unsure.length} word(s) — check these first:`)
    for (const w of unsure) console.log(`    ${w.start.toFixed(1).padStart(6)}s  ${w.text}  (p=${w.p.toFixed(2)})`)
  }
}

// --- render --------------------------------------------------------------

async function render(args, file, ctx) {
  const kind = kindOf(file)
  const dir = dirFor(args, file)
  const wordsPath = join(dir, 'words.json')
  const srtPath = join(dir, 'captions.srt')
  for (const p of [wordsPath, srtPath]) {
    if (!existsSync(p)) throw new Error(`${p} is missing — run \`make_reel.mjs draft ${file}\` first`)
  }
  const reelPath = join(dir, 'reel.mp4')
  const coverPath = join(dir, 'cover.jpg')
  ensureWritable([reelPath, coverPath], { force: args.force })
  console.log(`\n${file} (${kind})`)

  const { words } = JSON.parse(readFileSync(wordsPath, 'utf8'))
  const cues = parseSrt(readFileSync(srtPath, 'utf8'))
  if (!cues.length) throw new Error(`${srtPath} has no cues`)
  const aligned = alignEdits(cues, words)
  for (const g of aligned.filter(g => g.retimed)) {
    console.log(`  re-timed evenly (edited word count): "${g.words.map(w => w.text).join(' ')}"`)
  }
  const groups = aligned.map(g => g.words)
  const groupsPath = join(dir, 'groups.json')
  writeFileSync(groupsPath, JSON.stringify(groups, null, 1) + '\n')

  const { page, port, frames } = ctx
  const shot = (opts, path, transparent = true) =>
    screenshotHtml(page, port, frames, instantiateReel(TEMPLATE, opts), { width: REEL.width, height: REEL.height, path, transparent })
  const job = mkdtempSync(join(tmp, 'job-'))
  const card = { mode: 'card', hook: args.hook || '', kicker: args.kicker }
  const intro = args.intro ? join(job, 'intro.png') : null
  if (intro) await shot(card, intro, false)

  if (kind === 'video') {
    const duration = probeSeconds(file)
    if (duration > 180) console.warn(`  ${duration.toFixed(0)}s is longer than a 3-minute Reel; audio is capped at 180s and the video cut to match`)
    let audio = decodeAudio(file, kind, join(job, 'aligned.wav'))
    if (args.normalize) {
      const norm = join(job, 'norm.wav')
      console.log('  normalizing loudness…')
      normalizeClip(audio, norm, file)
      audio = norm
    }

    const bug = join(job, 'bug.png')
    await shot({ mode: 'bug' }, bug)
    const timeline = wordPopTimeline(groups, duration)
    const pngFor = new Map()
    const blank = join(job, 'blank.png')
    await shot({ mode: 'caption' }, blank)
    pngFor.set('', blank)
    let n = 0
    for (const seg of timeline) {
      if (pngFor.has(seg.text)) continue
      const png = join(job, `cap-${n++}.png`)
      await shot({ mode: 'caption', captionHtml: wordPopHtml(seg.words, seg.on) }, png)
      pngFor.set(seg.text, png)
    }
    const playlist = join(job, 'captions.ffconcat')
    writeFileSync(playlist, concatPlaylist(timeline, t => pngFor.get(t)))

    console.log(`  rendering ${reelPath} (${n} caption stills)…`)
    ffmpeg(buildVideoReelArgs({ video: file, audio, bug, playlist, intro, out: reelPath }))

    const at = args.coverAt ?? Math.round(duration * 0.2)
    const still = join(job, 'cover-photo.jpg')
    ffmpeg(['-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=1080:-2', '-q:v', '3', still])
    const photo = `data:image/jpeg;base64,${readFileSync(still).toString('base64')}`
    const coverPng = join(job, 'cover.png')
    await shot({ ...card, photo }, coverPng, false)
    ffmpeg(['-i', coverPng, '-q:v', '2', coverPath])
  } else {
    // make_audiogram does the normalize + waveform + captions; we add the intro.
    const agOut = join(job, 'ag')
    const title = (args.hook || '').replace(/\*/g, '')
    const agArgs = [join(REPO_ROOT, 'scripts', 'make_audiogram.mjs'), file, '--format', '9x16',
      '--words', groupsPath, '--out', agOut, '--force', '--name', args.name || 'JXN Film Club',
      ...(title ? ['--title', title] : [])]
    console.log('  rendering the 9x16 audiogram body…')
    const r = spawnSync(process.execPath, agArgs, { stdio: 'inherit' })
    if (r.status !== 0) throw new Error(`make_audiogram exited ${r.status}`)
    const body = join(agOut, 'audiogram', `${safeName(basename(file).replace(/\.[^.]+$/, ''))}-9x16.mp4`)
    if (intro) {
      console.log(`  adding the intro card → ${reelPath}`)
      ffmpeg(buildPrependIntroArgs({ body, intro, out: reelPath }))
    } else {
      copyFileSync(body, reelPath)
    }
    const coverPng = join(job, 'cover.png')
    await shot(card, coverPng, false)
    ffmpeg(['-i', coverPng, '-q:v', '2', coverPath])
  }
  console.log(`  wrote ${reelPath}\n  wrote ${coverPath}`)
}

// --- main ----------------------------------------------------------------

let args
try { args = parseReelArgs(process.argv.slice(2)) } catch (err) { fail(err.message) }
for (const f of args.files) if (!existsSync(f)) fail(`no such file: ${f}`)
try { run('ffmpeg', ['-version']) } catch (err) { fail(err.message) }
tmp = mkdtempSync(join(tmpdir(), 'jxnfc-reel-'))

if (args.command === 'draft') {
  try { for (const f of args.files) draft(args, f) } catch (err) { fail(err.message) }
} else {
  let browser
  try { browser = await launchChromium() } catch (err) { fail(err.message) }
  const frames = new Map()
  const server = await startServer(frames, { repoRoot: REPO_ROOT, allow: ['css', 'fonts', 'img'] })
  const ctx = { page: await browser.newPage(), port: server.address().port, frames }
  let failure = null
  try {
    for (const f of args.files) await render(args, f, ctx)
  } catch (err) { failure = err } finally {
    await browser.close().catch(() => {})
    server.close()
  }
  if (failure) fail(failure.message)
}
