import privacyHtml from './privacy.html'
import signupHtml from './signup.html'
import brandCss from './brand.css'
import faviconIco from './favicon.ico'

const OTP_TTL = 600          // 10 min
const SESSION_TTL = 3600     // 1 hour — matches JWT exp
const REFRESH_TTL = 30 * 24 * 3600  // 30 days — "remember this device" token
// Cloudflare KV enforces a 60s minimum expirationTtl, so 60 is the floor for
// both knobs. Throttle is permissive on the user side — a single stuck code
// is still valid for OTP_TTL.
const SEND_THROTTLE = 60
const SIGNUP_THROTTLE = 60
const MAX_OTP_FAILURES = 5   // wrong-code lockout per email per OTP window

// Screening dates are calendar days in the club's home timezone (Jackson, MS).
// Gating "today" off UTC instead would roll over 5-6 hours early each evening
// Central time, blocking same-day event creation and cancelling/scrubbing
// screenings hours before they've actually happened locally.
function centralToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
}

const cors = (env) => ({
  'Access-Control-Allow-Origin': env.SITE_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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

  // Daily cron (see [triggers] in wrangler.toml): privacy retention promise
  // from /privacy — 30 days after a screening, attendee emails and the host's
  // address/notes are deleted.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scrubPastEvents(env))
  },
}

