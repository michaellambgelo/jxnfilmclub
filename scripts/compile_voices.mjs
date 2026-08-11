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
// IMPORTANT: clips — including approved ones — auto-delete 60 days after
// submission (R2 bucket lifecycle + KV TTL). Run this before they age out.
//
// Every wrangler call passes --remote explicitly: wrangler v4 defaults KV/R2
// ops to the local simulator, which would silently read nothing.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// wrangler runs from worker/ so the join worker's wrangler.toml resolves the
// MEMBERS_KV binding (and --env staging).
const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'worker')
const BUCKETS = { production: 'jxnfilm-voice', staging: 'jxnfilm-voice-staging' }
const USAGE = 'usage: node scripts/compile_voices.mjs <promptId> [--env production|staging] [--out DIR]'
const MAX_BUFFER = 64 * 1024 * 1024

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

// --- process helpers ---

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, ...opts })
  if (r.error?.code === 'ENOENT') {
    fail(cmd === 'ffmpeg'
      ? 'ffmpeg not found — this script needs it for normalization and concat. Install it first: brew install ffmpeg'
      : `${cmd} not found on PATH`)
  }
  if (r.error) fail(`${cmd} failed to start: ${r.error.message}`)
  return r
}

function wrangler(args) {
  const r = run('npx', ['wrangler', ...args], { cwd: WORKER_DIR })
  if (r.status !== 0) fail(`wrangler ${args.join(' ')}\n${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`)
  return r.stdout
}

// ffmpeg logs to stderr; a non-zero exit is fatal. Returns stderr for the
// loudnorm-measurement / duration parsing.
function ffmpeg(args) {
  const r = run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args])
  if (r.status !== 0) fail(`ffmpeg ${args.join(' ')}\n${(r.stderr || `exit ${r.status}`).slice(-2000)}`)
  return r.stderr || ''
}

const fmtDur = (sec) => {
  const whole = Math.round(Number(sec) || 0)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

// Preflight ffmpeg so the failure happens before any slow wrangler calls.
run('ffmpeg', ['-version'])

const envFlags = envName === 'staging' ? ['--env', 'staging'] : []

// --- 1. list + fetch KV rows, keep approved ---

console.log(`Listing voice:${promptId}: rows on ${envName}…`)
// Slice from the first bracket — wrangler banners/update notices sometimes
// share stdout with the JSON payload.
const listOut = wrangler([
  'kv', 'key', 'list', '--binding', 'MEMBERS_KV',
  '--prefix', `voice:${promptId}:`, '--remote', ...envFlags,
])
const bracket = listOut.indexOf('[')
if (bracket === -1) fail(`unexpected wrangler kv list output:\n${listOut.slice(0, 500)}`)
let keys
try { keys = JSON.parse(listOut.slice(bracket)) } catch { fail(`could not parse wrangler kv list output:\n${listOut.slice(0, 500)}`) }
if (!keys.length) fail(`no voice submissions found for prompt "${promptId}" on ${envName}`)

const clips = []
for (const k of keys) {
  const raw = wrangler(['kv', 'key', 'get', '--binding', 'MEMBERS_KV', '--remote', k.name, ...envFlags])
  let row
  try { row = JSON.parse(raw) } catch { console.warn(`  skipping ${k.name}: unparseable value`); continue }
  if (row.status !== 'approved') {
    console.log(`  ${k.name}: ${row.status || 'no status'} — skipped`)
    continue
  }
  if (!row.r2Key) { console.warn(`  skipping ${k.name}: no r2Key`); continue }
  clips.push({ key: k.name, ...row })
}
if (!clips.length) fail(`no APPROVED clips for prompt "${promptId}" on ${envName} — approve some in the admin Voice tab first`)
clips.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))  // submission order
console.log(`${clips.length} approved clip(s) of ${keys.length} submission(s).`)

tmp = mkdtempSync(join(tmpdir(), 'jxnfc-voice-'))
try {
  // --- 2. pull the R2 objects ---
  clips.forEach((c, i) => {
    const ext = ((c.r2Key.split('.').pop() || '').replace(/[^a-z0-9]/gi, '')) || 'bin'
    c.raw = join(tmp, `raw-${i}.${ext}`)
    console.log(`Pulling ${c.r2Key}…`)
    wrangler(['r2', 'object', 'get', `${BUCKETS[envName]}/${c.r2Key}`, '--file', c.raw, '--remote'])
  })

  // --- 3. two-pass loudnorm + 3-min cap → 48k mono wav intermediates ---
  const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11'
  clips.forEach((c, i) => {
    console.log(`Normalizing ${c.name || c.memberId}…`)
    // Measure pass. -t 180 here too: measuring the full clip but applying to
    // a truncated one would target the wrong loudness.
    const measured = ffmpeg(['-i', c.raw, '-t', '180',
      '-af', `${LOUDNORM}:print_format=json`, '-f', 'null', '-'])
    const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(measured)
    if (dur) c.probedSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
    const s = measured.lastIndexOf('{')
    const e = measured.lastIndexOf('}')
    if (s === -1 || e <= s) fail(`could not parse the loudnorm measurement for ${c.key}`)
    let m
    try { m = JSON.parse(measured.slice(s, e + 1)) } catch { fail(`bad loudnorm JSON for ${c.key}`) }
    c.norm = join(tmp, `norm-${i}.wav`)
    // A silent/near-silent clip measures input_i as -inf, which the apply
    // pass rejects — fall back to single-pass (dynamic) loudnorm for that
    // clip instead of killing the whole batch.
    const vals = [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset]
    if (vals.some(v => !Number.isFinite(Number(v)))) {
      console.warn(`  ${c.key}: non-finite loudnorm measurement (silent clip?) — using single-pass normalization`)
      ffmpeg(['-i', c.raw, '-t', '180', '-af', LOUDNORM, '-ar', '48000', '-ac', '1', c.norm])
    } else {
      // Apply pass with the measured values (true two-pass, linear mode).
      ffmpeg(['-i', c.raw, '-t', '180',
        '-af', `${LOUDNORM}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
        '-ar', '48000', '-ac', '1', c.norm])
    }
  })

  // --- 4. concat with 0.5s gaps (between clips only, none trailing) ---
  const silence = join(tmp, 'silence.wav')
  ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.5', silence])
  const listFile = join(tmp, 'concat.txt')
  const lines = []
  clips.forEach((c, i) => {
    if (i > 0) lines.push(`file '${silence}'`)
    lines.push(`file '${c.norm}'`)
  })
  writeFileSync(listFile, lines.join('\n') + '\n')

  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `${promptId}-segment.wav`)
  // All inputs share format (48k mono s16 wav) so stream copy is safe.
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile])

  // --- 5. manifest ---
  console.log(`\nWrote ${outFile}`)
  console.log('\nManifest (segment order):')
  clips.forEach((c, i) => {
    const secs = Math.min(180, c.probedSec ?? (Number(c.duration) || 0))
    console.log(`  ${i + 1}. ${c.name || c.memberId} — ${fmtDur(secs)}  (${c.key})`)
  })
  console.log('\nReminder: source clips auto-delete 60 days after submission (R2 lifecycle).')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
