// Shared plumbing for the voice-clip CLIs (compile_voices.mjs and
// make_audiogram.mjs): wrangler KV/R2 access, EBU R128 loudness
// normalization, and process helpers.
//
// Unlike the CLIs, everything here THROWS on failure — each CLI decides
// whether an error is fatal (compile) or a skip-with-warning (audiogram
// prompt mode, where a missing R2 object just means the clip aged out).

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// wrangler runs from worker/ so the join worker's wrangler.toml resolves the
// MEMBERS_KV binding (and --env staging).
export const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'worker')
export const BUCKETS = { production: 'jxnfilm-voice', staging: 'jxnfilm-voice-staging' }
const MAX_BUFFER = 64 * 1024 * 1024

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, ...opts })
  if (r.error?.code === 'ENOENT') {
    throw new Error(cmd === 'ffmpeg'
      ? 'ffmpeg not found — this script needs it for normalization and rendering. Install it first: brew install ffmpeg'
      : `${cmd} not found on PATH`)
  }
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`)
  return r
}

export function wrangler(args) {
  const r = run('npx', ['wrangler', ...args], { cwd: WORKER_DIR })
  if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')}\n${(r.stderr || r.stdout || `exit ${r.status}`).trim()}`)
  return r.stdout
}

// ffmpeg logs to stderr; a non-zero exit is fatal. Returns stderr for the
// loudnorm-measurement / duration parsing.
export function ffmpeg(args) {
  const r = run('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args])
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}\n${(r.stderr || `exit ${r.status}`).slice(-2000)}`)
  return r.stderr || ''
}

export const fmtDur = (sec) => {
  const whole = Math.round(Number(sec) || 0)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

const envFlags = (envName) => envName === 'staging' ? ['--env', 'staging'] : []

// List voice:{promptId}:* rows from MEMBERS_KV and return the APPROVED ones
// in submission order, each as { key, ...row }. Logs skipped rows.
export function listApprovedClips(promptId, envName) {
  console.log(`Listing voice:${promptId}: rows on ${envName}…`)
  // Slice from the first bracket — wrangler banners/update notices sometimes
  // share stdout with the JSON payload.
  const listOut = wrangler([
    'kv', 'key', 'list', '--binding', 'MEMBERS_KV',
    '--prefix', `voice:${promptId}:`, '--remote', ...envFlags(envName),
  ])
  const bracket = listOut.indexOf('[')
  if (bracket === -1) throw new Error(`unexpected wrangler kv list output:\n${listOut.slice(0, 500)}`)
  let keys
  try { keys = JSON.parse(listOut.slice(bracket)) } catch { throw new Error(`could not parse wrangler kv list output:\n${listOut.slice(0, 500)}`) }
  if (!keys.length) throw new Error(`no voice submissions found for prompt "${promptId}" on ${envName}`)

  const clips = []
  for (const k of keys) {
    const raw = wrangler(['kv', 'key', 'get', '--binding', 'MEMBERS_KV', '--remote', k.name, ...envFlags(envName)])
    let row
    try { row = JSON.parse(raw) } catch { console.warn(`  skipping ${k.name}: unparseable value`); continue }
    if (row.status !== 'approved') {
      console.log(`  ${k.name}: ${row.status || 'no status'} — skipped`)
      continue
    }
    if (!row.r2Key) { console.warn(`  skipping ${k.name}: no r2Key`); continue }
    clips.push({ key: k.name, ...row })
  }
  clips.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))  // submission order
  console.log(`${clips.length} approved clip(s) of ${keys.length} submission(s).`)
  return { clips, total: keys.length }
}

// Download a clip's R2 object to destPath. Throws on failure — the KV row can
// outlive the object briefly (KV TTL is exact, R2 lifecycle sweeps daily, and
// vice versa), so callers decide whether a miss is fatal.
export function pullClip(clip, envName, destPath) {
  console.log(`Pulling ${clip.r2Key}…`)
  wrangler(['r2', 'object', 'get', `${BUCKETS[envName]}/${clip.r2Key}`, '--file', destPath, '--remote'])
}

const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11'

// Two-pass EBU R128 loudnorm + hard 3-minute cap → 48 kHz mono WAV.
// Returns the probed source duration in seconds (or null). `label` only
// flavors error/warning messages.
export function normalizeClip(rawPath, destWav, label = rawPath) {
  // Measure pass. -t 180 here too: measuring the full clip but applying to
  // a truncated one would target the wrong loudness.
  const measured = ffmpeg(['-i', rawPath, '-t', '180',
    '-af', `${LOUDNORM}:print_format=json`, '-f', 'null', '-'])
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(measured)
  const probedSec = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null
  const s = measured.lastIndexOf('{')
  const e = measured.lastIndexOf('}')
  if (s === -1 || e <= s) throw new Error(`could not parse the loudnorm measurement for ${label}`)
  let m
  try { m = JSON.parse(measured.slice(s, e + 1)) } catch { throw new Error(`bad loudnorm JSON for ${label}`) }
  // A silent/near-silent clip measures input_i as -inf, which the apply
  // pass rejects — fall back to single-pass (dynamic) loudnorm for that
  // clip instead of killing the whole batch.
  const vals = [m.input_i, m.input_tp, m.input_lra, m.input_thresh, m.target_offset]
  if (vals.some(v => !Number.isFinite(Number(v)))) {
    console.warn(`  ${label}: non-finite loudnorm measurement (silent clip?) — using single-pass normalization`)
    ffmpeg(['-i', rawPath, '-t', '180', '-af', LOUDNORM, '-ar', '48000', '-ac', '1', destWav])
  } else {
    // Apply pass with the measured values (true two-pass, linear mode).
    ffmpeg(['-i', rawPath, '-t', '180',
      '-af', `${LOUDNORM}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
      '-ar', '48000', '-ac', '1', destWav])
  }
  return probedSec
}

// Concatenate normalized WAVs with 0.5 s silence gaps (between clips only,
// none trailing) into destWav. All inputs share format (48k mono s16 wav from
// normalizeClip) so stream copy is safe. tmpDir holds the intermediates.
export function concatWithGaps(normPaths, destWav, tmpDir) {
  const silence = join(tmpDir, 'silence.wav')
  ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.5', silence])
  const listFile = join(tmpDir, 'concat.txt')
  const lines = []
  normPaths.forEach((p, i) => {
    if (i > 0) lines.push(`file '${silence}'`)
    lines.push(`file '${p}'`)
  })
  writeFileSync(listFile, lines.join('\n') + '\n')
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', destWav])
}
