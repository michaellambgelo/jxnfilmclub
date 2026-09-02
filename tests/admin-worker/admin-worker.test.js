import { env } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { verifyAccessJwt } from '../../admin/worker/src/index.js'

// --- Test JWT plumbing: an in-test RSA keypair stands in for the Access
// --- signing certs; the JWKS endpoint is served by a fetch mock.

const enc = new TextEncoder()
const KID = 'test-kid'
const AUD = 'test-aud-tag'
const ISS = 'https://testteam.cloudflareaccess.com'

let privateKey, publicJwk

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const b64urlJson = (obj) => b64url(enc.encode(JSON.stringify(obj)))

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'])
  privateKey = pair.privateKey
  publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: KID }
})

async function signToken(claims = {}, { kid = KID, alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    aud: [AUD], iss: ISS, email: 'michael@michaellamb.dev',
    iat: now, exp: now + 300, ...claims,
  }
  const head = b64urlJson({ alg, kid })
  const body = b64urlJson(payload)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, enc.encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(sig)}`
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('/cdn-cgi/access/certs')) {
      return Response.json({ keys: [publicJwk] })
    }
    return new Response(`unexpected fetch: ${url}`, { status: 500 })
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const kv of [env.MEMBERS_KV, env.ATTENDANCE_KV, env.MEMBERS_KV_STAGING, env.ATTENDANCE_KV_STAGING]) {
    const { keys } = await kv.list()
    for (const k of keys) await kv.delete(k.name)
  }
  for (const bucket of [env.VOICE, env.VOICE_STAGING]) {
    const { objects } = await bucket.list()
    for (const o of objects) await bucket.delete(o.key)
  }
})

function call(path, { method = 'GET', body, token, envOverrides } = {}) {
  const headers = {}
  if (token) headers['Cf-Access-Jwt-Assertion'] = token
  const request = new Request(`https://admin.jxnfilm.club${path}`, { method, headers, body })
  return worker.fetch(request, { ...env, ...envOverrides })
}

// --- verifyAccessJwt (pure core) ---

describe('verifyAccessJwt', () => {
  const opts = { aud: AUD, issuer: ISS }

  it('accepts a valid token and returns the payload', async () => {
    const payload = await verifyAccessJwt(await signToken(), [publicJwk], opts)
    expect(payload?.email).toBe('michael@michaellamb.dev')
  })

  it('rejects a tampered signature', async () => {
    const [h, p] = (await signToken()).split('.')
    const forged = `${h}.${b64urlJson({ aud: [AUD], iss: ISS, email: 'evil@example.com', exp: Math.floor(Date.now() / 1000) + 300 })}.${(await signToken()).split('.')[2]}`
    expect(await verifyAccessJwt(forged, [publicJwk], opts)).toBeNull()
    expect(await verifyAccessJwt(`${h}.${p}.AAAA`, [publicJwk], opts)).toBeNull()
  })

  it('rejects wrong aud, wrong issuer, and expiry', async () => {
    expect(await verifyAccessJwt(await signToken({ aud: ['other-app'] }), [publicJwk], opts)).toBeNull()
    expect(await verifyAccessJwt(await signToken({ iss: 'https://other.cloudflareaccess.com' }), [publicJwk], opts)).toBeNull()
    expect(await verifyAccessJwt(await signToken({ exp: Math.floor(Date.now() / 1000) - 10 }), [publicJwk], opts)).toBeNull()
    expect(await verifyAccessJwt(await signToken({ exp: undefined }), [publicJwk], opts)).toBeNull()
  })

  it('rejects non-RS256 algs and unknown kids', async () => {
    expect(await verifyAccessJwt(await signToken({}, { alg: 'none' }), [publicJwk], opts)).toBeNull()
    expect(await verifyAccessJwt(await signToken({}, { kid: 'other-kid' }), [publicJwk], opts)).toBeNull()
  })

  it('rejects garbage', async () => {
    expect(await verifyAccessJwt('not-a-jwt', [publicJwk], opts)).toBeNull()
    expect(await verifyAccessJwt('', [publicJwk], opts)).toBeNull()
    expect(await verifyAccessJwt(undefined, [publicJwk], opts)).toBeNull()
  })
})

