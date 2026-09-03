import privacyHtml from './privacy.html'
import signupHtml from './signup.html'

// The policy page is the single source of truth for its own revision date.
// Null if the marker ever goes missing — the SPA treats that as "no toast".
const PRIVACY_UPDATED = (privacyHtml.match(/Last updated: (\d{4}-\d{2}-\d{2})/) || [])[1] || null
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

// Beta feedback capture (docs/features/feedback.md). Records auto-expire so
// the privacy promise ("we keep feedback at most 90 days") holds by design.
const FEEDBACK_TTL = 90 * 24 * 3600
const FEEDBACK_THROTTLE = 60
const FEEDBACK_CATEGORIES = ['bug', 'idea', 'other']
const MAX_FEEDBACK = 2000

// Member voice clips (podcast submissions from /speak). Bytes live in the
// VOICE R2 bucket; a bucket-wide 60-day lifecycle rule (configured at the
// account level) is the deletion mechanism — the Worker writes NO scrub code.
// KV metadata rows mirror that retention with a matching TTL, and every
// status rewrite carries the row's absolute expiry so the TTL never resets
// (same discipline as the feedback: rows).
const VOICE_TTL = 60 * 86400
const VOICE_MAX_BYTES = 8 * 1024 * 1024
const VOICE_THROTTLE = 60
const VOICE_STATUSES = ['approved', 'rejected']

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
  // X-Voice-* are the POST /voice metadata headers — the raw body is audio
  // bytes, so consent/duration can't ride in a JSON body and must be
  // preflight-allowed for the cross-origin SPA.
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Voice-Consent,X-Voice-Duration',
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
  // address/notes are deleted. Also reconciles members:all against the
  // canonical member: rows so any race-dropped aggregate entry self-heals
  // within a day even with no member activity.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scrubPastEvents(env))
    ctx.waitUntil(reconcileMembersAll(env))
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
    // Revision date for the SPA's one-time "policy updated" toast — parsed
    // from the policy page itself so there is exactly one date to bump.
    if (request.method === 'GET' && pathname === '/privacy/version') return json(env, { updated: PRIVACY_UPDATED })
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

    if (request.method === 'POST' && pathname === '/feedback')       return handleFeedback(request, env)

    // Member voice clips (podcast submissions from /speak).
    if (request.method === 'POST'   && pathname === '/voice')         return handleVoiceSubmit(request, env)
    if (request.method === 'DELETE' && pathname === '/voice')         return handleVoiceDelete(request, env)
    if (request.method === 'GET'    && pathname === '/voice/mine')    return handleVoiceMine(request, env)
    if (request.method === 'GET'    && pathname === '/voice/history') return handleVoiceHistory(request, env)
    if (request.method === 'GET'    && pathname === '/voice/audio')   return handleVoiceAudio(request, env)

    if (request.method === 'POST' && pathname === '/admin/newsletter/send') return handleNewsletterSend(request, env)
    if (request.method === 'POST' && pathname === '/admin/newsletter/image') return handleNewsletterImageUpload(request, env)
    if (request.method === 'GET'  && pathname === '/admin/tmdb/search')     return handleAdminTmdbSearch(request, env)
    if (request.method === 'POST' && pathname === '/admin/scrub')           return handleAdminScrub(request, env)
    if (request.method === 'POST' && pathname === '/admin/member/unlink')   return handleAdminMemberUnlink(request, env)
    if (request.method === 'GET'    && pathname === '/admin/voice')         return handleAdminVoiceList(request, env)
    if (request.method === 'POST'   && pathname === '/admin/voice/status')  return handleAdminVoiceStatus(request, env)
    if (request.method === 'POST'   && pathname === '/admin/voice/publish') return handleAdminVoicePublish(request, env)
    if (request.method === 'POST'   && pathname === '/admin/voice/transcript') return handleAdminVoiceTranscript(request, env)
    if (request.method === 'DELETE' && pathname === '/admin/voice')         return handleAdminVoiceDelete(request, env)

    if (request.method === 'POST' && pathname === '/session/revoke')  return handleSessionRevoke(request, env)
    if (request.method === 'POST' && pathname === '/session/refresh') return handleSessionRefresh(request, env)

    // Public read endpoints — Worker is the live source of truth, SPA hits
    // these directly so member/event mutations appear without a redeploy.
    // `data/{members,events}.json` are cron-snapshotted archives + fallbacks.
    if (request.method === 'GET' && pathname === '/members') return handleMembersGet(env)
    if (request.method === 'GET' && pathname === '/events')  return handleEventsGet(request, env)
    if (request.method === 'GET' && pathname.startsWith('/n/')) {
      return handleNewsletterArchiveGet(env, pathname.slice('/n/'.length))
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && pathname.startsWith('/nl/img/')) {
      return handleNewsletterImageGet(request, env, pathname.slice('/nl/img/'.length))
    }
    if (request.method === 'GET' && pathname === '/watched') return handleWatchedGet(request, env)
    if (request.method === 'GET' && pathname === '/avatars') return handleAvatarsGet(env)
    // Operator-editable config (admin portal writes config:* keys in
    // MEMBERS_KV). Public projection only — config:newsletter_template is
    // admin-only and deliberately absent here.
    if (request.method === 'GET' && pathname === '/config')  return handleConfigGet(env)
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

    const eventMatch = pathname.match(/^\/events\/([^\/]+)\/(attend|attendance|rsvp|rsvp\/me|rsvp\/guest|host)$/)
    if (eventMatch) {
      const [, eventId, suffix] = eventMatch
      if (suffix === 'attendance' && request.method === 'GET')   return handleAttendanceGet(env, eventId)
      if (suffix === 'attend'     && request.method === 'POST')  return handleAttend(request, env, eventId)
      if (suffix === 'attend'     && request.method === 'DELETE') return handleUnattend(request, env, eventId)
      if (suffix === 'rsvp'       && request.method === 'POST')   return handleRsvp(request, env, eventId)
      if (suffix === 'rsvp'       && request.method === 'DELETE') return handleUnrsvp(request, env, eventId)
      if (suffix === 'rsvp/me'    && request.method === 'GET')    return handleRsvpMe(request, env, eventId)
      if (suffix === 'rsvp/guest' && request.method === 'POST')   return handleGuestAdd(request, env, eventId)
      if (suffix === 'rsvp/guest' && request.method === 'DELETE') return handleGuestRemove(request, env, eventId)
      if (suffix === 'host'       && request.method === 'GET')    return handleEventHostView(request, env, eventId)
    }

    if (env.E2E_MODE === 'true' && pathname === '/__test/kv') return handleTestKv(request, env)
    // R2 read-back for e2e: the admin agent's local server proxies to this in
    // e2e mode so Playwright can verify uploaded clip bytes without R2 creds.
    if (env.E2E_MODE === 'true' && pathname === '/__test/r2' && request.method === 'GET') {
      return handleTestR2(request, env)
    }

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
// Surgically remove one handle from the stale-while-error Letterboxd caches
// (watched:cache / avatars:cache) so an unlinked member stops serving
// immediately without sacrificing anyone else's last-good data. This is a
// read-modify-write, which members:all deliberately avoids — safe here
// because a racing rebuild filters to current membership anyway, so a
// clobbered evict self-heals on the next rebuild (worst case: one extra
// freshness window). Tolerates both record shapes; an unparseable record is
// deleted outright and rebuilt from scratch.
async function evictHandleFromCaches(env, handle) {
  if (!handle) return
  for (const key of ['watched:cache', 'avatars:cache']) {
    const raw = await env.MEMBERS_KV.get(key)
    if (!raw) continue
    try {
      const rec = JSON.parse(raw)
      const map = rec && typeof rec.map === 'object' && rec.map ? rec.map : rec
      if (map && typeof map === 'object' && handle in map) {
        delete map[handle]
        await env.MEMBERS_KV.put(key, JSON.stringify(rec))
      }
    } catch {
      await env.MEMBERS_KV.delete(key)
    }
  }
}

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
  // The unlinked member's RSS/avatar stop serving immediately — but only
  // their entry goes. Deleting the whole record (the old approach) would
  // destroy every member's last-good stale-while-error data whenever an
  // unlink landed mid-Letterboxd-outage.
  await evictHandleFromCaches(env, handle || staleAggHandle)
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

  const renamedTo = updates.name && updates.name !== member.name ? updates.name : null

  Object.assign(member, updates)
  await env.MEMBERS_KV.put(`member:${claims.email}`, JSON.stringify(member))
  await patchMembersAll(env, publicMemberProjection(member))
  await writeSession(env, member)
  // Attendance is id-keyed and resolved on read, so it needs nothing here.
  // The two rows that still carry a *copy* of the name — event:{id}.hostName
  // and the rsvp:{id} entries — are read straight out of KV by outbound email
  // and the admin dashboard, so rewrite them when the name actually changes.
  if (renamedTo) await propagateNameChange(env, member.id, renamedTo)
  await dispatchGithub(env, 'update-member', { id: member.id, updates })
  return json(env, { ok: true, id: member.id })
}

// Rewrite the name snapshots a rename leaves stale. Guarded on an actual name
// change (a pronouns-only edit must not pay for two prefix scans), and both
// scans are bounded by the club's event count — screenings, not members.
//
// Failures are logged, not thrown: the rename itself already succeeded and is
// live everywhere that resolves on read, so a KV hiccup here must not 500 a
// member's profile save. The next write to either row picks up the new name
// from the resolvers anyway.
async function propagateNameChange(env, memberId, name) {
  if (!memberId) return
  try {
    const events = await env.ATTENDANCE_KV.list({ prefix: 'event:' })
    for (const k of events.keys) {
      const event = await readEvent(env, k.name.slice('event:'.length))
      if (!event || event.hostId !== memberId || event.hostName === name) continue
      await writeEvent(env, { ...event, hostName: name })
    }
    const rsvps = await env.ATTENDANCE_KV.list({ prefix: 'rsvp:' })
    for (const k of rsvps.keys) {
      const eventId = k.name.slice('rsvp:'.length)
      const rsvp = await readRsvp(env, eventId)
      const stale = r => r.memberId === memberId && r.name !== name
      if (!rsvp.confirmed.some(stale) && !rsvp.waitlist.some(stale)) continue
      const rename = r => (r.memberId === memberId ? { ...r, name } : r)
      rsvp.confirmed = rsvp.confirmed.map(rename)
      rsvp.waitlist = rsvp.waitlist.map(rename)
      await writeRsvp(env, eventId, rsvp)
    }
  } catch (e) {
    console.error('name propagation failed:', e?.message || e)
  }
}

// POST /member/delete — authenticated.
// Self-service membership deletion. Removes the member row, all reverse
// indices, any in-flight Letterboxd token, and the session snapshot.
// Revokes the current bearer token so a copy can't be replayed. Dispatches
// `remove-member` to drop the row from data/members.json. Past attendance
// entries (attend:{eventId} in ATTENDANCE_KV) are intentionally kept as
// historical record — only the member identity is removed. RSVP records
// (which carry the member's email) are purged everywhere via purgeRsvps().
// Feedback records are identity-stripped (text kept as anonymous feedback)
// via stripFeedbackIdentity().
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
  if (body && body.anonymize === true && (member.id || member.name)) {
    await anonymizeAttendance(env, member)
  }

  // Purge the member's RSVP entries before the KV cascade. Deliberately not
  // wrapped in try/catch: if the purge fails, the 500 lets the user retry —
  // swallowing the error would delete the account while leaving their email
  // behind in rsvp:* records, and claim success.
  await purgeRsvps(env, member, new URL(request.url).origin)

  // Voice clips are deleted outright (R2 bytes + KV rows) — a voice recording
  // can't be identity-stripped, it IS the identity. Same unguarded stance as
  // purgeRsvps: a failure here must block the deletion, not be swallowed.
  await purgeVoiceClips(env, member)

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
  // Feedback keeps its text as anonymous feedback; only the identity goes.
  if (member.id) await stripFeedbackIdentity(env, member.id)

  // Revoke this token so a stolen copy can't be used to re-sign-in or hit
  // any other authenticated endpoint during the JWT's remaining lifetime.
  if (claims.jti) {
    const remainingSec = Math.max(60, Math.ceil((claims.exp - Date.now()) / 1000))
    await env.MEMBERS_KV.put(`revoked:${claims.jti}`, '1', { expirationTtl: remainingSec })
  }

  await dispatchGithub(env, 'remove-member', { id: member.id })
  return json(env, { ok: true })
}

