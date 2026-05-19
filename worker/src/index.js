import privacyHtml from './privacy.html'
import signupHtml from './signup.html'

const OTP_TTL = 600          // 10 min
const SESSION_TTL = 3600     // 1 hour — matches JWT exp
// Cloudflare KV enforces a 60s minimum expirationTtl, so 60 is the floor for
// both knobs. Throttle is permissive on the user side — a single stuck code
// is still valid for OTP_TTL.
const SEND_THROTTLE = 60
const SIGNUP_THROTTLE = 60
const MAX_OTP_FAILURES = 5   // wrong-code lockout per email per OTP window

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
})

function originOk(request, env) {
  const origin = request.headers.get('Origin')
  if (!origin) return true
  if (origin === env.SITE_ORIGIN) return true
  // The Worker also serves the signup form at its own root (`GET /`); that
  // form POSTs back to /signup, so same-origin requests must pass too.
  if (origin === new URL(request.url).origin) return true
  return false
}

// --- Rate limiting (KV-backed, eventually consistent) ---
//
// KV writes race, so concurrent callers can both pass `throttle()` once. That's
// fine — the goal is to bound abuse, not to be a hard mutex. Counters live
// long enough to span the threat window; legitimate users recover after TTL.

async function throttle(env, key, windowSec) {
  if (await env.MEMBERS_KV.get(key)) return false
  await env.MEMBERS_KV.put(key, '1', { expirationTtl: windowSec })
  return true
}

async function checkAttempts(env, key, max) {
  const raw = await env.MEMBERS_KV.get(key)
  return (raw ? Number(raw) : 0) < max
}

async function recordFailure(env, key, windowSec) {
  const raw = await env.MEMBERS_KV.get(key)
  const count = (raw ? Number(raw) : 0) + 1
  await env.MEMBERS_KV.put(key, String(count), { expirationTtl: windowSec })
}

async function clearAttempts(env, key) {
  await env.MEMBERS_KV.delete(key)
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env)
    } catch (err) {
      // Any uncaught throw from a handler would otherwise become a default
      // 500 with no CORS headers, which browsers surface as a CORS violation
      // instead of the real error. Funnel everything through json() so
      // Access-Control-Allow-Origin is always set.
      console.error('Worker uncaught:', err && err.stack || err)
      return json(env, { error: 'internal server error' }, 500)
    }
  },
}

async function route(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) })

    // Defense-in-depth: if a browser sent an Origin header, it must match
    // SITE_ORIGIN. Bearer-token auth already blocks classic CSRF, but this
    // rejects cross-origin browser POSTs even if CORS is somehow misconfigured.
    // Non-browser callers (curl, server-to-server, unit tests via SELF.fetch)
    // typically omit Origin and pass through.
    if (request.method !== 'GET' && request.method !== 'OPTIONS' && !originOk(request, env)) {
      return json(env, { error: 'invalid origin' }, 403)
    }

    if (request.method === 'GET' && pathname === '/')        return html(render(signupHtml, env))
    if (request.method === 'GET' && pathname === '/privacy') return html(privacyHtml)

    if (request.method === 'POST' && pathname === '/signup')         return handleSignup(request, env)
    if (request.method === 'POST' && pathname === '/signup/verify')  return handleSignupVerify(request, env)

    if (request.method === 'POST' && pathname === '/otp/request')    return handleOtpRequest(request, env)
    if (request.method === 'POST' && pathname === '/otp/verify')     return handleOtpVerify(request, env)

    if (request.method === 'POST' && pathname === '/letterboxd/unlink')  return handleLbUnlink(request, env)

    if (request.method === 'GET'  && pathname === '/member/me')      return handleMemberMe(request, env)
    if (request.method === 'POST' && pathname === '/member/update')  return handleMemberUpdate(request, env)
    if (request.method === 'POST' && pathname === '/member/delete')  return handleMemberDelete(request, env)

    if (request.method === 'POST' && pathname === '/session/revoke') return handleSessionRevoke(request, env)

    if (request.method === 'GET' && pathname === '/events/attendance') return handleAttendanceMap(env)

    const eventMatch = pathname.match(/^\/events\/([^\/]+)\/(attend|attendance)$/)
    if (eventMatch) {
      const [, eventId, suffix] = eventMatch
      if (suffix === 'attendance' && request.method === 'GET')   return handleAttendanceGet(env, eventId)
      if (suffix === 'attend'     && request.method === 'POST')  return handleAttend(request, env, eventId)
      if (suffix === 'attend'     && request.method === 'DELETE') return handleUnattend(request, env, eventId)
    }

    if (env.E2E_MODE === 'true' && pathname === '/__test/kv') return handleTestKv(request, env)

    return new Response('Not Found', { status: 404 })
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

