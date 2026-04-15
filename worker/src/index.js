import privacyHtml from './privacy.html'
import signupHtml from './signup.html'

const OTP_TTL = 600         // 10 min
const LB_TOKEN_TTL = 172800 // 48 hours

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
})

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) })

    if (request.method === 'GET' && pathname === '/')        return html(render(signupHtml, env))
    if (request.method === 'GET' && pathname === '/privacy') return html(privacyHtml)

    if (request.method === 'POST' && pathname === '/signup')         return handleSignup(request, env)
    if (request.method === 'POST' && pathname === '/signup/verify')  return handleSignupVerify(request, env)

    if (request.method === 'POST' && pathname === '/otp/request')    return handleOtpRequest(request, env)
    if (request.method === 'POST' && pathname === '/otp/verify')     return handleOtpVerify(request, env)

    if (request.method === 'GET'  && pathname === '/letterboxd/status')  return handleLbStatus(request, env)
    if (request.method === 'POST' && pathname === '/letterboxd/request') return handleLbRequest(request, env)
    if (request.method === 'POST' && pathname === '/letterboxd/verify')  return handleLbVerify(request, env)
    if (request.method === 'POST' && pathname === '/letterboxd/unlink')  return handleLbUnlink(request, env)

    if (request.method === 'GET'  && pathname === '/member/me')      return handleMemberMe(request, env)
    if (request.method === 'POST' && pathname === '/member/update')  return handleMemberUpdate(request, env)

    const eventMatch = pathname.match(/^\/events\/([^\/]+)\/(attend|attendance)$/)
    if (eventMatch) {
      const [, eventId, suffix] = eventMatch
      if (suffix === 'attendance' && request.method === 'GET')   return handleAttendanceGet(env, eventId)
      if (suffix === 'attend'     && request.method === 'POST')  return handleAttend(request, env, eventId)
      if (suffix === 'attend'     && request.method === 'DELETE') return handleUnattend(request, env, eventId)
    }

    if (env.E2E_MODE === 'true' && pathname === '/__test/kv') return handleTestKv(request, env)

    return new Response('Not Found', { status: 404 })
  },
}

function html(body) {
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function render(template, env) {
  return template.replaceAll('%SITE_ORIGIN%', env.SITE_ORIGIN || 'https://jxnfilm.club')
}

function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(env) },
  })
}

const HANDLE_RE = /^[a-zA-Z0-9_-]+$/

// --- Signup ---

// POST /signup — (email, name, handle?)
// Creates pending:{email} with OTP code. Also mints an LB verification tag
// (always, even when handle is omitted — user may add one later from /edit).
// Sends a single email containing both the code and the tag instructions.
async function handleSignup(request, env) {
  const { email, name, handle } = await request.json()
  if (!email || !name) return json(env, { error: 'email and name required' }, 400)
  if (handle && !HANDLE_RE.test(handle)) {
    return json(env, { error: 'invalid handle format' }, 400)
  }

  if (await env.MEMBERS_KV.get(`member:${email}`)) {
    return json(env, { error: 'this email is already a member — try signing in' }, 409)
  }
  if (handle) {
    const claimedBy = await env.MEMBERS_KV.get(`email:${handle}`)
    if (claimedBy && claimedBy !== email) {
      return json(env, { error: 'this Letterboxd handle is already claimed' }, 409)
    }
  }

  const code = randomCode()
  const lbToken = `jxnfc-verify-${randomToken(8)}`

  await env.MEMBERS_KV.put(
    `pending:${email}`,
    JSON.stringify({ name, handle: handle || null, code }),
    { expirationTtl: OTP_TTL },
  )
  await env.MEMBERS_KV.put(
    `lb_token:${email}`,
    JSON.stringify({ token: lbToken, handle: handle || null, exp: Date.now() + LB_TOKEN_TTL * 1000 }),
    { expirationTtl: LB_TOKEN_TTL },
  )

  await sendSignupEmail(env, email, code, lbToken, handle)
  return json(env, { ok: true })
}