// Attendance is stored as `attend:{eventId} -> [{ id, name }, ...]`, keyed on
// the member id. Walking the entire prefix is the only way to find a member's
// past attendance — there's no per-member index. For a small club this is
// cheap; a 1000-member future would want an `attended_by:{id}` index.
//
// Matching is by id, so two members sharing a display name are no longer
// conflated — the pre-migration store deduped on name and would have scrubbed
// both. Rows that predate the id backfill still match on their id-less name
// (see attendeeIndex), which is the old behaviour for exactly those rows.
const FORMER_MEMBER_LABEL = 'former member'

// Deliberately name-only: `event.hostName` is NOT scrubbed, so a member who
// hosted screenings keeps their name on those events (and, via withHost(), in
// their attendance lists). Hosting is public attribution, not a passive
// record. /privacy states this and routes removal to a by-hand request at
// privacy@jxnfilm.club; the danger-zone checkbox in ui/auth.html repeats it.
// Don't "fix" this without changing all three.
async function anonymizeAttendance(env, member) {
  const list = await env.ATTENDANCE_KV.list({ prefix: 'attend:' })
  for (const k of list.keys) {
    const raw = await env.ATTENDANCE_KV.get(k.name)
    if (!raw) continue
    let arr
    try { arr = normalizeAttendees(JSON.parse(raw)) } catch { continue }
    const idx = attendeeIndex(arr, member.id, member.name)
    if (idx === -1) continue
    arr.splice(idx, 1)
    if (!arr.some(a => !a.id && a.name === FORMER_MEMBER_LABEL)) {
      arr.push(attendEntry(null, FORMER_MEMBER_LABEL))
    }
    const eventId = k.name.slice('attend:'.length)
    // Reuse writeAttendees so attendance:all aggregate stays in lockstep.
    await writeAttendees(env, eventId, arr)
  }
}

// POST /feedback — beta-phase active feedback capture.
// Anonymous submissions are allowed; when a valid bearer token is present the
// member identity is attached server-side (never trusted from the body), and
// `anonymous: true` lets a signed-in member opt out of attaching it. The
// absolute expiry is duplicated into the value so the account-deletion
// identity strip can rewrite the record without clearing its TTL — a bare
// put() would make the record permanent and break the 90-day retention
// promise in /privacy.
async function handleFeedback(request, env) {
  const body = await request.json().catch(() => ({}))

  if (!FEEDBACK_CATEGORIES.includes(body.category)) {
    return json(env, { error: 'invalid category' }, 400)
  }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message || message.length > MAX_FEEDBACK) {
    return json(env, { error: `message must be 1-${MAX_FEEDBACK} characters` }, 400)
  }
  const page = typeof body.page === 'string' ? body.page.slice(0, 200) : null

  // First IP-keyed throttle in the Worker: every other rate-limited endpoint
  // requires an email to key on, but anonymous feedback has none.
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (!await throttle(env, `rate:feedback:${ip}`, FEEDBACK_THROTTLE)) {
    return json(env, { error: 'too many submissions — try again in a minute' }, 429)
  }

  let member = null
  const claims = await authorize(request, env)
  if (claims && body.anonymous !== true) {
    const snapshot = await readSession(env, claims)
    member = { id: claims.id, email: claims.email, name: snapshot?.name || null }
  }

  const expiresAt = Math.floor(Date.now() / 1000) + FEEDBACK_TTL
  await env.MEMBERS_KV.put(
    `feedback:${Date.now()}:${randomToken(8)}`,
    JSON.stringify({
      at: new Date().toISOString(),
      category: body.category,
      message,
      page,
      member,
      expiresAt,
    }),
    { expirationTtl: FEEDBACK_TTL },
  )

  return json(env, { ok: true })
}

// Feedback half of the account-deletion cascade: strip the member's identity
// from their feedback records but keep the message as anonymous feedback.
// The rewrite carries the record's original absolute expiry; a record within
// KV's 60s expiration floor is deleted outright instead of rewritten.
async function stripFeedbackIdentity(env, memberId) {
  if (!memberId) return
  const list = await env.MEMBERS_KV.list({ prefix: 'feedback:' })
  for (const k of list.keys) {
    const raw = await env.MEMBERS_KV.get(k.name)
    if (!raw) continue
    let rec
    try { rec = JSON.parse(raw) } catch { continue }
    if (!rec?.member || rec.member.id !== memberId) continue
    rec.member = null
    const remaining = (rec.expiresAt || 0) - Math.floor(Date.now() / 1000)
    if (remaining < 60) {
      await env.MEMBERS_KV.delete(k.name)
    } else {
      await env.MEMBERS_KV.put(k.name, JSON.stringify(rec), { expiration: rec.expiresAt })
    }
  }
}

// --- Member voice clips (podcast submissions) ---
//
// Members record ≤3-minute clips on /speak answering the current prompt.
// Audio bytes go to the VOICE R2 bucket at voice/{promptId}/{memberId}.{ext};
// metadata rows live at voice:{promptId}:{memberId} in MEMBERS_KV. Retention
// is the account-level 60-day R2 lifecycle rule — the KV TTL mirrors it, and
// a KV row whose R2 object has already been lifecycle-deleted is EXPECTED
// (the two clocks aren't synchronized), so no handler 500s on an R2 miss.

// Current prompt: config:voice_prompt when it carries non-empty id + text,
// else the standing default. The deadline is display-only metadata.
async function voicePrompt(env) {
  const v = await readConfig(env, 'voice_prompt')
  if (v && typeof v.id === 'string' && v.id && typeof v.text === 'string' && v.text) {
    const out = { id: v.id, text: v.text }
    if (typeof v.deadline === 'string' && v.deadline) out.deadline = v.deadline
    return out
  }
  return { id: 'general', text: "Tell us what you're watching" }
}

// Rounds whose episode has actually aired, as a set of promptIds.
//
// This is the difference between "we're using your clip" and "your clip is
// out in the world", and only a human knows when the second becomes true —
// hence an explicit admin action rather than anything derived. Approval is a
// moderation state; publication is an event. Stored as config:voice_published
// = { promptIds: [...] }; a missing key means nothing has been published yet,
// which is the correct default for a fresh install.
async function publishedPrompts(env) {
  const v = await readConfig(env, 'voice_published')
  const ids = v && Array.isArray(v.promptIds) ? v.promptIds : []
  return new Set(ids.filter(id => validPromptId(id)))
}