// Letterboxd handles top out around 15 chars in practice; 30 is generous.
const HANDLE_RE = /^[a-zA-Z0-9_-]{1,30}$/
const MAX_EMAIL = 254       // RFC 5321 max length for a forward-path
const MAX_NAME = 80
const MAX_PRONOUNS = 32
// Loose RFC-5322-lite: rejects obvious garbage without descending into the
// full grammar. Resend will bounce anything that survives this.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isValidEmail(s) {
  return typeof s === 'string' && s.length <= MAX_EMAIL && EMAIL_RE.test(s)
}

function isValidName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_NAME
}

// --- Signup ---

// POST /signup — (email, name, handle?)
// Creates pending:{email} with OTP code. The optional handle is held on the
// pending row and promoted to the member row at /signup/verify time.
async function handleSignup(request, env) {
  const { email, name, handle } = await request.json()
  if (!email || !name) return json(env, { error: 'email and name required' }, 400)
  if (!isValidEmail(email)) return json(env, { error: 'invalid email format' }, 400)
  if (!isValidName(name)) return json(env, { error: 'invalid name' }, 400)
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

  // Throttle email sends so a single email can't be used to spam a victim's
  // inbox or burn through the Resend monthly quota.
  if (!(await throttle(env, `rate:signup_send:${email}`, SIGNUP_THROTTLE))) {
    return json(env, { error: 'please wait a moment before requesting another code' }, 429)
  }

  const code = randomCode()
  await env.MEMBERS_KV.put(
    `pending:${email}`,
    JSON.stringify({ name, handle: handle || null, code }),
    { expirationTtl: OTP_TTL },
  )

  await sendSignupEmail(env, email, code)
  return json(env, { ok: true })
}

