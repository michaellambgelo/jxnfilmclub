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
    for (const path of ['/', '/index.html', '/admin.js', '/style.css', '/api/kv?env=production&binding=MEMBERS_KV', '/api/whoami']) {
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

  it('serves the SPA shell with a valid token', async () => {
    const res = await call('/', { token: await signToken() })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(await res.text()).toContain('JxN admin')

    const js = await call('/admin.js', { token: await signToken() })
    expect(js.status).toBe(200)
    expect(await js.text()).toContain('HOSTED')
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

// --- Newsletter proxy: service binding + token selection per env ---

describe('/api/newsletter/send', () => {
  function stubService(response = { sent: 3 }, status = 200) {
    const calls = []
    const service = {
      fetch: vi.fn(async (url, init) => {
        calls.push({ url: String(url), init })
        return Response.json(response, { status })
      }),
    }
    return { service, calls }
  }

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
