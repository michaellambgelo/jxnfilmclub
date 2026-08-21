// Shared plumbing for the voice-clip CLIs (compile_voices.mjs and
// make_audiogram.mjs): wrangler KV/R2 access, EBU R128 loudness
// normalization, and process helpers.
//
// Unlike the CLIs, everything here THROWS on failure — each CLI decides
// whether an error is fatal (compile) or a skip-with-warning (audiogram
// prompt mode, where a missing R2 object just means the clip aged out).

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
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

// Argv for one R2 object fetch.
//
// The --file path is absolutized HERE, at the boundary, because wrangler runs
// with cwd = worker/ (that's how the MEMBERS_KV binding resolves) while Node
// resolves the same relative string against the repo root. Hand it
// 'out/archive/x.webm' and the bytes land in worker/out/archive/x.webm while
// the caller looks in out/archive/x.webm and sees nothing. Every pull used to
// target an absolute temp path, which hid this until source audio started
// being kept under the relative --out.
export function r2GetArgs(bucket, r2Key, filePath) {
  return ['r2', 'object', 'get', `${bucket}/${r2Key}`, '--file', resolve(filePath), '--remote']
}

// Argv for writing one object back to R2. Absolutized for the same reason
// r2GetArgs is: wrangler's cwd is worker/, this process's is the repo root.
export function r2PutArgs(bucket, key, filePath, contentType) {
  return ['r2', 'object', 'put', `${bucket}/${key}`, '--file', resolve(filePath),
    ...(contentType ? ['--content-type', contentType] : []), '--remote']
}

// Where a clip's transcript lives, on both sides of the wire: beside the audio
// locally, beside the object in R2. Same stem, .srt extension — so the bucket's
// all-prefixes 60-day lifecycle expires a transcript with the recording it
// describes, without anyone configuring that.
export function transcriptPathFor(outDir, promptId, clip) {
  return archivePathFor(outDir, promptId, clip).replace(/\.[^.]+$/, '.srt')
}

export function transcriptKeyFor(clip) {
  return String(clip.r2Key || '').replace(/\.[^.]+$/, '.srt')
}

// Does a failed pull actually mean the object is gone? Only a real R2 miss is
// the expected 60-day-lifecycle state; a local filesystem or process error is
// a bug, and reporting it as "likely expired" sends you looking in the wrong
// place entirely.
export function looksMissing(err) {
  const m = String((err && err.message) || err || '')
  return /\b404\b|not\s*found|does not exist|NoSuchKey|The specified key/i.test(m)
}

// Where an explicitly archived copy of a clip lives. One shared definition so
// the CLIs and the TUI can't disagree about it — the CLIs READ this location
// to avoid re-downloading, the TUI's archive action WRITES it.
export function archivePathFor(outDir, promptId, clip) {
  const ext = extname(clip.r2Key || '') || '.bin'
  return join(outDir, 'archive', promptId, `${clip.memberId}${ext}`)
}

// Is `path` a byte-complete copy of this clip? The KV row records the exact
// uploaded byte count, which is the only integrity signal available —
// wrangler exposes no ETag and no HEAD.
export function isCompleteCopy(path, expectedSize) {
  if (!existsSync(path)) return false
  if (!Number.isInteger(expectedSize) || expectedSize <= 0) return false
  try {
    return statSync(path).size === expectedSize
  } catch {
    return false
  }
}

