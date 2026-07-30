// Hosted admin dashboard Worker — admin.jxnfilm.club.
//
// Two independent gates in front of every byte, including the static files:
//   1. Cloudflare Access (One-time PIN) terminates anonymous traffic at the
//      edge before it reaches this Worker.
//   2. This Worker verifies the Cf-Access-Jwt-Assertion JWT itself (RS256
//      against the team's public JWKS), so a routing or Access-config
//      mistake can never expose the portal. No valid JWT → 403.
//
// Serves the same SPA files as the local dashboard (admin/index.html,
// admin.js, style.css — Text module imports) and reimplements
// admin/server.mjs's /api surface against direct KV bindings. The local
// dashboard remains the fallback and the only place that can patch
// data/members.json; here /api/file is a 404 and the snapshot crons
// reconcile the JSON within 6h.

import indexHtml from '../../index.html'
import adminJs from '../../admin.js'
import styleCss from '../../style.css'

const VALID_ENVS = new Set(['production', 'staging'])
const VALID_BINDINGS = new Set(['MEMBERS_KV', 'ATTENDANCE_KV'])

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status }
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
})

// --- Access JWT verification (RS256, WebCrypto, no deps) ---

const b64urlToBytes = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/') + pad)
  return Uint8Array.from(bin, c => c.charCodeAt(0))
}

const decodeSegment = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)))

// Pure verification core — takes the JWKS keys explicitly so tests can sign
// with an in-test keypair, no network. Returns the payload or null.
export async function verifyAccessJwt(token, keys, { aud, issuer, now = Date.now() } = {}) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  let header, payload
  try {
    header = decodeSegment(parts[0])
    payload = decodeSegment(parts[1])
  } catch { return null }
  if (header.alg !== 'RS256') return null
  const jwk = (keys || []).find(k => k.kid === header.kid)
  if (!jwk) return null
  let ok
  try {
    const key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  } catch { return null }
  if (!ok) return null
  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!aud || !audList.includes(aud)) return null
  if (issuer && payload.iss !== issuer) return null
  if (!payload.exp || payload.exp * 1000 <= now) return null
  return payload
}

let jwksCache = { keys: null, fetchedAt: 0 }
const JWKS_TTL_MS = 60 * 60 * 1000

async function fetchJwks(teamDomain, force = false) {
  if (!force && jwksCache.keys && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!res.ok) throw new HttpError(502, `jwks fetch failed: ${res.status}`)
  const { keys } = await res.json()
  jwksCache = { keys, fetchedAt: Date.now() }
  return keys
}

async function requireAccess(request, env) {
  // Fail closed: no token, or the Worker not yet configured → no access.
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null
  let keys = await fetchJwks(env.ACCESS_TEAM_DOMAIN).catch(() => null)
  if (!keys) return null
  // Unknown kid can mean Cloudflare rotated the signing certs mid-cache —
  // refetch once before rejecting.
  let kid
  try { kid = decodeSegment(token.split('.')[0]).kid } catch { return null }
  if (kid && !keys.some(k => k.kid === kid)) {
    keys = await fetchJwks(env.ACCESS_TEAM_DOMAIN, true).catch(() => null)
    if (!keys) return null
  }
  return verifyAccessJwt(token, keys, {
    aud: env.ACCESS_AUD,
    issuer: `https://${env.ACCESS_TEAM_DOMAIN}`,
  })
}

// --- KV plumbing ---

function kvFor(env, envName, binding) {
  if (!VALID_ENVS.has(envName)) throw new HttpError(400, `invalid env: ${envName}`)
  if (!VALID_BINDINGS.has(binding)) throw new HttpError(400, `invalid binding: ${binding}`)
  return env[envName === 'staging' ? `${binding}_STAGING` : binding]
}