async function route(request, env) {
    const url = new URL(request.url)
    const { pathname } = url

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(env) })

    // Unsubscribe is authenticated by its own signed token, not by Origin/CORS.
    // The RFC 8058 one-click POST is issued server-to-server by the recipient's
    // mailbox provider, so it must bypass the Origin gate below.
    if (pathname === '/unsubscribe' && (request.method === 'GET' || request.method === 'POST')) {
      return handleUnsubscribe(request, env)
    }
    // RSVP cancel link in screening emails — same rationale: token-authenticated,
    // GET shows a confirm page and POST performs the cancel from any origin.
    if (pathname === '/rsvp/cancel' && (request.method === 'GET' || request.method === 'POST')) {
      return handleRsvpCancel(request, env)
    }

    // Defense-in-depth: if a browser sent an Origin header, it must match
    // SITE_ORIGIN. Bearer-token auth already blocks classic CSRF, but this
    // rejects cross-origin browser POSTs even if CORS is somehow misconfigured.
    // Non-browser callers (curl, server-to-server, unit tests via SELF.fetch)
    // typically omit Origin and pass through.
    if (request.method !== 'GET' && request.method !== 'OPTIONS' && !originOk(request, env)) {
      return json(env, { error: 'invalid origin' }, 403)
    }

    if (request.method === 'GET' && pathname === '/')        return html(render(signupHtml, env))
    if (request.method === 'GET' && pathname === '/privacy') return html(render(privacyHtml, env))
    // Same icon as the main site (img/favicon.ico); the copy in worker/src is
    // byte-parity-tested. Served first-party so the browser's automatic
    // /favicon.ico request doesn't 404.
    if (request.method === 'GET' && pathname === '/favicon.ico') {
      return new Response(faviconIco, {
        headers: { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' },
      })
    }

    if (request.method === 'POST' && pathname === '/signup')         return handleSignup(request, env)
    if (request.method === 'POST' && pathname === '/signup/verify')  return handleSignupVerify(request, env)

    if (request.method === 'POST' && pathname === '/otp/request')    return handleOtpRequest(request, env)
    if (request.method === 'POST' && pathname === '/otp/verify')     return handleOtpVerify(request, env)

    if (request.method === 'POST' && pathname === '/letterboxd/unlink')  return handleLbUnlink(request, env)

    if (request.method === 'GET'  && pathname === '/member/me')      return handleMemberMe(request, env)
    if (request.method === 'POST' && pathname === '/member/update')  return handleMemberUpdate(request, env)
    if (request.method === 'POST' && pathname === '/member/delete')  return handleMemberDelete(request, env)

    if (request.method === 'POST' && pathname === '/admin/newsletter/send') return handleNewsletterSend(request, env)
    if (request.method === 'POST' && pathname === '/admin/scrub')           return handleAdminScrub(request, env)
    if (request.method === 'POST' && pathname === '/admin/member/unlink')   return handleAdminMemberUnlink(request, env)

    if (request.method === 'POST' && pathname === '/session/revoke')  return handleSessionRevoke(request, env)
    if (request.method === 'POST' && pathname === '/session/refresh') return handleSessionRefresh(request, env)

    // Public read endpoints — Worker is the live source of truth, SPA hits
    // these directly so member/event mutations appear without a redeploy.
    // `data/{members,events}.json` are cron-snapshotted archives + fallbacks.
    if (request.method === 'GET' && pathname === '/members') return handleMembersGet(env)
    if (request.method === 'GET' && pathname === '/events')  return handleEventsGet(env)
    if (request.method === 'GET' && pathname === '/watched') return handleWatchedGet(env)
    if (request.method === 'GET' && pathname === '/avatars') return handleAvatarsGet(env)
    // Poster search for the /host form — members only (keeps the TMDB key
    // server-side and the endpoint un-scrapeable).
    if (request.method === 'GET' && pathname === '/tmdb/search') return handleTmdbSearch(request, env)
    if (request.method === 'GET' && pathname === '/tmdb/posters') return handleTmdbPosters(request, env)

    if (request.method === 'GET' && pathname === '/events/attendance') return handleAttendanceMap(env)

    // Member-hosted screenings: create / edit / cancel.
    if (request.method === 'POST' && pathname === '/events') return handleCreateEvent(request, env)
    const eventIdMatch = pathname.match(/^\/events\/([^\/]+)$/)
    if (eventIdMatch) {
      if (request.method === 'PATCH')  return handleUpdateEvent(request, env, eventIdMatch[1])
      if (request.method === 'DELETE') return handleDeleteEvent(request, env, eventIdMatch[1])
    }

    const eventMatch = pathname.match(/^\/events\/([^\/]+)\/(attend|attendance|rsvp|rsvp\/me|host)$/)
    if (eventMatch) {
      const [, eventId, suffix] = eventMatch
      if (suffix === 'attendance' && request.method === 'GET')   return handleAttendanceGet(env, eventId)
      if (suffix === 'attend'     && request.method === 'POST')  return handleAttend(request, env, eventId)
      if (suffix === 'attend'     && request.method === 'DELETE') return handleUnattend(request, env, eventId)
      if (suffix === 'rsvp'       && request.method === 'POST')   return handleRsvp(request, env, eventId)
      if (suffix === 'rsvp'       && request.method === 'DELETE') return handleUnrsvp(request, env, eventId)
      if (suffix === 'rsvp/me'    && request.method === 'GET')    return handleRsvpMe(request, env, eventId)
      if (suffix === 'host'       && request.method === 'GET')    return handleEventHostView(request, env, eventId)
    }

    if (env.E2E_MODE === 'true' && pathname === '/__test/kv') return handleTestKv(request, env)

    // Browsers get a branded 404; API callers (no text/html Accept) keep the
    // plain-text response.
    if (request.method === 'GET' && (request.headers.get('Accept') || '').includes('text/html')) {
      return html(page(env, {
        title: 'Not Found',
        body: '<h1>Not found</h1>' +
          '<p>That page doesn&#39;t exist.</p>' +
          `<p><a href="${siteOrigin(env)}/">&larr; Back to Jackson Film Club</a></p>`,
      }), 404)
    }
    return new Response('Not Found', { status: 404 })
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function render(template, env) {
  return template
    .replaceAll('%BRAND_CSS%', brandCss)
    .replaceAll('%SITE_ORIGIN%', siteOrigin(env))
}

function siteOrigin(env) {
  return env.SITE_ORIGIN || 'https://jxnfilm.club'
}

// Shared shell for pages built in JS (unsubscribe, RSVP cancel, 404) — same
// head, wordmark header, and footer as signup.html / privacy.html.
function page(env, { title, body }) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title)} · Jackson Film Club</title>` +
    '<link rel="icon" href="/favicon.ico">' +
    `<style>${brandCss}</style></head><body>` +
    `<nav class="topnav"><a class="logo" href="${siteOrigin(env)}/">` +
    '<span class="logo-word">JXN Film Club</span>' +
    '<span class="logo-stamp">Est. JXN MS</span></a></nav>' +
    body +
    '<footer class="site-footer">' +
    '<span class="site-footer-mark">Jackson Film Club · Est. JXN MS</span>' +
    '<nav class="site-footer-links"><a href="/privacy">Privacy</a>' +
    '<a href="mailto:privacy@jxnfilm.club">Contact</a></nav>' +
    '</footer></body></html>'
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
  const { email, name, handle, newsletter } = await request.json()
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
    JSON.stringify({ name, handle: handle || null, newsletter: !!newsletter, code }),
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
  const { email, code, remember } = await request.json()
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
    newsletter: !!pending.newsletter,
    joined: new Date().toISOString(),
  }
  await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
  if (handle) {
    await env.MEMBERS_KV.put(`email:${handle}`, email)
    await env.MEMBERS_KV.put(`handle:${email}`, handle)
  }
  await env.MEMBERS_KV.delete(`pending:${email}`)
  await patchMembersAll(env, publicMemberProjection(member))
  await writeSession(env, member)
  const addPayload = { id, name: member.name, joined: member.joined }
  if (handle) addPayload.handle = handle
  await dispatchGithub(env, 'add-member', addPayload)

  const token = await signToken(env, { email, id, exp: Date.now() + 3600_000, jti: randomToken(16) })
  const refresh = remember === true ? await issueRefreshToken(env, member) : undefined
  return json(env, { token, email, id, name: member.name, handle, refresh })
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
  const { email, code, remember } = await request.json()
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
  const refresh = remember === true ? await issueRefreshToken(env, member) : undefined
  return json(env, { token, email, id: member.id, name: member.name, handle: member.handle, refresh })
}

// --- Letterboxd link ---
//
// Handle setting now lives in /member/update (members self-assert; admin
// disputes go through POST /admin/member/unlink below). Only unlinking has
// dedicated endpoints because the cascade is distinct (reverse-index cleanup
// + JSON projection update with handle: null).

// Full unlink cascade, shared by POST /letterboxd/unlink (member
// self-service) and POST /admin/member/unlink (admin moderation).
// Idempotent: running it against a member whose handle is already null still
// re-projects the members:all row (publicMemberProjection omits falsy
// handles), repairing any stale aggregate state.
async function unlinkCascade(env, member) {
  // Capture the aggregate row's handle before patching — a drifted state can
  // leave a handle in members:all (and a stray email: index) after the
  // canonical row already lost it.
  const aggRow = (await readMembersAll(env)).find(m => m.id === member.id)
  const staleAggHandle = aggRow ? aggRow.handle : null

  const handle = member.handle
  member.handle = null
  await env.MEMBERS_KV.put(`member:${member.email}`, JSON.stringify(member))
  if (handle) await env.MEMBERS_KV.delete(`email:${handle}`)
  if (staleAggHandle && staleAggHandle !== handle) {
    // Only clean the stray reverse index if it still points at this member —
    // another member may have legitimately claimed the handle since.
    const owner = await env.MEMBERS_KV.get(`email:${staleAggHandle}`)
    if (owner === member.email) await env.MEMBERS_KV.delete(`email:${staleAggHandle}`)
  }
  await env.MEMBERS_KV.delete(`handle:${member.email}`)
  await env.MEMBERS_KV.delete(`lb_token:${member.email}`)
  await patchMembersAll(env, publicMemberProjection(member))
  // Rebuild /watched from the corrected aggregate on next request instead of
  // serving the unlinked member's RSS for up to 15 more minutes.
  await env.MEMBERS_KV.delete('watched:cache')
  await writeSession(env, member)

  // `handle: null` tells update-member.yml to drop the field from the
  // public members.json row.
  await dispatchGithub(env, 'update-member', {
    id: member.id,
    updates: { handle: null },
  })
  return { unlinked: handle || staleAggHandle || null }
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

  await unlinkCascade(env, member)
  return json(env, { ok: true })
}

// POST /admin/member/unlink — bearer-auth with ADMIN_TOKEN (same gate as
// newsletter send / scrub). Admin moderation path: force-unlink a member's
// Letterboxd handle. Unlike the self-service endpoint there's no no-handle
// guard — this is also the idempotent repair path for canonical-vs-aggregate
// drift (member row already unlinked but members:all still shows the handle).
async function handleAdminMemberUnlink(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }

  let body
  try { body = await request.json() } catch { body = {} }
  if (!isValidEmail(body.email)) return json(env, { error: 'invalid email' }, 400)

  const memberRaw = await env.MEMBERS_KV.get(`member:${body.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  return json(env, { ok: true, ...await unlinkCascade(env, member) })
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
  // Newsletter consent toggle — the authenticated opt-out (and re-opt-in) path.
  if (typeof body.newsletter === 'boolean') {
    updates.newsletter = body.newsletter
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
  await patchMembersAll(env, publicMemberProjection(member))
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
// historical record — only the member identity is removed. RSVP records
// (which carry the member's email) are purged everywhere via purgeRsvps().
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

  // Purge the member's RSVP entries before the KV cascade. Deliberately not
  // wrapped in try/catch: if the purge fails, the 500 lets the user retry —
  // swallowing the error would delete the account while leaving their email
  // behind in rsvp:* records, and claim success.
  await purgeRsvps(env, member, new URL(request.url).origin)

  // KV cascade. Order doesn't matter for correctness — each delete is
  // independent — but doing the canonical row first means a mid-flight
  // crash leaves nothing reachable rather than a dangling reverse index.
  await env.MEMBERS_KV.delete(`member:${claims.email}`)
  await removeFromMembersAll(env, member.id)
  if (member.id) await env.MEMBERS_KV.delete(`session:${member.id}`)
  // Every remembered device dies with the account.
  if (member.id) await purgeRefreshTokens(env, member.id)
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
  // If the client remembered this device, revoke that too. Deleting a refresh
  // token requires possessing it, so no ownership check is needed — the worst
  // an attacker with someone else's token can do here is revoke it, which is
  // exactly what we'd want.
  const body = await request.json().catch(() => ({}))
  const refreshKey = refreshKvKey(body && body.refresh)
  if (refreshKey) await env.MEMBERS_KV.delete(refreshKey)
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

// --- Remember-this-device refresh tokens ---
//
// A refresh token is `{memberId}.{secret}` where the secret is a 32-char
// random string. The KV record `refresh:{id}:{secret}` is the source of
// truth: presence means valid, deletion revokes instantly — no deny-list
// needed (unlike the jti overlay for signed session tokens). Keying by
// member id first lets sign-out delete one device and account deletion
// prefix-list every device. Multiple devices each get their own token.
//
// Deliberately NOT rotated on use: rotation would let one tab's refresh
// invalidate another tab's stored token mid-race. Instead the record's TTL
// slides forward 30 days on every successful refresh, so an actively used
// device stays signed in and an abandoned one ages out.

function refreshKvKey(refresh) {
  if (typeof refresh !== 'string') return null
  // Split on the LAST dot: the secret is always the final segment and ids
  // are opaque strings we don't want to make assumptions about.
  const dot = refresh.lastIndexOf('.')
  if (dot < 1 || dot === refresh.length - 1) return null
  const id = refresh.slice(0, dot)
  const secret = refresh.slice(dot + 1)
  if (id.includes(':') || !/^[a-z0-9]{32}$/.test(secret)) return null
  return `refresh:${id}:${secret}`
}

async function issueRefreshToken(env, member) {
  const secret = randomToken(32)
  await env.MEMBERS_KV.put(
    `refresh:${member.id}:${secret}`,
    JSON.stringify({ email: member.email }),
    { expirationTtl: REFRESH_TTL },
  )
  return `${member.id}.${secret}`
}

async function purgeRefreshTokens(env, memberId) {
  const list = await env.MEMBERS_KV.list({ prefix: `refresh:${memberId}:` })
  for (const k of list.keys) await env.MEMBERS_KV.delete(k.name)
}

// POST /session/refresh — authenticated by the refresh token itself.
// Trades a valid device token for a fresh 1-hour session token, so a
// remembered device never has to re-run the email OTP flow. The member row
// is re-read on every refresh: a deleted account invalidates the device
// token immediately (and we clean up the orphaned record on sight).
async function handleSessionRefresh(request, env) {
  const { refresh } = await request.json().catch(() => ({}))
  const key = refreshKvKey(refresh)
  if (!key) return json(env, { error: 'invalid refresh token' }, 401)

  const recordRaw = await env.MEMBERS_KV.get(key)
  if (!recordRaw) return json(env, { error: 'invalid refresh token' }, 401)
  const record = JSON.parse(recordRaw)

  const memberRaw = await env.MEMBERS_KV.get(`member:${record.email}`)
  if (!memberRaw) {
    await env.MEMBERS_KV.delete(key)
    return json(env, { error: 'invalid refresh token' }, 401)
  }
  const member = JSON.parse(memberRaw)

  // Slide the device token's 30-day window and refresh the session snapshot.
  await env.MEMBERS_KV.put(key, recordRaw, { expirationTtl: REFRESH_TTL })
  await writeSession(env, member)

  const token = await signToken(env, {
    email: member.email, id: member.id, exp: Date.now() + 3600_000, jti: randomToken(16),
  })
  return json(env, { token, email: member.email, id: member.id, name: member.name, handle: member.handle })
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

  // For member-hosted screenings, attendance is the confirmed-RSVP list and is
  // managed via /events/:id/rsvp. Reject the post-hoc toggle so the SPA can't
  // accidentally double-write or skip the email/waitlist path.
  if (await isHostedEvent(env, eventId)) {
    return json(env, { error: 'this is a hosted screening — RSVP via /events/:id/rsvp' }, 409)
  }

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

  if (await isHostedEvent(env, eventId)) {
    return json(env, { error: 'this is a hosted screening — cancel via /events/:id/rsvp' }, 409)
  }

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

// --- Members public read (live KV → cron-snapshotted JSON) ---
//
// Mirrors the attendance live-vs-snapshot architecture but member-shaped.
// `members:all` is an array of public projections — explicit field-by-field
// to prevent future private fields (like `email`) from leaking via the
// public read. Per-member canonical state still lives at `member:{email}`.

function publicMemberProjection(member) {
  if (!member || !member.id) return null
  const out = { id: member.id, name: member.name, joined: member.joined }
  if (member.pronouns) out.pronouns = member.pronouns
  if (member.handle)   out.handle   = member.handle
  return out
}

// Public event projection — strips the host's private `address` so it never
// leaves the Worker except inside a `sendEmail()` payload to a confirmed RSVP.
// All public reads (`GET /events`, `events:all`, the cron snapshot to
// data/events.json) flow through this. Canonical full row stays at `event:{id}`
// for the host's own view and admin moderation.
function publicEventProjection(event) {
  if (!event || !event.id) return null
  const out = { id: event.id }
  // `notes` is deliberately excluded too: the host form promises notes are
  // "included in every RSVP email", and hosts put parking/entry details there.
  // They stay on the canonical row (emails, host view, admin) only.
  for (const k of ['title', 'film', 'year', 'date', 'venue', 'poster', 'letterboxd_uri',
                   'hostId', 'hostName', 'capacity', 'kind', 'time']) {
    if (event[k] !== undefined && event[k] !== null && event[k] !== '') out[k] = event[k]
  }
  return out
}

async function handleMembersGet(env) {
  const all = await readMembersAll(env)
  return json(env, all)
}

async function readMembersAll(env) {
  const raw = await env.MEMBERS_KV.get('members:all')
  if (raw) {
    const arr = safeParseArray(raw)
    if (arr.length || await env.MEMBERS_KV.get('members:bootstrapped')) return arr
  }
  return await bootstrapMembers(env)
}

// Upsert by id, used by every member-mutating handler so the live read
// reflects the change without waiting on a snapshot.
async function patchMembersAll(env, projection) {
  if (!projection || !projection.id) return
  const allRaw = await env.MEMBERS_KV.get('members:all')
  const all = allRaw ? safeParseArray(allRaw) : await bootstrapMembers(env)
  const idx = all.findIndex(m => m.id === projection.id)
  if (idx === -1) all.push(projection)
  else all[idx] = projection
  await env.MEMBERS_KV.put('members:all', JSON.stringify(all))
}

async function removeFromMembersAll(env, id) {
  if (!id) return
  const allRaw = await env.MEMBERS_KV.get('members:all')
  if (!allRaw) return
  const all = safeParseArray(allRaw)
  const filtered = all.filter(m => m.id !== id)
  if (filtered.length !== all.length) {
    await env.MEMBERS_KV.put('members:all', JSON.stringify(filtered))
  }
}

// One-shot per KV namespace: seed members:all from data/members.json baseline,
// overlay any member:{email} keys that already exist (those win). Subsequent
// calls return the cached aggregate without re-seeding.
async function bootstrapMembers(env) {
  if (await env.MEMBERS_KV.get('members:bootstrapped')) {
    const raw = await env.MEMBERS_KV.get('members:all')
    return raw ? safeParseArray(raw) : []
  }
  const baseline = await fetchMembersBaseline(env)
  const list = await env.MEMBERS_KV.list({ prefix: 'member:' })
  const kvProjections = []
  for (const k of list.keys) {
    const raw = await env.MEMBERS_KV.get(k.name)
    if (!raw) continue
    try {
      const m = JSON.parse(raw)
      const proj = publicMemberProjection(m)
      if (proj) kvProjections.push(proj)
    } catch { /* skip corrupt entry */ }
  }
  const merged = [...baseline]
  for (const proj of kvProjections) {
    const idx = merged.findIndex(m => m.id === proj.id)
    if (idx === -1) merged.push(proj)
    else merged[idx] = proj
  }
  await env.MEMBERS_KV.put('members:all', JSON.stringify(merged))
  await env.MEMBERS_KV.put('members:bootstrapped', '1')
  return merged
}

async function fetchMembersBaseline(env) {
  if (env.E2E_MODE === 'true') return []
  const owner = env.GITHUB_OWNER
  const repo = env.GITHUB_REPO
  const branch = env.GITHUB_BRANCH || 'main'
  if (!owner || !repo) return []
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/data/members.json`,
      { headers: { 'User-Agent': 'jxnfilmclub-join' }, cf: { cacheTtl: 60, cacheEverything: true } },
    )
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

function safeParseArray(raw) {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch { return [] }
}

// --- Events public read (live KV → cron-snapshotted JSON) ---
//
// Lives in ATTENDANCE_KV — events and attendance are semantically paired and
// snapshotted by sibling cron workflows. Admin dashboard writes per-event:{id}
// rows via the /api/kv shim and patches events:all in the same call.

async function handleEventsGet(env) {
  const all = await readEventsAll(env)
  // Belt-and-suspenders: even though writers should already project, re-project
  // on the way out so a buggy writer can never leak `address` to a public read.
  return json(env, all.map(publicEventProjection).filter(Boolean))
}

async function readEventsAll(env) {
  const raw = await env.ATTENDANCE_KV.get('events:all')
  if (raw) {
    const arr = safeParseArray(raw)
    if (arr.length || await env.ATTENDANCE_KV.get('events:bootstrapped')) return arr
  }
  return await bootstrapEvents(env)
}

async function bootstrapEvents(env) {
  if (await env.ATTENDANCE_KV.get('events:bootstrapped')) {
    const raw = await env.ATTENDANCE_KV.get('events:all')
    return raw ? safeParseArray(raw) : []
  }
  const baseline = await fetchEventsBaseline(env)
  const list = await env.ATTENDANCE_KV.list({ prefix: 'event:' })
  const kvEvents = []
  for (const k of list.keys) {
    const raw = await env.ATTENDANCE_KV.get(k.name)
    if (!raw) continue
    try {
      const e = JSON.parse(raw)
      if (e && e.id) kvEvents.push(e)
    } catch { /* skip */ }
  }
  const merged = [...baseline]
  for (const ev of kvEvents) {
    const idx = merged.findIndex(m => m.id === ev.id)
    if (idx === -1) merged.push(ev)
    else merged[idx] = ev
  }
  // events:all is the public aggregate — store projections, not canonical
  // rows, so it can never carry a host's private `address`.
  const projected = merged.map(publicEventProjection).filter(Boolean)
  await env.ATTENDANCE_KV.put('events:all', JSON.stringify(projected))
  await env.ATTENDANCE_KV.put('events:bootstrapped', '1')
  return projected
}

async function fetchEventsBaseline(env) {
  if (env.E2E_MODE === 'true') return []
  const owner = env.GITHUB_OWNER
  const repo = env.GITHUB_REPO
  const branch = env.GITHUB_BRANCH || 'main'
  if (!owner || !repo) return []
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/data/events.json`,
      { headers: { 'User-Agent': 'jxnfilmclub-join' }, cf: { cacheTtl: 60, cacheEverything: true } },
    )
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

// --- Live Last Four Watched (Letterboxd RSS via the Worker) ---
//
// GET /watched — public. Handle-keyed map of each linked member's last four
// diary entries, fetched live from Letterboxd RSS and cached in KV for
// WATCHED_CACHE_TTL so the site stays minutes-fresh without hammering
// Letterboxd (per-feed fetches are also edge-cached). data/watched.json
// (6h cron) remains the SPA's offline fallback and the Hot Takes source.

const WATCHED_CACHE_TTL = 900 // seconds; KV minimum expirationTtl is 60

// Browser-cacheable response: the SPA calls /watched once per event card, so
// a short max-age lets the browser dedupe across cards and navigations.
function watchedResponse(env, data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...cors(env) },
  })
}

