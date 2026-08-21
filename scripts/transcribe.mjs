#!/usr/bin/env node
// Transcribe voice clips into caption-shaped SRT, and push reviewed ones to R2.
//
//   node scripts/transcribe.mjs --prompt <promptId> [--member ID] [--env ...]
//        [--model tiny|base|small|medium|large-v3] [--out DIR] [--force] [--upload]
//   node scripts/transcribe.mjs <audio-file> [--model ...] [--out DIR] [--force]
//
// Runs locally: whisper via `uvx --from mlx-whisper`, so the model stays out of
// this repo's dependencies and the TUI keeps its "shell out, never
// reimplement" shape. Nothing here touches Workers AI or needs a deploy.
//
// The SRT lands beside the audio at out/archive/<promptId>/<memberId>.srt and
// is NOT uploaded by default — a machine transcript is a draft. Pushing it to
// R2 (--upload, or the TUI's Upload action) is the review gate: local means
// whisper wrote it, in R2 means a human read it. There is no separate
// "reviewed" flag to keep in sync, because which store it is in answers the
// question.
//
// Cue timing comes from whisper's SEGMENTS, never its words — see the header
// of scripts/lib/srt.mjs for the measurements behind that.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  archivePathFor, BUCKETS, ensureWritable, ffmpeg, fmtDur, listApprovedClips,
  looksMissing, pullClip, r2PutArgs, run, transcriptKeyFor, transcriptPathFor,
  wrangler,
} from './lib/voices.mjs'
import { selectClips } from './lib/audiogram.mjs'
import { captionCues, coverage, formatSrt } from './lib/srt.mjs'

const MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3']
const USAGE = `usage:
  node scripts/transcribe.mjs --prompt <promptId> [--member ID] [--env production|staging]
       [--model ${MODELS.join('|')}] [--out DIR] [--force] [--upload|--upload-only|--pull]
  node scripts/transcribe.mjs <audio-file> [--model ...] [--out DIR] [--force]

  The SRT is a DRAFT until you read it. --upload puts it in R2 next to the
  audio, which is what marks it reviewed; rendering captions requires that.`