// POST /signup/verify — (email, code)
// Promotes pending:{email} to member:{email}, dispatches add-member with a
// new random member id, and returns a session token. If the pending row
// carries a Letterboxd handle, it's promoted onto the member row and the
// reverse index keys are written in the same pass — no separate verify step.
async function handleSignupVerify(request, env) {
  const { email, code } = await request.json()
  if (!isValidEmail(email)) return json(env, { error: 'invalid email format' }, 400)

  const attemptsKey = `rate:signup_verify_fail:${email}`
  if (!(await checkAttempts(env, attemptsKey, MAX_OTP_FAILURES))) {
    return json(env, { error: 'too many attempts — request a new code' }, 429)
  }

  const pendingRaw = await env.MEMBERS_KV.get(`pending:${email}`)
  if (!pendingRaw) return json(env, { error: 'no pending signup — start over' }, 404)

  const pending = JSON.parse(pendingRaw)
  if (pending.code !== code) {
    await recordFailure(env, attemptsKey, OTP_TTL)
    return json(env, { error: 'invalid code' }, 401)
  }
  await clearAttempts(env, attemptsKey)

  // Re-check handle uniqueness right before commit. The 10-min OTP window
  // is small but non-zero — narrow the race to the few KV propagation
  // milliseconds (eventual consistency means we can't eliminate it).
  let handle = pending.handle || null
  if (handle) {
    const claimedBy = await env.MEMBERS_KV.get(`email:${handle}`)
    if (claimedBy && claimedBy !== email) {
      handle = null  // someone else won the race — strip rather than 409 mid-verify
    }
  }

  const id = randomToken(10)
  const member = {
    id,
    email,
    name: pending.name,
    pronouns: null,
    handle,
    joined: new Date().toISOString().slice(0, 10),
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  if (handle) {
    await env.MEMBERS_KV.put(`email:${handle}`, email)
    await env.MEMBERS_KV.put(`handle:${email}`, handle)
  }
  await env.MEMBERS_KV.delete(`pending:${email}`)
  await writeSession(env, member)
  const addPayload = { id, name: member.name, joined: member.joined }
  if (handle) addPayload.handle = handle
  await dispatchGithub(env, 'add-member', addPayload)

  const token = await signToken(env, { email, id, exp: Date.now() + 3600_000, jti: randomToken(16) })
  return json(env, { token, email, id, name: member.name, handle })
}

// --- Sign-in (returning members) ---

async function handleOtpRequest(request, env) {
  const { email } = await request.json()
  if (!email) return json(env, { error: 'email required' }, 400)
  if (!isValidEmail(email)) return json(env, { error: 'invalid email format' }, 400)
  if (!(await env.MEMBERS_KV.get(`member:${email}`))) {
    // Don't leak membership existence; silently 200. The UI will just say
    // "if this email is on file, we sent a code".
    return json(env, { ok: true })
  }

  // Throttle email sends. Silent 200 on throttle so we don't reveal via timing
  // or status code whether this address is being throttled (would leak
  // membership). Legit users who legitimately want a fresh code wait ~30s.
  if (!(await throttle(env, `rate:otp_send:${email}`, SEND_THROTTLE))) {
    return json(env, { ok: true })
  }

  const code = randomCode()
  await env.MEMBERS_KV.put(`otp:${email}`, code, { expirationTtl: OTP_TTL })
  await sendLoginEmail(env, email, code)
  return json(env, { ok: true })
}

async function handleOtpVerify(request, env) {
  const { email, code } = await request.json()
  if (!isValidEmail(email)) return json(env, { error: 'invalid email format' }, 400)

  const attemptsKey = `rate:otp_verify_fail:${email}`
  if (!(await checkAttempts(env, attemptsKey, MAX_OTP_FAILURES))) {
    return json(env, { error: 'too many attempts — request a new code' }, 429)
  }

  const stored = await env.MEMBERS_KV.get(`otp:${email}`)
  if (!stored || stored !== code) {
    await recordFailure(env, attemptsKey, OTP_TTL)
    return json(env, { error: 'invalid code' }, 401)
  }

  await env.MEMBERS_KV.delete(`otp:${email}`)
  await clearAttempts(env, attemptsKey)
  const memberRaw = await env.MEMBERS_KV.get(`member:${email}`)
  const member = memberRaw ? JSON.parse(memberRaw) : null
  if (!member) return json(env, { error: 'no member linked to this email' }, 403)

  await writeSession(env, member)
  const token = await signToken(env, { email, id: member.id, exp: Date.now() + 3600_000, jti: randomToken(16) })
  return json(env, { token, email, id: member.id, name: member.name, handle: member.handle })
}

// --- Letterboxd link ---
//
// Handle setting now lives in /member/update (members self-assert; the local
// admin dashboard handles disputes). Only unlinking has a dedicated endpoint
// because the cascade is distinct (reverse-index cleanup + JSON projection
// update with handle: null).

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
  await writeSession(env, member)

  // `handle: null` tells update-member.yml to drop the field from the
  // public members.json row.
  await dispatchGithub(env, 'update-member', {
    id: member.id,
    updates: { handle: null },
  })
  return json(env, { ok: true })
}

// --- Member read + update ---

// /member/me reads the per-session snapshot first (session:{id}) so a recent
// write lands in subsequent reads without waiting on the update-member
// workflow. On a session-KV miss we fall back to member:{email} and reseed,
// mirroring readAttendees' baseline-on-miss pattern.
async function handleMemberMe(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const member = await readSession(env, claims)
  if (!member) return json(env, { error: 'member not found' }, 404)
  return json(env, member)
}

