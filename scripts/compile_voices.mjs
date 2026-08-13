#!/usr/bin/env node
// Compile the APPROVED member voice clips for one prompt into a single
// podcast-ready segment.
//
//   node scripts/compile_voices.mjs <promptId> [--env production|staging] [--out DIR]
//
// Pipeline (no deps beyond node + wrangler + ffmpeg):
//   1. List voice:{promptId}:* rows from MEMBERS_KV (remote), keep only
//      status === 'approved', ordered by submission time.
//   2. Pull each clip's R2 object (jxnfilm-voice / jxnfilm-voice-staging).
//   3. Per clip: EBU R128 two-pass loudnorm (I=-16:TP=-1.5:LRA=11 — measure,
//      then apply with the measured values) + a hard 3-minute cap (-t 180),
//      transcoded to a 48 kHz mono WAV intermediate.
//   4. Concatenate with 0.5 s silence gaps into <out>/<promptId>-segment.wav
//      and print a manifest (order, member, duration).
//
// The KV/R2/loudnorm plumbing is shared with make_audiogram.mjs via
// scripts/lib/voices.mjs.
//
// IMPORTANT: clips — including approved ones — auto-delete 60 days after
// submission (R2 bucket lifecycle + KV TTL). Run this before they age out.
//
// Every wrangler call passes --remote explicitly: wrangler v4 defaults KV/R2
// ops to the local simulator, which would silently read nothing.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUCKETS, concatWithGaps, fmtDur, listApprovedClips, normalizeClip, pullClip, run,
} from './lib/voices.mjs'

const USAGE = 'usage: node scripts/compile_voices.mjs <promptId> [--env production|staging] [--out DIR]'

function fail(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

// fail() exits from inside the pipeline, which would skip a try/finally —
// clean the temp dir from the exit hook instead so no pulled audio is ever
// stranded on disk after a wrangler/ffmpeg failure.
let tmp = null
process.on('exit', () => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

// --- args ---

const argv = process.argv.slice(2)
let promptId = null
let envName = 'production'
let outDir = 'out'
// Flag values are validated at parse time — a missing value would otherwise
// surface as a crash at step 4, after every R2 pull and loudnorm pass.
function flagValue(flag, v) {
  if (v === undefined || v.startsWith('--')) fail(`${flag} needs a value\n${USAGE}`)
  return v
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--env') envName = flagValue(a, argv[++i])
  else if (a === '--out') outDir = flagValue(a, argv[++i])
  else if (a.startsWith('--')) fail(`unknown flag: ${a}\n${USAGE}`)
  else if (!promptId) promptId = a
  else fail(`unexpected argument: ${a}\n${USAGE}`)
}
if (!promptId) fail(USAGE)
if (!BUCKETS[envName]) fail(`--env must be production or staging (got: ${envName ?? '(none)'})`)

try {
  // Preflight ffmpeg so the failure happens before any slow wrangler calls.
  run('ffmpeg', ['-version'])

  // --- 1. list + fetch KV rows, keep approved ---
  const { clips } = listApprovedClips(promptId, envName)
  if (!clips.length) fail(`no APPROVED clips for prompt "${promptId}" on ${envName} — approve some in the admin Voice tab first`)

  tmp = mkdtempSync(join(tmpdir(), 'jxnfc-voice-'))

  // --- 2. pull the R2 objects ---
  clips.forEach((c, i) => {
    const ext = ((c.r2Key.split('.').pop() || '').replace(/[^a-z0-9]/gi, '')) || 'bin'
    c.raw = join(tmp, `raw-${i}.${ext}`)
    pullClip(c, envName, c.raw)
  })

  // --- 3. two-pass loudnorm + 3-min cap → 48k mono wav intermediates ---
  clips.forEach((c, i) => {
    console.log(`Normalizing ${c.name || c.memberId}…`)
    c.norm = join(tmp, `norm-${i}.wav`)
    c.probedSec = normalizeClip(c.raw, c.norm, c.key)
  })

  // --- 4. concat with 0.5s gaps (between clips only, none trailing) ---
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `${promptId}-segment.wav`)
  concatWithGaps(clips.map(c => c.norm), outFile, tmp)

  // --- 5. manifest ---
  console.log(`\nWrote ${outFile}`)
  console.log('\nManifest (segment order):')
  clips.forEach((c, i) => {
    const secs = Math.min(180, c.probedSec ?? (Number(c.duration) || 0))
    console.log(`  ${i + 1}. ${c.name || c.memberId} — ${fmtDur(secs)}  (${c.key})`)
  })
  console.log('\nReminder: source clips auto-delete 60 days after submission (R2 lifecycle).')
} catch (err) {
  fail(err.message)
}