function fail(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

let tmp = null
process.on('exit', () => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

// --- args ---

const argv = process.argv.slice(2)
const opts = { audioPath: null, promptId: null, members: [], envName: 'production',
  model: 'small', outDir: 'out', force: false, upload: false, uploadOnly: false,
  pull: false }
const flagValue = (flag, v) => {
  if (v === undefined || v.startsWith('--')) fail(`${flag} needs a value\n${USAGE}`)
  return v
}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--prompt') opts.promptId = flagValue(a, argv[++i])
  else if (a === '--member') opts.members.push(...flagValue(a, argv[++i]).split(',').map(s => s.trim()).filter(Boolean))
  else if (a === '--env') opts.envName = flagValue(a, argv[++i])
  else if (a === '--model') opts.model = flagValue(a, argv[++i])
  else if (a === '--out') opts.outDir = flagValue(a, argv[++i])
  else if (a === '--force') opts.force = true
  else if (a === '--upload') opts.upload = true
  else if (a === '--upload-only') { opts.upload = true; opts.uploadOnly = true }
  else if (a === '--pull') opts.pull = true
  else if (a.startsWith('--')) fail(`unknown flag: ${a}\n${USAGE}`)
  else if (!opts.audioPath) opts.audioPath = a
  else fail(`unexpected argument: ${a}\n${USAGE}`)
}
if (!opts.audioPath && !opts.promptId) fail(USAGE)
if (opts.audioPath && opts.promptId) fail(`pass either an audio file or --prompt, not both\n${USAGE}`)
if (!MODELS.includes(opts.model)) fail(`--model must be one of ${MODELS.join('|')} (got: ${opts.model})`)
if (!BUCKETS[opts.envName]) fail(`--env must be production or staging (got: ${opts.envName})`)
if (!opts.promptId && (opts.members.length || opts.upload || opts.pull)) {
  fail(`--member/--upload/--pull only apply to --prompt mode\n${USAGE}`)
}
if (opts.pull && opts.upload) fail(`--pull and --upload are opposite directions\n${USAGE}`)

// --- whisper ---

// Decode to what whisper actually wants — 16 kHz mono — rather than handing it
// an Opus/WebM container and hoping. Deliberately the RAW audio, not the
// loudnorm'd render input: normalization buys nothing for recognition.
function toWhisperWav(src, dest) {
  ffmpeg(['-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest])
  return dest
}

function whisper(wavPath, outDir) {
  const args = ['--from', 'mlx-whisper', 'mlx_whisper', wavPath,
    '--model', `mlx-community/whisper-${opts.model}-mlx`,
    '--output-dir', outDir, '--output-name', 'raw', '--output-format', 'srt']
  console.log(`Transcribing with whisper-${opts.model}…`)
  // stdio inherit so whisper's progress streams through to the TUI's run pane
  // instead of arriving in one lump when it finishes.
  const r = spawnSync('uvx', args, { stdio: 'inherit' })
  if (r.error?.code === 'ENOENT') {
    throw new Error('uvx not found — install uv (https://docs.astral.sh/uv/) to run whisper locally')
  }
  if (r.status !== 0) throw new Error(`whisper exited ${r.status}`)
  const srt = join(outDir, 'raw.srt')
  if (!existsSync(srt)) throw new Error(`whisper reported success but wrote no SRT to ${srt}`)
  return readFileSync(srt, 'utf8')
}

// Transcribe one audio file to one SRT path. Returns the cue list.
function transcribeTo(audioPath, srtPath, label) {
  ensureWritable([srtPath], { force: opts.force })
  const wav = join(tmp, `${basename(srtPath, '.srt')}-16k.wav`)
  toWhisperWav(audioPath, wav)
  const cues = captionCues(whisper(wav, tmp))
  if (!cues.length) throw new Error(`whisper produced no cues for ${label} — is the clip silent?`)
  rmSync(join(tmp, 'raw.srt'), { force: true })
  mkdirSync(dirname(srtPath), { recursive: true })
  writeFileSync(srtPath, formatSrt(cues))
  console.log(`  ${cues.length} cue(s), ${fmtDur(coverage(cues))} of speech → ${srtPath}`)
  return cues
}

// --- main ---

try {
  run('ffmpeg', ['-version'])
} catch (err) { fail(err.message) }

try {
  tmp = mkdtempSync(join(tmpdir(), 'jxnfc-transcribe-'))
  const written = []

  if (!opts.promptId) {
    const stem = basename(opts.audioPath).replace(/\.[^.]+$/, '')
    const srtPath = join(opts.outDir, 'transcripts', `${stem}.srt`)
    transcribeTo(opts.audioPath, srtPath, opts.audioPath)
    written.push(srtPath)
  } else {
    const { clips: approved } = listApprovedClips(opts.promptId, opts.envName)
    if (!approved.length) throw new Error(`no APPROVED clips for prompt "${opts.promptId}" on ${opts.envName}`)
    let clips = approved
    if (opts.members.length) {
      const { selected, missing } = selectClips(approved, opts.members)
      if (missing.length) {
        throw new Error(`no approved clip for ${missing.join(', ')} in "${opts.promptId}" — approved: ${approved.map(c => c.memberId).join(', ')}`)
      }
      clips = selected
    }

    for (const clip of clips) {
      const label = clip.name || clip.memberId
      const audio = archivePathFor(opts.outDir, opts.promptId, clip)
      const srtPath = transcriptPathFor(opts.outDir, opts.promptId, clip)
      console.log(`\n${label}`)

      if (opts.pull) {
        // R2 wins. The admin panel is an editing surface, so the copy there is
        // the one a human last touched — a local draft is stale by definition
        // once it has been round-tripped. Overwrites without asking, which is
        // the one place in this pipeline that is deliberate.
        console.log(`  Pulling reviewed transcript ← ${transcriptKeyFor(clip)}`)
        wrangler(['r2', 'object', 'get', `${BUCKETS[opts.envName]}/${transcriptKeyFor(clip)}`,
          '--file', resolve(srtPath), '--remote'])
        written.push(srtPath)
        continue
      }

      if (opts.uploadOnly) {
        // Publish what a human has already read. Deliberately no whisper here:
        // re-transcribing at upload time would overwrite the very edits this
        // step exists to publish.
        if (!existsSync(srtPath)) {
          throw new Error(`no transcript at ${srtPath} — transcribe it first`)
        }
      } else {
        try {
          pullClip(clip, opts.envName, audio)
        } catch (err) {
          if (!looksMissing(err)) throw err
          console.warn(`  SKIPPING — ${clip.r2Key} is gone from R2 (60-day lifecycle)`)
          continue
        }
        transcribeTo(audio, srtPath, label)
        written.push(srtPath)
      }

      if (opts.upload) {
        const key = transcriptKeyFor(clip)
        console.log(`  Uploading reviewed transcript → ${key}`)
        wrangler(r2PutArgs(BUCKETS[opts.envName], key, srtPath, 'text/plain'))
      }
    }
  }

  console.log('\nWrote:')
  written.forEach(f => console.log(`  ${f}`))
  if (!opts.upload && opts.promptId) {
    console.log('\nThis is a DRAFT. Read it, fix what whisper misheard, then upload it')
    console.log('(--upload, or the TUI\'s Upload transcript action) — captions render')
    console.log('from the copy in R2, so nothing unreviewed can reach a video.')
  }
} catch (err) {
  fail(err.message)
}
