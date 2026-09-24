// Giveaways: reusable, event-scoped prize draws (docs/features/giveaways.md).
//
// Storage is D1 (env.GIVEAWAYS_DB, schema in worker/migrations/). Members,
// events, RSVPs and voice clips stay in KV and are read through the helpers
// index.js passes in as `h` — this module never imports index.js, so there is
// no cycle and every rule below can be unit-tested against a bare D1.
//
// Entry model. A member opts in once per giveaway (POST /giveaways/:id/enter,
// accepting the rules). From then on syncEntries() derives which sources they
// qualify for and INSERT OR IGNOREs one row per source; the unique indexes make
// repeat syncs harmless, so every hook (enter, RSVP, Letterboxd link, voice
// submit) just calls it. Referral is the exception: one row per credited
// referral, capped inside the INSERT itself (creditReferral).

export const SOURCES = ['waitlist_signup', 'letterboxd_link', 'voice_prompt', 'referral']
export const STATUSES = ['draft', 'open', 'closed', 'drawn']
const ID_RE = /^[a-z0-9][a-z0-9-]{2,79}$/
const MAX_WEIGHT = 100
const MAX_REFERRAL_CAP = 1000

// --- pure helpers ---------------------------------------------------------

export function nowIso(now = Date.now()) {
  return new Date(now).toISOString()
}

// { source: { weight, cap? } } -> validated copy, or throws with a message.
export function parseSources(raw) {
  const obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {})
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('sources must be an object')
  const out = {}
  for (const [source, cfg] of Object.entries(obj)) {
    if (!SOURCES.includes(source)) throw new Error(`unknown source: ${source}`)
    const weight = Number(cfg?.weight ?? 1)
    if (!Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) {
      throw new Error(`${source}.weight must be an integer 1-${MAX_WEIGHT}`)
    }
    out[source] = { weight }
    if (source === 'referral') {
      const cap = Number(cfg?.cap)
      if (!Number.isInteger(cap) || cap < 1 || cap > MAX_REFERRAL_CAP) {
        throw new Error(`referral.cap must be an integer 1-${MAX_REFERRAL_CAP}`)
      }
      out.referral.cap = cap
    }
  }
  return out
}

// Validate an admin create/update body. Returns { giveaway } or { error }.
export function validGiveaway(body, existing = null) {
  const b = { ...(existing || {}), ...(body || {}) }
  const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max
  if (!ID_RE.test(b.id || '')) return { error: 'id must be 3-80 chars of a-z, 0-9 and -' }
  if (!str(b.event_id, 120)) return { error: 'event_id is required' }
  if (!str(b.title, 140)) return { error: 'title is required (max 140)' }
  if (!str(b.prize, 500)) return { error: 'prize is required (max 500)' }
  const winners = Number(b.winners)
  if (!Number.isInteger(winners) || winners < 1 || winners > 100) return { error: 'winners must be 1-100' }
  const tickets = Number(b.tickets_per_winner ?? 2)
  if (!Number.isInteger(tickets) || tickets < 1 || tickets > 20) return { error: 'tickets_per_winner must be 1-20' }
  const starts = Date.parse(b.starts_at), ends = Date.parse(b.ends_at)
  if (!Number.isFinite(starts) || !Number.isFinite(ends)) return { error: 'starts_at and ends_at must be ISO datetimes' }
  if (ends <= starts) return { error: 'ends_at must be after starts_at' }
  if (!STATUSES.includes(b.status || 'draft')) return { error: `status must be one of ${STATUSES.join(', ')}` }
  if (typeof (b.rules_md ?? '') !== 'string' || (b.rules_md || '').length > 20000) return { error: 'rules_md too long' }
  let sources
  try { sources = parseSources(b.sources) } catch (e) { return { error: e.message } }
  if (!Object.keys(sources).length) return { error: 'enable at least one entry source' }
  if (sources.voice_prompt && !str(b.voice_prompt_id, 80)) return { error: 'voice_prompt source needs voice_prompt_id' }
  const posInt = (v, d, max) => {
    const n = Number(v ?? d)
    return Number.isInteger(n) && n >= 1 && n <= max ? n : null
  }
  const voiceSeconds = posInt(b.voice_max_seconds, 180, 600)
  const voiceBytes = posInt(b.voice_max_bytes, 8 * 1024 * 1024, 8 * 1024 * 1024)
  const responseDays = posInt(b.winner_response_days, 3, 30)
  if (voiceSeconds == null) return { error: 'voice_max_seconds must be 1-600' }
  if (voiceBytes == null) return { error: 'voice_max_bytes must be 1-8388608 (the /voice upload cap)' }
  if (responseDays == null) return { error: 'winner_response_days must be 1-30' }
  return {
    giveaway: {
      id: b.id,
      event_id: b.event_id.trim(),
      title: b.title.trim(),
      prize: b.prize.trim(),
      winners,
      tickets_per_winner: tickets,
      starts_at: new Date(starts).toISOString(),
      ends_at: new Date(ends).toISOString(),
      rules_md: b.rules_md || '',
      status: b.status || 'draft',
      sources,
      count_prior_waitlist: b.count_prior_waitlist === true || b.count_prior_waitlist === 1 ? 1 : 0,
      voice_prompt_id: sources.voice_prompt ? b.voice_prompt_id.trim() : null,
      voice_max_seconds: voiceSeconds,
      voice_max_bytes: voiceBytes,
      winner_response_days: responseDays,
    },
  }
}

