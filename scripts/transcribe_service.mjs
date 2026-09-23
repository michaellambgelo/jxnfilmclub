#!/usr/bin/env node
// node0's always-on caption drafter for member voice clips.
//
//   TRANSCRIBE_TOKEN=… node scripts/transcribe_service.mjs
//
// The join Worker POSTs { key, env } to /hook the moment a clip is submitted
// (and again from its daily cron for anything still undrafted). This service
// answers 202 at once, then — one clip at a time — pulls the audio from the
// Worker, runs whisper locally, and posts the SRT back as a DRAFT. A draft is
// never a reviewed transcript: an admin still saves or "marks reviewed" it in
// the Voice tab before any captions render (worker: handleTranscriberDraft).
//
// Privacy shape: audio and transcript exist on this machine only inside a
// per-clip temp directory, removed in `finally`. Nothing is archived here —
// the 60-day retention promise is kept by R2 and KV, and an always-on box
// quietly accumulating clips would sit outside it.
//
// The hook names an ENVIRONMENT, never a URL: the Worker origin is looked up
// in ORIGINS below, so the token is only ever presented to a host this file
// already trusts, whatever a caller puts in the body.
//
// Env:
//   TRANSCRIBE_TOKEN     required; shared with the Worker's TRANSCRIBE_TOKEN secret
//   TRANSCRIBE_BIND      default 0.0.0.0 (the node6 tunnel reaches it over the LAN)
//   TRANSCRIBE_PORT      default 8088
//   TRANSCRIBE_MODEL     default small (scripts/lib/whisper.mjs MODELS)
//   TRANSCRIBE_DEFER     optional path to cluster-ops' defer-if-streaming.sh
//   TRANSCRIBE_LOG       default ~/Library/Logs/jxnfilm-transcribe/events.log

import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captionCues, formatSrt } from './lib/srt.mjs'
import { DEFAULT_MODEL, RAW_SRT, wavArgs, whisperArgs } from './lib/whisper.mjs'

export const ORIGINS = {
  production: 'https://join.jxnfilm.club',
  staging: 'https://join-staging.jxnfilm.club',
}
const HOOK_MAX_BYTES = 4096
const WHISPER_TIMEOUT_MS = 10 * 60 * 1000
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]

// --- pure helpers (unit-tested) ---

export function authorized(header, token) {
  if (!token || typeof header !== 'string') return false
  const a = Buffer.from(header)
  const b = Buffer.from(`Bearer ${token}`)
  return a.length === b.length && timingSafeEqual(a, b)
}

// { key, env } → a job, or null for anything malformed. Unknown fields
// (an `origin`, a URL) are ignored rather than trusted.
export function parseHook(text) {
  let body
  try { body = JSON.parse(text) } catch { return null }
  if (!body || typeof body !== 'object') return null
  const { key, env } = body
  if (typeof key !== 'string' || !/^voice:[^\s]{1,200}$/.test(key)) return null
  if (!Object.hasOwn(ORIGINS, env)) return null
  return { key, env }
}

function logfmtValue(v) {
  const s = String(v)
  return /[\s="]/.test(s) || s === '' ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"` : s
}

export function logfmt(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${logfmtValue(v)}`).join(' ')
}

// --- the queue ---

// One whisper at a time: it is a GPU burst on a machine that also streams.
// Keyed by env+key so a clip nudged twice (submit + cron) is drafted once.
export function createQueue(processJob) {
  const waiting = []
  const queued = new Set()
  let running = null
  let last = null

  async function drain() {
    if (running) return
    while (waiting.length) {
      const job = waiting.shift()
      running = job
      try {
        last = { ...job, ...(await processJob(job)), at: new Date().toISOString() }
      } catch (err) {
        last = { ...job, result: 'error', detail: err.message, at: new Date().toISOString() }
      } finally {
        queued.delete(`${job.env}|${job.key}`)
        running = null
      }
    }
  }

  return {
    push(job) {
      const id = `${job.env}|${job.key}`
      if (queued.has(id)) return false
      queued.add(id)
      waiting.push(job)
      drain()
      return true
    },
    status: () => ({ queued: waiting.length, running: running && running.key, last }),
    idle: () => new Promise(resolve => {
      const tick = () => (running || waiting.length) ? setTimeout(tick, 10) : resolve()
      tick()
    }),
  }
}

// --- the HTTP face ---

export function createHookServer({ token, queue }) {
  return createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, ...queue.status() })
    if (req.method !== 'POST' || req.url !== '/hook') return send(404, { error: 'not found' })
    if (!authorized(req.headers.authorization, token)) return send(401, { error: 'unauthorized' })

    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > HOOK_MAX_BYTES) { send(413, { error: 'too large' }); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => {
      if (res.headersSent) return
      const job = parseHook(Buffer.concat(chunks).toString('utf8'))
      if (!job) return send(400, { error: 'expected { key: "voice:…", env: "production"|"staging" }' })
      send(202, { accepted: queue.push(job) })
    })
  })
}

// --- the work ---

function spawnP(cmd, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000) })
    const timer = timeoutMs && setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', err => { clearTimeout(timer); reject(err.code === 'ENOENT' ? new Error(`${cmd} not found on PATH`) : err) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