// Content-type allowlist → file extension. Prefix-matched, NOT exact:
// browsers report 'audio/webm;codecs=opus' and friends. Returns null for
// anything outside the allowlist.
const VOICE_TYPES = [
  ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/m4a', 'm4a'],
  ['audio/aac', 'm4a'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
]

function voiceExt(contentType) {
  const ct = String(contentType || '').toLowerCase().trim()
  for (const [prefix, ext] of VOICE_TYPES) {
    if (ct.startsWith(prefix)) return ext
  }
  return null
}

// What the member-facing endpoints return: the row minus storage internals.
function voiceClipProjection(row, published) {
  if (!row) return null
  const out = {
    // Whether the ROUND has aired. A clip can be approved for months before
    // its episode drops, so the member UI must be able to tell those apart.
    published: published instanceof Set ? published.has(row.promptId) : false,
    promptId: row.promptId,
    promptText: row.promptText,
    contentType: row.contentType,
    size: row.size,
    consent: row.consent,
    at: row.at,
    expiresAt: row.expiresAt,
    status: row.status,
  }
  if (row.duration != null) out.duration = row.duration
  return out
}

// POST /voice — authenticated. Raw body = audio bytes; metadata rides in
// headers (Content-Type, X-Voice-Duration, X-Voice-Consent). One clip per
// member per current prompt: a resubmission replaces the old clip — new R2
// object, new 60-day clock (the lifecycle rule counts from upload, so the
// fresh expirationTtl mirrors it). Consent is not optional — a voice clip is
// identity — so no X-Voice-Consent: yes means no stored bytes, full stop.
async function handleVoiceSubmit(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const memberRaw = await env.MEMBERS_KV.get(`member:${claims.email}`)
  if (!memberRaw) return json(env, { error: 'member not found' }, 404)
  const member = JSON.parse(memberRaw)

  if (request.headers.get('X-Voice-Consent') !== 'yes') {
    return json(env, { error: 'consent is required — set X-Voice-Consent: yes' }, 400)
  }
  const contentType = request.headers.get('Content-Type') || ''
  const ext = voiceExt(contentType)
  if (!ext) return json(env, { error: 'unsupported audio type' }, 415)
  // Cheap reject on the declared length before buffering the body…
  const declared = Number(request.headers.get('Content-Length') || 0)
  if (declared > VOICE_MAX_BYTES) {
    return json(env, { error: 'audio too large (8MB max)' }, 413)
  }
  const bytes = await request.arrayBuffer()
  // …and verify the bytes actually read, since Content-Length is just a claim.
  if (bytes.byteLength > VOICE_MAX_BYTES) {
    return json(env, { error: 'audio too large (8MB max)' }, 413)
  }
  if (!bytes.byteLength) return json(env, { error: 'empty audio' }, 400)

  const prompt = await voicePrompt(env)
  const kvKey = `voice:${prompt.id}:${member.id}`
  const r2Key = `voice/${prompt.id}/${member.id}.${ext}`

  // Replace flow: if a previous clip for this prompt lives at a different R2
  // key (extension changed with the content type), delete the orphan so the
  // bucket never holds two clips for one member+prompt.
  let previous = null
  const previousRaw = await env.MEMBERS_KV.get(kvKey)
  if (previousRaw) {
    try { previous = JSON.parse(previousRaw) } catch { previous = null }
  }

  // Throttle after validation — a rejected submission shouldn't consume the
  // slot (same discipline as /feedback) — and only for FIRST submissions:
  // replacing your own clip is bounded by one-clip-per-member-per-prompt, and
  // the Replace button legitimately arrives seconds after the first submit.
  if (!previous && !(await throttle(env, `rate:voice_submit:${claims.email}`, VOICE_THROTTLE))) {
    return json(env, { error: 'please wait a moment before submitting again' }, 429)
  }

  await env.VOICE.put(r2Key, bytes, { httpMetadata: { contentType } })
  if (previous && previous.r2Key && previous.r2Key !== r2Key) {
    await env.VOICE.delete(previous.r2Key)
  }

  const durationHeader = request.headers.get('X-Voice-Duration')
  const duration = durationHeader != null ? Number(durationHeader) : null

  const row = {
    memberId: member.id,
    name: member.name,
    promptId: prompt.id,
    promptText: prompt.text,
    r2Key,
    contentType,
    size: bytes.byteLength,
    consent: true,
    at: new Date().toISOString(),
    expiresAt: Math.floor(Date.now() / 1000) + VOICE_TTL,
    status: 'pending',
  }
  if (member.handle) row.handle = member.handle
  if (Number.isFinite(duration) && duration > 0) row.duration = duration
  await env.MEMBERS_KV.put(kvKey, JSON.stringify(row), { expirationTtl: VOICE_TTL })

  // Contract: the response IS the safe projection (no wrapper object).
  return json(env, voiceClipProjection(row))
}

// GET /voice/mine — authenticated. The current prompt plus the caller's clip
// for it, or null.
//
// Returns the same whitelisted projection as /voice/history rather than the
// raw row. It used to hand back everything on the grounds that nothing in it
// was secret from its owner — which stopped being true the moment the row
// started carrying operator bookkeeping (transcript.reviewedAt). A whitelist
// makes new fields private by default instead of public by default.
async function handleVoiceMine(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const prompt = await voicePrompt(env)
  const raw = await env.MEMBERS_KV.get(`voice:${prompt.id}:${claims.id}`)
  let clip = null
  if (raw) {
    try { clip = JSON.parse(raw) } catch { clip = null }
  }
  return json(env, { prompt, clip: voiceClipProjection(clip, await publishedPrompts(env)) })
}

// Prompt ids are admin-set slugs. The pattern is a security boundary, not
// cosmetics: promptId is interpolated into voice:{promptId}:{memberId}, and
// a colon-bearing value could otherwise be crafted to address key shapes
// the caller doesn't own.
function validPromptId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

// DELETE /voice — authenticated. Removes the caller's clip (R2 object + KV
// row) for ?promptId=, defaulting to the current prompt so existing callers
// are unchanged. Idempotent — 200 even when nothing existed (R2 delete on a
// missing key is a no-op, matching the lifecycle-rule race).
async function handleVoiceDelete(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const requested = new URL(request.url).searchParams.get('promptId')
  if (requested != null && !validPromptId(requested)) {
    return json(env, { error: 'invalid promptId' }, 400)
  }
  const promptId = requested || (await voicePrompt(env)).id
  const kvKey = `voice:${promptId}:${claims.id}`
  const raw = await env.MEMBERS_KV.get(kvKey)
  if (raw) {
    try {
      const row = JSON.parse(raw)
      if (row.r2Key) await env.VOICE.delete(row.r2Key)
    } catch { /* unparseable row still gets deleted below */ }
    await env.MEMBERS_KV.delete(kvKey)
  }
  return json(env, { ok: true })
}

// GET /voice/history — authenticated. Every clip the caller has submitted,
// across prompts: the current prompt's clip first, the rest newest-first.
// currentPromptId rides along so the SPA can badge "this round" and offer
// Replace on that row only, from one source of truth.
async function handleVoiceHistory(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const prompt = await voicePrompt(env)
  const published = await publishedPrompts(env)
  const suffix = `:${claims.id}`
  const clips = []
  let cursor
  do {
    const page = await env.MEMBERS_KV.list({ prefix: 'voice:', cursor })
    for (const k of page.keys) {
      if (!k.name.endsWith(suffix)) continue
      const raw = await env.MEMBERS_KV.get(k.name)
      if (!raw) continue
      try {
        const row = JSON.parse(raw)
        if (row.memberId === claims.id) clips.push(voiceClipProjection(row, published))
      } catch { /* skip corrupt row */ }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  clips.sort((a, b) => {
    if ((a.promptId === prompt.id) !== (b.promptId === prompt.id)) {
      return a.promptId === prompt.id ? -1 : 1
    }
    return String(b.at).localeCompare(String(a.at))
  })
  return json(env, { currentPromptId: prompt.id, clips })
}

// GET /voice/audio?promptId= — authenticated. Streams the caller's OWN clip
// bytes back from R2 (the key is built from their claims.id, so ownership is
// structural). A KV row whose R2 object the lifecycle rule already deleted is
// the documented race — that's a friendly 404, not a 500. The SPA fetches
// with the bearer and plays via a blob URL; <audio src> can't carry a header.
async function handleVoiceAudio(request, env) {
  const claims = await authorize(request, env)
  if (!claims) return json(env, { error: 'unauthorized' }, 401)
  const promptId = new URL(request.url).searchParams.get('promptId')
  if (!validPromptId(promptId)) return json(env, { error: 'invalid promptId' }, 400)
  const raw = await env.MEMBERS_KV.get(`voice:${promptId}:${claims.id}`)
  if (!raw) return json(env, { error: 'clip not found' }, 404)
  let row = null
  try { row = JSON.parse(raw) } catch { row = null }
  if (!row || !row.r2Key) return json(env, { error: 'clip not found' }, 404)
  const obj = await env.VOICE.get(row.r2Key)
  if (!obj) return json(env, { error: 'clip audio has expired' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': row.contentType || 'application/octet-stream',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, no-store',
      ...cors(env),
    },
  })
}

// GET /admin/voice — bearer-auth with ADMIN_TOKEN (same gate as
// /admin/member/unlink). Every voice: row with its KV key, across prompts —
// the key is what /admin/voice/status and DELETE /admin/voice take back.
async function handleAdminVoiceList(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }
  const clips = []
  let cursor
  do {
    const page = await env.MEMBERS_KV.list({ prefix: 'voice:', cursor })
    for (const k of page.keys) {
      const raw = await env.MEMBERS_KV.get(k.name)
      if (!raw) continue
      try { clips.push({ key: k.name, ...JSON.parse(raw) }) } catch { /* skip corrupt row */ }
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  // The admin UI needs the published set to render a per-round toggle.
  return json(env, { clips, publishedPromptIds: [...(await publishedPrompts(env))].sort() })
}

// POST /admin/voice/publish — { promptId, published: boolean }.
//
// Marks a whole ROUND as aired, which is what flips every approved clip in it
// from "Approved" to "Published" for its member. Deliberately round-scoped
// rather than per-clip: an episode drops once, and a member whose clip was
// approved shouldn't have to wonder whether their particular clip made the
// cut after the episode is already out.
//
// Rewrites config:voice_published with NO expiry — this is operator config,
// not member data, and it must outlive the 60-day clip retention so a member
// who asks later still gets a truthful answer about a round.
async function handleAdminVoicePublish(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }
  const body = await request.json().catch(() => ({}))
  if (!validPromptId(body.promptId)) return json(env, { error: 'invalid promptId' }, 400)
  if (typeof body.published !== 'boolean') {
    return json(env, { error: 'published must be a boolean' }, 400)
  }
  const current = await publishedPrompts(env)
  if (body.published) current.add(body.promptId)
  else current.delete(body.promptId)
  const promptIds = [...current].sort()
  await env.MEMBERS_KV.put('config:voice_published', JSON.stringify({ promptIds }))
  return json(env, { ok: true, promptIds })
}

// POST /admin/voice/status — { key, status: 'approved' | 'rejected' }.
// Rewrites the row with its ORIGINAL absolute expiry (feedback: pattern) so
// moderation never resets the 60-day retention clock. A row already inside
// KV's 60s expiration floor can't be rewritten — it's deleted instead, which
// is where it was headed anyway.
async function handleAdminVoiceStatus(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }
  const body = await request.json().catch(() => ({}))
  if (typeof body.key !== 'string' || !body.key.startsWith('voice:')) {
    return json(env, { error: 'invalid key' }, 400)
  }
  if (!VOICE_STATUSES.includes(body.status)) {
    return json(env, { error: `status must be one of: ${VOICE_STATUSES.join(', ')}` }, 400)
  }
  const raw = await env.MEMBERS_KV.get(body.key)
  if (!raw) return json(env, { error: 'clip not found' }, 404)
  let row
  try { row = JSON.parse(raw) } catch { return json(env, { error: 'clip not found' }, 404) }

  const remaining = (row.expiresAt || 0) - Math.floor(Date.now() / 1000)
  if (remaining < 60) {
    await env.MEMBERS_KV.delete(body.key)
    return json(env, { error: 'clip has expired' }, 404)
  }
  row.status = body.status
  await env.MEMBERS_KV.put(body.key, JSON.stringify(row), { expiration: row.expiresAt })
  return json(env, { ok: true, key: body.key, status: row.status })
}

// POST /admin/voice/transcript — { key, srt? }. Saves an EDITED caption file,
// or with `srt` omitted, marks the existing one reviewed without rewriting it
// (the panel's "mark reviewed" button, for a transcript that needed no fixes).
//
// The admin panel only ever edits: transcripts are drafted locally by
// scripts/transcribe.mjs and uploaded, so no model runs anywhere near
// Cloudflare. This endpoint writes the corrected SRT back beside its audio and
// stamps the KV row as reviewed.
//
// The reviewed marker lives on the row rather than being inferred from the
// object's presence, because the DRAFT has to reach R2 before it can be edited
// here — so "an .srt exists" can no longer mean "a human read it". Rewritten
// with the row's ORIGINAL absolute expiry (the feedback: pattern) so reviewing
// never resets the 60-day retention clock, and the marker dies with the clip.
const VOICE_TRANSCRIPT_MAX = 256 * 1024

async function handleAdminVoiceTranscript(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }
  const body = await request.json().catch(() => ({}))
  if (typeof body.key !== 'string' || !body.key.startsWith('voice:')) {
    return json(env, { error: 'invalid key' }, 400)
  }
  const saving = body.srt !== undefined
  if (saving) {
    if (typeof body.srt !== 'string' || !body.srt.trim()) {
      return json(env, { error: 'srt is required' }, 400)
    }
    if (body.srt.length > VOICE_TRANSCRIPT_MAX) {
      return json(env, { error: 'transcript too large' }, 413)
    }
    // Cheapest possible shape check. An SRT with no timing line renders no
    // captions at all, and finding that out at render time is expensive.
    if (!body.srt.includes('-->')) {
      return json(env, { error: 'that does not look like an SRT — no timing lines' }, 400)
    }
  }

  const raw = await env.MEMBERS_KV.get(body.key)
  if (!raw) return json(env, { error: 'clip not found' }, 404)
  let row
  try { row = JSON.parse(raw) } catch { return json(env, { error: 'clip not found' }, 404) }
  if (!row.r2Key) return json(env, { error: 'clip has no audio' }, 404)

  const remaining = (row.expiresAt || 0) - Math.floor(Date.now() / 1000)
  if (remaining < 60) {
    await env.MEMBERS_KV.delete(body.key)
    return json(env, { error: 'clip has expired' }, 404)
  }

  // Same stem as the audio, so the bucket's all-prefixes lifecycle expires the
  // transcript with the recording it describes.
  const transcriptKey = row.r2Key.replace(/\.[^.]+$/, '.srt')
  let bytes
  if (saving) {
    await env.VOICE.put(transcriptKey, body.srt, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    })
    bytes = body.srt.length
  } else {
    // Marking reviewed without a body means vouching for what is already
    // stored — so there had better be something stored. Refusing here beats
    // stamping a clip whose transcript never arrived.
    const existing = await env.VOICE.head(transcriptKey)
    if (!existing) return json(env, { error: 'no transcript to review — upload one first' }, 404)
    bytes = existing.size
  }
  row.transcript = { reviewedAt: new Date().toISOString(), bytes }
  await env.MEMBERS_KV.put(body.key, JSON.stringify(row), { expiration: row.expiresAt })
  return json(env, { ok: true, key: body.key, transcriptKey, transcript: row.transcript })
}