// Per-isolate in-flight coalescing: N concurrent cold-cache requests share
// one upstream fan-out instead of each hitting every member's RSS feed.
let watchedInflight = null

async function handleWatchedGet(env) {
  if (env.E2E_MODE === 'true') return watchedResponse(env, {})
  const cached = await env.MEMBERS_KV.get('watched:cache')
  if (cached) {
    try { return watchedResponse(env, JSON.parse(cached)) } catch { /* refetch below */ }
  }
  if (!watchedInflight) {
    watchedInflight = buildWatched(env).finally(() => { watchedInflight = null })
  }
  return watchedResponse(env, await watchedInflight)
}

async function buildWatched(env) {
  const members = await readMembersAll(env)
  const handles = members.map(m => m && m.handle).filter(Boolean).slice(0, 40)
  const out = {}
  await Promise.all(handles.map(async handle => {
    try {
      const res = await fetch(`https://letterboxd.com/${encodeURIComponent(handle)}/rss/`, {
        headers: { 'User-Agent': 'jxnfilmclub-join' },
        cf: { cacheTtl: WATCHED_CACHE_TTL, cacheEverything: true },
      })
      if (!res.ok) return
      const films = parseLetterboxdRss(await res.text())
      if (films.length) out[handle] = films
    } catch { /* feed down: leave the handle absent, others still serve */ }
  }))

  // Don't cache a total miss (e.g. Letterboxd outage) — that would pin the
  // outage for a full TTL. Partial results are cached as best-effort.
  if (!handles.length || Object.keys(out).length) {
    await env.MEMBERS_KV.put('watched:cache', JSON.stringify(out), { expirationTtl: WATCHED_CACHE_TTL })
  }
  return out
}