async function handleMemberUpdate(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  const body = await request.json()
  const updates = {}
  if (typeof body.name === 'string' && body.name.length) {
    if (body.name.length > MAX_NAME) return json(env, { error: 'name too long' }, 400)
    updates.name = body.name
  }
  if (typeof body.pronouns === 'string') {
    if (body.pronouns.length > MAX_PRONOUNS) return json(env, { error: 'pronouns too long' }, 400)
    updates.pronouns = body.pronouns
  }
  // Letterboxd handle. Self-asserted as of the tag-verification removal —
  // admin moderation (via the local dashboard) is now the dispute path.
  // Uniqueness is still enforced via the email:{handle} reverse index so two
  // members can't claim the same handle.
  if (typeof body.handle === 'string' && body.handle.length) {
    if (!HANDLE_RE.test(body.handle)) {
      return json(env, { error: 'invalid handle format' }, 400)
    }
    if (body.handle !== member.handle) {
      const claimedBy = await env.MEMBERS_KV.get(`email:${body.handle}`)
      if (claimedBy && claimedBy !== claims.email) {
        return json(env, { error: 'this Letterboxd handle is already claimed' }, 409)
      }
    }
    updates.handle = body.handle
  }
  if (!Object.keys(updates).length) return json(env, { error: 'no updates' }, 400)

  // If the handle is changing, swap the reverse indices in lockstep with the
  // member row so a stale email:{old} or handle:{email} can't outlive the
  // member's actual handle.
  if (updates.handle && updates.handle !== member.handle) {
    if (member.handle) {
      await env.MEMBERS_KV.delete(`email:${member.handle}`)
    }
    await env.MEMBERS_KV.put(`email:${updates.handle}`, claims.email)
    await env.MEMBERS_KV.put(`handle:${claims.email}`, updates.handle)
  }

  Object.assign(member, updates)
  await env.MEMBERS_KV.put(`member:${claims.email}`, JSON.stringify(member))
  await writeSession(env, member)
  await dispatchGithub(env, 'update-member', { id: member.id, updates })
  return json(env, { ok: true, id: member.id })
}

// POST /member/delete — authenticated.
// Self-service membership deletion. Removes the member row, all reverse
// indices, any in-flight Letterboxd token, and the session snapshot.
// Revokes the current bearer token so a copy can't be replayed. Dispatches
// `remove-member` to drop the row from data/members.json. Past attendance
// entries (attend:{eventId} in ATTENDANCE_KV) are intentionally kept as
// historical record — only the member identity is removed.
async function handleMemberDelete(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  // Opt-in attendance scrub. Past `attend:{eventId}` arrays default to keeping
  // the member's name as historical record; with `anonymize: true` we replace
  // each occurrence of member.name with a generic "former member" label so the
  // event count is preserved while the identity is removed.
  const body = await request.json().catch(() => ({}))
  if (body && body.anonymize === true && member.name) {
    await anonymizeAttendance(env, member.name)
  }

  // KV cascade. Order doesn't matter for correctness — each delete is
  // independent — but doing the canonical row first means a mid-flight
  // crash leaves nothing reachable rather than a dangling reverse index.
  await env.MEMBERS_KV.delete(`member:${claims.email}`)
  if (member.id) await env.MEMBERS_KV.delete(`session:${member.id}`)
  if (member.handle) {
    await env.MEMBERS_KV.delete(`email:${member.handle}`)
    await env.MEMBERS_KV.delete(`handle:${claims.email}`)
  }
  await env.MEMBERS_KV.delete(`lb_token:${claims.email}`)

  // Revoke this token so a stolen copy can't be used to re-sign-in or hit
  // any other authenticated endpoint during the JWT's remaining lifetime.
  if (claims.jti) {
    const remainingSec = Math.max(60, Math.ceil((claims.exp - Date.now()) / 1000))
    await env.MEMBERS_KV.put(`revoked:${claims.jti}`, '1', { expirationTtl: remainingSec })
  }

  await dispatchGithub(env, 'remove-member', { id: member.id })
  return json(env, { ok: true })
}

// Attendance is stored as `attend:{eventId} -> [name, name, ...]`, name-keyed
// (not id-keyed). Walking the entire prefix is the only way to find a
// member's past attendance — there's no per-member index. For a small club
// this is cheap; a 1000-member future would want an `attended_by:{name}` index.
//
// Collision note: members are de-duped by display name on attend, so two
// members sharing a name would already be conflated in attendance lists.
// Scrubbing by name will remove all of them. The signup flow doesn't enforce
// unique names — picking a creative-but-unique display name is on the user.
const FORMER_MEMBER_LABEL = 'former member'

async function anonymizeAttendance(env, memberName) {
  const list = await env.ATTENDANCE_KV.list({ prefix: 'attend:' })
  for (const k of list.keys) {
    const raw = await env.ATTENDANCE_KV.get(k.name)
    if (!raw) continue
    let arr
    try { arr = JSON.parse(raw) } catch { continue }
    if (!Array.isArray(arr)) continue
    const idx = arr.indexOf(memberName)
    if (idx === -1) continue
    arr.splice(idx, 1)
    if (!arr.includes(FORMER_MEMBER_LABEL)) arr.push(FORMER_MEMBER_LABEL)
    const eventId = k.name.slice('attend:'.length)
    // Reuse writeAttendees so attendance:all aggregate stays in lockstep.
    await writeAttendees(env, eventId, arr)
  }
}