// Entries are accepted only while status is open AND the clock is inside the
// window — an admin forgetting to flip status to closed must not keep a
// giveaway taking entries past its advertised end.
export function isAcceptingEntries(g, now = Date.now()) {
  return !!g && g.status === 'open' &&
    now >= Date.parse(g.starts_at) && now < Date.parse(g.ends_at)
}

// Canonical form for "is this the same person?" checks on referrals: case,
// +tags and (for Gmail) dots are how one inbox becomes many addresses.
export function normalizeEmail(email) {
  if (typeof email !== 'string') return ''
  const at = email.trim().toLowerCase().lastIndexOf('@')
  if (at < 1) return email.trim().toLowerCase()
  let local = email.trim().toLowerCase().slice(0, at)
  let domain = email.trim().toLowerCase().slice(at + 1)
  if (domain === 'googlemail.com') domain = 'gmail.com'
  local = local.split('+')[0]
  if (domain === 'gmail.com') local = local.replaceAll('.', '')
  return `${local}@${domain}`
}

// Accepts a bare username, @username, or any letterboxd.com profile URL
// (with or without scheme, www, trailing path). Returns the username or null.
// Film/list URLs are not profiles: letterboxd.com/film/... is rejected.
const LB_RESERVED = new Set(['film', 'films', 'list', 'lists', 'members', 'journal', 'search',
  'pro', 'about', 'settings', 'activity', 'tag', 'director', 'actor', 'studio', 'crew', 'year', 'decade'])