// Minimal RSS extraction matching scripts/refresh_letterboxd.py: last four
// non-list items -> { title, year?, link, watched_date?, poster? }.
function parseLetterboxdRss(xml) {
  const films = []
  for (const item of String(xml).split('<item>').slice(1)) {
    if (rssTag(item, 'guid').includes('letterboxd-list')) continue
    const film = {
      title: unescapeXml(rssTag(item, 'letterboxd:filmTitle') || rssTag(item, 'title')),
      link: rssTag(item, 'link'),
    }
    if (!film.title || !film.link) continue
    const year = rssTag(item, 'letterboxd:filmYear')
    if (year) film.year = year
    const watched = rssTag(item, 'letterboxd:watchedDate')
    if (watched) film.watched_date = watched
    const poster = /<img\s[^>]*src="([^"]+)"/.exec(item)
    if (poster) film.poster = poster[1]
    films.push(film)
    if (films.length >= 4) break
  }
  return films
}

function rssTag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml)
  return m ? m[1].trim() : ''
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

// --- Letterboxd avatars (profile-page og:image via the Worker) ---
//
// GET /avatars — public. Handle-keyed map of each linked member's Letterboxd
// avatar URL, scraped from the profile page's og:image meta tag (Letterboxd
// has no API and RSS carries no avatar). Cached in KV for a week — avatars
// churn slowly — with a membership signature so a newly linked handle
// invalidates the cache immediately instead of waiting out the TTL. The SPA
// falls back to the letter <avatar> for any handle absent from the map.

const AVATARS_CACHE_TTL = 86400 * 7 // seconds

function avatarsResponse(env, data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600', ...cors(env) },
  })
}

// Membership signature: sorted linked-handle list. Cheap to recompute (one
// KV read) and changes exactly when the avatar set should.
function avatarsSig(members) {
  return members.map(m => m && m.handle).filter(Boolean).sort().join(',')
}

// Per-isolate in-flight coalescing, same pattern as watchedInflight.
let avatarsInflight = null

async function handleAvatarsGet(env) {
  if (env.E2E_MODE === 'true') return avatarsResponse(env, {})
  const members = await readMembersAll(env)
  const cached = await env.MEMBERS_KV.get('avatars:cache')
  if (cached) {
    try {
      const rec = JSON.parse(cached)
      if (rec.sig === avatarsSig(members)) return avatarsResponse(env, rec.map || {})
    } catch { /* rebuild below */ }
  }
  if (!avatarsInflight) {
    avatarsInflight = buildAvatars(env, members).finally(() => { avatarsInflight = null })
  }
  return avatarsResponse(env, await avatarsInflight)
}

async function buildAvatars(env, members) {
  const handles = members.map(m => m && m.handle).filter(Boolean).slice(0, 40)
  const out = {}
  await Promise.all(handles.map(async handle => {
    try {
      const res = await fetch(`https://letterboxd.com/${encodeURIComponent(handle)}/`, {
        headers: { 'User-Agent': 'jxnfilmclub-join' },
        cf: { cacheTtl: 86400, cacheEverything: true },
      })
      if (!res.ok) return
      const url = parseOgImage(await res.text())
      if (url) out[handle] = url
    } catch { /* profile down: handle absent, letter avatar covers it */ }
  }))

  // Don't cache a total miss (e.g. Letterboxd outage) — that would pin the
  // outage for a full week. Partial results are cached as best-effort.
  if (!handles.length || Object.keys(out).length) {
    const rec = { sig: avatarsSig(members), map: out }
    await env.MEMBERS_KV.put('avatars:cache', JSON.stringify(rec), { expirationTtl: AVATARS_CACHE_TTL })
  }
  return out
}

// Attribute-order-tolerant og:image extraction. Members without a custom
// avatar get Letterboxd's grey default (asset path contains /static/img/) —
// skip it so the letter avatar renders instead.
function parseOgImage(html) {
  const m = /<meta\s[^>]*(?:property|name)="og:image"[^>]*>/.exec(String(html))
  if (!m) return ''
  const c = /content="([^"]+)"/.exec(m[0])
  const url = c ? c[1] : ''
  if (!url || !/^https:\/\//.test(url)) return ''
  if (url.includes('/static/img/')) return ''
  return url
}

// --- Member-hosted screenings (RSVP + private address) ---
//
// Member-hosted screenings live in the same `event:{id}` rows as admin-curated
// club events, distinguished by `hostId` (a member id). Hosted events come in
// two kinds (see validScreeningInput): `house` — the host's `address` is
// private, only ever leaving the Worker inside a sendEmail() payload to a
// confirmed RSVP; and `meetup` — a public theater from the THEATERS allowlist,
// optional capacity/showtime, no address stored at all. Rows without `kind`
// predate meetups and are treated as 'house'. Public reads (GET /events,
// events:all, the data/events.json snapshot) flow through
// publicEventProjection() and never include `address`.
//
// RSVP state lives at `rsvp:{eventId}` in ATTENDANCE_KV as
//   { confirmed: [{ memberId, name, email, at }], waitlist: [{ ... }] }
// The confirmed list is mirrored write-through into `attend:{eventId}` (names
// only) so the existing public attendance read path keeps working unchanged.

async function isHostedEvent(env, eventId) {
  const raw = await env.ATTENDANCE_KV.get(`event:${eventId}`)
  if (!raw) return false
  try { return !!JSON.parse(raw).hostId } catch { return false }
}

async function readEvent(env, eventId) {
  const raw = await env.ATTENDANCE_KV.get(`event:${eventId}`)
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

// Canonical write: full row at event:{id} (may carry private `address`); the
// public aggregate `events:all` gets the projection so it can never leak.
async function writeEvent(env, event) {
  await env.ATTENDANCE_KV.put(`event:${event.id}`, JSON.stringify(event))
  const allRaw = await env.ATTENDANCE_KV.get('events:all')
  const all = allRaw ? safeParseArray(allRaw) : await bootstrapEvents(env)
  const proj = publicEventProjection(event)
  const idx = all.findIndex(e => e.id === event.id)
  if (idx === -1) all.push(proj)
  else all[idx] = proj
  await env.ATTENDANCE_KV.put('events:all', JSON.stringify(all))
}

async function deleteEvent(env, eventId) {
  await env.ATTENDANCE_KV.delete(`event:${eventId}`)
  const allRaw = await env.ATTENDANCE_KV.get('events:all')
  if (allRaw) {
    const all = safeParseArray(allRaw)
    const next = all.filter(e => e.id !== eventId)
    if (next.length !== all.length) {
      await env.ATTENDANCE_KV.put('events:all', JSON.stringify(next))
    }
  }
}

async function readRsvp(env, eventId) {
  const raw = await env.ATTENDANCE_KV.get(`rsvp:${eventId}`)
  if (!raw) return { confirmed: [], waitlist: [] }
  try {
    const r = JSON.parse(raw)
    return {
      confirmed: Array.isArray(r.confirmed) ? r.confirmed : [],
      waitlist:  Array.isArray(r.waitlist)  ? r.waitlist  : [],
    }
  } catch {
    return { confirmed: [], waitlist: [] }
  }
}

// Write the RSVP record AND mirror confirmed-names into attend:{id} so public
// GET /events/:id/attendance keeps returning the same shape it always has.
async function writeRsvp(env, eventId, rsvp) {
  await env.ATTENDANCE_KV.put(`rsvp:${eventId}`, JSON.stringify(rsvp))
  await writeAttendees(env, eventId, rsvp.confirmed.map(r => r.name))
}

async function removeRsvp(env, eventId) {
  await env.ATTENDANCE_KV.delete(`rsvp:${eventId}`)
  await env.ATTENDANCE_KV.delete(`attend:${eventId}`)
  const allRaw = await env.ATTENDANCE_KV.get('attendance:all')
  if (allRaw) {
    const all = safeParseObject(allRaw)
    if (all[eventId]) {
      delete all[eventId]
      await env.ATTENDANCE_KV.put('attendance:all', JSON.stringify(all))
    }
  }
}

// Cancel tokens — non-expiring, HMAC-signed. Same shape as signUnsubToken,
// distinct purpose discriminator so a leaked unsub token can't cancel an RSVP.
async function signRsvpCancelToken(env, eventId, memberId) {
  const payload = b64u(JSON.stringify({ ev: eventId, m: memberId, p: 'rsvp-cancel' }))
  const sig = await hmac(env.OTP_SIGNING_KEY, payload)
  return `${payload}.${sig}`
}

async function verifyRsvpCancelToken(env, token) {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = await hmac(env.OTP_SIGNING_KEY, payload)
  if (sig !== expected) return null
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return claims.p === 'rsvp-cancel' && claims.ev && claims.m ? claims : null
  } catch {
    return null
  }
}