// DELETE /admin/voice — { key }. Removes the KV row and its R2 object.
// Idempotent: 200 even if either side was already gone.
async function handleAdminVoiceDelete(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }
  const body = await request.json().catch(() => ({}))
  if (typeof body.key !== 'string' || !body.key.startsWith('voice:')) {
    return json(env, { error: 'invalid key' }, 400)
  }
  const raw = await env.MEMBERS_KV.get(body.key)
  if (raw) {
    try {
      const row = JSON.parse(raw)
      if (row.r2Key) await env.VOICE.delete(row.r2Key)
    } catch { /* unparseable row still gets deleted below */ }
    await env.MEMBERS_KV.delete(body.key)
  }
  return json(env, { ok: true })
}

// Account-deletion sweep for voice clips. A voice clip can't be
// identity-stripped the way feedback text can — the voice IS the identity —
// so the member's rows and R2 objects are deleted outright. Like purgeRsvps,
// deliberately unguarded: a throw 500s the delete so the user can retry,
// rather than claiming success while their voice lingers in the bucket.
async function purgeVoiceClips(env, member) {
  if (!member?.id) return
  let cursor
  do {
    const page = await env.MEMBERS_KV.list({ prefix: 'voice:', cursor })
    for (const k of page.keys) {
      const raw = await env.MEMBERS_KV.get(k.name)
      if (!raw) continue
      let row
      try { row = JSON.parse(raw) } catch { continue }
      if (row.memberId !== member.id) continue
      if (row.r2Key) await env.VOICE.delete(row.r2Key)
      await env.MEMBERS_KV.delete(k.name)
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
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

// An attendance entry is `{ id, name }`:
//   id   — a member id, a synthetic `guest:xxxxxxxx` id, or null when the row
//          predates the id migration and no member matched the stored name
//   name — a display-name snapshot; the fallback rendered whenever `id`
//          resolves to nothing (deleted member, guest, legacy row)
//
// The id is what is canonical. Names are re-resolved from `members:all` on
// every read, so a member who renames is renamed everywhere their name shows
// up at once — attendee lists, the homepage leaderboard, their account stats,
// and (on the next cron tick) the data/attendance.json snapshot.
function attendEntry(id, name) {
  return { id: id || null, name: typeof name === 'string' ? name : '' }
}

// Every read path funnels through here, so both the current `[{id,name}]`
// shape and the legacy `[name]` arrays that predate the migration parse —
// including bootstrapAttendance, which meets an old-format
// data/attendance.json on a cold namespace.
function normalizeAttendees(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const v of value) {
    if (typeof v === 'string') {
      if (v) out.push(attendEntry(null, v))
    } else if (v && typeof v === 'object') {
      const id = typeof v.id === 'string' && v.id ? v.id : null
      const name = typeof v.name === 'string' ? v.name : ''
      if (id || name) out.push(attendEntry(id, name))
    }
  }
  return out
}

// Locate a member in an attendee list: by id first, then — for rows that
// haven't been backfilled yet — by an exact match on a legacy id-less name.
// Without that second arm a member who attended before the migration would be
// appended a second time the next time they toggled the button.
function attendeeIndex(attendees, id, name) {
  if (id) {
    const i = attendees.findIndex(a => a.id === id)
    if (i !== -1) return i
  }
  return name ? attendees.findIndex(a => !a.id && a.name === name) : -1
}

// Read-time name resolution. Reads `members:all` RAW rather than through
// readMembersAll(): the attendance hot path must not be able to trigger the
// members bootstrap (an extra origin fetch) — the same reasoning as the raw
// events:all read in handleAttendanceMap.
async function memberNamesById(env) {
  const map = new Map()
  const raw = await env.MEMBERS_KV.get('members:all')
  if (!raw) return map
  for (const m of safeParseArray(raw)) {
    if (m && m.id && m.name) map.set(m.id, m.name)
  }
  return map
}

// Swap stored name snapshots for each member's current name, then dedupe.
// Dedupe drops (a) repeated ids and (b) id-less legacy rows whose name now
// duplicates an id-bearing one — the artifact of a half-backfilled event, and
// exactly the conflation the old name-keyed store performed unconditionally.
// Two *different* members who share a display name both survive: the id check
// runs first, so only the id-less row can ever be collapsed.
function resolveAttendees(attendees, names) {
  const resolved = attendees.map(a => (
    a.id && names.has(a.id) ? attendEntry(a.id, names.get(a.id)) : a
  ))
  const identified = new Set(resolved.filter(a => a.id).map(a => a.name))
  const out = []
  const seenIds = new Set()
  const seenNames = new Set()
  for (const a of resolved) {
    if (a.id) {
      if (seenIds.has(a.id)) continue
      seenIds.add(a.id)
    } else {
      if (identified.has(a.name) || seenNames.has(a.name)) continue
      seenNames.add(a.name)
    }
    out.push(a)
  }
  return out
}

// Same read-time resolution for the one other place a member's name is copied
// into a row they don't own: `event.hostName`.
function resolveHostNames(events, names) {
  return events.map(e => {
    if (!e || !e.hostId) return e
    const name = names.get(e.hostId)
    return name && name !== e.hostName ? { ...e, hostName: name } : e
  })
}

// The host of a screening attended it. writeRsvp() mirrors the host into
// attend:{id}, but this read-time overlay is what makes it true everywhere:
// screenings created before that rule never get a fresh RSVP write, and the
// leaderboard reads the data/attendance.json snapshot taken off these
// endpoints — so overlaying on read backfills both without a KV migration.
// Idempotent, and runs BEFORE name resolution so a pre-migration mirror that
// wrote the host as a bare name is upgraded in place instead of gaining an
// id-bearing twin beside it.
function withHost(attendees, event) {
  if (!event || !event.hostId) return attendees
  if (attendees.some(a => a.id === event.hostId)) return attendees
  const hostName = event.hostName || ''
  const legacy = hostName ? attendees.findIndex(a => !a.id && a.name === hostName) : -1
  if (legacy !== -1) {
    const next = attendees.slice()
    next[legacy] = attendEntry(event.hostId, hostName)
    return next
  }
  if (!hostName) return attendees
  return [attendEntry(event.hostId, hostName), ...attendees]
}

// GET /events/:id/attendance — public; returns { attendees: [{ id, name }] }.
async function handleAttendanceGet(env, eventId) {
  const [attendees, event, names] = await Promise.all([
    readAttendees(env, eventId),
    readEvent(env, eventId),
    memberNamesById(env),
  ])
  return json(env, { attendees: resolveAttendees(withHost(attendees, event), names) })
}

// GET /events/attendance — public; bulk read { [eventId]: [{ id, name }] }.
// Three KV GETs in the steady state (attendance:all + events:all for the
// hosts + members:all for current names). Deliberately reads events:all and
// members:all raw rather than via their readers: the attendance path must not
// trigger either bootstrap (an extra origin fetch). On a cold namespace the
// host overlay simply waits for the first GET /events, which every page load
// already performs.
async function handleAttendanceMap(env) {
  const all = await readAttendanceAll(env)
  const eventsRaw = await env.ATTENDANCE_KV.get('events:all')
  const events = eventsRaw ? safeParseArray(eventsRaw) : []
  const names = await memberNamesById(env)
  const out = { ...all }
  for (const e of events) {
    if (!e || !e.hostId) continue
    out[e.id] = withHost(out[e.id] || [], e)
  }
  for (const id of Object.keys(out)) out[id] = resolveAttendees(out[id], names)
  return json(env, { attendance: out })
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
  if (attendeeIndex(attendees, member.id, member.name) === -1) {
    attendees.push(attendEntry(member.id, member.name))
    await writeAttendees(env, eventId, attendees)
  }
  return json(env, { ok: true, attendees: resolveAttendees(attendees, await memberNamesById(env)) })
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
  const idx = attendeeIndex(attendees, member.id, member.name)
  if (idx !== -1) {
    attendees.splice(idx, 1)
    await writeAttendees(env, eventId, attendees)
  }
  return json(env, { ok: true, attendees: resolveAttendees(attendees, await memberNamesById(env)) })
}

// Per-event read: canonical attend:{id} first, then aggregate overlay as a
// fallback for events that predate the per-event key being written. No repo
// fetch — if both are missing, the event simply has no attendees.
async function readAttendees(env, eventId) {
  const raw = await env.ATTENDANCE_KV.get(`attend:${eventId}`)
  if (raw) {
    try { return normalizeAttendees(JSON.parse(raw)) } catch { /* fall through */ }
  }
  const all = await readAttendanceAll(env)
  return normalizeAttendees(all[eventId])
}

// Aggregate read with one-shot bootstrap. Returns {} on total cold start if
// the repo baseline is unreachable; the next request retries the bootstrap.
async function readAttendanceAll(env) {
  const raw = await env.ATTENDANCE_KV.get('attendance:all')
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return normalizeAttendanceMap(parsed)
      }
    } catch { /* fall through to bootstrap */ }
  }
  return await bootstrapAttendance(env)
}

function normalizeAttendanceMap(map) {
  const out = {}
  for (const [eventId, list] of Object.entries(map)) out[eventId] = normalizeAttendees(list)
  return out
}