// POST /session/revoke — authenticated.
// Drops the current bearer token by recording its jti in revoked:{jti} with a
// TTL matching the token's remaining lifetime. verifyToken consults this on
// every authenticated read. Idempotent; replays just refresh the same key.
async function handleSessionRevoke(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  // Tokens issued before jti was added can't be revoked server-side; the
  // client should still drop its localStorage session so this is best-effort
  // from their side. Return ok so the UI button always succeeds.
  if (!claims.jti) return json(env, { ok: true })
  // KV minimum TTL is 60s; clamp anything shorter (token would expire before
  // a meaningful next request anyway).
  const remainingSec = Math.max(60, Math.ceil((claims.exp - Date.now()) / 1000))
  await env.MEMBERS_KV.put(`revoked:${claims.jti}`, '1', { expirationTtl: remainingSec })
  // Also evict the session snapshot so /member/me can't serve cached data to
  // an attacker who somehow replays before the revocation propagates.
  if (claims.id) await env.MEMBERS_KV.delete(`session:${claims.id}`)
  return json(env, { ok: true })
}

// Session KV overlay — session:{id} holds a short-TTL (1h) snapshot of the
// member row so authenticated reads don't need to re-resolve the email from
// the token or merge with the still-propagating public members.json.
//
// Write-through: every handler that mutates member:{email} also refreshes
// the session snapshot, so the next /member/me reflects the change without
// waiting on the update-member workflow. Read path mirrors readAttendees —
// fall back to member:{email} on a session-KV miss and reseed.
async function writeSession(env, member) {
  if (!member?.id) return
  await env.MEMBERS_KV.put(
    `session:${member.id}`,
    JSON.stringify(member),
    { expirationTtl: SESSION_TTL },
  )
}

async function readSession(env, claims) {
  const sessionRaw = await env.MEMBERS_KV.get(`session:${claims.id}`)
  if (sessionRaw) return JSON.parse(sessionRaw)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return null
  const member = JSON.parse(memberRaw)
  await writeSession(env, member)
  return member
}

// --- Attendance ---
//
// KV-first architecture: ATTENDANCE_KV is the single live source of truth.
// `data/attendance.json` in the repo is an archival snapshot committed by the
// snapshot-attendance workflow and a one-shot bootstrap source when a KV
// namespace is empty (first deploy, new staging namespace, manual wipe).
//
// KV layout:
//   attend:{eventId}        — canonical per-event attendee array
//   attendance:all          — aggregate map { eventId: [names] } for O(1) bulk reads
//   attendance:bootstrapped — marker; presence means the repo→KV seed has run
//
// Reads never touch the repo on the hot path. The aggregate is refreshed
// write-through on every mutation, mirroring the session:{id} overlay pattern.

// GET /events/:id/attendance — public; returns { attendees: [...names] }.
async function handleAttendanceGet(env, eventId) {
  const attendees = await readAttendees(env, eventId)
  return json(env, { attendees })
}

// GET /events/attendance — public; bulk read { [eventId]: [...names] }.
// Single KV GET in the steady state.
async function handleAttendanceMap(env) {
  const all = await readAttendanceAll(env)
  return json(env, { attendance: all })
}

// POST /events/:id/attend — authenticated.
// Writes to ATTENDANCE_KV only. The snapshot-attendance workflow runs on a
// cron and flushes KV to data/attendance.json; there is no per-click workflow
// dispatch, so rapid toggles don't queue individual GitHub Actions runs.
async function handleAttend(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  const attendees = await readAttendees(env, eventId)
  if (!attendees.includes(member.name)) {
    attendees.push(member.name)
    await writeAttendees(env, eventId, attendees)
  }
  return json(env, { ok: true, attendees })
}

// DELETE /events/:id/attend — authenticated. KV-only, same reasoning as attend.
async function handleUnattend(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)

  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  const attendees = await readAttendees(env, eventId)
  const idx = attendees.indexOf(member.name)
  if (idx !== -1) {
    attendees.splice(idx, 1)
    await writeAttendees(env, eventId, attendees)
  }
  return json(env, { ok: true, attendees })
}