// --- Screening email templates ---
//
// Single-recipient transactional sends (mirrors the OTP path; no batch).
// Reuses sendEmail()'s E2E_MODE mock — Playwright e2e never sends real mail.

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  const ampm = h >= 12 ? 'pm' : 'am'
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`
}

const MEETUP_SELF_ORGANIZED =
  'This meetup is self-organized — buy your own ticket and get yourself there; the club just shows up together.'

function fmtScreeningWhen(event) {
  // Date as-is (YYYY-MM-DD); hosted events of either kind may carry an
  // optional showtime.
  if (!event.date) return 'TBD'
  return event.time ? `${event.date} at ${fmtTime(event.time)}` : event.date
}

function rsvpEmailBody(event, address, notes, cancelUrl) {
  const lines = [
    `You're confirmed for ${event.title} on ${fmtScreeningWhen(event)}.`,
    `Film: ${event.film || '(see host)'}`,
    `Hosted by: ${event.hostName || 'a member'}`,
    '',
  ]
  if (event.kind === 'meetup') {
    lines.push(`Venue: ${event.venue}`)
  } else {
    lines.push('Address:', address)
  }
  if (event.time) lines.push(`Showtime: ${fmtTime(event.time)}`)
  if (event.kind === 'meetup') lines.push('', MEETUP_SELF_ORGANIZED)
  if (notes) {
    lines.push('', 'Notes from the host:', notes)
  }
  lines.push(
    '',
    "Can't make it? Use the one-click link below to cancel — it opens a spot",
    'for the next person on the waitlist:',
    cancelUrl,
  )
  return lines.join('\n')
}

async function sendRsvpEmail(env, member, event, origin) {
  const token = await signRsvpCancelToken(env, event.id, member.id)
  const cancelUrl = `${origin}/rsvp/cancel?token=${encodeURIComponent(token)}`
  const subject = `You're in for ${event.title} on ${fmtScreeningWhen(event)}`
  await sendEmail(env, member.email, subject, rsvpEmailBody(event, event.address || '', event.notes || '', cancelUrl))
}

async function sendScreeningUpdateEmail(env, member, event, changes, origin) {
  const token = await signRsvpCancelToken(env, event.id, member.id)
  const cancelUrl = `${origin}/rsvp/cancel?token=${encodeURIComponent(token)}`
  const lines = [
    `Heads up — ${event.hostName || 'the host'} updated the screening "${event.title}".`,
    '',
    'What changed:',
  ]
  for (const c of changes) lines.push(`  • ${c.field}: ${c.from || '(blank)'} → ${c.to || '(blank)'}`)
  lines.push(
    '',
    'Current details:',
    `Date: ${fmtScreeningWhen(event)}`,
  )
  if (event.kind === 'meetup') {
    lines.push(`Venue: ${event.venue}`)
  } else {
    lines.push(`Address: ${event.address || '(see host)'}`)
  }
  if (event.time) lines.push(`Showtime: ${fmtTime(event.time)}`)
  if (event.kind === 'meetup') lines.push('', MEETUP_SELF_ORGANIZED)
  if (event.notes) lines.push('', 'Notes from the host:', event.notes)
  lines.push('', "Can't make it anymore? One-click cancel:", cancelUrl)
  const subject = `Update: ${event.title} on ${fmtScreeningWhen(event)}`
  await sendEmail(env, member.email, subject, lines.join('\n'))
}

async function sendScreeningCancelledEmail(env, member, event) {
  const subject = `Cancelled: ${event.title} on ${fmtScreeningWhen(event)}`
  const text = [
    `Sorry — ${event.hostName || 'the host'} cancelled the screening "${event.title}"`,
    `that was scheduled for ${fmtScreeningWhen(event)}.`,
    '',
    'No action needed on your end. Watch the events page for future screenings.',
  ].join('\n')
  await sendEmail(env, member.email, subject, text)
}

// --- Screening route handlers ---

const MAX_EVENT_FIELD = 200
const MAX_ADDRESS = 500
const MAX_NOTES = 2000
const MAX_CAPACITY = 1000

// Strict venue allowlist for theater meetups (kind: 'meetup'). Mirrored in
// ui/views.html (events-new-view THEATERS) — keep both in lockstep. Venue
// additions go through venues@jxnfilm.club review.
const THEATERS = [
  'Patton House & Gallery',
  'The Capri Theater',
  'Legacy Parkway Theaters',
  'Cinemark XD in Pearl',
  'Malco Renaissance in Ridgeland',
  'Malco Grandview & IMAX in Madison',
  'B&B Theaters at Northpark in Ridgeland',
]

function slugifyForId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

// Two hosted-event kinds:
//   'house'  — private address (required), required capacity + waitlist.
//   'meetup' — public theater from the THEATERS allowlist, optional capacity
//              (no cap → RSVPs always confirm), optional showtime; any
//              submitted address is ignored, never stored.
function validScreeningInput(body) {
  const out = {}
  out.kind = body.kind === 'meetup' ? 'meetup' : 'house'
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > MAX_EVENT_FIELD) {
    return { error: 'title is required (≤200 chars)' }
  }
  out.title = body.title.trim()
  if (typeof body.film === 'string' && body.film.length <= MAX_EVENT_FIELD) out.film = body.film.trim()
  if (body.year != null) {
    const y = Number(body.year)
    if (!Number.isInteger(y) || y < 1888 || y > 2100) return { error: 'invalid year' }
    out.year = y
  }
  if (typeof body.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return { error: 'date is required (YYYY-MM-DD)' }
  }
  out.date = body.date
  // Showtime is optional on both kinds — house screenings have one too.
  if (body.time != null && body.time !== '') {
    if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) {
      return { error: 'time must be HH:MM (24-hour)' }
    }
    out.time = body.time
  }
  if (out.kind === 'meetup') {
    if (typeof body.venue !== 'string' || !THEATERS.includes(body.venue.trim())) {
      return { error: 'venue must be one of the listed theaters' }
    }
    out.venue = body.venue.trim()
    if (body.capacity != null && body.capacity !== '') {
      const cap = Number(body.capacity)
      if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAPACITY) {
        return { error: 'capacity must be a positive integer (≤1000)' }
      }
      out.capacity = cap
    }
  } else {
    if (typeof body.address !== 'string' || !body.address.trim() || body.address.length > MAX_ADDRESS) {
      return { error: 'address is required (≤500 chars)' }
    }
    out.address = body.address.trim()
    const cap = Number(body.capacity)
    if (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAPACITY) {
      return { error: 'capacity must be a positive integer (≤1000)' }
    }
    out.capacity = cap
    if (typeof body.venue === 'string' && body.venue.length <= MAX_EVENT_FIELD) out.venue = body.venue.trim()
  }
  if (typeof body.notes === 'string') {
    if (body.notes.length > MAX_NOTES) return { error: 'notes too long (≤2000 chars)' }
    if (body.notes.trim()) out.notes = body.notes
  }
  if (typeof body.poster === 'string' && body.poster.length <= 500) out.poster = body.poster.trim()
  if (typeof body.letterboxd_uri === 'string' && body.letterboxd_uri.trim()) {
    const uri = body.letterboxd_uri.trim()
    // Hosts link their diary entry (or the film page) — public field, so only
    // accept real Letterboxd URLs.
    if (uri.length > 500 || !/^https:\/\/(www\.)?(letterboxd\.com|boxd\.it)\//.test(uri)) {
      return { error: 'letterboxd_uri must be a letterboxd.com or boxd.it link' }
    }
    out.letterboxd_uri = uri
  }
  return { value: out }
}

// GET /tmdb/search?q=… — authenticated poster search for the /host form.
// Proxies TMDB movie search so the API key stays a Worker secret; returns a
// trimmed list (top 8 with posters). Accepts either a TMDB v3 api key or a
// v4 read token (JWTs start with "eyJ") in TMDB_API_KEY.
async function handleTmdbSearch(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const q = (new URL(request.url).searchParams.get('q') || '').trim()
  if (!q) return json(env, { results: [] })
  if (env.E2E_MODE === 'true') {
    // Canned fixture so Playwright (and local UI work) never hits TMDB.
    return json(env, { results: [
      { id: 603, title: 'The Matrix', year: '1999',
        poster: 'https://image.tmdb.org/t/p/w500/e2e-matrix.jpg',
        thumb:  'https://image.tmdb.org/t/p/w92/e2e-matrix.jpg' },
    ] })
  }
  if (!env.TMDB_API_KEY) return json(env, { error: 'poster search is not configured' }, 503)

  const res = await tmdbFetch(env, '/search/movie', { query: q, include_adult: 'false' })
  if (!res.ok) return json(env, { error: 'poster search failed' }, 502)
  const data = await res.json().catch(() => ({}))
  const results = (data.results || [])
    .filter(m => m.poster_path)
    .slice(0, 8)
    .map(m => ({
      id: m.id,
      title: m.title,
      year: (m.release_date || '').slice(0, 4),
      poster: `https://image.tmdb.org/t/p/w500${m.poster_path}`,
      thumb: `https://image.tmdb.org/t/p/w92${m.poster_path}`,
    }))
  return json(env, { results })
}