async function kvListAll(kv, prefix) {
  const keys = []
  let cursor
  do {
    const page = await kv.list({ prefix: prefix || undefined, cursor })
    keys.push(...page.keys)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return keys
}

// name → string|null map for the listed keys. Bulk get (array form, ≤100
// keys per call) keeps subrequest counts low; falls back to capped parallel
// singles where bulk isn't available.
async function kvValues(kv, names) {
  const values = {}
  for (let i = 0; i < names.length; i += 100) {
    const chunk = names.slice(i, i + 100)
    let got = null
    if (chunk.length > 1) {
      try { got = await kv.get(chunk) } catch { got = null }
    }
    if (got instanceof Map) {
      for (const n of chunk) values[n] = got.get(n) ?? null
    } else {
      const cap = 10
      let next = 0
      const worker = async () => {
        while (next < chunk.length) {
          const name = chunk[next++]
          values[name] = await kv.get(name)
        }
      }
      await Promise.all(Array.from({ length: Math.min(cap, chunk.length) }, worker))
    }
  }
  return values
}

// --- Newsletter proxy (service bindings — see wrangler.toml) ---

async function handleNewsletterSend(request, env, q) {
  if (!VALID_ENVS.has(q.env)) throw new HttpError(400, `invalid env: ${q.env}`)
  const staging = q.env === 'staging'
  const service = staging ? env.JOIN_WORKER_STAGING : env.JOIN_WORKER
  const token = staging ? (env.ADMIN_TOKEN_STAGING || env.ADMIN_TOKEN) : env.ADMIN_TOKEN
  if (!token) {
    const name = staging ? 'ADMIN_TOKEN_STAGING (or ADMIN_TOKEN)' : 'ADMIN_TOKEN'
    throw new HttpError(400, `set the ${name} secret on the admin worker before sending`)
  }
  // The join Worker derives unsubscribe-link origins from request.url, so
  // pass its real public URL through the service binding.
  const origin = staging ? 'https://join-staging.jxnfilm.club' : 'https://join.jxnfilm.club'
  const workerRes = await service.fetch(`${origin}/admin/newsletter/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: await request.text(),
  })
  const text = await workerRes.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { error: text || `worker ${workerRes.status}` } }
  return json(workerRes.status, data)
}

// --- Static files (Text module imports; nothing else ships) ---

const STATIC = {
  '/': [indexHtml, 'text/html; charset=utf-8'],
  '/index.html': [indexHtml, 'text/html; charset=utf-8'],
  '/admin.js': [adminJs, 'application/javascript; charset=utf-8'],
  '/style.css': [styleCss, 'text/css; charset=utf-8'],
}

// --- Routing (mirrors admin/server.mjs handle()) ---

async function handle(request, env, access) {
  const url = new URL(request.url)
  const method = request.method
  const q = Object.fromEntries(url.searchParams)

  // GET /api/kv?env=&binding=&prefix=  → { keys, values }
  if (method === 'GET' && url.pathname === '/api/kv') {
    const kv = kvFor(env, q.env, q.binding)
    const keys = await kvListAll(kv, q.prefix || '')
    const values = await kvValues(kv, keys.map(k => k.name))
    return json(200, { keys, values })
  }
  // DELETE /api/kv?env=&binding=&key=
  if (method === 'DELETE' && url.pathname === '/api/kv') {
    if (!q.key) throw new HttpError(400, 'key required')
    await kvFor(env, q.env, q.binding).delete(q.key)
    return json(200, { ok: true })
  }
  // PUT /api/kv?env=&binding=&key=  body = raw value
  if (method === 'PUT' && url.pathname === '/api/kv') {
    if (!q.key) throw new HttpError(400, 'key required')
    await kvFor(env, q.env, q.binding).put(q.key, await request.text())
    return json(200, { ok: true })
  }
  // /api/file is local-dashboard-only (patches the git checkout).
  if (url.pathname === '/api/file') {
    return json(404, { error: 'not available in hosted mode — use the local dashboard (npm run admin)' })
  }
  // POST /api/newsletter/send?env=  body = JSON { subject, html?, text?, testTo? }
  if (method === 'POST' && url.pathname === '/api/newsletter/send') {
    return handleNewsletterSend(request, env, q)
  }
  // Identity comes from the verified Access JWT.
  if (method === 'GET' && url.pathname === '/api/whoami') {
    return json(200, { email: access.email || '(no email claim)', mode: 'hosted' })
  }
  if (method === 'GET' && STATIC[url.pathname]) {
    const [body, type] = STATIC[url.pathname]
    return new Response(body, {
      headers: { 'Content-Type': type, 'Cache-Control': 'no-store' },
    })
  }
  if (method === 'GET') return json(404, { error: 'not found' })
  return json(405, { error: 'method not allowed' })
}

export default {
  async fetch(request, env) {
    try {
      const access = await requireAccess(request, env)
      if (!access) return json(403, { error: 'forbidden' })
      return await handle(request, env, access)
    } catch (e) {
      return json(e?.status || 500, { error: e?.message || String(e) })
    }
  },
}