// Write-through: canonical per-event key + patch the aggregate overlay so the
// next bulk read reflects this change in a single KV GET.
async function writeAttendees(env, eventId, attendees) {
  const entries = normalizeAttendees(attendees)
  await env.ATTENDANCE_KV.put(`attend:${eventId}`, JSON.stringify(entries))
  // Other events' lists are written back byte-for-byte, legacy shape included:
  // the aggregate migrates lazily, one event per mutation, and any row that
  // never gets touched is still normalized on read.
  const allRaw = await env.ATTENDANCE_KV.get('attendance:all')
  const all = allRaw ? safeParseObject(allRaw) : await bootstrapAttendance(env)
  all[eventId] = entries
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
    return raw ? normalizeAttendanceMap(safeParseObject(raw)) : {}
  }
  const baseline = await fetchAttendanceBaseline(env)
  const list = await env.ATTENDANCE_KV.list({ prefix: 'attend:' })
  const existing = await Promise.all(
    list.keys.map(async k => [k.name.slice('attend:'.length), await env.ATTENDANCE_KV.get(k.name)]),
  )
  const merged = normalizeAttendanceMap(baseline)
  for (const [eventId, raw] of existing) {
    if (raw) {
      try { merged[eventId] = normalizeAttendees(JSON.parse(raw)) } catch { /* skip corrupt entry */ }
    }
  }
  await env.ATTENDANCE_KV.put('attendance:all', JSON.stringify(merged))
  await Promise.all(
    Object.entries(merged).map(([id, attendees]) =>
      env.ATTENDANCE_KV.put(`attend:${id}`, JSON.stringify(attendees)),
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
  await reconcileMembersAll(env, { ensure: projection })
}

async function removeFromMembersAll(env, id) {
  if (!id) return
  await reconcileMembersAll(env, { excludeId: id })
}

// KV has no transactions, so the old read-modify-write upsert could lose a
// concurrent signup: two /signup/verify calls inside the ~60s edge-propagation
// window each read an aggregate missing the other's append, and the later
// write clobbered the earlier one (dropped a real member on 2026-08-05).
// Every aggregate write now reconciles against the canonical member:{email}
// rows: union of the current aggregate and every canonical projection
// (canonical wins), plus the caller's own row via `ensure` (a just-put row
// may not be list-visible yet) and minus `excludeId` (a just-deleted one may
// still be). A concurrent clobber can still drop a row for a moment, but the
// next mutation — or the daily cron's bare reconcile — restores it from the
// canonical row, so drift is transient instead of permanent. Aggregate rows
// without a canonical KV row (data/members.json baseline members, e2e seeds)
// are preserved untouched.
async function reconcileMembersAll(env, { ensure = null, excludeId = null } = {}) {
  const allRaw = await env.MEMBERS_KV.get('members:all')
  const all = allRaw ? safeParseArray(allRaw) : await bootstrapMembers(env)
  const upsert = (proj) => {
    if (!proj || !proj.id) return
    const idx = all.findIndex(m => m.id === proj.id)
    if (idx === -1) all.push(proj)
    else all[idx] = proj
  }
  let cursor
  do {
    const page = await env.MEMBERS_KV.list({ prefix: 'member:', cursor })
    const rows = await Promise.all(page.keys.map(k => env.MEMBERS_KV.get(k.name)))
    for (const raw of rows) {
      if (!raw) continue
      try { upsert(publicMemberProjection(JSON.parse(raw))) } catch { /* skip corrupt row */ }
    }
    cursor = page.list_complete ? null : page.cursor
  } while (cursor)
  upsert(ensure)
  const out = excludeId ? all.filter(m => m.id !== excludeId) : all
  await env.MEMBERS_KV.put('members:all', JSON.stringify(out))
  return out
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

// A screening at somebody's home is not advertised to the open internet. There
// is no per-event toggle: kind === 'house' IS the signal, so it cannot be
// misconfigured, and a host cannot forget to tick a box. Theater meetups
// (kind: 'meetup') and the club's own screenings (no host) stay public.
//
// Legacy rows predate the kind field: a hosted event without one was always a
// house screening, which is the same reading events-view uses.
function isMembersOnly(event) {
  if (!event) return false
  return event.kind === 'house' || (!event.kind && !!event.hostId)
}

// GET /events — public, with OPTIONAL auth. A valid session sees every
// screening; anyone else sees only the public ones.
//
// This one filter is what keeps house screenings out of the public data files
// too: snapshot-events.yml curls this endpoint with no Authorization header,
// so what it commits to the public repo is exactly the anonymous view. That
// matters more than the live page — a repo commit is permanent.
//
// An invalid or expired token degrades to the anonymous view rather than
// 401ing, so a stale session still renders a working calendar.
async function handleEventsGet(request, env) {
  const all = await readEventsAll(env)
  const claims = await authorize(request, env)
  const visible = claims ? all : all.filter(e => !isMembersOnly(e))
  // Belt-and-suspenders: even though writers should already project, re-project
  // on the way out so a buggy writer can never leak `address` to a public read.
  // hostName is a snapshot of the host's name at create time; resolve it off
  // hostId so a rename lands here (and in the data/events.json snapshot the
  // cron takes off this endpoint) without rewriting every row.
  const names = await memberNamesById(env)
  return json(env, resolveHostNames(visible.map(publicEventProjection).filter(Boolean), names))
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
// diary entries, fetched live from Letterboxd RSS. Stale-while-error cache:
// the KV record `{ map, fetchedAt, missAt? }` persists with NO expiration,
// and freshness is checked in code — a stale record triggers a rebuild, but
// the last good data keeps serving through any Letterboxd outage, however
// long. A rebuild can only replace an entry it successfully refetched; a
// TOTAL miss just stamps missAt so retries back off. Per-feed fetches are
// also edge-cached. data/watched.json (6h cron) remains the SPA's offline
// fallback and the Hot Takes source.

const WATCHED_CACHE_TTL = 900 // seconds; freshness window (checked in code, not a KV TTL)
const WATCHED_MISS_TTL = 120  // total-miss backoff before retrying upstream

// What an unauthenticated caller gets per handle. The cache holds
// WATCHED_FEED_DEPTH (the RSS ceiling); this is the slice the public site
// needs — sections render 4 and the weekly strip only reaches back 7 days,
// so shipping the full depth to every visitor would multiply the payload for
// data no page renders. `?depth=full` (ADMIN_TOKEN) opts into the whole
// cached map for the admin's paged diary cards.
const WATCHED_PUBLIC_DEPTH = 12

// Slice each handle's films to `depth`. The map is already newest-first per
// handle (RSS order), so a head slice is the recent window.
function projectWatched(map, depth) {
  if (!Number.isFinite(depth)) return map || {}
  const out = {}
  for (const [handle, films] of Object.entries(map || {})) {
    out[handle] = (films || []).slice(0, depth)
  }
  return out
}

// Tolerates the pre-stale-while-error record shape (the bare map): it reads
// as stale-but-present and upgrades on the next successful rebuild.
function readWatchedRecord(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed.fetchedAt === undefined && parsed.missAt === undefined
      ? { map: parsed, fetchedAt: 0 }
      : parsed
  } catch { return null }
}

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

async function handleWatchedGet(request, env) {
  if (env.E2E_MODE === 'true') return watchedResponse(env, {})

  // Full depth is admin-only — not because the films are secret (they're
  // public on the site and on Letterboxd) but because it's a 4x payload that
  // only the admin's paged diary cards consume. The `env.ADMIN_TOKEN &&`
  // guard is load-bearing: without it an unset var would let a request with
  // no Authorization header through, as authorizeGuestManager notes.
  const wantsFull = new URL(request.url).searchParams.get('depth') === 'full'
  let depth = WATCHED_PUBLIC_DEPTH
  if (wantsFull) {
    const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
    if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
      return json(env, { error: 'unauthorized' }, 401)
    }
    depth = Infinity
  }

  const rec = readWatchedRecord(await env.MEMBERS_KV.get('watched:cache'))
  const now = Date.now()
  if (rec) {
    const fresh = now - (rec.fetchedAt || 0) < WATCHED_CACHE_TTL * 1000
    const backoff = rec.missAt && now - rec.missAt < WATCHED_MISS_TTL * 1000
    if (fresh || backoff) return watchedResponse(env, projectWatched(rec.map, depth))
  }
  if (!watchedInflight) {
    watchedInflight = buildWatched(env, rec).finally(() => { watchedInflight = null })
  }
  return watchedResponse(env, projectWatched(await watchedInflight, depth))
}

async function buildWatched(env, prevRec) {
  const members = await readMembersAll(env)
  const handles = members.map(m => m && m.handle).filter(Boolean).slice(0, 40)
  const prev = (prevRec && prevRec.map) || {}
  const out = {}
  let fetchedAny = false
  await Promise.all(handles.map(async handle => {
    try {
      const res = await fetch(`https://letterboxd.com/${encodeURIComponent(handle)}/rss/`, {
        headers: { 'User-Agent': 'jxnfilmclub-join' },
        cf: { cacheTtl: WATCHED_CACHE_TTL, cacheEverything: true },
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      fetchedAny = true
      const films = parseLetterboxdRss(await res.text())
      if (films.length) out[handle] = films
      // A 200 with an empty feed is genuinely empty — the entry drops.
    } catch {
      // Feed unreachable (outage / challenge): carry the last good entry.
      if (prev[handle]) out[handle] = prev[handle]
    }
  }))

  // `out` is built strictly from CURRENT membership handles, so unlinked or
  // deleted members never ride along on carried-forward data. Any successful
  // fetch counts as a fresh build; a TOTAL miss re-stores the carried map
  // with a missAt stamp so retries back off without ever discarding the last
  // good data. No KV expiration — the record must outlive any outage.
  const rec = (!handles.length || fetchedAny)
    ? { map: out, fetchedAt: Date.now() }
    : { map: out, fetchedAt: (prevRec && prevRec.fetchedAt) || 0, missAt: Date.now() }
  await env.MEMBERS_KV.put('watched:cache', JSON.stringify(rec))
  return rec.map
}

// Minimal RSS extraction matching scripts/refresh_letterboxd.py: recent
// non-list items -> { title, year?, link, watched_date?, rating?, liked?, rewatch?, poster? }.
//
// Depth is WATCHED_FEED_DEPTH, not 4: the /watched member sections show the
// last four, but the weekly club strip clusters over everything in its
// window — an active member can push a film out of their last four within a
// day (8 diary entries in a week is real data), which silently dropped their
// name from a shared-watch cluster.
//
// 50 is the ceiling Letterboxd's RSS actually serves: an active member's feed
// carries exactly 50 diary entries (100 items, half of them other activity),
// so this takes everything on offer and costs no extra request — we already
// download the whole feed. It is a ROLLING window, not an archive: at ~21
// films/month the busiest member's 50 span ~12 weeks, and anything older is
// gone from the feed for good. Letterboxd is the archive; we only mirror what
// it still serves. The public projection is WATCHED_PUBLIC_DEPTH.
const WATCHED_FEED_DEPTH = 50

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
    const rating = rssTag(item, 'letterboxd:memberRating')
    if (rating) film.rating = rating
    if (rssTag(item, 'letterboxd:memberLike') === 'Yes') film.liked = true
    if (rssTag(item, 'letterboxd:rewatch') === 'Yes') film.rewatch = true
    const poster = /<img\s[^>]*src="([^"]+)"/.exec(item)
    if (poster) film.poster = poster[1]
    films.push(film)
    if (films.length >= WATCHED_FEED_DEPTH) break
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

// --- Letterboxd avatars (films-subpage header via the Worker) ---
//
// GET /avatars — public. Handle-keyed map of each linked member's Letterboxd
// avatar URL, scraped from the /{handle}/films/ subpage's profile header
// (Letterboxd has no open API and RSS carries no avatar). The profile ROOT
// page sat behind a Cloudflare bot challenge as of Aug 2026 — unreachable to
// a Worker fetch — while the films subpage stayed open; its og:image is a
// generic share card, but the header <img> is the real avatar.
//
// Stale-while-error cache, same scheme as watched:cache: the KV record
// `{ sig, map, fetchedAt, missAt? }` persists with NO expiration, freshness
// (one week — avatars churn slowly) is checked in code, rebuilds carry the
// last good entry forward for any handle they fail to refetch, and a TOTAL
// miss stamps missAt so retries back off without discarding data. The
// membership signature still forces a rebuild the moment a handle links or
// unlinks. The SPA falls back to the letter <avatar> for any absent handle.

const AVATARS_CACHE_TTL = 86400 * 7 // seconds; freshness window (checked in code, not a KV TTL)
const AVATARS_MISS_TTL = 3600       // total-miss backoff (outage / challenge spread)

// Tolerates the pre-stale-while-error record shape ({ sig, map } with no
// fetchedAt): it reads as stale-but-present and upgrades on the next
// successful rebuild.
function readAvatarsRecord(raw) {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || typeof parsed.map !== 'object' || !parsed.map) return null
    if (parsed.fetchedAt === undefined) parsed.fetchedAt = 0
    return parsed
  } catch { return null }
}

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
  const rec = readAvatarsRecord(await env.MEMBERS_KV.get('avatars:cache'))
  const now = Date.now()
  if (rec) {
    const fresh = rec.sig === avatarsSig(members) && now - (rec.fetchedAt || 0) < AVATARS_CACHE_TTL * 1000
    const backoff = rec.missAt && now - rec.missAt < AVATARS_MISS_TTL * 1000
    if (fresh || backoff) return avatarsResponse(env, rec.map)
  }
  if (!avatarsInflight) {
    avatarsInflight = buildAvatars(env, members, rec).finally(() => { avatarsInflight = null })
  }
  return avatarsResponse(env, await avatarsInflight)
}

