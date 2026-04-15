import privacyHtml from './privacy.html'
import signupHtml from './signup.html'

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
})

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) })

    if (request.method === 'GET' && pathname === '/')        return html(signupHtml)
    if (request.method === 'GET' && pathname === '/privacy') return html(privacyHtml)

    if (request.method === 'POST' && pathname === '/signup')        return handleSignup(request, env)
    if (request.method === 'POST' && pathname === '/signup/verify') return handleSignupVerify(request, env)
    if (request.method === 'POST' && pathname === '/otp/request')   return handleOtpRequest(request, env)
    if (request.method === 'POST' && pathname === '/otp/verify')    return handleOtpVerify(request, env)
    if (request.method === 'POST' && pathname === '/member/update') return handleMemberUpdate(request, env)

    if (env.E2E_MODE === 'true' && pathname === '/__test/kv') return handleTestKv(request, env)

    return new Response('Not Found', { status: 404 })
  },
}

function html(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  })
}

// Step 1 of signup: validate handle, check for duplicates, issue a verify
// token. Caller has 1 hour to either log a diary entry tagged with the token
// or create a Letterboxd list named with the token, then call /signup/verify.
async function handleSignup(request, env) {
  const { email, handle, name } = await request.json()
  if (!email || !handle) return json(env, { error: 'email and handle required' }, 400)
  if (!/^[a-zA-Z0-9_-]+$/.test(handle)) {
    return json(env, { error: 'invalid handle format' }, 400)
  }

  const lbBase = env.LETTERBOXD_BASE || 'https://letterboxd.com'
  const lb = await fetch(`${lbBase}/${encodeURIComponent(handle)}/`)
  if (!lb.ok) return json(env, { error: 'Letterboxd profile not found' }, 400)

  // Already claimed by someone else?
  if (await env.MEMBERS_KV.get(`email:${handle}`)) {
    return json(env, { error: 'this Letterboxd handle is already claimed by a member' }, 409)
  }

  const token = `jxnfc-verify-${randomToken(8)}`
  const pending = JSON.stringify({ email, handle, name: name || handle })
  await env.MEMBERS_KV.put(`verify:${handle}`, JSON.stringify({ token, pending }), {
    expirationTtl: 3600,
  })

  return json(env, {
    ok: true,
    token,
    instructions:
      `Add ${token} to your Letterboxd account in one of two ways, then return here and click Verify:\n` +
      `  - Tag any diary entry with: ${token}\n` +
      `  - Or create a list named: ${token}\n` +
      `You can remove it after verification.`,
  })
}

// Step 2 of signup: scrape the Letterboxd profile and look for the token.
async function handleSignupVerify(request, env) {
  const { email, handle } = await request.json()
  if (!email || !handle) return json(env, { error: 'email and handle required' }, 400)

  const raw = await env.MEMBERS_KV.get(`verify:${handle}`)
  if (!raw) return json(env, { error: 'no pending verification — start over' }, 404)

  const { token, pending } = JSON.parse(raw)
  const claim = JSON.parse(pending)
  if (claim.email !== email) {
    return json(env, { error: 'email does not match the pending claim' }, 403)
  }

  const lbBase = env.LETTERBOXD_BASE || 'https://letterboxd.com'
  const [rssText, listsText] = await Promise.all([
    fetch(`${lbBase}/${encodeURIComponent(handle)}/rss/`).then(r => r.text()).catch(() => ''),
    fetch(`${lbBase}/${encodeURIComponent(handle)}/lists/`).then(r => r.text()).catch(() => ''),
  ])
  if (!rssText.includes(token) && !listsText.includes(token)) {
    return json(env, {
      error: 'token not found on the Letterboxd profile yet — make sure the diary entry or list was saved',
    }, 422)
  }

  // Verified — write KV bidirectionally and dispatch.
  await env.MEMBERS_KV.put(`email:${handle}`, email)
  await env.MEMBERS_KV.put(`handle:${email}`, handle)
  await env.MEMBERS_KV.delete(`verify:${handle}`)
  await dispatchGithub(env, 'add-member', { handle, name: claim.name })

  return json(env, { ok: true })
}