// GET /tmdb/posters?id=… — authenticated step 2 of the poster picker: all
// alternate posters TMDB lists for a confirmed film (capped at 12, TMDB's
// vote-ranked order preserved).
async function handleTmdbPosters(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const id = new URL(request.url).searchParams.get('id')
  if (!id || !/^\d+$/.test(id)) return json(env, { error: 'a numeric TMDB movie id is required' }, 400)
  if (env.E2E_MODE === 'true') {
    return json(env, { posters: [
      { full: 'https://image.tmdb.org/t/p/w500/e2e-matrix.jpg',     thumb: 'https://image.tmdb.org/t/p/w185/e2e-matrix.jpg' },
      { full: 'https://image.tmdb.org/t/p/w500/e2e-matrix-alt.jpg', thumb: 'https://image.tmdb.org/t/p/w185/e2e-matrix-alt.jpg' },
    ] })
  }
  if (!env.TMDB_API_KEY) return json(env, { error: 'poster search is not configured' }, 503)

  const res = await tmdbFetch(env, `/movie/${id}/images`, { include_image_language: 'en,null' })
  if (!res.ok) return json(env, { error: 'poster search failed' }, 502)
  const data = await res.json().catch(() => ({}))
  const posters = (data.posters || [])
    .filter(p => p.file_path)
    .slice(0, 12)
    .map(p => ({
      full: `https://image.tmdb.org/t/p/w500${p.file_path}`,
      thumb: `https://image.tmdb.org/t/p/w185${p.file_path}`,
    }))
  return json(env, { posters })
}

// Shared TMDB fetch: v3 api key rides as a query param, v4 read tokens
// (JWTs start with "eyJ") as a bearer header; responses edge-cached a day.
async function tmdbFetch(env, path, params) {
  const url = new URL(`https://api.themoviedb.org/3${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const headers = { 'User-Agent': 'jxnfilmclub-join' }
  if (env.TMDB_API_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${env.TMDB_API_KEY}`
  else url.searchParams.set('api_key', env.TMDB_API_KEY)
  return fetch(url.toString(), { headers, cf: { cacheTtl: 86400, cacheEverything: true } })
}

// POST /events — authenticated. Any member can host. Generates the event id
// (date-prefixed readable slug + 4-char random suffix for uniqueness), stamps
// hostId/hostName, seeds an empty rsvp:{id}.
async function handleCreateEvent(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  const body = await request.json().catch(() => ({}))
  const v = validScreeningInput(body)
  if (v.error) return json(env, { error: v.error }, 400)

  const today = centralToday()
  if (v.value.date < today) return json(env, { error: 'date must be today or later' }, 400)

  const slug = slugifyForId(v.value.title) || 'screening'
  const event = {
    id: `${v.value.date}-${slug}-${randomToken(4)}`,
    ...v.value,
    hostId: member.id,
    hostName: member.name,
  }
  // House screenings join a listing where personal homes carry a
  // public-friendly venue name ("Michael Lamb's house") — never the address.
  // Default the label from the host's display name when none was given.
  if (event.kind === 'house' && !event.venue) {
    event.venue = `${member.name}'s house`
  }
  await writeEvent(env, event)
  await writeRsvp(env, event.id, { confirmed: [], waitlist: [] })
  return json(env, { ok: true, id: event.id, event: publicEventProjection(event) })
}

// PATCH /events/:id — host-only. address/date/(venue treated as "where")
// changes auto-notify confirmed RSVPs. Increasing capacity auto-promotes
// from the waitlist (each promoted member gets the same email a fresh RSVP
// gets, with the address). Decreasing capacity below current confirmed → 400.
async function handleUpdateEvent(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const event = await readEvent(env, eventId)
  if (!event) return json(env, { error: 'event not found' }, 404)
  if (!event.hostId || event.hostId !== claims.id) {
    return json(env, { error: 'only the host can edit this screening' }, 403)
  }

  const body = await request.json().catch(() => ({}))
  // Kind is immutable: converting a house screening (private address already
  // emailed to RSVPs) into a public meetup mid-flight, or vice versa, is a
  // semantic mess. Legacy hosted rows without `kind` get stamped 'house' here.
  const existingKind = event.kind || 'house'
  if (body.kind !== undefined && body.kind !== existingKind) {
    return json(env, { error: 'kind cannot be changed' }, 400)
  }
  // Merge incoming + existing, validate against the same constraints. On a
  // house screening, address and capacity must remain present.
  const merged = { ...event, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), kind: existingKind }
  const v = validScreeningInput(merged)
  if (v.error) return json(env, { error: v.error }, 400)

  // Capacity-decrease guard (capacity is optional on meetups).
  const rsvp = await readRsvp(env, eventId)
  if (v.value.capacity != null && v.value.capacity < rsvp.confirmed.length) {
    return json(env, { error: `cannot reduce capacity below the ${rsvp.confirmed.length} already-confirmed RSVPs` }, 400)
  }

  const changes = []
  for (const field of ['date', 'time', 'address', 'venue']) {
    if ((event[field] || '') !== (v.value[field] || '')) {
      changes.push({ field, from: event[field] || '', to: v.value[field] || '' })
    }
  }

  const updated = { ...event, ...v.value, hostId: event.hostId, hostName: event.hostName }
  // letterboxd_uri is clearable on both kinds: an explicit ''/null in the
  // body deletes the key (the validator only omits empties; the spread
  // would otherwise resurrect the old value). Backs the host panel's
  // "Unlink Diary Entry" button.
  if (body.letterboxd_uri === '' || body.letterboxd_uri === null) delete updated.letterboxd_uri
  // Showtime is optional on both kinds, so an explicit ''/null clears it.
  if (body.time === '' || body.time === null) delete updated.time
  if (updated.kind === 'meetup') {
    // A meetup must never store an address, even one left over on the stale
    // row. Capacity is optional here, so an explicit ''/null in the body
    // clears it (the validator only omits empties; the spread would
    // otherwise resurrect the old value).
    delete updated.address
    if (body.capacity === '' || body.capacity === null) delete updated.capacity
  }
  await writeEvent(env, updated)

  // Capacity increase (or un-capping a meetup) → promote waitlist head-first
  // until either full or empty.
  const origin = new URL(request.url).origin
  let rsvpAfter = rsvp
  const effCap = v.value.capacity == null ? Infinity : v.value.capacity
  if (effCap > rsvp.confirmed.length && rsvp.waitlist.length) {
    const slots = effCap - rsvp.confirmed.length
    const promoted = rsvp.waitlist.slice(0, slots)
    rsvpAfter = {
      confirmed: [...rsvp.confirmed, ...promoted],
      waitlist:  rsvp.waitlist.slice(slots),
    }
    await writeRsvp(env, eventId, rsvpAfter)
    for (const p of promoted) {
      try { await sendRsvpEmail(env, { id: p.memberId, email: p.email, name: p.name }, updated, origin) }
      catch (e) { console.error('promotion email failed:', e?.message || e) }
    }
  }

  // Notify confirmed RSVPs of address/date/venue changes.
  if (changes.length) {
    for (const c of rsvpAfter.confirmed) {
      try { await sendScreeningUpdateEmail(env, { id: c.memberId, email: c.email, name: c.name }, updated, changes, origin) }
      catch (e) { console.error('update email failed:', e?.message || e) }
    }
  }

  return json(env, { ok: true, event: publicEventProjection(updated), notified: changes.length ? rsvpAfter.confirmed.length : 0 })
}

// DELETE /events/:id — host-only (or admin via the dashboard, which writes KV
// directly). Sends a cancellation email to every confirmed RSVP, then tears
// down event:{id}, rsvp:{id}, attend:{id}, and the aggregate entries.
async function handleDeleteEvent(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const event = await readEvent(env, eventId)
  if (!event) return json(env, { error: 'event not found' }, 404)
  if (!event.hostId || event.hostId !== claims.id) {
    return json(env, { error: 'only the host can cancel this screening' }, 403)
  }

  const rsvp = await readRsvp(env, eventId)
  for (const c of rsvp.confirmed) {
    try { await sendScreeningCancelledEmail(env, { id: c.memberId, email: c.email, name: c.name }, event) }
    catch (e) { console.error('cancellation email failed:', e?.message || e) }
  }

  await removeRsvp(env, eventId)
  await deleteEvent(env, eventId)
  return json(env, { ok: true, notified: rsvp.confirmed.length })
}