async function buildAvatars(env, members, prevRec) {
  const handles = members.map(m => m && m.handle).filter(Boolean).slice(0, 40)
  const prev = (prevRec && prevRec.map) || {}
  const out = {}
  let fetchedAny = false
  await Promise.all(handles.map(async handle => {
    try {
      const res = await fetch(`https://letterboxd.com/${encodeURIComponent(handle)}/films/`, {
        headers: { 'User-Agent': 'jxnfilmclub-join' },
        cf: { cacheTtl: 86400, cacheEverything: true },
      })
      if (!res.ok) throw new Error(`status ${res.status}`)
      fetchedAny = true
      const url = parseProfileAvatar(await res.text())
      if (url) out[handle] = url
      // A 200 without a custom upload: the member uses the Letterboxd
      // default — the entry drops and the letter avatar covers them.
    } catch {
      // Profile unreachable (outage / challenge): carry the last good URL.
      if (prev[handle]) out[handle] = prev[handle]
    }
  }))

  // Same contract as buildWatched: `out` is built strictly from CURRENT
  // membership handles, any successful fetch counts as a fresh build, and a
  // TOTAL miss re-stores the carried map with a missAt stamp. No KV
  // expiration — the record must outlive any outage.
  const rec = (!handles.length || fetchedAny)
    ? { sig: avatarsSig(members), map: out, fetchedAt: Date.now() }
    : { sig: avatarsSig(members), map: out, fetchedAt: (prevRec && prevRec.fetchedAt) || 0, missAt: Date.now() }
  await env.MEMBERS_KV.put('avatars:cache', JSON.stringify(rec))
  return rec.map
}