// Per-event read: canonical attend:{id} first, then aggregate overlay as a
// fallback for events that predate the per-event key being written. No repo
// fetch — if both are missing, the event simply has no attendees.
async function readAttendees(env, eventId) {
  const raw = await env.ATTENDANCE_KV.get(`attend:${eventId}`)
  if (raw) {
    try { return JSON.parse(raw) } catch { /* fall through */ }
  }
  const all = await readAttendanceAll(env)
  return Array.isArray(all[eventId]) ? all[eventId] : []
}

// Aggregate read with one-shot bootstrap. Returns {} on total cold start if
// the repo baseline is unreachable; the next request retries the bootstrap.
async function readAttendanceAll(env) {
  const raw = await env.ATTENDANCE_KV.get('attendance:all')
  if (raw) {
    try { return JSON.parse(raw) } catch { /* fall through to bootstrap */ }
  }
  return await bootstrapAttendance(env)
}

// Write-through: canonical per-event key + patch the aggregate overlay so the
// next bulk read reflects this change in a single KV GET.
async function writeAttendees(env, eventId, attendees) {
  await env.ATTENDANCE_KV.put(`attend:${eventId}`, JSON.stringify(attendees))
  const allRaw = await env.ATTENDANCE_KV.get('attendance:all')
  const all = allRaw ? safeParseObject(allRaw) : await bootstrapAttendance(env)
  all[eventId] = attendees
  await env.ATTENDANCE_KV.put('attendance:all', JSON.stringify(all))
}

// One-shot per KV namespace: seed attendance:all + each attend:{id} from
// data/attendance.json, then mark bootstrapped. Any per-event KV entries that
// already exist win over baseline — that covers the case where a write lands
// before the first read triggers bootstrap. Subsequent calls return the
// cached aggregate without re-seeding. Returns the aggregate (possibly {}).
async function bootstrapAttendance(env) {
  if (await env.ATTENDANCE_KV.get('attendance:bootstrapped')) {
    const raw = await env.ATTENDANCE_KV.get('attendance:all')
    return raw ? safeParseObject(raw) : {}
  }
  const baseline = await fetchAttendanceBaseline(env)
  const list = await env.ATTENDANCE_KV.list({ prefix: 'attend:' })
  const existing = await Promise.all(
    list.keys.map(async k => [k.name.slice('attend:'.length), await env.ATTENDANCE_KV.get(k.name)]),
  )
  const merged = { ...baseline }
  for (const [eventId, raw] of existing) {
    if (raw) {
      try { merged[eventId] = JSON.parse(raw) } catch { /* skip corrupt entry */ }
    }
  }
  await env.ATTENDANCE_KV.put('attendance:all', JSON.stringify(merged))
  await Promise.all(
    Object.entries(merged).map(([id, attendees]) =>
      env.ATTENDANCE_KV.put(`attend:${id}`, JSON.stringify(Array.isArray(attendees) ? attendees : [])),
    ),
  )
  await env.ATTENDANCE_KV.put('attendance:bootstrapped', '1')
  return merged
}

function safeParseObject(raw) {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch { return {} }
}