// POST /events/:id/rsvp — authenticated, hosted events only. Confirms if
// under cap, otherwise waitlists. Confirmation emails the address; waitlist
// gets no email until promotion (then a confirmation email goes out).
async function handleRsvp(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  const event = await readEvent(env, eventId)
  if (!event) return json(env, { error: 'event not found' }, 404)
  if (!event.hostId) return json(env, { error: 'this event does not accept RSVPs (use /attend)' }, 409)
  // A screening that already happened takes no RSVPs — also keeps a late
  // request from recreating a record the post-event scrub already deleted.
  const today = centralToday()
  if (event.date && event.date < today) {
    return json(env, { error: 'this screening has already happened' }, 409)
  }

  const rsvp = await readRsvp(env, eventId)
  if (rsvp.confirmed.some(r => r.memberId === member.id)) {
    return json(env, { ok: true, status: 'confirmed' })
  }
  if (rsvp.waitlist.some(r => r.memberId === member.id)) {
    const position = rsvp.waitlist.findIndex(r => r.memberId === member.id) + 1
    return json(env, { ok: true, status: 'waitlisted', position })
  }

  const entry = { memberId: member.id, name: member.name, email: member.email, at: Date.now() }
  // No capacity (uncapped meetup) → everyone confirms, nobody waitlists.
  const capacity = event.capacity == null ? Infinity : (Number(event.capacity) || 0)
  const origin = new URL(request.url).origin

  if (rsvp.confirmed.length < capacity) {
    rsvp.confirmed.push(entry)
    await writeRsvp(env, eventId, rsvp)
    try { await sendRsvpEmail(env, member, event, origin) }
    catch (e) { console.error('rsvp email failed:', e?.message || e) }
    return json(env, { ok: true, status: 'confirmed' })
  }
  rsvp.waitlist.push(entry)
  await writeRsvp(env, eventId, rsvp)
  return json(env, { ok: true, status: 'waitlisted', position: rsvp.waitlist.length })
}

// Shared cancel implementation used by DELETE /events/:id/rsvp (authenticated
// by bearer) and POST /rsvp/cancel (authenticated by signed token).
async function cancelRsvp(env, eventId, memberId, origin) {
  const event = await readEvent(env, eventId)
  if (!event) return { ok: false, code: 404, error: 'event not found' }
  if (!event.hostId) return { ok: false, code: 409, error: 'not a hosted screening' }

  const rsvp = await readRsvp(env, eventId)
  const cIdx = rsvp.confirmed.findIndex(r => r.memberId === memberId)
  if (cIdx !== -1) {
    rsvp.confirmed.splice(cIdx, 1)
    // Promote the head of waitlist (if any) into the freed slot.
    let promoted = null
    if (rsvp.waitlist.length) {
      promoted = rsvp.waitlist.shift()
      rsvp.confirmed.push(promoted)
    }
    await writeRsvp(env, eventId, rsvp)
    if (promoted) {
      try { await sendRsvpEmail(env, { id: promoted.memberId, email: promoted.email, name: promoted.name }, event, origin) }
      catch (e) { console.error('promotion email failed:', e?.message || e) }
    }
    return { ok: true, status: 'cancelled', promoted: !!promoted }
  }
  const wIdx = rsvp.waitlist.findIndex(r => r.memberId === memberId)
  if (wIdx !== -1) {
    rsvp.waitlist.splice(wIdx, 1)
    await writeRsvp(env, eventId, rsvp)
    return { ok: true, status: 'cancelled', promoted: false }
  }
  return { ok: true, status: 'not-rsvped', promoted: false }
}

// --- Post-event privacy scrub ---
//
// The privacy policy promises: 30 days after a screening, its RSVP list
// (attendee emails) and the host's private address/notes are deleted. The
// names-only attend:{eventId} history and the public event listing stay —
// they never contained either. Runs daily via the cron trigger; also
// triggerable as POST /admin/scrub for ops/staging verification.

const SCRUB_AFTER_DAYS = 30

async function scrubPastEvents(env) {
  const cutoffDate = new Date(Date.now() - SCRUB_AFTER_DAYS * 86400_000)
  const cutoff = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(cutoffDate)
  let scrubbedEvents = 0
  let deletedRsvps = 0

  // Hosted events past the cutoff: strip private fields off the canonical row.
  // events:all projections carry `date` + `hostId`, so no event:* prefix scan.
  // writeEvent re-projects into events:all, which never held address/notes.
  const all = await readEventsAll(env)
  for (const proj of all) {
    if (!proj || !proj.hostId || !proj.date || proj.date >= cutoff) continue
    const event = await readEvent(env, proj.id)
    if (!event || event.scrubbedAt) continue
    delete event.address
    delete event.notes
    event.scrubbedAt = new Date().toISOString()
    await writeEvent(env, event)
    scrubbedEvents++
  }

  // RSVP sweep: delete every rsvp:{id} whose event is past the cutoff — or
  // gone entirely (the admin dashboard writes KV directly and can orphan a
  // record; handleDeleteEvent cleans up after itself).
  let cursor
  do {
    const page = await env.ATTENDANCE_KV.list({ prefix: 'rsvp:', cursor })
    for (const k of page.keys) {
      const event = await readEvent(env, k.name.slice('rsvp:'.length))
      if (!event || (event.date && event.date < cutoff)) {
        await env.ATTENDANCE_KV.delete(k.name)
        deletedRsvps++
      }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)

  console.log(`scrubPastEvents: cutoff=${cutoff} scrubbedEvents=${scrubbedEvents} deletedRsvps=${deletedRsvps}`)
  return { cutoff, scrubbedEvents, deletedRsvps }
}

// POST /admin/scrub — bearer-auth with ADMIN_TOKEN (same gate as the
// newsletter send). Manual trigger for the daily scheduled scrub.
async function handleAdminScrub(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }
  return json(env, { ok: true, ...await scrubPastEvents(env) })
}

// Account-deletion sweep: remove the member's {memberId, name, email, at}
// entries from every rsvp:{eventId} record. Like anonymizeAttendance there's
// no per-member index, so this walks the whole prefix — cheap at club scale,
// but paginate anyway (list() pages at 1000 keys).
//
// Upcoming hosted events go through cancelRsvp() so the freed slot promotes
// the waitlist head (with the usual confirmation email). Past or orphaned
// records get a direct filtered write instead: no promotion emails for an
// event that already happened, and no writeRsvp() so the names-only
// attend:{eventId} history stays intact (name removal remains the separate
// `anonymize` opt-in).
async function purgeRsvps(env, member, origin) {
  const today = centralToday()
  let cursor
  do {
    const page = await env.ATTENDANCE_KV.list({ prefix: 'rsvp:', cursor })
    for (const k of page.keys) {
      const eventId = k.name.slice('rsvp:'.length)
      const rsvp = await readRsvp(env, eventId)
      const mine = r => r.memberId === member.id
      if (!rsvp.confirmed.some(mine) && !rsvp.waitlist.some(mine)) continue

      const event = await readEvent(env, eventId)
      if (event && event.hostId && event.date >= today) {
        await cancelRsvp(env, eventId, member.id, origin)
      } else {
        await env.ATTENDANCE_KV.put(`rsvp:${eventId}`, JSON.stringify({
          confirmed: rsvp.confirmed.filter(r => !mine(r)),
          waitlist:  rsvp.waitlist.filter(r => !mine(r)),
        }))
      }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
}

async function handleUnrsvp(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)
  const origin = new URL(request.url).origin
  const r = await cancelRsvp(env, eventId, member.id, origin)
  if (!r.ok) return json(env, { error: r.error }, r.code)
  return json(env, r)
}

// GET /events/:id/rsvp/me — authenticated. Lets the SPA render the right
// affordance (RSVP / On waitlist / You're in) without exposing other members.
async function handleRsvpMe(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const rsvp = await readRsvp(env, eventId)
  const cIdx = rsvp.confirmed.findIndex(r => r.memberId === claims.id)
  if (cIdx !== -1) return json(env, { status: 'confirmed' })
  const wIdx = rsvp.waitlist.findIndex(r => r.memberId === claims.id)
  if (wIdx !== -1) return json(env, { status: 'waitlisted', position: wIdx + 1 })
  return json(env, { status: 'none' })
}

// GET /events/:id/host — host-only view of the attendee list. Names + waitlist
// positions only; no attendee emails are exposed. Address is returned so the
// host can double-check what's going out in the RSVP emails.
async function handleEventHostView(request, env, eventId) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const event = await readEvent(env, eventId)
  if (!event) return json(env, { error: 'event not found' }, 404)
  if (!event.hostId || event.hostId !== claims.id) {
    return json(env, { error: 'only the host can view this' }, 403)
  }
  const rsvp = await readRsvp(env, eventId)
  return json(env, {
    kind: event.kind || 'house',
    capacity: event.capacity || null,
    address: event.address || null,
    venue: event.venue || null,
    time: event.time || null,
    notes: event.notes || null,
    confirmed: rsvp.confirmed.map(r => r.name),
    waitlist:  rsvp.waitlist.map(r => r.name),
  })
}