export function parseLetterboxdHandle(input) {
  if (typeof input !== 'string') return null
  let s = input.trim()
  if (!s) return null
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?letterboxd\.com\/([^/?#]+)(?:[/?#].*)?$/i)
  if (url) s = url[1]
  else if (/[/.:]/.test(s)) return null
  s = s.replace(/^@/, '')
  if (!/^[a-zA-Z0-9_-]{1,30}$/.test(s)) return null
  if (LB_RESERVED.has(s.toLowerCase())) return null
  return s
}

// Does a public Letterboxd profile exist? No API: the /films/ subpage, which
// (unlike the profile root, bot-challenged since Aug 2026) answers plainly.
// 'yes' | 'no' | 'unknown' — unknown (challenge, 5xx, network) must never be
// treated as 'no'; callers accept and flag instead.
export async function letterboxdProfileExists(handle, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`https://letterboxd.com/${encodeURIComponent(handle)}/films/`, {
      method: 'GET', redirect: 'follow',
      headers: { 'User-Agent': 'jxnfilmclub-join (+https://jxnfilm.club)' },
      // This runs inline on RSVP and profile-update requests: a slow
      // letterboxd.com must not hang them. A timeout reads as 'unknown'.
      signal: AbortSignal.timeout(5000),
    })
    if (res.status === 200) return 'yes'
    if (res.status === 404) return 'no'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// Uniform integer in [0, n) from the CSPRNG, by rejection sampling: taking
// `x % n` directly over-weights small values whenever 2^32 is not a multiple
// of n. `rand` is injectable for tests; it must return a Uint32.
export function secureRandomInt(n, rand = randomUint32) {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new Error('secureRandomInt: bad range')
  const limit = Math.floor(2 ** 32 / n) * n
  for (;;) {
    const x = rand()
    if (x < limit) return x % n
  }
}

function randomUint32() {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

// Weighted draw WITHOUT replacement over members. pool: [{ member_id, weight }]
// with integer weights. Each pick chooses a ticket uniformly from the
// remaining total weight, so a member with 3 entries is 3x as likely as one
// with 1. Returns winners in draw order plus the integers used, for the log.
export function weightedDraw(pool, count, rand = randomUint32) {
  const remaining = pool.map(p => ({ member_id: p.member_id, weight: Number(p.weight) }))
  const winners = [], values = []
  while (winners.length < count && remaining.length) {
    const total = remaining.reduce((s, p) => s + p.weight, 0)
    const ticket = secureRandomInt(total, rand)
    values.push(ticket)
    let acc = 0
    const idx = remaining.findIndex(p => (acc += p.weight) > ticket)
    winners.push(remaining[idx].member_id)
    remaining.splice(idx, 1)
  }
  return { winners, values }
}

// Order-independent fingerprint of the draw pool, logged with each draw so
// anyone can later check which pool a result came from.
export async function poolHash(pool) {
  const canon = pool.map(p => `${p.member_id}:${p.weight}`).sort().join('\n')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function csvCell(v) {
  const s = v == null ? '' : String(v)
  // Leading =,+,-,@ would run as a formula when the box office opens it.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

export function toCsv(header, rows) {
  return [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

// --- D1 access ------------------------------------------------------------

function rowToGiveaway(r) {
  if (!r) return null
  return { ...r, sources: parseSourcesSafe(r.sources) }
}

function parseSourcesSafe(s) {
  try { return parseSources(s) } catch { return {} }
}

export async function getGiveaway(db, id) {
  return rowToGiveaway(await db.prepare('SELECT * FROM giveaways WHERE id = ?').bind(id).first())
}

export async function listGiveaways(db, { eventId = null, includeDraft = false } = {}) {
  const where = [], args = []
  if (eventId) { where.push('event_id = ?'); args.push(eventId) }
  if (!includeDraft) where.push("status != 'draft'")
  const sql = `SELECT * FROM giveaways${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY starts_at, id`
  const { results } = await db.prepare(sql).bind(...args).all()
  return results.map(rowToGiveaway)
}

export async function saveGiveaway(db, g, now = Date.now()) {
  const ts = nowIso(now)
  await db.prepare(`
    INSERT INTO giveaways (id, event_id, title, prize, winners, tickets_per_winner, starts_at, ends_at,
      rules_md, status, sources, count_prior_waitlist, voice_prompt_id, voice_max_seconds,
      voice_max_bytes, winner_response_days, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
    ON CONFLICT (id) DO UPDATE SET
      event_id = ?2, title = ?3, prize = ?4, winners = ?5, tickets_per_winner = ?6,
      starts_at = ?7, ends_at = ?8, rules_md = ?9, status = ?10, sources = ?11,
      count_prior_waitlist = ?12, voice_prompt_id = ?13, voice_max_seconds = ?14,
      voice_max_bytes = ?15, winner_response_days = ?16, updated_at = ?17`)
    .bind(g.id, g.event_id, g.title, g.prize, g.winners, g.tickets_per_winner, g.starts_at, g.ends_at,
      g.rules_md, g.status, JSON.stringify(g.sources), g.count_prior_waitlist, g.voice_prompt_id,
      g.voice_max_seconds, g.voice_max_bytes, g.winner_response_days, ts)
    .run()
  return getGiveaway(db, g.id)
}

export async function getParticipant(db, giveawayId, memberId) {
  return db.prepare('SELECT * FROM participants WHERE giveaway_id = ? AND member_id = ?')
    .bind(giveawayId, memberId).first()
}

export async function addParticipant(db, giveawayId, member, commsConsent, now = Date.now()) {
  const ts = nowIso(now)
  // Re-entering refreshes name/email/consent; rules_accepted_at keeps the first
  // acceptance, which is the one the entries were earned under.
  await db.prepare(`
    INSERT INTO participants (giveaway_id, member_id, name, email, comms_consent, rules_accepted_at, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
    ON CONFLICT (giveaway_id, member_id) DO UPDATE SET name = ?3, email = ?4, comms_consent = ?5`)
    .bind(giveawayId, member.id, member.name || '', member.email, commsConsent ? 1 : 0, ts)
    .run()
}

// One row per (giveaway, member, source); a no-op if it already exists.
export async function insertEntry(db, g, memberId, source, { detail = null, flagged = false, flagReason = null, now = Date.now() } = {}) {
  const cfg = g.sources[source]
  if (!cfg || source === 'referral') return false
  const res = await db.prepare(`
    INSERT OR IGNORE INTO entries (giveaway_id, member_id, source, weight, detail, flagged, flag_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(g.id, memberId, source, cfg.weight, detail, flagged ? 1 : 0, flagReason, nowIso(now))
    .run()
  return res.meta.changes > 0
}

// Derive and record every non-referral source this member qualifies for.
// Idempotent and cheap; call it from any hook. `h` supplies KV reads:
//   h.readRsvp(eventId) -> { confirmed, waitlist }
//   h.letterboxdCheck(handle) -> 'yes' | 'no' | 'unknown'
//   h.readVoice(promptId, memberId) -> voice row | null
export async function syncEntries(db, h, g, member, now = Date.now()) {
  if (!isAcceptingEntries(g, now)) return []
  if (!(await getParticipant(db, g.id, member.id))) return []
  const added = []

  if (g.sources.waitlist_signup) {
    const rsvp = await h.readRsvp(g.event_id)
    const mine = [...rsvp.confirmed, ...rsvp.waitlist].find(r => r.memberId === member.id)
    const inWindow = mine && (g.count_prior_waitlist || Number(mine.at) >= Date.parse(g.starts_at))
    if (inWindow && await insertEntry(db, g, member.id, 'waitlist_signup', { now })) added.push('waitlist_signup')
  }

  if (g.sources.letterboxd_link && member.handle) {
    const exists = await h.letterboxdCheck(member.handle)
    if (exists !== 'no') {
      const flagged = exists !== 'yes'
      const ok = await insertEntry(db, g, member.id, 'letterboxd_link', {
        detail: member.handle, flagged,
        flagReason: flagged ? 'letterboxd profile could not be verified (challenge or outage)' : null, now,
      })
      if (ok) added.push('letterboxd_link')
    }
  }

  if (g.sources.voice_prompt && g.voice_prompt_id && h.readVoice) {
    const clip = await h.readVoice(g.voice_prompt_id, member.id)
    if (clip && clip.r2Key) {
      // Size is enforced at upload; length is only a browser claim until node0
      // measures it (clip.measuredSeconds). Over either limit -> flag, not drop.
      const secs = Number(clip.measuredSeconds ?? clip.duration)
      const reasons = []
      if (Number(clip.size) > g.voice_max_bytes) reasons.push(`file ${clip.size} B > ${g.voice_max_bytes} B`)
      if (Number.isFinite(secs) && secs > g.voice_max_seconds) reasons.push(`length ${Math.round(secs)} s > ${g.voice_max_seconds} s`)
      if (clip.measuredSeconds == null) reasons.push('length not yet measured')
      const hardFail = reasons.some(r => !r.startsWith('length not yet'))
      const ok = await insertEntry(db, g, member.id, 'voice_prompt', {
        detail: `voice:${g.voice_prompt_id}:${member.id}`,
        flagged: reasons.length > 0,
        flagReason: reasons.length ? reasons.join('; ') : null, now,
      })
      if (ok) added.push('voice_prompt')
      // A later measurement can clear or confirm the flag on an existing row.
      else if (clip.measuredSeconds != null) {
        await db.prepare(`UPDATE entries SET flagged = ?, flag_reason = ?
          WHERE giveaway_id = ? AND member_id = ? AND source = 'voice_prompt'`)
          .bind(hardFail ? 1 : 0, hardFail ? reasons.join('; ') : null, g.id, member.id).run()
      }
    }
  }
  return added
}

export async function memberSummary(db, g, memberId) {
  const participant = await getParticipant(db, g.id, memberId)
  const { results } = await db.prepare(`
    SELECT source, COUNT(*) AS n, SUM(weight) AS w FROM entries
    WHERE giveaway_id = ? AND member_id = ? AND excluded = 0 GROUP BY source`)
    .bind(g.id, memberId).all()
  const bySource = {}
  let total = 0
  for (const r of results) { bySource[r.source] = { count: r.n, entries: r.w }; total += r.w }
  return { entered: !!participant, commsConsent: !!participant?.comms_consent, bySource, total }
}

// Admin view: every entry with participant name, plus totals by source.
export async function adminEntries(db, giveawayId) {
  const { results: entries } = await db.prepare(`
    SELECT e.*, p.name, p.email FROM entries e
    LEFT JOIN participants p ON p.giveaway_id = e.giveaway_id AND p.member_id = e.member_id
    WHERE e.giveaway_id = ? ORDER BY e.created_at, e.id`).bind(giveawayId).all()
  const { results: counts } = await db.prepare(`
    SELECT source, COUNT(*) AS rows, SUM(weight) AS entries,
      SUM(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged,
      SUM(CASE WHEN excluded = 1 THEN 1 ELSE 0 END) AS excluded
    FROM entries WHERE giveaway_id = ? GROUP BY source`).bind(giveawayId).all()
  const participants = await db.prepare('SELECT COUNT(*) AS n FROM participants WHERE giveaway_id = ?')
    .bind(giveawayId).first()
  return { entries, bySource: counts, participants: participants.n }
}

export async function setEntryExcluded(db, giveawayId, entryId, excluded) {
  const res = await db.prepare('UPDATE entries SET excluded = ? WHERE giveaway_id = ? AND id = ?')
    .bind(excluded ? 1 : 0, giveawayId, entryId).run()
  return res.meta.changes > 0
}

// The draw pool: summed weight per member, skipping excluded entries, flagged
// ones when asked, and anyone already selected or forfeited in this giveaway.
export async function drawPool(db, giveawayId, { excludeFlagged }) {
  const { results } = await db.prepare(`
    SELECT e.member_id, SUM(e.weight) AS weight FROM entries e
    JOIN participants p ON p.giveaway_id = e.giveaway_id AND p.member_id = e.member_id
    WHERE e.giveaway_id = ?1 AND e.excluded = 0 ${excludeFlagged ? 'AND e.flagged = 0' : ''}
      AND e.member_id NOT IN (SELECT member_id FROM winners WHERE giveaway_id = ?1)
    GROUP BY e.member_id ORDER BY e.member_id`).bind(giveawayId).all()
  return results.map(r => ({ member_id: r.member_id, weight: Number(r.weight) }))
}

// Initial draw. Only from 'closed' (entries frozen), and the status flip, the
// log row and the winner rows land in one batch — D1 runs a batch as a single
// transaction, so a concurrent second draw fails on the winners primary key
// instead of producing two sets of winners.
export async function runDraw(db, g, { runBy, excludeFlagged = true, rand, now = Date.now() }) {
  if (g.status !== 'closed') return { error: `draw needs status "closed" (is "${g.status}")`, code: 409 }
  if (now < Date.parse(g.ends_at)) return { error: 'the giveaway has not ended yet', code: 409 }
  const pool = await drawPool(db, g.id, { excludeFlagged })
  if (!pool.length) return { error: 'no eligible entries to draw from', code: 409 }
  const { winners, values } = weightedDraw(pool, g.winners, rand)
  return commitDraw(db, g, { kind: 'draw', runBy, excludeFlagged, pool, winners, values, now })
}

// Replace one winner who did not respond: forfeit them, draw one more from
// everyone not yet selected or forfeited.
export async function runRedraw(db, g, forfeitMemberId, { runBy, excludeFlagged = true, rand, now = Date.now() }) {
  if (g.status !== 'drawn') return { error: 'redraw needs a completed draw', code: 409 }
  const current = await db.prepare(`SELECT * FROM winners WHERE giveaway_id = ? AND member_id = ? AND status = 'selected'`)
    .bind(g.id, forfeitMemberId).first()
  if (!current) return { error: 'that member is not a current winner', code: 404 }
  const pool = await drawPool(db, g.id, { excludeFlagged })
  const { winners, values } = weightedDraw(pool, 1, rand)
  // An empty pool still forfeits: the non-responder loses the prize either
  // way, and the log records that nobody was left to replace them.
  return commitDraw(db, g, { kind: 'redraw', runBy, excludeFlagged, pool, winners, values, now,
    replaces: forfeitMemberId })
}

// Commit a draw or redraw as ONE D1 batch (a transaction). The precondition
// (still closed / the forfeited winner still selected) is re-checked INSIDE
// the transaction by every statement: each winner INSERT only fires if it
// holds, and the state change runs last. D1 serializes batches, so when two
// runs race, the second one sees the first one's committed state and inserts
// nothing. Checking a status UPDATE's row count after the fact would be too
// late: the INSERTs before it would already have committed.
async function commitDraw(db, g, { kind, runBy, excludeFlagged, pool, winners, values, now, replaces = null }) {
  const ts = nowIso(now)
  const hash = await poolHash(pool)
  const total = pool.reduce((s, p) => s + p.weight, 0)
  const log = await db.prepare(`
    INSERT INTO draws (giveaway_id, kind, run_by, run_at, exclude_flagged, pool_members, pool_entries,
      snapshot_sha256, random_values, winners, replaces_member)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(g.id, kind, runBy, ts, excludeFlagged ? 1 : 0, pool.length, total, hash,
      JSON.stringify(values), JSON.stringify(winners), replaces)
    .first()

  const precondition = kind === 'draw'
    ? { sql: "EXISTS (SELECT 1 FROM giveaways WHERE id = ?6 AND status = 'closed')", args: [g.id] }
    : { sql: "EXISTS (SELECT 1 FROM winners WHERE giveaway_id = ?6 AND member_id = ?7 AND status = 'selected')", args: [g.id, replaces] }
  const stmts = winners.map(memberId => db.prepare(`
    INSERT INTO winners (giveaway_id, member_id, draw_id, status, tickets, selected_at)
    SELECT ?1, ?2, ?3, 'selected', ?4, ?5 WHERE ${precondition.sql}`)
    .bind(g.id, memberId, log.id, g.tickets_per_winner, ts, ...precondition.args))
  stmts.push(kind === 'draw'
    ? db.prepare("UPDATE giveaways SET status = 'drawn', updated_at = ? WHERE id = ? AND status = 'closed'").bind(ts, g.id)
    : db.prepare("UPDATE winners SET status = 'forfeited' WHERE giveaway_id = ? AND member_id = ? AND status = 'selected'").bind(g.id, replaces))

  let committed = false
  try {
    const results = await db.batch(stmts)
    // The last statement is the state change: exactly one row means this run
    // held the precondition, so its inserts (gated on the same thing) landed.
    committed = results[results.length - 1].meta.changes === 1
  } catch {
    committed = false   // e.g. a replacement who became a winner concurrently (primary key)
  }
  if (!committed) {
    // Keep the attempt in the audit trail, marked as not committed.
    await db.prepare('UPDATE draws SET winners = ?, random_values = ? WHERE id = ?')
      .bind('[]', JSON.stringify({ aborted: 'another draw committed first', values }), log.id).run()
    return { error: 'draw did not commit (another draw got there first)', code: 409 }
  }
  return { drawId: log.id, winners, poolMembers: pool.length, poolEntries: total, snapshot: hash }
}

export async function listWinners(db, giveawayId) {
  const { results } = await db.prepare(`
    SELECT w.*, p.name, p.email FROM winners w
    LEFT JOIN participants p ON p.giveaway_id = w.giveaway_id AND p.member_id = w.member_id
    WHERE w.giveaway_id = ? ORDER BY w.selected_at, w.draw_id`).bind(giveawayId).all()
  return results
}

export async function listDraws(db, giveawayId) {
  const { results } = await db.prepare('SELECT * FROM draws WHERE giveaway_id = ? ORDER BY id')
    .bind(giveawayId).all()
  return results
}

// Account deletion: remove this member's giveaway data outright. Draw logs
// keep the opaque member id in their JSON (no name/email), so the audit trail
// still adds up.
export async function purgeMember(db, memberId) {
  await db.batch([
    db.prepare('DELETE FROM entries WHERE member_id = ?').bind(memberId),
    db.prepare('DELETE FROM participants WHERE member_id = ?').bind(memberId),
    db.prepare('DELETE FROM referral_codes WHERE member_id = ?').bind(memberId),
    db.prepare("UPDATE referrals SET referee_member_id = NULL, referee_email_norm = 'deleted:' || id WHERE referee_member_id = ?").bind(memberId),
    db.prepare("UPDATE winners SET status = 'forfeited' WHERE member_id = ? AND status = 'selected'").bind(memberId),
  ])
}

// Retention: 60 days after a giveaway ends (room for redraws and prize
// handoff), its personal data goes. The giveaway row, draw log and winner rows
// stay — they hold opaque member ids only.
export const RETENTION_DAYS = 60
export async function scrubGiveaways(db, now = Date.now()) {
  const cutoff = nowIso(now - RETENTION_DAYS * 86400 * 1000)
  const { results } = await db.prepare('SELECT id FROM giveaways WHERE ends_at < ?').bind(cutoff).all()
  for (const { id } of results) {
    await db.batch([
      db.prepare('DELETE FROM entries WHERE giveaway_id = ?').bind(id),
      db.prepare('DELETE FROM participants WHERE giveaway_id = ?').bind(id),
      db.prepare('DELETE FROM referrals WHERE giveaway_id = ?').bind(id),
    ])
  }
  return results.length
}

// --- referrals ------------------------------------------------------------
//
// One stable code per member (referral_codes), carried as ?ref= from the
// member's link through the signup page into the pending signup row, and
// credited only in /signup/verify — i.e. only for a new, verified email.
// Credit goes to every open giveaway that counts referrals and that the
// referrer has entered.
//
// Suspicious patterns are FLAGGED (entry kept, excluded from the draw by
// default, visible to the admin), never silently dropped. Hard rejects are
// reserved for rule breaks: self-referral and an address that is an alias of
// an existing member.

export const REF_CODE_RE = /^[a-z0-9]{8}$/
const REF_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'   // no 0/o/1/l/i: codes get read aloud
export const REF_RATE_PER_HOUR = 5        // referrer credits per hour before flagging
export const REF_IP_THRESHOLD = 3         // referrals from one network (24h) before flagging

// Heuristic, not exhaustive: the common throwaway inbox providers.
export const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', '10minutemail.net', '20minutemail.com', '33mail.com', 'anonaddy.me',
  'burnermail.io', 'byom.de', 'discard.email', 'dispostable.com', 'emailondeck.com',
  'fakeinbox.com', 'fakemail.net', 'getairmail.com', 'getnada.com', 'guerrillamail.biz',
  'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.info', 'guerrillamail.net',
  'guerrillamail.org', 'guerrillamailblock.com', 'harakirimail.com', 'inboxbear.com',
  'incognitomail.org', 'mail.tm', 'mail-temp.com', 'mailcatch.com', 'maildrop.cc',
  'mailinator.com', 'mailinator.net', 'mailnesia.com', 'mailpoof.com', 'mailsac.com',
  'mintemail.com', 'moakt.com', 'mohmal.com', 'mytemp.email', 'nada.email', 'sharklasers.com',
  'spam4.me', 'spamgourmet.com', 'temp-mail.io', 'temp-mail.org', 'tempail.com',
  'tempmail.dev', 'tempmail.net', 'tempmailo.com', 'tempr.email', 'throwawaymail.com',
  'trashmail.com', 'trashmail.de', 'trashmail.net', 'yopmail.com', 'yopmail.fr', 'yopmail.net',
])

export function isDisposableEmail(email) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1] || ''
  return DISPOSABLE_DOMAINS.has(domain)
}

function randomRefCode(rand) {
  let out = ''
  for (let i = 0; i < 8; i++) out += REF_ALPHABET[secureRandomInt(REF_ALPHABET.length, rand)]
  return out
}

export async function getOrCreateReferralCode(db, memberId, now = Date.now()) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db.prepare('SELECT code FROM referral_codes WHERE member_id = ?').bind(memberId).first()
    if (existing) return existing.code
    // INSERT OR IGNORE covers both races: a concurrent call for the same
    // member (member_id UNIQUE) and a code collision (code PRIMARY KEY).
    await db.prepare('INSERT OR IGNORE INTO referral_codes (code, member_id, created_at) VALUES (?, ?, ?)')
      .bind(randomRefCode(), memberId, nowIso(now)).run()
  }
  const row = await db.prepare('SELECT code FROM referral_codes WHERE member_id = ?').bind(memberId).first()
  if (!row) throw new Error('could not mint a referral code')
  return row.code
}

export async function referralStats(db, g, memberId) {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM entries
    WHERE giveaway_id = ? AND member_id = ? AND source = 'referral' AND excluded = 0`)
    .bind(g.id, memberId).first()
  return { credited: row.n, cap: g.sources.referral ? g.sources.referral.cap : 0 }
}

// Credit a verified signup that arrived with ?ref=CODE. `referee` is the new
// member; `aliasOfExisting` is whether their normalized email matches another
// member (computed by the caller, which owns the KV member scan).
// Returns one { giveawayId, status, reason } per giveaway considered.
export async function creditReferral(db, { code, referee, ipHash = null, aliasOfExisting = false, now = Date.now() }) {
  if (!REF_CODE_RE.test(code || '')) return []
  const owner = await db.prepare('SELECT member_id FROM referral_codes WHERE code = ?').bind(code).first()
  if (!owner) return []
  const referrerId = owner.member_id

  const { results } = await db.prepare(`
    SELECT g.*, p.email AS referrer_email FROM giveaways g
    JOIN participants p ON p.giveaway_id = g.id AND p.member_id = ?
    WHERE g.status = 'open'`).bind(referrerId).all()
  const refereeNorm = normalizeEmail(referee.email)
  const ts = nowIso(now)
  const outcomes = []

  for (const row of results) {
    const g = rowToGiveaway(row)
    if (!g.sources.referral || !isAcceptingEntries(g, now)) continue

    let status = 'credited'
    const reasons = []
    if (referee.id === referrerId || refereeNorm === normalizeEmail(row.referrer_email)) {
      status = 'rejected'; reasons.push('self-referral')
    } else if (aliasOfExisting) {
      status = 'rejected'; reasons.push('email is an alias of an existing member')
    } else {
      if (isDisposableEmail(referee.email)) reasons.push('disposable email domain')
      if (ipHash) {
        const sameNet = await db.prepare(`SELECT COUNT(*) AS n FROM referrals
          WHERE giveaway_id = ? AND ip_hash = ? AND created_at > ?`)
          .bind(g.id, ipHash, nowIso(now - 86400 * 1000)).first()
        if (sameNet.n >= REF_IP_THRESHOLD) reasons.push(`${sameNet.n + 1} referral signups from one network in 24h`)
      }
      const recent = await db.prepare(`SELECT COUNT(*) AS n FROM referrals
        WHERE giveaway_id = ? AND referrer_member_id = ? AND created_at > ? AND status IN ('credited', 'flagged')`)
        .bind(g.id, referrerId, nowIso(now - 3600 * 1000)).first()
      if (recent.n >= REF_RATE_PER_HOUR) reasons.push(`more than ${REF_RATE_PER_HOUR} referrals in an hour`)
      if (reasons.length) status = 'flagged'
    }

    // The unique index on (giveaway, referee) makes a second referral of the
    // same person a no-op, whoever sends it.
    const ref = await db.prepare(`INSERT OR IGNORE INTO referrals
      (giveaway_id, referrer_member_id, referee_member_id, referee_email_norm, ip_hash, status, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .bind(g.id, referrerId, referee.id, refereeNorm, ipHash, status, reasons.join('; ') || null, ts).first()
    if (!ref) { outcomes.push({ giveawayId: g.id, status: 'duplicate', reason: 'already referred' }); continue }

    if (status === 'credited' || status === 'flagged') {
      // Cap enforced inside the INSERT: the count and the write are one
      // statement, so two referrals landing together cannot both squeeze
      // under the cap.
      const ins = await db.prepare(`
        INSERT INTO entries (giveaway_id, member_id, source, weight, ref_id, detail, flagged, flag_reason, created_at)
        SELECT ?1, ?2, 'referral', ?3, ?4, ?5, ?6, ?7, ?8
        WHERE (SELECT COUNT(*) FROM entries WHERE giveaway_id = ?1 AND member_id = ?2 AND source = 'referral') < ?9`)
        .bind(g.id, referrerId, g.sources.referral.weight, ref.id, `referred ${referee.id}`,
          status === 'flagged' ? 1 : 0, status === 'flagged' ? reasons.join('; ') : null, ts, g.sources.referral.cap)
        .run()
      if (ins.meta.changes === 0) {
        await db.prepare("UPDATE referrals SET status = 'capped', reason = ? WHERE id = ?")
          .bind(`referrer reached the cap of ${g.sources.referral.cap}`, ref.id).run()
        status = 'capped'
      }
    }
    outcomes.push({ giveawayId: g.id, status, reason: reasons.join('; ') || null })
  }
  return outcomes
}
