#!/usr/bin/env node
// Local admin dashboard server. Shells to `wrangler` for KV ops and writes
// `data/*.json` files directly. No auth in this process — the user's local
// `wrangler` login is the trust boundary. Binds to 127.0.0.1 only.

import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const WORKER_DIR = resolve(ROOT, 'worker')
const PORT = Number(process.env.ADMIN_PORT || 5174)

// Allowlists. Anything else in the corresponding query param hard-fails 400
// so a typo can't accidentally shell-inject or escape the admin's surface.
const VALID_ENVS = new Set(['production', 'staging'])
const VALID_BINDINGS = new Set(['MEMBERS_KV', 'ATTENDANCE_KV'])
const VALID_FILES = new Set(['data/events.json', 'data/members.json'])
const READABLE_FILES = new Set([...VALID_FILES, 'data/attendance.json', 'data/watched.json', 'data/takes.json'])

// E2E mode: when ADMIN_E2E_WORKER_ORIGIN is set (playwright.config.ts), all
// KV ops talk to that join worker's /__test/kv shim (wrangler dev --local
// with E2E_MODE=true) instead of shelling to `wrangler kv --remote`, and the
// admin proxies target the same origin. This is the only way the admin
// backend and the e2e join worker can share KV state: the wrangler CLI hits
// real Cloudflare KV, and a second Miniflare on the same persist dir races
// the first (see the SQLITE_BUSY note below). Unset → behavior unchanged.
const E2E_ORIGIN = process.env.ADMIN_E2E_WORKER_ORIGIN || null

// Deployed Worker origins per env — target for the newsletter/unlink/watched
// proxies. In E2E mode both envs collapse onto the single local dev worker
// (which already runs `--env staging`).
const WORKER_ORIGINS = E2E_ORIGIN
  ? { production: E2E_ORIGIN, staging: E2E_ORIGIN }
  : {
      production: 'https://join.jxnfilm.club',
      staging: 'https://join-staging.jxnfilm.club',
    }

// Voice-clip R2 buckets per env (see worker/wrangler.toml). Keys under
// voice/ only; both buckets carry a 60-day lifecycle deletion rule.
const VOICE_BUCKETS = { production: 'jxnfilm-voice', staging: 'jxnfilm-voice-staging' }

// wrangler r2 object get gives us bytes but no content type — infer it from
// the key's extension so <audio> gets a plausible type locally. (Hosted mode
// serves the R2 object's stored httpMetadata instead.)
const AUDIO_TYPES = {
  webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', flac: 'audio/flac',
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status }
}

function envFlags(env) {
  if (!VALID_ENVS.has(env)) throw new HttpError(400, `invalid env: ${env}`)
  return env === 'staging' ? ['--env', 'staging'] : []
}

function checkBinding(b) {
  if (!VALID_BINDINGS.has(b)) throw new HttpError(400, `invalid binding: ${b}`)
}