export function createWorker({ token, model = DEFAULT_MODEL, deferScript, log, fetchImpl = fetch }) {
  // Network and 5xx retry; 4xx is an answer, not a failure.
  async function call(url, init) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(url, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } })
        if (res.status < 500 || attempt >= RETRY_DELAYS_MS.length) return res
      } catch (err) {
        if (attempt >= RETRY_DELAYS_MS.length) throw err
      }
      await sleep(RETRY_DELAYS_MS[attempt])
    }
  }

  async function deferred() {
    if (!deferScript) return false
    // --wait 60 7200: poll each minute, give up after two hours. Giving up
    // is safe — the Worker's daily cron re-nudges anything still undrafted.
    try { await spawnP('bash', [deferScript, '--wait', '60', '7200']); return false } catch { return true }
  }

  return async function processJob({ key, env }) {
    const origin = ORIGINS[env]
    const t0 = Date.now()
    if (await deferred()) {
      log({ event: 'deferred', env, key })
      return { result: 'deferred' }
    }
    const tmp = mkdtempSync(join(tmpdir(), 'jxnfc-draft-'))
    try {
      const audioRes = await call(`${origin}/transcriber/audio?key=${encodeURIComponent(key)}`)
      if (audioRes.status === 404) { log({ event: 'gone', env, key }); return { result: 'gone' } }
      if (!audioRes.ok) throw new Error(`audio fetch ${audioRes.status}`)
      const at = audioRes.headers.get('X-Voice-At')
      const audioPath = join(tmp, 'clip.audio')
      writeFileSync(audioPath, Buffer.from(await audioRes.arrayBuffer()))

      const wav = join(tmp, 'clip-16k.wav')
      await spawnP('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...wavArgs(audioPath, wav)])
      await spawnP('uvx', whisperArgs(wav, tmp, model), { timeoutMs: WHISPER_TIMEOUT_MS })
      const cues = captionCues(readFileSync(join(tmp, RAW_SRT), 'utf8'))
      if (!cues.length) {
        // Silence, or a clip whisper could not hear. Nothing to caption; the
        // cron will re-nudge daily and get the same answer, which is cheap.
        log({ event: 'no_speech', env, key, ms: Date.now() - t0 })
        return { result: 'no_speech' }
      }

      const srt = formatSrt(cues)
      const res = await call(`${origin}/transcriber/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, at, srt }),
      })
      // 409 = a transcript already exists, or the member replaced / deleted
      // the clip mid-run. Either way there is nothing more to do for this job.
      const result = res.ok ? 'drafted' : res.status === 409 ? 'superseded' : res.status === 404 ? 'gone' : null
      if (!result) throw new Error(`draft post ${res.status}: ${(await res.text()).slice(0, 200)}`)
      log({ event: result, env, key, cues: cues.length, ms: Date.now() - t0, model })
      return { result }
    } catch (err) {
      log({ event: 'error', env, key, detail: err.message.slice(0, 300), ms: Date.now() - t0 })
      throw err
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

// Catch up on anything submitted while this service was down.
async function sweep({ token, queue, log }) {
  for (const env of Object.keys(ORIGINS)) {
    try {
      const res = await fetch(`${ORIGINS[env]}/transcriber/pending`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) { log({ event: 'sweep_error', env, status: res.status }); continue }
      const { keys = [] } = await res.json()
      for (const key of keys) queue.push({ key, env })
      log({ event: 'sweep', env, pending: keys.length })
    } catch (err) {
      log({ event: 'sweep_error', env, detail: err.message })
    }
  }
}

// --- main ---

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const token = process.env.TRANSCRIBE_TOKEN
  if (!token) {
    // Fail closed, like laya's LAYA_TOKEN: an unauthenticated hook would let
    // anyone who finds the hostname make this box fetch and transcribe.
    console.error('TRANSCRIBE_TOKEN is not set; refusing to start')
    process.exit(1)
  }
  // A mistyped guard path would make every job look "deferred" forever.
  if (process.env.TRANSCRIBE_DEFER && !existsSync(process.env.TRANSCRIBE_DEFER)) {
    console.error(`TRANSCRIBE_DEFER=${process.env.TRANSCRIBE_DEFER} does not exist; refusing to start`)
    process.exit(1)
  }
  const logPath = process.env.TRANSCRIBE_LOG || join(homedir(), 'Library/Logs/jxnfilm-transcribe/events.log')
  mkdirSync(dirname(logPath), { recursive: true })
  const log = fields => {
    const line = logfmt({ ts: new Date().toISOString(), svc: 'jxnfilm-transcribe', ...fields })
    appendFileSync(logPath, line + '\n')
    console.log(line)
  }

  const processJob = createWorker({
    token, log,
    model: process.env.TRANSCRIBE_MODEL || DEFAULT_MODEL,
    deferScript: process.env.TRANSCRIBE_DEFER || null,
  })
  const queue = createQueue(processJob)
  const bind = process.env.TRANSCRIBE_BIND || '0.0.0.0'
  const port = Number(process.env.TRANSCRIBE_PORT || 8088)
  createHookServer({ token, queue }).listen(port, bind, () => {
    log({ event: 'start', bind, port, model: process.env.TRANSCRIBE_MODEL || DEFAULT_MODEL })
    sweep({ token, queue, log })
  })
}