// Reads data/attendance.json from GitHub raw content. Only invoked by
// bootstrapAttendance on a fresh KV namespace. In E2E mode the network is
// suppressed — tests seed KV directly. On any failure we return {} so the
// worker stays available; the next request retries the bootstrap.
async function fetchAttendanceBaseline(env) {
  if (env.E2E_MODE === 'true') return {}
  const owner = env.GITHUB_OWNER
  const repo = env.GITHUB_REPO
  const branch = env.GITHUB_BRANCH || 'main'
  if (!owner || !repo) return {}
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/data/attendance.json`,
      { headers: { 'User-Agent': 'jxnfilmclub-join' }, cf: { cacheTtl: 60, cacheEverything: true } },
    )
    if (!res.ok) return {}
    const data = await res.json()
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  } catch { return {} }
}

// --- E2E / dev helper ---

async function handleTestKv(request, env) {
  // Default to MEMBERS_KV for back-compat with existing fixtures; tests that
  // need attendance state pass ?ns=ATTENDANCE_KV (or { ns: ... } in the body).
  const url = new URL(request.url)
  const resolveNs = (raw) => {
    if (!raw || raw === 'MEMBERS_KV') return env.MEMBERS_KV
    if (raw === 'ATTENDANCE_KV') return env.ATTENDANCE_KV
    throw new HttpErrorLite(400, `invalid ns: ${raw}`)
  }
  // POST body or DELETE-with-body can override too — keeps the seed helper
  // signatures flat (no extra query stringification).
  const nsFromQuery = url.searchParams.get('ns')

  if (request.method === 'POST') {
    const { key, value, ttl, ns } = await request.json()
    const kv = resolveNs(ns || nsFromQuery)
    await kv.put(key, value, ttl ? { expirationTtl: ttl } : undefined)
    return json(env, { ok: true })
  }
  if (request.method === 'DELETE' && request.headers.get('Content-Type') === 'application/json') {
    const { key, ns } = await request.json()
    const kv = resolveNs(ns || nsFromQuery)
    await kv.delete(key)
    return json(env, { ok: true })
  }
  if (request.method === 'GET') {
    const kv = resolveNs(nsFromQuery)
    const key = url.searchParams.get('key')
    const prefix = url.searchParams.get('prefix')
    if (prefix !== null) {
      const list = await kv.list({ prefix })
      return json(env, { keys: list.keys.map(k => k.name) })
    }
    const value = await kv.get(key)
    return json(env, { key, value })
  }
  if (request.method === 'DELETE') {
    const kv = resolveNs(nsFromQuery)
    const prefix = url.searchParams.get('prefix')
    if (prefix !== null) {
      const list = await kv.list({ prefix })
      await Promise.all(list.keys.map(k => kv.delete(k.name)))
      return json(env, { deleted: list.keys.length })
    }
  }
  return json(env, { error: 'method not allowed' }, 405)
}

// Lightweight throw helper used only inside the E2E shim; the dispatcher's
// existing try/catch surfaces it as the right JSON shape.
class HttpErrorLite extends Error {
  constructor(status, msg) { super(msg); this.status = status }
}

// --- Email ---

async function sendSignupEmail(env, to, code) {
  const subject = 'Your Jackson Film Club membership code'
  const text = [
    `Your membership code: ${code}`,
    '',
    `Enter this 6-digit code on ${env.SITE_ORIGIN || 'https://jxnfilm.club'}/verify`,
    'to confirm your Jackson Film Club membership. This code expires in 10 minutes.',
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
//
// Best-effort: KV is the source of truth, the data/*.json projection is
// downstream. A throw here would block the KV cascade in callers mid-flight
// (an expired PAT once half-deleted a real member — KV gone, JSON intact).
// Instead we log and write a `dispatch_failed:` audit row that
// scripts/admin/kv-audit.mjs and the local admin dashboard can pick up to
// reconcile drift.

async function dispatchGithub(env, event_type, client_payload) {
  if (env.E2E_MODE === 'true') {
    await env.MEMBERS_KV.put('__last_dispatch__', JSON.stringify({ event_type, client_payload }))
    return
  }
  // Staging writes to KV but never commits to the shared data/*.json ledger in
  // main. Skip the dispatch entirely so staging activity stays isolated.
  if (env.ENVIRONMENT === 'staging') return
  try {
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
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      await recordDispatchFailure(env, event_type, client_payload, `${res.status}: ${detail}`)
    }
  } catch (err) {
    await recordDispatchFailure(env, event_type, client_payload, `threw: ${err && err.message || err}`)
  }
}

async function recordDispatchFailure(env, event_type, client_payload, reason) {
  console.error(`GitHub dispatch ${event_type} failed (${reason})`)
  // 7-day TTL so the audit log is bounded but easy to inspect from the local
  // admin dashboard via /api/kv?prefix=dispatch_failed:.
  try {
    const key = `dispatch_failed:${event_type}:${Date.now()}`
    await env.MEMBERS_KV.put(
      key,
      JSON.stringify({ event_type, client_payload, reason, at: new Date().toISOString() }),
      { expirationTtl: 7 * 24 * 3600 },
    )
  } catch { /* audit failure is non-fatal — KV cascade has already succeeded */ }
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
  if (!(claims.exp > Date.now())) return null
  // Server-side revocation overlay. Tokens issued before this commit have no
  // jti and can't be revoked — they still expire on schedule.
  if (claims.jti && await env.MEMBERS_KV.get(`revoked:${claims.jti}`)) return null
  return claims
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

// Lowercase alphanumeric only: Letterboxd flattens tag text/URLs to
// lowercase, and member ids end up in public JSON + URL fragments, so
// lowercase keeps everything round-trippable without case mismatch.
// 36 chars × 8 positions = 2.8e12 combos for LB tokens — plenty.
function randomToken(len) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(len))
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('')
}