// POST /signup/verify — (email, code)
// Promotes pending:{email} to member:{email}, dispatches add-member with a
// new random member id, and returns a session token. The LB token (if any)
// stays alive for 48h so the user can complete Letterboxd verification from
// their account page.
async function handleSignupVerify(request, env) {
  const { email, code } = await request.json()
  const pendingRaw = await env.MEMBERS_KV.get(`pending:${email}`)
  if (!pendingRaw) return json(env, { error: 'no pending signup — start over' }, 404)

  const pending = JSON.parse(pendingRaw)
  if (pending.code !== code) return json(env, { error: 'invalid code' }, 401)

  const id = randomToken(10)
  const member = {
    id,
    email,
    name: pending.name,
    pronouns: null,
    handle: null,
    joined: new Date().toISOString().slice(0, 10),
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  await env.MEMBERS_KV.delete(`pending:${email}`)
  await dispatchGithub(env, 'add-member', { id, name: member.name, joined: member.joined })

  const token = await signToken(env, { email, id, exp: Date.now() + 3600_000 })
  return json(env, { token, email, id, handle: null })
}

// --- Sign-in (returning members) ---

async function handleOtpRequest(request, env) {
  const { email } = await request.json()
  if (!email) return json(env, { error: 'email required' }, 400)
  if (!(await env.MEMBERS_KV.get(`member:${email}`))) {
    // Don't leak membership existence; silently 200. The UI will just say
    // "if this email is on file, we sent a code".
    return json(env, { ok: true })
  }

  const code = randomCode()
  await env.MEMBERS_KV.put(`otp:${email}`, code, { expirationTtl: OTP_TTL })
  await sendLoginEmail(env, email, code)
  return json(env, { ok: true })
}

async function handleOtpVerify(request, env) {
  const { email, code } = await request.json()
  const stored = await env.MEMBERS_KV.get(`otp:${email}`)
  if (!stored || stored !== code) return json(env, { error: 'invalid code' }, 401)

  await env.MEMBERS_KV.delete(`otp:${email}`)
  const memberRaw = await env.MEMBERS_KV.get(`member:${email}`)
  const member = memberRaw ? JSON.parse(memberRaw) : null
  if (!member) return json(env, { error: 'no member linked to this email' }, 403)

  const token = await signToken(env, { email, id: member.id, exp: Date.now() + 3600_000 })
  return json(env, { token, email, id: member.id, handle: member.handle })
}

// --- Letterboxd verification ---

// GET /letterboxd/status — authenticated
async function handleLbStatus(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  if (member.handle) {
    return json(env, { verified: true, handle: member.handle })
  }
  const lbRaw = await env.MEMBERS_KV.get(`lb_token:${claims.email}`)
  if (lbRaw) {
    const lb = JSON.parse(lbRaw)
    return json(env, { pending: true, handle: lb.handle, token: lb.token, exp: lb.exp })
  }
  return json(env, { none: true })
}

// POST /letterboxd/request — authenticated, (handle)
// Issues a fresh LB token with a 48h TTL, tied to the given handle.
async function handleLbRequest(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const { handle } = await request.json()
  if (!handle || !HANDLE_RE.test(handle)) {
    return json(env, { error: 'invalid handle format' }, 400)
  }
  const claimedBy = await env.MEMBERS_KV.get(`email:${handle}`)
  if (claimedBy && claimedBy !== claims.email) {
    return json(env, { error: 'this Letterboxd handle is already claimed' }, 409)
  }

  const token = `jxnfc-verify-${randomToken(8)}`
  const exp = Date.now() + LB_TOKEN_TTL * 1000
  await env.MEMBERS_KV.put(
    `lb_token:${claims.email}`,
    JSON.stringify({ token, handle, exp }),
    { expirationTtl: LB_TOKEN_TTL },
  )
  return json(env, { token, handle, exp })
}

// POST /letterboxd/verify — authenticated
// Scrapes letterboxd.com/<handle>/rss/ for the pending token. RSS covers both
// tagged diary entries and list-creation events, so a single feed check suffices.
async function handleLbVerify(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const lbRaw = await env.MEMBERS_KV.get(`lb_token:${claims.email}`)
  if (!lbRaw) return json(env, { error: 'no pending verification — request a new tag' }, 410)
  const { token, handle } = JSON.parse(lbRaw)
  if (!handle) return json(env, { error: 'add your Letterboxd handle first' }, 400)

  const lbBase = env.LETTERBOXD_BASE || 'https://letterboxd.com'
  const rssText = await fetch(`${lbBase}/${encodeURIComponent(handle)}/rss/`)
    .then(r => r.text())
    .catch(() => '')
  if (!rssText.includes(token)) {
    return json(env, {
      error: 'token not found on your Letterboxd RSS feed yet — make sure the diary entry or list was saved, then try again',
    }, 422)
  }

  // Commit the link.
  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)
  member.handle = handle
  await env.MEMBERS_KV.put(`member:${claims.email}`, JSON.stringify(member))
  await env.MEMBERS_KV.put(`email:${handle}`, claims.email)
  await env.MEMBERS_KV.put(`handle:${claims.email}`, handle)
  await env.MEMBERS_KV.delete(`lb_token:${claims.email}`)

  await dispatchGithub(env, 'update-member', {
    id: member.id,
    updates: { handle },
  })
  return json(env, { ok: true, handle })
}