function runWrangler(args, stdinBody) {
  return new Promise((res, rej) => {
    const child = spawn('npx', ['wrangler', ...args], {
      cwd: WORKER_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', rej)
    child.on('close', code => {
      if (code !== 0) {
        const detail = (stderr || stdout).trim() || `exit ${code}`
        rej(new HttpError(502, `wrangler ${args.join(' ')}\n${detail}`))
      } else {
        res(stdout)
      }
    })
    if (stdinBody !== undefined) child.stdin.end(stdinBody)
    else child.stdin.end()
  })
}

// Binary-safe variant of runWrangler for R2 object bytes — the string
// accumulation above would corrupt audio through UTF-8 decoding.
function runWranglerBinary(args) {
  return new Promise((res, rej) => {
    const child = spawn('npx', ['wrangler', ...args], {
      cwd: WORKER_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks = []
    let stderr = ''
    child.stdout.on('data', d => chunks.push(d))
    child.stderr.on('data', d => { stderr += d })
    child.on('error', rej)
    child.on('close', code => {
      if (code !== 0) {
        rej(new HttpError(502, `wrangler ${args.join(' ')}\n${stderr.trim() || `exit ${code}`}`))
      } else {
        res(Buffer.concat(chunks))
      }
    })
    child.stdin.end()
  })
}

// --- KV helpers ---

// E2E transport: speak to the local join worker's /__test/kv shim. The shim's
// list returns names only (no expiration metadata) — the sessions tab shows
// "—" for expirations in e2e runs, which is acceptable.
async function e2eKv(method, params, body) {
  const url = new URL(`${E2E_ORIGIN}/__test/kv`)
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v)
  const res = await fetch(url, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) throw new HttpError(502, `e2e kv ${method} → ${res.status}`)
  return res.json()
}

// `--remote` is required since wrangler v4 flipped the default for KV ops
// from remote to local; without it we'd be reading/writing the local
// miniflare SQLite store (and racing whatever `wrangler dev` happens to
// hold the same DB open — SQLITE_BUSY in the admin UI).
async function kvList(env, binding, prefix) {
  checkBinding(binding)
  if (E2E_ORIGIN) {
    envFlags(env) // still validate the env param
    const { keys } = await e2eKv('GET', { ns: binding, prefix: prefix || '' })
    return keys.map(name => ({ name }))
  }
  const args = ['kv', 'key', 'list', '--binding', binding, '--remote', ...envFlags(env)]
  if (prefix) args.push('--prefix', prefix)
  const out = await runWrangler(args)
  return JSON.parse(out)
}

async function kvGet(env, binding, key) {
  checkBinding(binding)
  if (E2E_ORIGIN) {
    envFlags(env)
    const { value } = await e2eKv('GET', { ns: binding, key })
    return value
  }
  // wrangler exits non-zero on "key not found", which we surface as null.
  try {
    return await runWrangler(['kv', 'key', 'get', '--binding', binding, '--remote', key, ...envFlags(env)])
  } catch (e) {
    if (e.status === 502 && /not found/i.test(e.message)) return null
    throw e
  }
}

async function kvBulkGet(env, binding, keys) {
  // Parallelize with a cap so we don't spawn hundreds of procs simultaneously.
  // wrangler has no native bulk-get; each `kv key get` is ~1s of process
  // startup. With cap=8 a 50-key load takes ~7s; with cap=1 it'd take ~50s.
  const cap = 8
  const out = {}
  let i = 0
  async function worker() {
    while (true) {
      const idx = i++
      if (idx >= keys.length) return
      const key = keys[idx]
      try { out[key] = await kvGet(env, binding, key) }
      catch (e) { out[key] = { __error: e.message || String(e) } }
    }
  }
  await Promise.all(Array.from({ length: cap }, worker))
  return out
}

async function kvPut(env, binding, key, value) {
  checkBinding(binding)
  if (E2E_ORIGIN) {
    envFlags(env)
    await e2eKv('POST', {}, { ns: binding, key, value })
    return
  }
  await runWrangler(['kv', 'key', 'put', '--binding', binding, '--remote', key, value, ...envFlags(env)])
}

async function kvDelete(env, binding, key) {
  checkBinding(binding)
  if (E2E_ORIGIN) {
    envFlags(env)
    await e2eKv('DELETE', {}, { ns: binding, key })
    return
  }
  await runWrangler(['kv', 'key', 'delete', '--binding', binding, '--remote', key, ...envFlags(env)])
}

// --- File helpers ---

async function fileGet(relPath) {
  if (!READABLE_FILES.has(relPath)) throw new HttpError(400, `file not allowed: ${relPath}`)
  return await readFile(resolve(ROOT, relPath), 'utf8')
}

async function filePut(relPath, body) {
  if (!VALID_FILES.has(relPath)) throw new HttpError(400, `file not allowed: ${relPath}`)
  // Round-trip parse to validate it's well-formed JSON before persisting.
  try { JSON.parse(body) } catch (e) { throw new HttpError(400, `invalid JSON: ${e.message}`) }
  await writeFile(resolve(ROOT, relPath), body)
}

// --- HTTP routing ---

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((res, rej) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rej)
  })
}