// --- The gate: every route 403s without a valid Access JWT ---

describe('access gate', () => {
  it('403s every surface without the header', async () => {
    for (const path of ['/', '/index.html', '/admin.js', '/lib.js', '/contentgen.js', '/style.css', '/api/kv?env=production&binding=MEMBERS_KV', '/api/whoami', '/api/img?url=https%3A%2F%2Fimage.tmdb.org%2Fx.jpg', '/api/voice?env=production&key=voice%2Fx.webm', '/api/voice/list?env=production']) {
      const res = await call(path)
      expect(res.status, path).toBe(403)
    }
  })

  it('403s a valid-looking but unverifiable token', async () => {
    const res = await call('/', { token: (await signToken()) + 'x' })
    expect(res.status).toBe(403)
  })

  it('fails closed when ACCESS_AUD / ACCESS_TEAM_DOMAIN are unset', async () => {
    const token = await signToken()
    expect((await call('/', { token, envOverrides: { ACCESS_AUD: '' } })).status).toBe(403)
    expect((await call('/', { token, envOverrides: { ACCESS_TEAM_DOMAIN: '' } })).status).toBe(403)
  })

  it('denied navigations get the styled page, API calls keep JSON', async () => {
    // The page must exceed 512 bytes or Chrome swaps in its own generic
    // error page, hiding whether the worker or the Access edge denied.
    const nav = await call('/')
    expect(nav.status).toBe(403)
    expect(nav.headers.get('Content-Type')).toContain('text/html')
    const body = await nav.text()
    expect(body).toContain('Access denied')
    expect(body.length).toBeGreaterThan(512)

    const api = await call('/api/whoami')
    expect(api.status).toBe(403)
    expect(await api.json()).toEqual({ error: 'forbidden' })
  })

  it('serves the SPA shell with a valid token', async () => {
    const res = await call('/', { token: await signToken() })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(await res.text()).toContain('JxN admin')

    const js = await call('/admin.js', { token: await signToken() })
    expect(js.status).toBe(200)
    expect(await js.text()).toContain('HOSTED')

    const lib = await call('/lib.js', { token: await signToken() })
    expect(lib.status).toBe(200)
    expect(lib.headers.get('Content-Type')).toContain('javascript')
    expect(await lib.text()).toContain('buildWatchedSectionHtml')

    const cgen = await call('/contentgen.js', { token: await signToken() })
    expect(cgen.status).toBe(200)
    expect(cgen.headers.get('Content-Type')).toContain('javascript')
    expect(await cgen.text()).toContain('renderContentGen')
  })

  it('whoami reflects the verified JWT email', async () => {
    const res = await call('/api/whoami', { token: await signToken({ email: 'lambm07@gmail.com' }) })
    expect(await res.json()).toEqual({ email: 'lambm07@gmail.com', mode: 'hosted' })
  })
})

// --- /api/kv: env/binding mapping, isolation, shape parity with server.mjs ---