// POST /letterboxd/unlink — authenticated
// Drops the verified Letterboxd link from the member row and public JSON.
// Idempotent-ish: 400s if there's nothing to unlink.
async function handleLbUnlink(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)
  if (!member.handle) return json(env, { error: 'no Letterboxd linked' }, 400)

  const handle = member.handle
  member.handle = null
  await env.MEMBERS_KV.put(`member:${claims.email}`, JSON.stringify(member))
  await env.MEMBERS_KV.delete(`email:${handle}`)
  await env.MEMBERS_KV.delete(`handle:${claims.email}`)
  await env.MEMBERS_KV.delete(`lb_token:${claims.email}`)

  // `handle: null` tells update-member.yml to drop the field from the
  // public members.json row.
  await dispatchGithub(env, 'update-member', {
    id: member.id,
    updates: { handle: null },
  })
  return json(env, { ok: true })
}

// --- Member read + update ---

async function handleMemberMe(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const raw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!raw) return json(env, { error: 'member not found' }, 404)
  return json(env, JSON.parse(raw))
}



async function handleMemberUpdate(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  const body = await request.json()
  const updates = {}
  if (typeof body.name === 'string' && body.name.length) updates.name = body.name
  if (typeof body.pronouns === 'string') updates.pronouns = body.pronouns
  if (!Object.keys(updates).length) return json(env, { error: 'no updates' }, 400)

  Object.assign(member, updates)
  await env.MEMBERS_KV.put(`member:${claims.email}`, JSON.stringify(member))
  await dispatchGithub(env, 'update-member', { id: member.id, updates })
  return json(env, { ok: true, id: member.id })
}

// --- Attendance ---

// GET /events/:id/attendance — public; returns { attendees: [...handles] }.
// Reads from KV so the UI sees self-report changes before the workflow commits.
async function handleAttendanceGet(env, eventId) {
  const raw = await env.ATTENDANCE_KV.get(`attend:${eventId}`)
  return json(env, { attendees: raw ? JSON.parse(raw) : [] })
}

// POST /events/:id/attend — authenticated; member must have a verified handle.
async function handleAttend(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)
  if (!member.handle) return json(env, { error: 'link your Letterboxd handle first' }, 403)

  const attendees = await readAttendees(env, eventId)
  if (!attendees.includes(member.handle)) {
    attendees.push(member.handle)
    await env.ATTENDANCE_KV.put(`attend:${eventId}`, JSON.stringify(attendees))
    await dispatchGithub(env, 'update-attendance', {
      event_id: eventId, handle: member.handle, action: 'add',
    })
  }
  return json(env, { ok: true, attendees })
}