// Download a clip's R2 object to destPath — IDEMPOTENTLY.
//
// Repeating a pull is free and repeating an interrupted pull is safe:
//   * destPath already byte-complete → no request at all;
//   * an explicitly archived copy is byte-complete → copied locally, no request;
//   * otherwise download to `.part` and rename, so a failed or cancelled
//     transfer can never leave a truncated file sitting at the real path
//     looking like a finished one.
//
// Returns { source: 'cache' | 'archive' | 'r2', bytes }. Throws on failure —
// the KV row can outlive the object briefly (KV TTL is exact, the R2 lifecycle
// sweeps daily, and vice versa), so callers decide whether a miss is fatal.
export function pullClip(clip, envName, destPath, opts = {}) {
  const expected = Number.isInteger(opts.expectedSize) ? opts.expectedSize
    : (Number.isInteger(clip.size) ? clip.size : null)

  if (isCompleteCopy(destPath, expected)) {
    console.log(`Reusing ${destPath} (already complete, ${expected} bytes)`)
    return { source: 'cache', bytes: expected }
  }
  if (opts.reuseFrom && isCompleteCopy(opts.reuseFrom, expected)) {
    console.log(`Reusing archived ${opts.reuseFrom} (${expected} bytes) — no R2 request`)
    mkdirSync(dirname(destPath), { recursive: true })
    copyFileSync(opts.reuseFrom, destPath)
    return { source: 'archive', bytes: expected }
  }
  if (existsSync(destPath)) {
    // Present but the wrong size: a half-finished earlier transfer. Replacing
    // it is a repair, and it is announced rather than silent.
    console.log(`Re-pulling ${clip.r2Key} — ${destPath} is ${statSync(destPath).size} bytes, expected ${expected ?? '?'}`)
  }

  console.log(`Pulling ${clip.r2Key}…`)
  // Absolute from here down: the rename and the stat run in the Node process's
  // cwd, the download runs in wrangler's. They must name the same file.
  const dest = isAbsolute(destPath) ? destPath : resolve(destPath)
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  rmSync(part, { force: true })
  try {
    wrangler(r2GetArgs(BUCKETS[envName], clip.r2Key, part))
    if (!existsSync(part)) {
      throw new Error(`wrangler reported success but wrote nothing to ${part}`)
    }
    renameSync(part, dest)
  } catch (err) {
    rmSync(part, { force: true })
    throw err
  }
  return { source: 'r2', bytes: statSync(dest).size }
}

// Refuse to overwrite finished output.
//
// Nothing in this pipeline deletes or replaces a file in out/ on its own: a
// run that would land on top of an existing render stops and names the
// conflicts instead. `force` is the only way past, and it is never a default.
export function ensureWritable(paths, { force = false } = {}) {
  if (force) return []
  const clashes = paths.filter(p => existsSync(p))
  if (clashes.length) {
    const shown = clashes.slice(0, 8).map(p => `  ${p}`).join('\n')
    const more = clashes.length > 8 ? `\n  …and ${clashes.length - 8} more` : ''
    throw new Error(
      `refusing to overwrite ${clashes.length} existing output file(s):\n${shown}${more}\n` +
      'Move or delete them yourself, render to a different --out, or pass --force.')
  }
  return clashes
}

// Duration in seconds, parsed off ffmpeg's own report — the caption timeline
// has to know how long the rendered audio actually is, and the render input is
// the NORMALIZED file (capped at 3 minutes), not the source.
export function probeSeconds(path) {
  const out = ffmpeg(['-i', path, '-f', 'null', '-'])
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out)
  if (!m) throw new Error(`could not read the duration of ${path}`)
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
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

// Silence inserted between clips in a compiled segment. Exported because the
// caption track has to shift each clip's cues by exactly this much — if the
// two ever disagreed, every caption after the first clip would drift and end
// up attributed to the wrong speaker.
export const CONCAT_GAP_SECONDS = 0.5

// Concatenate normalized WAVs with CONCAT_GAP_SECONDS silence gaps (between
// clips only, none trailing) into destWav. All inputs share format (48k mono s16 wav from
// normalizeClip) so stream copy is safe. tmpDir holds the intermediates.
export function concatWithGaps(normPaths, destWav, tmpDir) {
  const silence = join(tmpDir, 'silence.wav')
  ffmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', String(CONCAT_GAP_SECONDS), silence])
  const listFile = join(tmpDir, 'concat.txt')
  const lines = []
  normPaths.forEach((p, i) => {
    if (i > 0) lines.push(`file '${silence}'`)
    lines.push(`file '${p}'`)
  })
  writeFileSync(listFile, lines.join('\n') + '\n')
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', destWav])
}