async function serveStatic(req, res, urlPath) {
  const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\//, '')
  // Allowlist the static files the admin UI ships.
  if (!/^[a-z0-9_.-]+$/i.test(relPath)) return json(res, 404, { error: 'not found' })
  try {
    const buf = await readFile(join(HERE, relPath))
    const type = relPath.endsWith('.html') ? 'text/html; charset=utf-8'
      : relPath.endsWith('.css') ? 'text/css; charset=utf-8'
      : relPath.endsWith('.js')  ? 'application/javascript; charset=utf-8'
      : 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(buf)
  } catch {
    json(res, 404, { error: 'not found' })
  }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const method = req.method
  const q = Object.fromEntries(url.searchParams)

  // GET /api/kv?env=&binding=&prefix=  → { keys, values }
  if (method === 'GET' && url.pathname === '/api/kv') {
    const keys = await kvList(q.env, q.binding, q.prefix || '')
    const names = keys.map(k => k.name)
    const values = await kvBulkGet(q.env, q.binding, names)
    return json(res, 200, { keys, values })
  }
  // DELETE /api/kv?env=&binding=&key=
  if (method === 'DELETE' && url.pathname === '/api/kv') {
    if (!q.key) throw new HttpError(400, 'key required')
    await kvDelete(q.env, q.binding, q.key)
    return json(res, 200, { ok: true })
  }
  // PUT /api/kv?env=&binding=&key=  body = raw value
  if (method === 'PUT' && url.pathname === '/api/kv') {
    if (!q.key) throw new HttpError(400, 'key required')
    const body = await readBody(req)
    await kvPut(q.env, q.binding, q.key, body)
    return json(res, 200, { ok: true })
  }
  // GET /api/file?path=  → { content }
  if (method === 'GET' && url.pathname === '/api/file') {
    const content = await fileGet(q.path)
    return json(res, 200, { content })
  }
  // PUT /api/file?path=  body = raw JSON
  if (method === 'PUT' && url.pathname === '/api/file') {
    const body = await readBody(req)
    await filePut(q.path, body)
    return json(res, 200, { ok: true })
  }
  // POST /api/newsletter/send?env=  body = JSON { subject, html?, text?, testTo? }
  // Proxies to the deployed Worker's /admin/newsletter/send with ADMIN_TOKEN
  // held here (server-side) so the browser never sees the secret. Token per env:
  // ADMIN_TOKEN (prod) / ADMIN_TOKEN_STAGING (staging, falls back to ADMIN_TOKEN).
  if (method === 'POST' && url.pathname === '/api/newsletter/send') {
    if (!VALID_ENVS.has(q.env)) throw new HttpError(400, `invalid env: ${q.env}`)
    const token = q.env === 'staging'
      ? (process.env.ADMIN_TOKEN_STAGING || process.env.ADMIN_TOKEN)
      : process.env.ADMIN_TOKEN
    if (!token) {
      const name = q.env === 'staging' ? 'ADMIN_TOKEN_STAGING (or ADMIN_TOKEN)' : 'ADMIN_TOKEN'
      throw new HttpError(400, `set ${name} in the admin server environment before sending`)
    }
    const body = await readBody(req)
    const workerRes = await fetch(`${WORKER_ORIGINS[q.env]}/admin/newsletter/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    })
    const text = await workerRes.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { error: text || `worker ${workerRes.status}` } }
    return json(res, workerRes.status, data)
  }
  // POST /api/member/unlink?env=  body = JSON { email }
  // Proxies to the deployed Worker's /admin/member/unlink — the canonical
  // unlink cascade (member row + reverse indices + members:all + session +
  // update-member dispatch). Note: local mode no longer patches
  // data/members.json directly for this action; the update-member dispatch
  // commits it to main, and this checkout converges on `git pull`.
  if (method === 'POST' && url.pathname === '/api/member/unlink') {
    if (!VALID_ENVS.has(q.env)) throw new HttpError(400, `invalid env: ${q.env}`)
    const token = q.env === 'staging'
      ? (process.env.ADMIN_TOKEN_STAGING || process.env.ADMIN_TOKEN)
      : process.env.ADMIN_TOKEN
    if (!token) {
      const name = q.env === 'staging' ? 'ADMIN_TOKEN_STAGING (or ADMIN_TOKEN)' : 'ADMIN_TOKEN'
      throw new HttpError(400, `set ${name} in the admin server environment before unlinking`)
    }
    const body = await readBody(req)
    const workerRes = await fetch(`${WORKER_ORIGINS[q.env]}/admin/member/unlink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    })
    const text = await workerRes.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { error: text || `worker ${workerRes.status}` } }
    return json(res, workerRes.status, data)
  }
  // POST/DELETE /api/rsvp/guest?env=&event=  body = JSON { name, email?,
  // force? } (POST) or { id } (DELETE) — proxies the join Worker's
  // /events/:id/rsvp/guest so manual guest adds/removes go through the real
  // capacity/waitlist/email logic (never a raw KV write).
  if ((method === 'POST' || method === 'DELETE') && url.pathname === '/api/rsvp/guest') {
    if (!VALID_ENVS.has(q.env)) throw new HttpError(400, `invalid env: ${q.env}`)
    if (!q.event) throw new HttpError(400, 'event required')
    const token = q.env === 'staging'
      ? (process.env.ADMIN_TOKEN_STAGING || process.env.ADMIN_TOKEN)
      : process.env.ADMIN_TOKEN
    if (!token) {
      const name = q.env === 'staging' ? 'ADMIN_TOKEN_STAGING (or ADMIN_TOKEN)' : 'ADMIN_TOKEN'
      throw new HttpError(400, `set ${name} in the admin server environment before managing guests`)
    }
    const body = await readBody(req)
    const workerRes = await fetch(`${WORKER_ORIGINS[q.env]}/events/${encodeURIComponent(q.event)}/rsvp/guest`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    })
    const text = await workerRes.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { error: text || `worker ${workerRes.status}` } }
    return json(res, workerRes.status, data)
  }
  // GET /api/tmdb/search?env=&q=  → proxies the join Worker's admin-gated
  // TMDB poster search with ADMIN_TOKEN held server-side, mirroring the
  // hosted admin worker's /api/tmdb/search.
  if (method === 'GET' && url.pathname === '/api/tmdb/search') {
    if (!VALID_ENVS.has(q.env)) throw new HttpError(400, `invalid env: ${q.env}`)
    const token = q.env === 'staging'
      ? (process.env.ADMIN_TOKEN_STAGING || process.env.ADMIN_TOKEN)
      : process.env.ADMIN_TOKEN
    if (!token) {
      const name = q.env === 'staging' ? 'ADMIN_TOKEN_STAGING (or ADMIN_TOKEN)' : 'ADMIN_TOKEN'
      throw new HttpError(400, `set ${name} in the admin server environment before searching`)
    }
    const workerRes = await fetch(
      `${WORKER_ORIGINS[q.env]}/admin/tmdb/search?${new URLSearchParams({ q: q.q || '' })}`,
      { headers: { Authorization: `Bearer ${token}` } })
    const text = await workerRes.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { error: text || `worker ${workerRes.status}` } }
    return json(res, workerRes.status, data)
  }
  // GET /api/watched?env=  → proxies the join Worker's /watched map
  // (server-side fetch — the browser can't call it cross-origin itself).
  // Mirrors the hosted admin worker: asks for full depth when a token is
  // available, falls back to the public slice when it isn't.
  if (method === 'GET' && url.pathname === '/api/watched') {
    if (!VALID_ENVS.has(q.env)) throw new HttpError(400, `invalid env: ${q.env}`)
    const token = q.env === 'staging'
      ? (process.env.ADMIN_TOKEN_STAGING || process.env.ADMIN_TOKEN)
      : process.env.ADMIN_TOKEN
    const workerRes = await fetch(
      `${WORKER_ORIGINS[q.env]}/watched${token ? '?depth=full' : ''}`,
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
    const text = await workerRes.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = {} }
    return json(res, workerRes.status, data)
  }
  // GET /api/voice?env=&key=<r2Key>[&download=1]  → member voice-clip audio.
  // E2E mode proxies the join worker's /__test/r2 shim (shared simulated R2);
  // locally it shells to `wrangler r2 object get`. A missing object is the
  // EXPECTED post-lifecycle state (the bucket's 60-day rule deletes on a
  // daily cadence while the KV TTL is exact) → 404 { error: 'expired' },
  // matching the hosted admin worker — never a 5xx.
  if (method === 'GET' && url.pathname === '/api/voice') {
    if (!VALID_ENVS.has(q.env)) throw new HttpError(400, `invalid env: ${q.env}`)
    const key = q.key || ''
    if (!key.startsWith('voice/')) throw new HttpError(400, 'invalid key')
    const filename = (key.split('/').pop() || 'clip').replace(/[^\w.-]/g, '_')
    const dispo = q.download ? { 'Content-Disposition': `attachment; filename="${filename}"` } : {}
    if (E2E_ORIGIN) {
      const shim = await fetch(`${E2E_ORIGIN}/__test/r2?${new URLSearchParams({ key })}`)
      if (shim.status === 404) return json(res, 404, { error: 'expired' })
      if (!shim.ok) throw new HttpError(502, `e2e r2 shim → ${shim.status}`)
      const buf = Buffer.from(await shim.arrayBuffer())
      res.writeHead(200, {
        'Content-Type': shim.headers.get('content-type') || 'application/octet-stream',
        'Content-Length': buf.length,
        ...dispo,
      })
      return res.end(buf)
    }
    // `--remote` is REQUIRED here too: wrangler v4 defaults r2 object ops to
    // the local simulator (same trap as the KV commands above).
    let buf
    try {
      buf = await runWranglerBinary(['r2', 'object', 'get', `${VOICE_BUCKETS[q.env]}/${key}`, '--pipe', '--remote'])
    } catch (e) {
      if (e.status === 502 && /not exist|not found|404/i.test(e.message)) {
        return json(res, 404, { error: 'expired' })
      }
      throw e
    }
    const ext = (key.split('.').pop() || '').toLowerCase()
    res.writeHead(200, {
      'Content-Type': AUDIO_TYPES[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      ...dispo,
    })
    return res.end(buf)
  }
  // POST /api/voice/status?env=   body = JSON { key, status } — and —
  // POST /api/voice/publish?env=  body = JSON { promptId, published } — and —
  // DELETE /api/voice?env=        body = JSON { key }
  // Voice moderation MUST go through the join Worker: it rewrites the KV row
  // with its remaining TTL (and deletes the R2 object on delete). A raw
  // /api/kv PUT would drop the TTL and make the row persistent. In E2E mode
  // WORKER_ORIGINS collapses onto the local dev worker and playwright's
  // ADMIN_TOKEN=e2e-admin-token applies; locally these need a real token in
  // the environment — without one they're hosted-portal-only.
  if ((method === 'POST' && url.pathname === '/api/voice/status') ||
      (method === 'POST' && url.pathname === '/api/voice/publish') ||
      (method === 'POST' && url.pathname === '/api/voice/transcript') ||
      (method === 'DELETE' && url.pathname === '/api/voice')) {
    if (!VALID_ENVS.has(q.env)) throw new HttpError(400, `invalid env: ${q.env}`)
    const token = q.env === 'staging'
      ? (process.env.ADMIN_TOKEN_STAGING || process.env.ADMIN_TOKEN)
      : process.env.ADMIN_TOKEN
    if (!token) {
      const name = q.env === 'staging' ? 'ADMIN_TOKEN_STAGING (or ADMIN_TOKEN)' : 'ADMIN_TOKEN'
      throw new HttpError(501, `voice moderation proxies the join Worker and needs its ${name} — export it before \`npm run admin\`, or use the hosted portal (admin.jxnfilm.club) where the secret is already set`)
    }
    const adminPath = url.pathname === '/api/voice/status' ? '/admin/voice/status'
      : url.pathname === '/api/voice/publish' ? '/admin/voice/publish'
      : url.pathname === '/api/voice/transcript' ? '/admin/voice/transcript'
      : '/admin/voice'
    const body = await readBody(req)
    const workerRes = await fetch(`${WORKER_ORIGINS[q.env]}${adminPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    })
    const text = await workerRes.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = { error: text || `worker ${workerRes.status}` } }
    return json(res, workerRes.status, data)
  }
  // GET /api/img?url=  → proxied image bytes for Content Gen canvas
  // rendering (same-origin, so the canvas isn't CORS-tainted). Mirrors the
  // hosted admin worker's allowlist — keep the two in sync.
  if (method === 'GET' && url.pathname === '/api/img') {
    const IMG_PROXY_HOSTS = new Set(['image.tmdb.org', 'a.ltrbxd.com', 's.ltrbxd.com', 'jxnfilm.club'])
    let target
    try { target = new URL(q.url) } catch { throw new HttpError(400, 'invalid url') }
    if (target.protocol !== 'https:' || !IMG_PROXY_HOSTS.has(target.hostname)) {
      throw new HttpError(403, `host not allowed: ${target.hostname || '(none)'}`)
    }
    const imgRes = await fetch(target.href)
    if (!imgRes.ok) throw new HttpError(502, `image fetch failed: ${imgRes.status}`)
    const type = imgRes.headers.get('content-type') || ''
    if (!type.startsWith('image/')) throw new HttpError(502, `not an image: ${type || '(no content-type)'}`)
    const buf = Buffer.from(await imgRes.arrayBuffer())
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'Content-Length': buf.length })
    return res.end(buf)
  }
  // Lightweight liveness probe. In E2E mode skip the wrangler subprocess —
  // there's no Cloudflare auth involved and each spawn costs ~1s per page load.
  if (method === 'GET' && url.pathname === '/api/whoami') {
    if (E2E_ORIGIN) return json(res, 200, { email: 'e2e@local', mode: 'e2e' })
    const out = await runWrangler(['whoami']).catch(e => `not authenticated: ${e.message}`)
    return json(res, 200, { wrangler: out.trim() })
  }
  // Static files.
  if (method === 'GET') return serveStatic(req, res, url.pathname)
  json(res, 405, { error: 'method not allowed' })
}

const server = createServer(async (req, res) => {
  try {
    await handle(req, res)
  } catch (e) {
    const status = e?.status || 500
    json(res, status, { error: e?.message || String(e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`jxnfilmclub admin → http://localhost:${PORT}`)
  console.log(`  (wrangler whoami: run \`npx wrangler whoami\` if KV calls fail)`)
})