// DELETE /events/:id/attend — authenticated; member must have a verified handle.
async function handleUnattend(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)
  if (!member.handle) return json(env, { error: 'link your Letterboxd handle first' }, 403)

  const attendees = await readAttendees(env, eventId)
  const idx = attendees.indexOf(member.handle)
  if (idx !== -1) {
    attendees.splice(idx, 1)
    await env.ATTENDANCE_KV.put(`attend:${eventId}`, JSON.stringify(attendees))
    await dispatchGithub(env, 'update-attendance', {
      event_id: eventId, handle: member.handle, action: 'remove',
    })
  }
  return json(env, { ok: true, attendees })
}

async function readAttendees(env, eventId) {
  const raw = await env.ATTENDANCE_KV.get(`attend:${eventId}`)
  return raw ? JSON.parse(raw) : []
}

// --- E2E / dev helper ---

async function handleTestKv(request, env) {
  if (request.method === 'POST') {
    const { key, value, ttl } = await request.json()
    await env.MEMBERS_KV.put(key, value, ttl ? { expirationTtl: ttl } : undefined)
    return json(env, { ok: true })
  }
  if (request.method === 'DELETE' && request.headers.get('Content-Type') === 'application/json') {
    const { key } = await request.json()
    await env.MEMBERS_KV.delete(key)
    return json(env, { ok: true })
  }
  if (request.method === 'GET') {
    const url = new URL(request.url)
    const key = url.searchParams.get('key')
    const prefix = url.searchParams.get('prefix')
    if (prefix !== null) {
      const list = await env.MEMBERS_KV.list({ prefix })
      return json(env, { keys: list.keys.map(k => k.name) })
    }
    const value = await env.MEMBERS_KV.get(key)
    return json(env, { key, value })
  }
  if (request.method === 'DELETE') {
    const url = new URL(request.url)
    const prefix = url.searchParams.get('prefix')
    if (prefix !== null) {
      const list = await env.MEMBERS_KV.list({ prefix })
      await Promise.all(list.keys.map(k => env.MEMBERS_KV.delete(k.name)))
      return json(env, { deleted: list.keys.length })
    }
  }
  return json(env, { error: 'method not allowed' }, 405)
}

// --- Email ---

async function sendSignupEmail(env, to, code, lbToken, handle) {
  const subject = 'Your Jackson Film Club membership code'
  const lbLine = handle
    ? `letterboxd.com/${handle}`
    : 'your Letterboxd profile'
  const text = [
    `Your membership code: ${code}`,
    '',
    `Enter this 6-digit code on ${env.SITE_ORIGIN || 'https://jxnfilm.club'}/verify`,
    'to confirm your Jackson Film Club membership. This code expires in 10 minutes.',
    '',
    '---',
    '',
    'Optional — verify your Letterboxd profile',
    '',
    `To add a verified link to ${lbLine} on your member entry, add this tag`,
    'to a diary entry or a list on your Letterboxd profile:',
    '',
    `  ${lbToken}`,
    '',
    `(expires in 48 hours)`,
    '',
    'Then visit https://jxnfilm.club/edit and click "Verify Letterboxd".',
  ].join('\n')
  await sendEmail(env, to, subject, text)
}

async function sendLoginEmail(env, to, code) {
  const text = [
    `Your login code: ${code}`,
    '',
    'This code expires in 10 minutes.',
    "If you didn't request it, ignore this email.",
  ].join('\n')
  await sendEmail(env, to, 'Your Jackson Film Club login code', text)
}

async function sendEmail(env, to, subject, text) {
  if (env.E2E_MODE === 'true') {
    await env.MEMBERS_KV.put('__last_email__', JSON.stringify({ to, subject, text }))
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
      subject,
      text,
    }),
  })
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
}

// --- GitHub dispatch ---

async function dispatchGithub(env, event_type, client_payload) {
  if (env.E2E_MODE === 'true') {
    await env.MEMBERS_KV.put('__last_dispatch__', JSON.stringify({ event_type, client_payload }))
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

// --- Tokens ---

async function authorize(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  return verifyToken(env, auth)
}

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

function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

function randomToken(len) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}