describe('/api/kv', () => {
  it('maps env+binding to the right namespace and keeps envs isolated', async () => {
    await env.MEMBERS_KV.put('member:prod@example.com', JSON.stringify({ email: 'prod@example.com' }))
    await env.MEMBERS_KV_STAGING.put('member:staging@example.com', JSON.stringify({ email: 'staging@example.com' }))
    const token = await signToken()

    const prod = await (await call('/api/kv?env=production&binding=MEMBERS_KV&prefix=member:', { token })).json()
    expect(prod.keys.map(k => k.name)).toEqual(['member:prod@example.com'])
    expect(JSON.parse(prod.values['member:prod@example.com']).email).toBe('prod@example.com')

    const staging = await (await call('/api/kv?env=staging&binding=MEMBERS_KV&prefix=member:', { token })).json()
    expect(staging.keys.map(k => k.name)).toEqual(['member:staging@example.com'])
  })

  it('PUT writes only the selected env; DELETE removes and returns ok', async () => {
    const token = await signToken()
    const put = await call('/api/kv?env=staging&binding=ATTENDANCE_KV&key=event:test', { method: 'PUT', body: '{"id":"test"}', token })
    expect(await put.json()).toEqual({ ok: true })
    expect(await env.ATTENDANCE_KV_STAGING.get('event:test')).toBe('{"id":"test"}')
    expect(await env.ATTENDANCE_KV.get('event:test')).toBeNull()

    const del = await call('/api/kv?env=staging&binding=ATTENDANCE_KV&key=event:test', { method: 'DELETE', token })
    expect(await del.json()).toEqual({ ok: true })
    expect(await env.ATTENDANCE_KV_STAGING.get('event:test')).toBeNull()
  })

  it('rejects invalid env/binding with server.mjs-parity messages', async () => {
    const token = await signToken()
    const badEnv = await call('/api/kv?env=prod&binding=MEMBERS_KV', { token })
    expect(badEnv.status).toBe(400)
    expect((await badEnv.json()).error).toBe('invalid env: prod')

    const badBinding = await call('/api/kv?env=production&binding=SECRETS_KV', { token })
    expect(badBinding.status).toBe(400)
    expect((await badBinding.json()).error).toBe('invalid binding: SECRETS_KV')

    const noKey = await call('/api/kv?env=production&binding=MEMBERS_KV', { method: 'DELETE', token })
    expect(noKey.status).toBe(400)
    expect((await noKey.json()).error).toBe('key required')
  })

  it('lists many keys with expirations surfaced', async () => {
    const token = await signToken()
    for (let i = 0; i < 25; i++) {
      await env.MEMBERS_KV.put(`rate:otp_send:${i}@example.com`, String(i), { expirationTtl: 600 })
    }
    const res = await (await call('/api/kv?env=production&binding=MEMBERS_KV&prefix=rate:', { token })).json()
    expect(res.keys).toHaveLength(25)
    expect(res.keys[0]).toHaveProperty('name')
    expect(res.keys[0].expiration).toBeGreaterThan(Date.now() / 1000)
    expect(res.values[res.keys[3].name]).toBe(res.keys[3].name.split(':')[2].split('@')[0])
  })
})

// --- /api/file is local-only ---

describe('/api/file', () => {
  it('404s in hosted mode for both GET and PUT', async () => {
    const token = await signToken()
    expect((await call('/api/file?path=data/members.json', { token })).status).toBe(404)
    expect((await call('/api/file?path=data/members.json', { method: 'PUT', body: '[]', token })).status).toBe(404)
  })
})

// --- Join-worker proxies: service binding + token selection per env ---

function stubService(response = { sent: 3 }, status = 200, raw = false) {
  const calls = []
  const service = {
    fetch: vi.fn(async (url, init) => {
      calls.push({ url: String(url), init })
      return raw
        ? new Response(response, { status })
        : Response.json(response, { status })
    }),
  }
  return { service, calls }
}