// First custom-upload avatar URL in the films subpage — that's the profile
// header portrait. Custom uploads live under /resized/avatar/upload/;
// members without one get a /static/img/ default that never matches this
// pattern, so the letter avatar covers them. The size segment of the URL is
// rewritable server-side — request 80px so the 2.2rem circle stays crisp on
// retina displays (the page itself ships 48px).
function parseProfileAvatar(html) {
  const m = /https:\/\/a\.ltrbxd\.com\/resized\/avatar\/upload\/[^"'\s]*avtr-[^"'\s]*/.exec(String(html))
  if (!m) return ''
  return m[0].replace(/avtr-0-[0-9]+-0-[0-9]+-crop/, 'avtr-0-80-0-80-crop')
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
// The confirmed list is mirrored write-through into `attend:{eventId}` as
// `{ id, name }` entries keyed on the same memberId, so a rename resolves
// there the same way it does everywhere else.

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

// Write the RSVP record AND mirror the attendees into attend:{id} as id-keyed
// entries, so public GET /events/:id/attendance sees the same people the RSVP
// list does. The host is an attendee — they're in the room, and the leaderboard /
// member attendance history read this mirror — but is deliberately NOT an
// rsvp.confirmed entry: capacity counts guest slots, so a synthetic host RSVP
// would eat one, mail the host their own address, and trip the "cannot reduce
// capacity below confirmed" guard.
//
// `event` is optional: pass it when the caller already has the row (saves a
// KV read), otherwise it's fetched.
async function writeRsvp(env, eventId, rsvp, event) {
  await env.ATTENDANCE_KV.put(`rsvp:${eventId}`, JSON.stringify(rsvp))
  const ev = event || await readEvent(env, eventId)
  const entries = rsvp.confirmed.map(r => attendEntry(r.memberId, r.name))
  if (ev && ev.hostId && !entries.some(e => e.id === ev.hostId)) {
    entries.unshift(attendEntry(ev.hostId, ev.hostName || ''))
  }
  await writeAttendees(env, eventId, entries)
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

function rsvpEmailBody(event, address, notes, cancelUrl, opts = {}) {
  const lines = [
    opts.intro || `You're confirmed for ${event.title} on ${fmtScreeningWhen(event)}.`,
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
  lines.push('', ...(opts.cancelLines || [
    "Can't make it? Use the one-click link below to cancel — it opens a spot",
    'for the next person on the waitlist:',
  ]), cancelUrl)
  return lines.join('\n')
}

async function sendRsvpEmail(env, member, event, origin) {
  if (!member.email) return // name-only guests have nothing to send to
  const token = await signRsvpCancelToken(env, event.id, member.id)
  const cancelUrl = `${origin}/rsvp/cancel?token=${encodeURIComponent(token)}`
  const subject = `You're in for ${event.title} on ${fmtScreeningWhen(event)}`
  await sendEmail(env, member.email, subject, rsvpEmailBody(event, event.address || '', event.notes || '', cancelUrl))
}

// Guest variant: same details, but the intro names who added them and the
// cancel link is framed as an opt-out — a guest never asked us to store
// their email, so the exit (and the retention promise) leads.
async function sendGuestRsvpEmail(env, guest, event, origin) {
  if (!guest.email) return
  const token = await signRsvpCancelToken(env, event.id, guest.memberId)
  const cancelUrl = `${origin}/rsvp/cancel?token=${encodeURIComponent(token)}`
  const subject = `You're in for ${event.title} on ${fmtScreeningWhen(event)}`
  const body = rsvpEmailBody(event, event.address || '', event.notes || '', cancelUrl, {
    intro: `${event.hostName || 'A club member'} added you to the guest list for ${event.title} on ${fmtScreeningWhen(event)}.`,
    cancelLines: [
      "Didn't expect this, or can't make it? One click removes you from the",
      'list — and we keep no other record of your email past 30 days after',
      'the screening:',
    ],
  })
  await sendEmail(env, guest.email, subject, body)
}

async function sendScreeningUpdateEmail(env, member, event, changes, origin) {
  if (!member.email) return // name-only guests have nothing to send to
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
  if (!member.email) return // name-only guests have nothing to send to
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

// Read one operator-editable config value from MEMBERS_KV (written by the
// admin portal's generic KV editor as `config:{key}`). Returns the parsed
// JSON value, or null when the key is missing or its content isn't valid
// JSON — config reads must never take a public endpoint to 500.
async function readConfig(env, key) {
  try {
    return await env.MEMBERS_KV.get('config:' + key, { type: 'json' })
  } catch {
    return null
  }
}

// Shape-validate a config:theaters value: a non-empty array of non-empty
// strings yields the trimmed list, anything else null. Shared by the
// validation path (theaterAllowlist) and the public /config projection so
// the SPA never renders entries the worker would reject.
function validTheaterList(value) {
  if (Array.isArray(value) && value.length && value.every(t => typeof t === 'string' && t.trim())) {
    return value.map(t => t.trim())
  }
  return null
}

// GET /config — public projection of the operator-editable config. Each field
// is the parsed KV value or null; theaters is additionally shape-validated
// (null unless it would actually be enforced). config:newsletter_template is
// admin-only and intentionally excluded.
async function handleConfigGet(env) {
  const [theaters, podcast, copy, voice_prompt] = await Promise.all([
    readConfig(env, 'theaters'),
    readConfig(env, 'podcast'),
    readConfig(env, 'copy'),
    readConfig(env, 'voice_prompt'),
  ])
  // voice_prompt is deliberately raw (parsed KV value or null): the SPA
  // applies the same default voicePrompt() falls back to.
  return json(env, { theaters: validTheaterList(theaters), podcast, copy, voice_prompt })
}

// Venue allowlist for theater meetups (kind: 'meetup'). Precedence: the KV
// key `config:theaters` (a JSON array of non-empty strings, edited via the
// admin portal) overrides when valid; the THEATERS literal below is the
// availability fallback when the key is missing, unparseable, empty, or
// contains non-string/blank entries. The frontend mirrors the same
// precedence via GET /config (ui/views.html events-new-view falls back to
// its own THEATERS copy) — keep both literals in lockstep. Venue suggestions
// arrive via the feedback form; admins add them by editing config:theaters.
const THEATERS = [
  'Patton House & Gallery',
  'The Capri Theater',
  'Legacy Parkway Theaters',
  'Cinemark XD in Pearl',
  'Malco Renaissance in Ridgeland',
  'Malco Grandview & IMAX in Madison',
  'B&B Theaters at Northpark in Ridgeland',
]

// Resolve the live meetup venue allowlist per the precedence above: KV
// config:theaters when it is a non-empty array of non-empty strings
// (entries trimmed), else the THEATERS literal.
async function theaterAllowlist(env) {
  return validTheaterList(await readConfig(env, 'theaters')) || THEATERS
}

function slugifyForId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

// Two hosted-event kinds:
//   'house'  — private address (required), required capacity + waitlist.
//   'meetup' — public theater from the THEATERS allowlist, optional capacity
//              (no cap → RSVPs always confirm), optional showtime; any
//              submitted address is ignored, never stored.
function validScreeningInput(body, theaters = THEATERS) {
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
    if (typeof body.venue !== 'string' || !theaters.includes(body.venue.trim())) {
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
  return tmdbSearchResponse(request, env)
}

// GET /admin/tmdb/search — bearer-auth with ADMIN_TOKEN (same gate as the
// other /admin routes). Backs the admin newsletter composer's poster picker;
// same proxy body as the member route so the TMDB key stays a Worker secret.
async function handleAdminTmdbSearch(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }
  return tmdbSearchResponse(request, env)
}

async function tmdbSearchResponse(request, env) {
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
  const v = validScreeningInput(body, await theaterAllowlist(env))
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
  await writeRsvp(env, event.id, { confirmed: [], waitlist: [] }, event)
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
  const v = validScreeningInput(merged, await theaterAllowlist(env))
  if (v.error) return json(env, { error: v.error }, 400)

  // Capacity-decrease guard (capacity is optional on meetups). Only when the
  // PATCH actually touches capacity — a force-added guest can leave confirmed
  // above capacity, and unrelated edits (title, diary link) must still work.
  const rsvp = await readRsvp(env, eventId)
  if (body.capacity !== undefined && v.value.capacity != null && v.value.capacity < rsvp.confirmed.length) {
    return json(env, { error: `cannot reduce capacity below the ${rsvp.confirmed.length} already-confirmed RSVPs` }, 400)
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

  // Diff the final row, not v.value: the delete-on-empty rules above run
  // after validation, and a diff computed pre-mutation can disagree with
  // what's stored (the pre-a95211b "time → (blank)" phantom email).
  const changes = []
  for (const field of ['date', 'time', 'address', 'venue']) {
    if ((event[field] || '') !== (updated[field] || '')) {
      changes.push({ field, from: event[field] || '', to: updated[field] || '' })
    }
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
    await writeRsvp(env, eventId, rsvpAfter, updated)
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
  // A screening that already happened can't be cancelled: deletion would
  // email cancellation notices for an event that's over. The post-event
  // scrub cron owns past-event teardown (and admins write KV directly).
  if (event.date && event.date < centralToday()) {
    return json(env, { error: 'this screening has already happened' }, 409)
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
  // The host already counts as an attendee (see writeRsvp/withHost). Letting
  // them RSVP would eat one of their own guest slots and mail them their own
  // address.
  if (event.hostId === member.id) {
    return json(env, { error: "you're hosting — you're already counted as attending" }, 409)
  }

  const rsvp = await readRsvp(env, eventId)
  if (rsvp.confirmed.some(r => r.memberId === member.id)) {
    return json(env, { ok: true, status: 'confirmed' })
  }
  if (rsvp.waitlist.some(r => r.memberId === member.id)) {
    const position = rsvp.waitlist.findIndex(r => r.memberId === member.id) + 1
    return json(env, { ok: true, status: 'waitlisted', position })
  }
  // One email, one spot: the host may already have added this person as a
  // guest (host-added entries carry a guest: id, so the memberId checks
  // above never catch them).
  const sameEmail = r => r.email && r.email.toLowerCase() === member.email.toLowerCase()
  if (rsvp.confirmed.some(sameEmail) || rsvp.waitlist.some(sameEmail)) {
    return json(env, { error: 'you are already on the guest list for this screening — use the link in your confirmation email to cancel' }, 409)
  }

  const entry = { memberId: member.id, name: member.name, email: member.email, at: Date.now() }
  // No capacity (uncapped meetup) → everyone confirms, nobody waitlists.
  const capacity = event.capacity == null ? Infinity : (Number(event.capacity) || 0)
  const origin = new URL(request.url).origin

  if (rsvp.confirmed.length < capacity) {
    rsvp.confirmed.push(entry)
    await writeRsvp(env, eventId, rsvp, event)
    try { await sendRsvpEmail(env, member, event, origin) }
    catch (e) { console.error('rsvp email failed:', e?.message || e) }
    return json(env, { ok: true, status: 'confirmed' })
  }
  rsvp.waitlist.push(entry)
  await writeRsvp(env, eventId, rsvp, event)
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
    // Promote the head of waitlist into the freed slot — but only if there
    // really is one: a force-confirmed guest can push confirmed past
    // capacity, and a cancel there must not promote into a still-full room.
    const capacity = event.capacity == null ? Infinity : (Number(event.capacity) || 0)
    let promoted = null
    if (rsvp.waitlist.length && rsvp.confirmed.length < capacity) {
      promoted = rsvp.waitlist.shift()
      rsvp.confirmed.push(promoted)
    }
    await writeRsvp(env, eventId, rsvp, event)
    if (promoted) {
      try { await sendRsvpEmail(env, { id: promoted.memberId, email: promoted.email, name: promoted.name }, event, origin) }
      catch (e) { console.error('promotion email failed:', e?.message || e) }
    }
    return { ok: true, status: 'cancelled', promoted: !!promoted }
  }
  const wIdx = rsvp.waitlist.findIndex(r => r.memberId === memberId)
  if (wIdx !== -1) {
    rsvp.waitlist.splice(wIdx, 1)
    await writeRsvp(env, eventId, rsvp, event)
    return { ok: true, status: 'cancelled', promoted: false }
  }
  return { ok: true, status: 'not-rsvped', promoted: false }
}

// --- Manual guest RSVPs (host or admin) ---
//
// Hosts can put non-members on their own guest list; the admin dashboard can
// do it for any hosted event (via the join worker, so capacity/waitlist/email
// logic and the attend:{id} mirror all hold — never a raw KV write). Guest
// entries carry a synthetic 'guest:xxxxxxxx' memberId so every
// findIndex-by-memberId path (cancel tokens, removal, /rsvp/me) works
// unchanged and can never collide with a real member id.

function isGuestId(id) {
  return typeof id === 'string' && id.startsWith('guest:')
}

// 'admin' | 'host' | { code, error }. Admin-token equality first (same gate
// as handleAdminScrub); the env.ADMIN_TOKEN && guard is load-bearing — with
// the var unset, an accept-phrased comparison would grant admin to anyone
// sending no Authorization header at all.
async function authorizeGuestManager(request, env, event) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (env.ADMIN_TOKEN && auth === env.ADMIN_TOKEN) return 'admin'
  const claims = await authorize(request, env)
  if (!claims) return { code: 401, error: 'unauthorized' }
  if (!event.hostId || event.hostId !== claims.id) {
    return { code: 403, error: 'only the host can manage the guest list' }
  }
  return 'host'
}

// POST /events/:id/rsvp/guest — body { name, email?, force? }
async function handleGuestAdd(request, env, eventId) {
  const event = await readEvent(env, eventId)
  if (!event) return json(env, { error: 'event not found' }, 404)
  if (!event.hostId) return json(env, { error: 'not a hosted screening' }, 409)
  if (event.date && event.date < centralToday()) {
    return json(env, { error: 'this screening has already happened' }, 409)
  }
  const who = await authorizeGuestManager(request, env, event)
  if (typeof who !== 'string') return json(env, { error: who.error }, who.code)

  const body = await request.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!isValidName(name)) return json(env, { error: 'guest name required' }, 400)
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  if (email && !isValidEmail(email)) return json(env, { error: 'invalid email' }, 400)

  const rsvp = await readRsvp(env, eventId)
  // Email dedupe across members and guests both lists; name-only guests are
  // never deduped — two guests named Sam can both come.
  if (email) {
    const sameEmail = r => r.email && r.email.toLowerCase() === email.toLowerCase()
    if (rsvp.confirmed.some(sameEmail) || rsvp.waitlist.some(sameEmail)) {
      return json(env, { error: 'that email already has an RSVP for this screening' }, 409)
    }
  }

  const entry = { memberId: `guest:${randomToken(8)}`, name, at: Date.now(), addedBy: who === 'admin' ? 'admin' : event.hostId }
  if (email) entry.email = email

  const capacity = event.capacity == null ? Infinity : (Number(event.capacity) || 0)
  if (rsvp.confirmed.length < capacity || body.force === true) {
    rsvp.confirmed.push(entry)
    await writeRsvp(env, eventId, rsvp, event)
    try { await sendGuestRsvpEmail(env, entry, event, new URL(request.url).origin) }
    catch (e) { console.error('guest rsvp email failed:', e?.message || e) }
    return json(env, { ok: true, status: 'confirmed', id: entry.memberId })
  }
  rsvp.waitlist.push(entry)
  await writeRsvp(env, eventId, rsvp, event)
  return json(env, { ok: true, status: 'waitlisted', position: rsvp.waitlist.length, id: entry.memberId })
}

// DELETE /events/:id/rsvp/guest — body { id }. Guests only: members keep
// their own agency (self-cancel button or email link); a host silently
// removing a member would leave that member confused with no notification.
async function handleGuestRemove(request, env, eventId) {
  const event = await readEvent(env, eventId)
  if (!event) return json(env, { error: 'event not found' }, 404)
  if (!event.hostId) return json(env, { error: 'not a hosted screening' }, 409)
  // Past screenings are read-only until the scrub deletes them: removal
  // routes through cancelRsvp, whose waitlist promotion would email someone
  // an address for a screening that already happened.
  if (event.date && event.date < centralToday()) {
    return json(env, { error: 'this screening has already happened' }, 409)
  }
  const who = await authorizeGuestManager(request, env, event)
  if (typeof who !== 'string') return json(env, { error: who.error }, who.code)

  const body = await request.json().catch(() => ({}))
  if (!isGuestId(body.id)) {
    return json(env, { error: 'only guest entries can be removed here' }, 400)
  }
  const r = await cancelRsvp(env, eventId, body.id, new URL(request.url).origin)
  if (!r.ok) return json(env, { error: r.error }, r.code || 500)
  return json(env, r)
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
// newsletter send). Manual trigger for the daily scheduled scrub; mirrors the
// cron by also reconciling members:all (ops repair for aggregate drift).
async function handleAdminScrub(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }
  const reconciled = await reconcileMembersAll(env)
  const scrub = await scrubPastEvents(env)
  return json(env, { ok: true, ...scrub, reconciledMembers: reconciled.length })
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
  // RSVP rows carry the guest's name as it was when they signed up; members
  // are resolved off memberId so the host sees current names. Guest entries
  // (no member row) keep the name the host typed.
  const names = await memberNamesById(env)
  const nameOf = r => (r.memberId && names.get(r.memberId)) || r.name
  return json(env, {
    kind: event.kind || 'house',
    capacity: event.capacity || null,
    address: event.address || null,
    venue: event.venue || null,
    time: event.time || null,
    notes: event.notes || null,
    confirmed: rsvp.confirmed.map(nameOf),
    waitlist:  rsvp.waitlist.map(nameOf),
    // Guest entries only, id + name — the id is what the remove button
    // sends back; member ids and emails stay unexposed.
    guests: [
      ...rsvp.confirmed.filter(r => isGuestId(r.memberId)).map(r => ({ id: r.memberId, name: r.name, list: 'confirmed' })),
      ...rsvp.waitlist.filter(r => isGuestId(r.memberId)).map(r => ({ id: r.memberId, name: r.name, list: 'waitlist' })),
    ],
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

// GET /__test/r2?key=… — E2E-only R2 read-back: the object's bytes with its
// stored content-type, or 404. The admin agent's local server proxies to
// this in e2e mode so Playwright can verify uploaded voice clips.
async function handleTestR2(request, env) {
  const key = new URL(request.url).searchParams.get('key')
  const obj = key ? await env.VOICE.get(key) : null
  if (!obj) return new Response('Not Found', { status: 404 })
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      ...cors(env),
    },
  })
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
      from: env.NEWSLETTER_FROM || 'Jackson Film Club <noreply@join.jxnfilm.club>',
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

// --- Newsletter web archive (shareable permalink) ---
//
// Every broadcast is also published at a stable URL, linked from the footer as
// "view this in your browser". That is the conventional escape hatch and it
// covers four things at once: forwarding a newsletter to someone who is not a
// member, Gmail clipping a long body, a client blocking images, and any mail
// app that mangles the table layout.
//
// What gets archived is the PRE-FOOTER body. buildNewsletterMessage signs a
// per-recipient unsubscribe token into each copy, so archiving a rendered
// message would publish one member's signed token on a public page — anyone
// opening the link could unsubscribe them. The archive holds only the shared
// body every recipient saw identically.

const ARCHIVE_ID = /^[a-z0-9][a-z0-9-]{0,80}$/

// Readable enough to recognise in a shared link, random enough not to be
// enumerable: anyone with the URL can read it, and nothing lists them.
function newsletterArchiveId(subject, iso) {
  const slug = String(subject || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    .replace(/-+$/, '')
  const rand = [...crypto.getRandomValues(new Uint8Array(5))]
    .map(b => b.toString(16).padStart(2, '0')).join('')
  return [iso.slice(0, 7), slug, rand].filter(Boolean).join('-')
}

async function putNewsletterArchive(env, id, record) {
  // No TTL: a permalink that expires is worse than one that never existed,
  // because it is already sitting in delivered mail.
  await env.MEMBERS_KV.put(`newsletter:archive:${id}`, JSON.stringify(record))
}

// GET /n/:id — PUBLIC. The shared copy of a sent newsletter.
async function handleNewsletterArchiveGet(env, id) {
  if (!ARCHIVE_ID.test(id || '')) return html(page(env, { title: 'Not found', body: NEWSLETTER_ARCHIVE_404 }), 404)
  const raw = await env.MEMBERS_KV.get(`newsletter:archive:${id}`)
  const rec = raw ? JSON.parse(raw) : null
  if (!rec) return html(page(env, { title: 'Not found', body: NEWSLETTER_ARCHIVE_404 }), 404)

  const body =
    `<main class="prose"><p class="hint">Jackson Film Club newsletter · ${escapeHtml(String(rec.at || '').slice(0, 10))}</p>` +
    `<h1>${escapeHtml(rec.subject || 'Newsletter')}</h1>` +
    `<div class="nl-archive">${rec.html || `<pre>${escapeHtml(rec.text || '')}</pre>`}</div>` +
    `<p class="hint"><a href="${siteOrigin(env)}/">← Jackson Film Club</a></p></main>`

  // The body is operator-authored HTML rendered on OUR origin, which is a step
  // up from rendering in a mail client's sandbox. A locked-down CSP means a
  // script that ever reached a newsletter cannot execute here: styles and
  // images still work, nothing else does.
  return new Response(page(env, { title: rec.subject || 'Newsletter', body }), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy':
        "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https:; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

const NEWSLETTER_ARCHIVE_404 =
  '<main class="prose"><h1>Newsletter not found</h1>' +
  '<p>That link may be mistyped, or the newsletter was never published.</p></main>'

// --- Newsletter flyer images (R2 bucket NEWS) ---
//
// Email clients send no cookies and no bearer token, and Gmail fetches through
// its own image proxy, so the read route below is necessarily PUBLIC. That is
// the whole reason this exists rather than reusing the Access-gated /api/img
// on the admin Worker.
//
// Retention is deliberately INDEFINITE, unlike voice clips. Apple Mail and
// Outlook re-fetch from origin on every open, so an expiring object silently
// breaks flyers in newsletters that were delivered months ago. These are club
// marketing assets, not personal data — the 60-day promise does not apply, and
// reusing jxnfilm-voice would inherit its bucket-wide expiry and do exactly
// that damage on a delay.

const NEWSLETTER_IMG_MAX_BYTES = 1.5 * 1024 * 1024
const NEWSLETTER_IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' }
// Content-addressed: 64 hex of SHA-256 plus an allowlisted extension. Nothing
// else can be spelled, so the route cannot be walked into another prefix.
const NEWSLETTER_IMG_KEY = /^([a-f0-9]{64})\.(jpg|png)$/

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')

// POST /admin/newsletter/image — bearer ADMIN_TOKEN.
// Body: { contentType, b64 }. JSON rather than raw bytes so the admin Worker's
// existing proxyJoinAdmin (which forwards `await request.text()` re-headed as
// application/json) carries it verbatim — no new proxy code.
async function handleNewsletterImageUpload(request, env) {
  const auth = request.headers.get('Authorization')?.replace(/^Bearer /, '')
  if (!env.ADMIN_TOKEN || auth !== env.ADMIN_TOKEN) {
    return json(env, { error: 'unauthorized' }, 401)
  }
  // Without this the missing binding throws into the top-level catch and reads
  // as "internal server error" — the same trap the VOICE comment in
  // wrangler.toml exists because of.
  if (!env.NEWS) {
    return json(env, { error: 'newsletter image storage is not configured for this environment' }, 503)
  }

  const { contentType, b64 } = await request.json().catch(() => ({}))
  const ext = NEWSLETTER_IMG_TYPES[String(contentType || '').toLowerCase()]
  if (!ext) return json(env, { error: 'unsupported image type — jpeg or png only' }, 415)

  const raw = String(b64 || '')
  if (!raw) return json(env, { error: 'empty image' }, 400)
  // Cheap reject on the encoded length before decoding: base64 is 4/3 of the
  // bytes it carries, so this bounds the allocation below.
  if (raw.length * 3 / 4 > NEWSLETTER_IMG_MAX_BYTES) {
    return json(env, { error: 'image too large (1.5MB max)' }, 413)
  }
  let bytes
  try {
    const bin = atob(raw)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch {
    return json(env, { error: 'image is not valid base64' }, 400)
  }
  // …and again on what actually decoded, since the length above is a claim.
  if (bytes.byteLength > NEWSLETTER_IMG_MAX_BYTES) {
    return json(env, { error: 'image too large (1.5MB max)' }, 413)
  }
  if (!bytes.byteLength) return json(env, { error: 'empty image' }, 400)

  // Content addressing makes re-inserting the same flyer idempotent, and means
  // an undone insert leaves an orphan that the next identical upload reuses
  // rather than duplicating.
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const name = `${hex(digest)}.${ext}`
  await env.NEWS.put(`newsletter/${name}`, bytes, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
  })
  return json(env, { url: `${new URL(request.url).origin}/nl/img/${name}`, key: name })
}

// GET|HEAD /nl/img/{sha256}.{jpg|png} — PUBLIC, no auth. This is what an email
// client fetches. HEAD is accepted because some clients and link scanners
// probe before fetching, and Workers does not derive it from GET.
async function handleNewsletterImageGet(request, env, name) {
  // Validate BEFORE touching R2: a malformed name must not become a bucket
  // read, and there is no listing endpoint.
  const m = NEWSLETTER_IMG_KEY.exec(name || '')
  if (!m) return new Response('not found', { status: 404 })
  if (!env.NEWS) return new Response('not configured', { status: 503 })

  // A Worker-constructed Response is not edge-cached by Cache-Control alone,
  // so without this every open by a non-Gmail client is a Worker invocation
  // and an R2 read. The route is public and unrate-limited; this is the only
  // thing bounding read volume.
  const cache = caches.default
  const hit = await cache.match(request)
  if (hit) return hit

  const obj = await env.NEWS.get(`newsletter/${name}`)
  if (!obj) return new Response('not found', { status: 404 })

  const headers = new Headers({
    // From the extension we validated, never from stored metadata a future
    // writer might get wrong.
    'Content-Type': m[2] === 'png' ? 'image/png' : 'image/jpeg',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': '*',
  })
  const res = new Response(request.method === 'HEAD' ? null : obj.body, { headers })
  if (request.method === 'GET') await cache.put(request, res.clone())
  return res
}

// Deliberately looser than the admin's own 92KB block: the operator should
// always hear the client's quality-framed message first, and this exists only
// to stop an unrecoverable failure reaching sendBatch.
const NEWSLETTER_HTML_MAX_BYTES = 128 * 1024
const NEWSLETTER_TEXT_MAX_BYTES = 64 * 1024

const utf8Len = (s) => new TextEncoder().encode(String(s || '')).length

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

  // These run BEFORE the testTo branch below, deliberately. A test send is the
  // one path that makes a broken body look fine — a data: URI renders
  // perfectly in a test to an Apple Mail address and is stripped by Gmail for
  // the actual list — so an unguarded test send is a false-confidence
  // generator. The admin mirrors these checks; this is the authority, and it
  // also catches a body arriving through any other caller.
  const htmlBytes = utf8Len(bodyHtml)
  if (htmlBytes > NEWSLETTER_HTML_MAX_BYTES) {
    return json(env, {
      error: `html body is ${Math.round(htmlBytes / 1024)}KB, over the ${Math.round(NEWSLETTER_HTML_MAX_BYTES / 1024)}KB limit. ` +
        'Gmail clips messages near 102KB and a body this size can exhaust the Worker while fanning out per recipient.',
    }, 413)
  }
  const textBytes = utf8Len(bodyText)
  if (textBytes > NEWSLETTER_TEXT_MAX_BYTES) {
    return json(env, { error: `text body is ${Math.round(textBytes / 1024)}KB, over the ${Math.round(NEWSLETTER_TEXT_MAX_BYTES / 1024)}KB limit.` }, 413)
  }
  if (/src\s*=\s*["']?\s*data:/i.test(String(bodyHtml || ''))) {
    return json(env, {
      error: 'html body contains an embedded data: image. Gmail strips those at render time, so most recipients would see nothing. Host the image and reference it by URL.',
    }, 400)
  }
  {
    // A staging image URL in a production send 404s for every recipient.
    const selfOrigin = new URL(request.url).origin
    const wrong = (String(bodyHtml || '').match(/https?:\/\/[^"'\s>]*\/nl\/img\/[^"'\s>]*/gi) || [])
      .find(u => !u.startsWith(selfOrigin + '/'))
    if (wrong) {
      return json(env, { error: `html body references an image on another environment (${wrong}).` }, 400)
    }
  }

  // Postal address is OPTIONAL: the footer prints it only when the var is
  // set. (Removed from the committed config 2026-08-11 — it was a home
  // address. Re-add NEWSLETTER_POSTAL_ADDRESS, e.g. a PO Box, to restore the
  // strict CAN-SPAM footer line.)
  const postal = env.NEWSLETTER_POSTAL_ADDRESS || ''
  const from = env.NEWSLETTER_FROM || 'Jackson Film Club <noreply@join.jxnfilm.club>'
  const origin = new URL(request.url).origin
  // Archived before any message is built, because the footer has to carry the
  // link. What is stored is bodyHtml/bodyText as composed — never a rendered
  // message, whose footer holds a per-recipient signed unsubscribe token.
  const at = new Date().toISOString()
  const archiveId = newsletterArchiveId(subject, at)
  const permalink = `${new URL(request.url).origin}/n/${archiveId}`
  await putNewsletterArchive(env, archiveId, {
    subject, html: bodyHtml || '', text: bodyText || '', at, test: !!testTo,
  })
  const opts = { from, subject, bodyHtml, bodyText, postal, origin, permalink }

  // Test send: one faithful preview to a single address (full unsubscribe link,
  // headers, and footer), bypassing the opt-in list. No audit row — a test
  // isn't a real broadcast.
  if (testTo) {
    if (!isValidEmail(testTo)) return json(env, { error: 'invalid testTo' }, 400)
    try {
      const sent = await sendBatch(env, [await buildNewsletterMessage(env, testTo, opts)])
      return json(env, { ok: true, sent, test: true, permalink })
    } catch (err) {
      // Without this, a `Resend batch 422: ...` throw funnels through the
      // top-level catch and reaches the operator as "internal server error",
      // with the real cause visible only in Workers Logs. The route is
      // admin-only, so forwarding upstream text leaks nothing.
      return json(env, { error: String((err && err.message) || err) }, 502)
    }
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

  let sent = 0
  try {
    sent = await sendBatch(env, messages)
  } catch (err) {
    // Same reasoning as the test-send branch: surface the real cause instead
    // of "internal server error". sendBatch attaches how many messages had
    // already gone out, so a partial broadcast is reported as partial —
    // retrying a send that already reached 100 inboxes would double-send them.
    return json(env, { error: String((err && err.message) || err), sent: err.sent || 0, partial: (err.sent || 0) > 0 }, 502)
  }
  // Audit trail: one row per real broadcast, surfaced in the admin dashboard's
  // newsletter history. Tiny and kept indefinitely (no TTL).
  if (sent > 0) {
    await env.MEMBERS_KV.put(
      `newsletter:sent:${at}`,
      JSON.stringify({ subject, count: sent, at: Date.now(), archiveId }),
    )
  }
  return json(env, { ok: true, sent, permalink })
}

// One Resend message for a single recipient: personalized unsubscribe link +
// List-Unsubscribe headers (RFC 8058) + CAN-SPAM footer. Shared by the real
// broadcast loop and the test send so they can't drift.
async function buildNewsletterMessage(env, email, { from, subject, bodyHtml, bodyText, postal, origin, permalink }) {
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
  if (bodyHtml) msg.html = appendFooterHtml(bodyHtml, unsubUrl, postal, permalink)
  if (bodyText) msg.text = appendFooterText(bodyText, unsubUrl, postal, permalink)
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
    if (!res.ok) {
      // Carry how many already went out. A mid-broadcast failure is not
      // all-or-nothing — chunk 1 of 3 may already be in 100 inboxes — and a
      // caller that reports 0 invites a retry that duplicates them.
      const err = new Error(`Resend batch ${res.status}: ${await res.text()}`)
      err.sent = sent
      throw err
    }
    sent += chunk.length
  }
  return sent
}

function appendFooterText(body, unsubUrl, postal, permalink) {
  const lines = [body, '', '—']
  if (permalink) lines.push(`Share this: ${permalink}`)
  lines.push(
    'You received this because you opted in to Jackson Film Club announcements.',
    `Unsubscribe: ${unsubUrl}`,
  )
  if (postal) lines.push(postal)
  return lines.join('\n')
}

function appendFooterHtml(body, unsubUrl, postal, permalink) {
  return `${body}<hr><p style="font-size:12px;color:#888">` +
    (permalink
      ? `Want to share this with someone? <a href="${permalink}">View it in your browser</a>.<br>`
      : '') +
    'You received this because you opted in to Jackson Film Club announcements.<br>' +
    `<a href="${unsubUrl}">Unsubscribe</a>` +
    (postal ? `<br>${escapeHtml(postal)}` : '') + '</p>'
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
