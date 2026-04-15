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

    if (request.method === 'POST' && pathname === '/signup')       return handleSignup(request, env)
    if (request.method === 'POST' && pathname === '/otp/request')  return handleOtpRequest(request, env)
    if (request.method === 'POST' && pathname === '/otp/verify')   return handleOtpVerify(request, env)
    if (request.method === 'POST' && pathname === '/member/update')return handleMemberUpdate(request, env)

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

async function handleSignup(request, env) {
  const { email, handle, name } = await request.json()
  if (!email || !handle) return json(env, { error: 'email and handle required' }, 400)

  const lb = await fetch(`https://letterboxd.com/${encodeURIComponent(handle)}/`)
  if (!lb.ok) return json(env, { error: 'Letterboxd profile not found' }, 400)

  await env.MEMBERS_KV.put(`email:${handle}`, email)
  await dispatchGithub(env, 'add-member', { handle, name: name || handle })
  return json(env, { ok: true })
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
  return json(env, { token })
}

async function handleMemberUpdate(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  const claims = await verifyToken(env, auth)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const updates = await request.json()
  await dispatchGithub(env, 'update-member', { email: claims.email, updates })
  return json(env, { ok: true })
}

// --- Resend ---
// Requires a verified `jxnfilm.club` domain in Resend (adds SPF + DKIM DNS).
async function sendOtpEmail(env, to, code) {
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