// Dev-only: seed KV directly. Only enabled when wrangler is started with
// --var E2E_MODE:true (see playwright.config.ts).
async function handleTestKv(request, env) {
  if (request.method === 'POST') {
    const { key, value, ttl } = await request.json()
    await env.MEMBERS_KV.put(key, value, ttl ? { expirationTtl: ttl } : undefined)
    return json(env, { ok: true })
  }
  if (request.method === 'DELETE') {
    const { key } = await request.json()
    await env.MEMBERS_KV.delete(key)
    return json(env, { ok: true })
  }
  return json(env, { error: 'method not allowed' }, 405)
}

function randomToken(len) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}

async function handleOtpRequest(request, env) {
  const { email } = await request.json()
  if (!email) return json(env, { error: 'email required' }, 400)

  const code = String(Math.floor(100000 + Math.random() * 900000))
  await env.MEMBERS_KV.put(`otp:${email}`, code, { expirationTtl: 600 })
  await sendOtpEmail(env, email, code)
  return json(env, { ok: true })
}

async function handleOtpVerify(request, env) {
  const { email, code } = await request.json()
  const stored = await env.MEMBERS_KV.get(`otp:${email}`)
  if (!stored || stored !== code) return json(env, { error: 'invalid code' }, 401)

  await env.MEMBERS_KV.delete(`otp:${email}`)
  const token = await signToken(env, { email, exp: Date.now() + 3600_000 })
  // Include the linked handle if any — lets the client prefill the edit form
  // without a separate round-trip. null if this email isn't linked to a member.
  const handle = await env.MEMBERS_KV.get(`handle:${email}`)
  return json(env, { token, handle })
}

async function handleMemberUpdate(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  const claims = await verifyToken(env, auth)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  // Resolve the handle server-side from the token's email. Any client-supplied
  // `updates.handle` is ignored — you can only edit your own row.
  const handle = await env.MEMBERS_KV.get(`handle:${claims.email}`)
  if (!handle) return json(env, { error: 'no member linked to this email' }, 403)

  const body = await request.json()
  const updates = { handle, name: body.name, pronouns: body.pronouns }
  await dispatchGithub(env, 'update-member', { email: claims.email, updates })
  return json(env, { ok: true, handle })
}

// --- Resend ---
// Requires a verified `jxnfilm.club` domain in Resend (adds SPF + DKIM DNS).
async function sendOtpEmail(env, to, code) {
  if (env.E2E_MODE === 'true') {
    await env.MEMBERS_KV.put(`__last_otp__`, JSON.stringify({ to, code }))
    return
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'Jackson Film Club <noreply@join.jxnfilm.club>',
      to: [to],
      subject: 'Your Jackson Film Club login code',
      text: `Your login code: ${code}\n\nThis code expires in 10 minutes.\nIf you didn't request it, ignore this email.`,
    }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
}

// --- GitHub dispatch ---
async function dispatchGithub(env, event_type, client_payload) {
  if (env.E2E_MODE === 'true') {
    await env.MEMBERS_KV.put(`__last_dispatch__`, JSON.stringify({ event_type, client_payload }))
    return
  }
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'jxnfilmclub-join',
      },
      body: JSON.stringify({ event_type, client_payload }),
    },
  )
  if (!res.ok) throw new Error(`GitHub dispatch ${res.status}: ${await res.text()}`)
}

// --- Tokens: HMAC-SHA256 over base64url(JSON) ---
async function signToken(env, claims) {
  const payload = b64u(JSON.stringify(claims))
  const sig = await hmac(env.OTP_SIGNING_KEY, payload)
  return `${payload}.${sig}`
}

async function verifyToken(env, token) {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = await hmac(env.OTP_SIGNING_KEY, payload)
  if (sig !== expected) return null
  const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
  return claims.exp > Date.now() ? claims : null
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return b64u(String.fromCharCode(...new Uint8Array(sig)))
}

function b64u(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