// GET /rsvp/cancel?token=…  →  human-facing confirm page (a GET that mutates
// would get triggered by link prefetchers).
// POST /rsvp/cancel?token=… →  performs the cancellation. Same token works
// for both; idempotent.
async function handleRsvpCancel(request, env) {
  const token = new URL(request.url).searchParams.get('token')
  const claims = await verifyRsvpCancelToken(env, token)
  if (!claims) {
    if (request.method === 'POST') return new Response('invalid token', { status: 400 })
    return html(unsubPage(env, 'This cancel link is invalid or has expired.', 'Cancel RSVP'))
  }
  if (request.method === 'GET') {
    return html(rsvpCancelConfirmPage(env, token))
  }
  const origin = new URL(request.url).origin
  const r = await cancelRsvp(env, claims.ev, claims.m, origin)
  if (!r.ok) return new Response(r.error || 'error', { status: r.code || 500 })
  return html(unsubPage(
    env,
    r.status === 'cancelled'
      ? "Your RSVP has been cancelled. If you were confirmed and there was a waitlist, the next person has been notified."
      : "You weren't RSVPed for this screening (or already cancelled). Nothing to do.",
    'Cancel RSVP',
  ))
}

function rsvpCancelConfirmPage(env, token) {
  const escaped = escapeHtml(token)
  return page(env, {
    title: 'Cancel RSVP',
    body: '<h1>Cancel your RSVP?</h1>' +
      '<p>Click the button to release your spot. If there’s a waitlist, the next person will be notified automatically.</p>' +
      `<form method="POST" action="/rsvp/cancel?token=${escaped}"><button type="submit">Cancel my RSVP</button></form>` +
      `<p class="hint"><a href="${siteOrigin(env)}/events">Never mind — back to events</a></p>`,
  })
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

// --- Newsletter (opt-in announcements) ---
//
// Separate from the transactional OTP path above. Consent is a private
// `newsletter` boolean on each member:{email} row, never projected into the
// public members list. Every send carries a one-click unsubscribe link +
// List-Unsubscribe headers (Gmail/Yahoo bulk rules, RFC 8058) and the postal
// address required by CAN-SPAM — opt-out is the federal + deliverability floor
// regardless of how lax state law is.

// Unsubscribe tokens never expire: a link must keep working long after any
// login session. Distinct from signToken/verifyToken, which require an `exp`
// claim. HMAC over the email so the link can't be forged. Reuses hmac()/b64u().
async function signUnsubToken(env, email) {
  const payload = b64u(JSON.stringify({ e: email, p: 'unsub' }))
  const sig = await hmac(env.OTP_SIGNING_KEY, payload)
  return `${payload}.${sig}`
}

async function verifyUnsubToken(env, token) {
  if (!token) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = await hmac(env.OTP_SIGNING_KEY, payload)
  if (sig !== expected) return null
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return claims.p === 'unsub' && claims.e ? claims.e : null
  } catch {
    return null
  }
}

// GET /unsubscribe?token=...  — human-facing confirmation page.
// POST /unsubscribe?token=... — RFC 8058 one-click, called server-to-server by
// the mailbox provider. Both flip newsletter:false and are idempotent.
async function handleUnsubscribe(request, env) {
  const token = new URL(request.url).searchParams.get('token')
  const email = await verifyUnsubToken(env, token)
  if (!email) {
    if (request.method === 'POST') return new Response('invalid token', { status: 400 })
    return html(unsubPage(env, 'This unsubscribe link is invalid or has expired.'))
  }

  const memberRaw = await env.MEMBERS_KV.get(`member:${email}`)
  if (memberRaw) {
    const member = JSON.parse(memberRaw)
    if (member.newsletter !== false) {
      member.newsletter = false
      await env.MEMBERS_KV.put(`member:${email}`, JSON.stringify(member))
      // Keep the session overlay (if the member happens to be logged in) in step
      // so a subsequent /member/me reflects the unsubscribe immediately.
      if (await env.MEMBERS_KV.get(`session:${member.id}`)) await writeSession(env, member)
    }
  }

  if (request.method === 'POST') return new Response('ok', { status: 200 })
  return html(unsubPage(
    env,
    "You've been unsubscribed from Jackson Film Club announcements. " +
    "You'll still receive one-time login codes when you sign in.",
  ))
}

// POST /admin/newsletter/send — bearer-auth with ADMIN_TOKEN.
// Body: { subject, html?, text? }. Sends to every member with newsletter===true.
async function handleNewsletterSend(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }

  const { subject, html: bodyHtml, text: bodyText, testTo } = await request.json().catch(() => ({}))
  if (!subject || (!bodyHtml && !bodyText)) {
    return json(env, { error: 'subject and html or text required' }, 400)
  }

  const postal = env.NEWSLETTER_POSTAL_ADDRESS || ''
  if (!postal) {
    return json(env, { error: 'NEWSLETTER_POSTAL_ADDRESS is not configured (required by CAN-SPAM)' }, 500)
  }
  const from = env.NEWSLETTER_FROM || 'Jackson Film Club <noreply@join.jxnfilm.club>'
  const origin = new URL(request.url).origin
  const opts = { from, subject, bodyHtml, bodyText, postal, origin }

  // Test send: one faithful preview to a single address (full unsubscribe link,
  // headers, and footer), bypassing the opt-in list. No audit row — a test
  // isn't a real broadcast.
  if (testTo) {
    if (!isValidEmail(testTo)) return json(env, { error: 'invalid testTo' }, 400)
    const sent = await sendBatch(env, [await buildNewsletterMessage(env, testTo, opts)])
    return json(env, { ok: true, sent, test: true })
  }

  // Collect opted-in recipients from the canonical member rows. KV list pages
  // at 1000 keys; loop the cursor so a growing club never silently truncates.
  const recipients = []
  let cursor
  do {
    const page = await env.MEMBERS_KV.list({ prefix: 'member:', cursor })
    for (const k of page.keys) {
      const raw = await env.MEMBERS_KV.get(k.name)
      if (!raw) continue
      try {
        const m = JSON.parse(raw)
        if (m.newsletter === true && m.email) recipients.push(m.email)
      } catch { /* skip corrupt row */ }
    }
    cursor = page.list_complete ? null : page.cursor
  } while (cursor)

  if (!recipients.length) return json(env, { ok: true, sent: 0 })

  const messages = []
  for (const email of recipients) {
    messages.push(await buildNewsletterMessage(env, email, opts))
  }

  const sent = await sendBatch(env, messages)
  // Audit trail: one row per real broadcast, surfaced in the admin dashboard's
  // newsletter history. Tiny and kept indefinitely (no TTL).
  if (sent > 0) {
    await env.MEMBERS_KV.put(
      `newsletter:sent:${new Date().toISOString()}`,
      JSON.stringify({ subject, count: sent, at: Date.now() }),
    )
  }
  return json(env, { ok: true, sent })
}

// One Resend message for a single recipient: personalized unsubscribe link +
// List-Unsubscribe headers (RFC 8058) + CAN-SPAM footer. Shared by the real
// broadcast loop and the test send so they can't drift.
async function buildNewsletterMessage(env, email, { from, subject, bodyHtml, bodyText, postal, origin }) {
  const token = await signUnsubToken(env, email)
  const unsubUrl = `${origin}/unsubscribe?token=${encodeURIComponent(token)}`
  const msg = {
    from,
    to: [email],
    subject,
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe@jxnfilm.club>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
  if (bodyHtml) msg.html = appendFooterHtml(bodyHtml, unsubUrl, postal)
  if (bodyText) msg.text = appendFooterText(bodyText, unsubUrl, postal)
  return msg
}

// Resend batch endpoint: up to 100 messages per call. Honors E2E_MODE like
// sendEmail() so Playwright e2e never sends real mail.
async function sendBatch(env, messages) {
  const CHUNK = 100
  let sent = 0
  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK)
    if (env.E2E_MODE === 'true') {
      await env.MEMBERS_KV.put('__last_newsletter__', JSON.stringify(chunk))
      sent += chunk.length
      continue
    }
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify(chunk),
    })
    if (!res.ok) throw new Error(`Resend batch ${res.status}: ${await res.text()}`)
    sent += chunk.length
  }
  return sent
}

function appendFooterText(body, unsubUrl, postal) {
  return [
    body, '', '—',
    'You received this because you opted in to Jackson Film Club announcements.',
    `Unsubscribe: ${unsubUrl}`,
    postal,
  ].join('\n')
}

function appendFooterHtml(body, unsubUrl, postal) {
  return `${body}<hr><p style="font-size:12px;color:#888">` +
    'You received this because you opted in to Jackson Film Club announcements.<br>' +
    `<a href="${unsubUrl}">Unsubscribe</a><br>${escapeHtml(postal)}</p>`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function unsubPage(env, message, title = 'Unsubscribe') {
  return page(env, {
    title,
    body: `<h1>Jackson Film Club</h1><p>${escapeHtml(message)}</p>` +
      `<p class="hint"><a href="${siteOrigin(env)}/">← Back to Jackson Film Club</a></p>`,
  })
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