describe('/api/newsletter/send', () => {
  it('production uses JOIN_WORKER with ADMIN_TOKEN against join.jxnfilm.club', async () => {
    const { service, calls } = stubService()
    const res = await call('/api/newsletter/send?env=production', {
      method: 'POST', body: JSON.stringify({ subject: 'Hi' }),
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(await res.json()).toEqual({ sent: 3 })
    expect(calls[0].url).toBe('https://join.jxnfilm.club/admin/newsletter/send')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token')
    expect(calls[0].init.body).toBe('{"subject":"Hi"}')
  })

  it('staging uses JOIN_WORKER_STAGING with ADMIN_TOKEN_STAGING against join-staging', async () => {
    const { service, calls } = stubService()
    const res = await call('/api/newsletter/send?env=staging', {
      method: 'POST', body: JSON.stringify({ subject: 'Hi', testTo: 'x@example.com' }),
      token: await signToken(), envOverrides: { JOIN_WORKER_STAGING: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join-staging.jxnfilm.club/admin/newsletter/send')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token-staging')
  })

  it('relays the join worker error status/body', async () => {
    const { service } = stubService({ error: 'unauthorized' }, 401)
    const res = await call('/api/newsletter/send?env=production', {
      method: 'POST', body: '{}', token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('unauthorized')
  })

  it('400s when the token secret is missing', async () => {
    const { service } = stubService()
    const res = await call('/api/newsletter/send?env=production', {
      method: 'POST', body: '{}', token: await signToken(),
      envOverrides: { JOIN_WORKER: service, ADMIN_TOKEN: '' },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('ADMIN_TOKEN')
  })
})

// --- TMDB poster search proxy: GET with the admin token, no body ---

describe('/api/tmdb/search', () => {
  it('production uses JOIN_WORKER with ADMIN_TOKEN and passes the query through', async () => {
    const { service, calls } = stubService({ results: [{ id: 603, title: 'The Matrix' }] })
    const res = await call('/api/tmdb/search?env=production&q=the%20matrix', {
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect((await res.json()).results).toHaveLength(1)
    expect(calls[0].url).toBe('https://join.jxnfilm.club/admin/tmdb/search?q=the+matrix')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token')
  })

  it('staging uses JOIN_WORKER_STAGING with ADMIN_TOKEN_STAGING against join-staging', async () => {
    const { service, calls } = stubService({ results: [] })
    const res = await call('/api/tmdb/search?env=staging&q=halloween', {
      token: await signToken(), envOverrides: { JOIN_WORKER_STAGING: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join-staging.jxnfilm.club/admin/tmdb/search?q=halloween')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token-staging')
  })

  it('relays the join worker error status/body and 400s without the secret', async () => {
    const { service } = stubService({ error: 'unauthorized' }, 401)
    const denied = await call('/api/tmdb/search?env=production&q=x', {
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(denied.status).toBe(401)
    const missing = await call('/api/tmdb/search?env=production&q=x', {
      token: await signToken(), envOverrides: { JOIN_WORKER: service, ADMIN_TOKEN: '' },
    })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toContain('ADMIN_TOKEN')
  })
})

// --- Member unlink proxy: same shape as the newsletter proxy ---

describe('/api/member/unlink', () => {
  it('production uses JOIN_WORKER with ADMIN_TOKEN against join.jxnfilm.club', async () => {
    const { service, calls } = stubService({ ok: true, unlinked: 'modhandle' })
    const res = await call('/api/member/unlink?env=production', {
      method: 'POST', body: JSON.stringify({ email: 'adm@example.com' }),
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(await res.json()).toEqual({ ok: true, unlinked: 'modhandle' })
    expect(calls[0].url).toBe('https://join.jxnfilm.club/admin/member/unlink')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token')
    expect(calls[0].init.body).toBe('{"email":"adm@example.com"}')
  })

  it('staging uses JOIN_WORKER_STAGING with ADMIN_TOKEN_STAGING against join-staging', async () => {
    const { service, calls } = stubService({ ok: true })
    const res = await call('/api/member/unlink?env=staging', {
      method: 'POST', body: JSON.stringify({ email: 'adm@example.com' }),
      token: await signToken(), envOverrides: { JOIN_WORKER_STAGING: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join-staging.jxnfilm.club/admin/member/unlink')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token-staging')
  })

  it('relays the join worker error status/body', async () => {
    const { service } = stubService({ error: 'member not found' }, 404)
    const res = await call('/api/member/unlink?env=production', {
      method: 'POST', body: '{"email":"ghost@example.com"}', token: await signToken(),
      envOverrides: { JOIN_WORKER: service },
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('member not found')
  })

  it('400s when the token secret is missing', async () => {
    const { service } = stubService()
    const res = await call('/api/member/unlink?env=production', {
      method: 'POST', body: '{}', token: await signToken(),
      envOverrides: { JOIN_WORKER: service, ADMIN_TOKEN: '' },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('ADMIN_TOKEN')
  })
})

// --- Guest RSVP proxy: POST adds, DELETE removes, both via the join worker ---

describe('/api/rsvp/guest', () => {
  it('POST proxies to the join worker guest endpoint with the admin token', async () => {
    const { service, calls } = stubService({ ok: true, status: 'confirmed', id: 'guest:abc12345' })
    const res = await call('/api/rsvp/guest?env=production&event=2099-01-15-test-ab12', {
      method: 'POST', body: JSON.stringify({ name: 'Gwen', email: 'gwen@example.com' }),
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(await res.json()).toEqual({ ok: true, status: 'confirmed', id: 'guest:abc12345' })
    expect(calls[0].url).toBe('https://join.jxnfilm.club/events/2099-01-15-test-ab12/rsvp/guest')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token')
    expect(calls[0].init.body).toBe('{"name":"Gwen","email":"gwen@example.com"}')
  })

  it('DELETE proxies with method DELETE and the guest id body', async () => {
    const { service, calls } = stubService({ ok: true, status: 'cancelled', promoted: false })
    const res = await call('/api/rsvp/guest?env=production&event=evt-1', {
      method: 'DELETE', body: JSON.stringify({ id: 'guest:abc12345' }),
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join.jxnfilm.club/events/evt-1/rsvp/guest')
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].init.body).toBe('{"id":"guest:abc12345"}')
  })

  it('staging uses JOIN_WORKER_STAGING with the staging token', async () => {
    const { service, calls } = stubService({ ok: true, status: 'confirmed', id: 'guest:x' })
    const res = await call('/api/rsvp/guest?env=staging&event=evt-2', {
      method: 'POST', body: JSON.stringify({ name: 'G' }),
      token: await signToken(), envOverrides: { JOIN_WORKER_STAGING: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join-staging.jxnfilm.club/events/evt-2/rsvp/guest')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token-staging')
  })

  it('400s without an event param; relays join worker errors', async () => {
    const { service } = stubService({ error: 'that email already has an RSVP for this screening' }, 409)
    const missing = await call('/api/rsvp/guest?env=production', {
      method: 'POST', body: '{"name":"G"}', token: await signToken(),
      envOverrides: { JOIN_WORKER: service },
    })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toContain('event')

    const dupe = await call('/api/rsvp/guest?env=production&event=evt-3', {
      method: 'POST', body: '{"name":"G","email":"d@example.com"}', token: await signToken(),
      envOverrides: { JOIN_WORKER: service },
    })
    expect(dupe.status).toBe(409)
    expect((await dupe.json()).error).toContain('already has an RSVP')
  })
})

describe('/api/newsletter/image', () => {
  it('proxies the upload to the join Worker with ADMIN_TOKEN', async () => {
    const { service, calls } = stubService({ url: 'https://join.jxnfilm.club/nl/img/abc.jpg', key: 'abc.jpg' })
    const res = await call('/api/newsletter/image?env=production', {
      method: 'POST',
      body: JSON.stringify({ contentType: 'image/jpeg', b64: 'AAAA' }),
      token: await signToken(),
      envOverrides: { JOIN_WORKER: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join.jxnfilm.club/admin/newsletter/image')
    expect(calls[0].init?.headers?.Authorization).toBe('Bearer test-admin-token')
    // The JSON body is why this reuses proxyJoinAdmin unchanged — it forwards
    // request.text() re-headed as application/json, so it carries verbatim.
    expect(JSON.parse(calls[0].init.body)).toEqual({ contentType: 'image/jpeg', b64: 'AAAA' })
  })

  it('uses the staging binding and token for staging', async () => {
    const { service, calls } = stubService({})
    await call('/api/newsletter/image?env=staging', {
      method: 'POST',
      body: JSON.stringify({ contentType: 'image/png', b64: 'AA' }),
      token: await signToken(),
      envOverrides: { JOIN_WORKER_STAGING: service },
    })
    expect(calls[0].url).toBe('https://join-staging.jxnfilm.club/admin/newsletter/image')
    expect(calls[0].init?.headers?.Authorization).toBe('Bearer test-admin-token-staging')
  })

  it('400s on an invalid env', async () => {
    const res = await call('/api/newsletter/image?env=nope', {
      method: 'POST', body: '{}', token: await signToken(),
    })
    expect(res.status).toBe(400)
  })
})

// --- Watched proxy: full-depth read over the service binding ---
//
// The admin asks for ?depth=full so Content Gen's paged diary cards and the
// Stats film counts see the whole cached feed, not the public 12-per-handle
// slice the site needs. That read is bearer-gated on the join Worker.

describe('/api/watched', () => {
  it('production asks JOIN_WORKER for full depth with ADMIN_TOKEN', async () => {
    const { service, calls } = stubService({ modhandle: [{ title: 'Film' }] })
    const res = await call('/api/watched?env=production', {
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(await res.json()).toEqual({ modhandle: [{ title: 'Film' }] })
    expect(calls[0].url).toBe('https://join.jxnfilm.club/watched?depth=full')
    expect(calls[0].init?.headers?.Authorization).toBe('Bearer test-admin-token')
  })

  it('staging uses JOIN_WORKER_STAGING and ADMIN_TOKEN_STAGING against join-staging', async () => {
    const { service, calls } = stubService({})
    const res = await call('/api/watched?env=staging', {
      token: await signToken(), envOverrides: { JOIN_WORKER_STAGING: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join-staging.jxnfilm.club/watched?depth=full')
    expect(calls[0].init?.headers?.Authorization).toBe('Bearer test-admin-token-staging')
  })

  it('falls back to the public read when no admin token is configured', async () => {
    // Degrade, don't fail: a shallower map makes the diary pager thinner,
    // but erroring would take out the whole Content Gen tab.
    const { service, calls } = stubService({ modhandle: [{ title: 'Film' }] })
    const res = await call('/api/watched?env=production', {
      token: await signToken(), envOverrides: { JOIN_WORKER: service, ADMIN_TOKEN: '' },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join.jxnfilm.club/watched')
    expect(calls[0].init?.headers?.Authorization).toBeUndefined()
  })

  it('400s on an invalid env', async () => {
    const res = await call('/api/watched?env=nope', { token: await signToken() })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid env: nope')
  })

  it('degrades a non-JSON upstream body to {} with the status relayed', async () => {
    const { service } = stubService('<html>cf error page</html>', 522, true)
    const res = await call('/api/watched?env=production', {
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(res.status).toBe(522)
    expect(await res.json()).toEqual({})
  })
})

// --- Routing fallthrough ---

describe('routing fallthrough', () => {
  it('404s an unknown GET path with a valid token', async () => {
    const res = await call('/nonexistent', { token: await signToken() })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('not found')
  })

  it('405s an unrouted non-GET method with a valid token', async () => {
    const res = await call('/api/kv?env=production&binding=MEMBERS_KV&key=x', {
      method: 'PATCH', body: 'x', token: await signToken(),
    })
    expect(res.status).toBe(405)
    expect((await res.json()).error).toBe('method not allowed')
  })
})

// --- /api/voice: R2-backed voice-clip streaming ---

describe('/api/voice', () => {
  const KEY = 'voice/summer-2026/mem_1a2b.webm'
  const BYTES = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x42])
  const voiceUrl = (params) => `/api/voice?${new URLSearchParams(params)}`

  it('streams the object with its stored content type', async () => {
    await env.VOICE.put(KEY, BYTES, { httpMetadata: { contentType: 'audio/webm' } })
    const res = await call(voiceUrl({ env: 'production', key: KEY }), { token: await signToken() })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('audio/webm')
    expect(res.headers.get('Content-Disposition')).toBeNull()
    expect(res.headers.get('Content-Length')).toBe(String(BYTES.length))
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES)
  })

  it('download=1 adds an attachment disposition with a sanitized filename', async () => {
    await env.VOICE.put(KEY, BYTES, { httpMetadata: { contentType: 'audio/webm' } })
    const res = await call(voiceUrl({ env: 'production', key: KEY, download: '1' }), { token: await signToken() })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="mem_1a2b.webm"')
    await res.arrayBuffer()  // drain the R2 stream (keeps isolated storage poppable)
  })

  it('env=staging reads VOICE_STAGING, not VOICE', async () => {
    await env.VOICE_STAGING.put(KEY, BYTES, { httpMetadata: { contentType: 'audio/ogg' } })
    const staging = await call(voiceUrl({ env: 'staging', key: KEY }), { token: await signToken() })
    expect(staging.status).toBe(200)
    expect(staging.headers.get('Content-Type')).toBe('audio/ogg')
    await staging.arrayBuffer()  // drain the R2 stream

    const prod = await call(voiceUrl({ env: 'production', key: KEY }), { token: await signToken() })
    expect(prod.status).toBe(404)
  })

  it('404s a missing object with { error: "expired" } — never a 500', async () => {
    const res = await call(voiceUrl({ env: 'production', key: 'voice/gone/clip.webm' }), { token: await signToken() })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'expired' })
  })

  it('400s an invalid env and keys outside the voice/ prefix', async () => {
    const badEnv = await call(voiceUrl({ env: 'prod', key: KEY }), { token: await signToken() })
    expect(badEnv.status).toBe(400)
    expect((await badEnv.json()).error).toBe('invalid env: prod')

    for (const badKey of ['member:a@b.com', 'voicemail/x.webm', '']) {
      const res = await call(voiceUrl({ env: 'production', key: badKey }), { token: await signToken() })
      expect(res.status, `key=${badKey}`).toBe(400)
      expect((await res.json()).error).toBe('invalid key')
    }
  })

  it('falls back to application/octet-stream when no content type was stored', async () => {
    await env.VOICE.put(KEY, BYTES)
    const res = await call(voiceUrl({ env: 'production', key: KEY }), { token: await signToken() })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    await res.arrayBuffer()  // drain the R2 stream
  })
})

// --- Voice moderation proxies: status / delete / list via the join worker ---

describe('/api/voice/status', () => {
  it('production POSTs /admin/voice/status on JOIN_WORKER with ADMIN_TOKEN', async () => {
    const { service, calls } = stubService({ ok: true, status: 'approved' })
    const res = await call('/api/voice/status?env=production', {
      method: 'POST', body: JSON.stringify({ key: 'voice:summer-2026:mem_1', status: 'approved' }),
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(await res.json()).toEqual({ ok: true, status: 'approved' })
    expect(calls[0].url).toBe('https://join.jxnfilm.club/admin/voice/status')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token')
    expect(calls[0].init.body).toBe('{"key":"voice:summer-2026:mem_1","status":"approved"}')
  })

  it('staging uses JOIN_WORKER_STAGING with ADMIN_TOKEN_STAGING against join-staging', async () => {
    const { service, calls } = stubService({ ok: true, status: 'rejected' })
    const res = await call('/api/voice/status?env=staging', {
      method: 'POST', body: JSON.stringify({ key: 'voice:x:y', status: 'rejected' }),
      token: await signToken(), envOverrides: { JOIN_WORKER_STAGING: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join-staging.jxnfilm.club/admin/voice/status')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token-staging')
  })

  it('relays join worker errors and 400s when the token secret is missing', async () => {
    const { service } = stubService({ error: 'row not found' }, 404)
    const notFound = await call('/api/voice/status?env=production', {
      method: 'POST', body: '{"key":"voice:x:y","status":"approved"}', token: await signToken(),
      envOverrides: { JOIN_WORKER: service },
    })
    expect(notFound.status).toBe(404)
    expect((await notFound.json()).error).toBe('row not found')

    const missing = await call('/api/voice/status?env=production', {
      method: 'POST', body: '{}', token: await signToken(),
      envOverrides: { JOIN_WORKER: service, ADMIN_TOKEN: '' },
    })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toContain('ADMIN_TOKEN')
  })
})

describe('DELETE /api/voice', () => {
  it('proxies DELETE /admin/voice with the key body and the admin token', async () => {
    const { service, calls } = stubService({ ok: true, deleted: true })
    const res = await call('/api/voice?env=production', {
      method: 'DELETE', body: JSON.stringify({ key: 'voice:summer-2026:mem_1' }),
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(await res.json()).toEqual({ ok: true, deleted: true })
    expect(calls[0].url).toBe('https://join.jxnfilm.club/admin/voice')
    expect(calls[0].init.method).toBe('DELETE')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token')
    expect(calls[0].init.body).toBe('{"key":"voice:summer-2026:mem_1"}')
  })

  it('staging uses JOIN_WORKER_STAGING with the staging token', async () => {
    const { service, calls } = stubService({ ok: true })
    const res = await call('/api/voice?env=staging', {
      method: 'DELETE', body: '{"key":"voice:x:y"}',
      token: await signToken(), envOverrides: { JOIN_WORKER_STAGING: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join-staging.jxnfilm.club/admin/voice')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token-staging')
  })
})

describe('/api/voice/list', () => {
  it('GETs /admin/voice on JOIN_WORKER with the admin token', async () => {
    const { service, calls } = stubService({ clips: [{ memberId: 'mem_1' }] })
    const res = await call('/api/voice/list?env=production', {
      token: await signToken(), envOverrides: { JOIN_WORKER: service },
    })
    expect(await res.json()).toEqual({ clips: [{ memberId: 'mem_1' }] })
    expect(calls[0].url).toBe('https://join.jxnfilm.club/admin/voice')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token')
  })

  it('staging targets join-staging with the staging token; 400s without a secret', async () => {
    const { service, calls } = stubService({ clips: [] })
    const res = await call('/api/voice/list?env=staging', {
      token: await signToken(), envOverrides: { JOIN_WORKER_STAGING: service },
    })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe('https://join-staging.jxnfilm.club/admin/voice')
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-admin-token-staging')

    const missing = await call('/api/voice/list?env=production', {
      token: await signToken(), envOverrides: { JOIN_WORKER: service, ADMIN_TOKEN: '' },
    })
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toContain('ADMIN_TOKEN')
  })

  it('400s an invalid env', async () => {
    const res = await call('/api/voice/list?env=nope', { token: await signToken() })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid env: nope')
  })
})

// --- /api/img: same-origin image proxy for Content Gen canvas rendering ---

describe('/api/img', () => {
  const imgUrl = (u) => `/api/img?url=${encodeURIComponent(u)}`

  it('proxies an allowlisted https image with its content type', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return Response.json({ keys: [publicJwk] })
      if (String(url) === 'https://image.tmdb.org/t/p/w500/poster.jpg') {
        return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } })
      }
      return new Response('unexpected', { status: 500 })
    })
    const res = await call(imgUrl('https://image.tmdb.org/t/p/w500/poster.jpg'), { token: await signToken() })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toContain('max-age=3600')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  it('403s a non-allowlisted host and non-https schemes', async () => {
    for (const bad of ['https://evil.example.com/x.jpg', 'http://image.tmdb.org/x.jpg']) {
      const res = await call(imgUrl(bad), { token: await signToken() })
      expect(res.status, bad).toBe(403)
    }
  })

  it('400s a malformed url', async () => {
    const res = await call(imgUrl('not a url'), { token: await signToken() })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid url')
  })

  it('502s a non-image upstream response', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return Response.json({ keys: [publicJwk] })
      return new Response('<html>not an image</html>', { headers: { 'Content-Type': 'text/html' } })
    })
    const res = await call(imgUrl('https://image.tmdb.org/x.jpg'), { token: await signToken() })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('not an image')
  })

  it('502s an upstream error status', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('/cdn-cgi/access/certs')) return Response.json({ keys: [publicJwk] })
      return new Response('nope', { status: 404 })
    })
    const res = await call(imgUrl('https://a.ltrbxd.com/gone.jpg'), { token: await signToken() })
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('image fetch failed: 404')
  })
})
