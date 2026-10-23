// Film stats: a club-owned, accumulating record of who in the club logged
// which film (docs/features/film-stats.md). Storage is the FILMS_DB D1
// binding (worker/migrations-films/). Everything here takes the D1 handle,
// never `env`, so the module stays testable on its own; index.js owns the
// HTTP faces, the buildWatched hook, the cron and the departure cascades.
//
// Writes are set-based: each ingest is four statements regardless of how
// many entries it carries, because the rows ride in as ONE JSON parameter
// unpacked by json_each(). Per-row statements would blow both D1's ~100
// bound-parameter cap and its per-invocation query budget at 40 members x 50
// entries.

// Club era: the first event in data/events.json. Diary entries dated before
// this — or with no diary date at all — are never stored.
export const CLUB_ERA_START = '2020-11-10'

// Most slugs a single GET /films/stats may ask about (the /watched strip
// renders far fewer).
export const MAX_STATS_SLUGS = 40

// Review text is stored up to this many characters. The Python scraper's
// 300-char truncate is take-card presentation; this is an archive, so the cap
// only bounds a pathological review's row size.
export const REVIEW_MAX = 2000

// Letterboxd film slugs are lowercase ASCII, digits and hyphens. The /films/:slug
// route and the entry-URL parser share this class so a stored slug is always
// routable.
export const FILM_SLUG_RE = /^[a-z0-9-]+$/

// Entry link -> film slug. https://letterboxd.com/{handle}/film/{slug}/
// optionally followed by a rewatch counter {n}/. Anything else (lists,
// malformed links) is null and the entry is skipped. The site parses links
// with the identical rule.
const ENTRY_URL_RE = /^https:\/\/letterboxd\.com\/[^/]+\/film\/([a-z0-9-]+)\/(?:[0-9]+\/)?$/

export function filmSlugFromUrl(url) {
  const m = ENTRY_URL_RE.exec(String(url || ''))
  return m ? m[1] : null
}

const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

// Central-time day cutoff as a bare YYYY-MM-DD, `days` calendar days back
// inclusive of today. Mirrors centralDayCutoff in model/index.ts (the /watched
// strip's window) so thisWeek here and the strip agree on what a week is.
export function centralDayCutoff(days = 7, today) {
  const ref = DATE_RE.test(String(today || ''))
    ? String(today)
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
  const cut = new Date(ref + 'T00:00:00Z')
  cut.setUTCDate(cut.getUTCDate() - (days - 1))
  return cut.toISOString().slice(0, 10)
}

function nextDay(date) {
  const d = new Date(date + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

function ratingOf(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0.5 && n <= 5 ? n : null
}

// One parsed RSS film (parseLetterboxdRss's shape, review included) -> the
// JSON row the ingest statements unpack, or null when it can't be stored.
function ingestRow(memberKey, handle, f) {
  if (!f || typeof f !== 'object') return null
  const slug = filmSlugFromUrl(f.link)
  const date = String(f.watched_date || '')
  if (!slug || !DATE_RE.test(date) || date < CLUB_ERA_START || !f.title) return null
  const review = typeof f.review === 'string' && f.review.trim() ? f.review.trim().slice(0, REVIEW_MAX) : null
  return {
    k: memberKey, h: handle || null, u: String(f.link), s: slug,
    t: String(f.title), y: f.year ? String(f.year) : null, p: f.poster || null,
    m: f.tmdb_id ? String(f.tmdb_id) : null,
    d: date, rw: f.rewatch ? 1 : 0,
    r: ratingOf(f.rating), l: f.liked ? 1 : 0, v: review,
  }
}

const FILMS_UPSERT = `
  INSERT INTO films (slug, title, year, poster, tmdb_id, first_seen)
  SELECT json_extract(value, '$.s'), json_extract(value, '$.t'), json_extract(value, '$.y'),
         json_extract(value, '$.p'), json_extract(value, '$.m'), ?2
  FROM json_each(?1) WHERE true
  ON CONFLICT (slug) DO UPDATE SET
    title = excluded.title,
    year = COALESCE(excluded.year, films.year),
    poster = COALESCE(excluded.poster, films.poster),
    tmdb_id = COALESCE(excluded.tmdb_id, films.tmdb_id)`

// A departed member (unlink or account deletion) is tombstoned in
// `departures`; every write below skips their rows, so an ingest built from a
// stale members:all — or already in flight when they left — can't re-insert
// their feed under the live id. Relinking clears the tombstone.
const NOT_DEPARTED = `NOT IN (SELECT member_key FROM departures)`

// An entry whose diary date was edited on Letterboxd keeps its URL, so it
// would be ignored by LOGS_INSERT (entry_url taken) and then missed by the
// (member, film, date) version join. Move the stored log to the new date
// first; event_id resets so screening linking re-runs on the corrected date.
// OR IGNORE: if the member already has another log of that film on the new
// date, the old row is left as it was rather than violating the unique rule.
const LOGS_REDATE = `
  UPDATE OR IGNORE logs SET watched_date = json_extract(j.value, '$.d'), event_id = NULL
  FROM json_each(?1) j
  WHERE logs.entry_url = json_extract(j.value, '$.u')
    AND logs.member_key = json_extract(j.value, '$.k')
    AND logs.watched_date <> json_extract(j.value, '$.d')
  RETURNING logs.watched_date`

// OR IGNORE covers both uniqueness rules: the same entry_url seen again, and
// a renamed handle re-serving an old entry under a new URL (same member, film
// and date). RETURNING lists only the rows actually inserted, so the caller
// can link just those to screenings.
const LOGS_INSERT = `
  INSERT OR IGNORE INTO logs (entry_url, film_slug, member_key, handle, watched_date, rewatch, first_seen)
  SELECT json_extract(value, '$.u'), json_extract(value, '$.s'), json_extract(value, '$.k'),
         json_extract(value, '$.h'), json_extract(value, '$.d'), json_extract(value, '$.rw'), ?2
  FROM json_each(?1)
  WHERE json_extract(value, '$.k') ${NOT_DEPARTED}
  RETURNING watched_date`

// Append a version only when (rating, liked, review) differs from the log's
// latest one. IS, not =, so NULL compares equal to NULL.
const VERSIONS_INSERT = `
  INSERT OR IGNORE INTO log_versions (log_id, seen_at, rating, liked, review)
  SELECT l.id, ?2, json_extract(j.value, '$.r'), json_extract(j.value, '$.l'), json_extract(j.value, '$.v')
  FROM json_each(?1) j
  JOIN logs l ON l.member_key = json_extract(j.value, '$.k')
             AND l.film_slug = json_extract(j.value, '$.s')
             AND l.watched_date = json_extract(j.value, '$.d')
  WHERE json_extract(j.value, '$.k') ${NOT_DEPARTED}
    AND NOT EXISTS (
    SELECT 1 FROM log_versions v
    WHERE v.log_id = l.id
      AND v.seen_at = (SELECT MAX(seen_at) FROM log_versions WHERE log_id = l.id)
      AND v.rating IS json_extract(j.value, '$.r')
      AND v.liked IS json_extract(j.value, '$.l')
      AND v.review IS json_extract(j.value, '$.v'))`

const INGEST_CHUNK = 500

// Ingest several members' parsed feeds, four statements per chunk of rows.
// `batches` is [{ member: { id, handle }, films }]. Returns { candidates, changed,
// earliest }: candidate rows after the era/slug/date filter, the number of
// logs inserted or re-dated, and the earliest watched_date among those (null
// when nothing changed) — the `since` for linking the new rows to screenings.
export async function ingestMany(db, batches, nowIso = new Date().toISOString()) {
  const rows = []
  const seen = new Set()
  for (const { member, films } of batches || []) {
    if (!member || !member.id) continue
    for (const f of films || []) {
      const row = ingestRow(member.id, member.handle, f)
      if (!row) continue
      // Two feed entries for one film on one day collapse into one log (the
      // schema's member/film/date rule); keep the newest (RSS order) so the
      // two don't alternate as versions on every ingest.
      const key = row.k + '\n' + row.s + '\n' + row.d
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
  }
  // Chunked so one JSON parameter stays well under D1's 2 MB value cap even
  // when every entry carries a REVIEW_MAX review (500 x ~2 KB ≈ 1 MB). A full
  // 40 x 50 rebuild is at most four chunks, sixteen statements.
  let changed = 0
  let earliest = null
  for (let i = 0; i < rows.length; i += INGEST_CHUNK) {
    const payload = JSON.stringify(rows.slice(i, i + INGEST_CHUNK))
    const res = await db.batch([
      db.prepare(FILMS_UPSERT).bind(payload, nowIso),
      db.prepare(LOGS_REDATE).bind(payload),
      db.prepare(LOGS_INSERT).bind(payload, nowIso),
      db.prepare(VERSIONS_INSERT).bind(payload, nowIso),
    ])
    for (const r of [res[1], res[2]]) {
      for (const { watched_date: d } of (r && r.results) || []) {
        changed++
        if (!earliest || d < earliest) earliest = d
      }
    }
  }
  return { candidates: rows.length, changed, earliest }
}

// One member's feed. `member` is { id, handle }; logs are keyed on the id.
export function ingestLogs(db, member, films, nowIso) {
  return ingestMany(db, [{ member, films }], nowIso)
}

function norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase()
}

// The film an event screened, as matchers: an explicit Letterboxd slug when
// the event carries one, else the normalized film title + year (the key the
// /watched strip clusters on). `letterboxd_uri` is a boxd.it short link, which
// can't be resolved to a slug offline, so it isn't consulted.
function eventMatcher(event) {
  const slug = typeof event.letterboxd === 'string' && FILM_SLUG_RE.test(event.letterboxd) ? event.letterboxd : null
  const title = norm(event.film)
  const year = event.year == null || event.year === '' ? '' : String(event.year)
  return (log) => {
    if (slug) return log.film_slug === slug
    if (!title || norm(log.title) !== title) return false
    // Either side without a year matches on title alone.
    return !year || !log.year || String(log.year) === year
  }
}

// Link unlinked logs to the club screening they record: the member is on the
// event's attendance list, it is the event's film, and the diary date is the
// event date or the day after. `events` are event rows/projections, and
// `attendance` the eventId -> [{ id, name }] map. Only logs with
// watched_date >= `since` are considered. Returns the number linked.
export async function linkScreenings(db, events, attendance, { since = CLUB_ERA_START } = {}) {
  const candidates = []
  for (const e of events || []) {
    if (!e || !e.id || !DATE_RE.test(String(e.date || ''))) continue
    const ids = new Set(((attendance && attendance[e.id]) || []).map(a => a && a.id).filter(Boolean))
    if (!ids.size) continue
    candidates.push({ id: e.id, dates: [e.date, nextDay(e.date)], ids, matches: eventMatcher(e) })
  }
  if (!candidates.length) return 0
  const { results } = await db.prepare(
    `SELECT l.id, l.member_key, l.film_slug, l.watched_date, f.title, f.year
     FROM logs l JOIN films f ON f.slug = l.film_slug
     WHERE l.event_id IS NULL AND l.watched_date >= ?1`,
  ).bind(since).all()
  const updates = []
  for (const log of results || []) {
    const ev = candidates.find(c => c.ids.has(log.member_key) && c.dates.includes(log.watched_date) && c.matches(log))
    if (ev) updates.push(db.prepare('UPDATE logs SET event_id = ?1 WHERE id = ?2 AND event_id IS NULL').bind(ev.id, log.id))
  }
  if (updates.length) await db.batch(updates)
  return updates.length
}

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('')
}

// Departure (unlink or account deletion): one random 'former:' key per
// departing member, so one-vote-per-person still holds; handle and every
// version's review text go. entry_url is rewritten too — it embeds the
// handle, so leaving it would leave the identity in the row. The same batch
// tombstones the member id (see NOT_DEPARTED), atomically with the rewrite,
// so no later or in-flight ingest can put their feed back under the live id.
// A member who departs twice while tombstoned keeps their first former key.
// After an unlink the tombstone keeps the id -> former key mapping (private,
// never served) so a relink can replace those rows; `forget` (account
// deletion) drops it, leaving the former rows unlinkable to anyone. Returns
// the logs rewritten.
const FORMER_KEY_OF = `(SELECT former_key FROM departures WHERE member_key = ?1)`
const NEW_FORMER_KEY = `COALESCE(${FORMER_KEY_OF}, ?2)`

export async function anonymizeFilmLogs(db, memberId, { forget = false, nowIso = new Date().toISOString() } = {}) {
  if (!memberId) return 0
  const key = 'former:' + randomHex(8)
  const [, , logs] = await db.batch([
    db.prepare('INSERT OR IGNORE INTO departures (member_key, former_key, at) VALUES (?1, ?2, ?3)').bind(memberId, key, nowIso),
    db.prepare('UPDATE log_versions SET review = NULL WHERE log_id IN (SELECT id FROM logs WHERE member_key = ?1)').bind(memberId),
    // COALESCE: a deleted member's tombstone has no former key left to reuse.
    db.prepare(`UPDATE logs SET member_key = ${NEW_FORMER_KEY}, handle = NULL, entry_url = ${NEW_FORMER_KEY} || '/' || id
                WHERE member_key = ?1`).bind(memberId, key),
    ...(forget ? [db.prepare('UPDATE departures SET former_key = NULL WHERE member_key = ?1').bind(memberId)] : []),
  ])
  return (logs && logs.meta && logs.meta.changes) || 0
}

function purgeStatements(db, keySql, arg) {
  return [
    db.prepare(`DELETE FROM log_versions WHERE log_id IN (SELECT id FROM logs WHERE member_key = ${keySql})`).bind(arg),
    db.prepare(`DELETE FROM logs WHERE member_key = ${keySql}`).bind(arg),
  ]
}

// Relink (a departed member links a Letterboxd handle again): the log starts
// fresh. Their former-member logs are deleted and the tombstone cleared, so
// the next ingest re-adds whatever their feed still carries under the live id
// without counting them twice. Entries older than the feed's window are not
// re-added. A no-op for a member who never departed. Returns the logs deleted.
export async function relinkFilmLogs(db, memberId) {
  if (!memberId) return 0
  const [, logs] = await db.batch([
    ...purgeStatements(db, FORMER_KEY_OF, memberId),
    db.prepare('DELETE FROM departures WHERE member_key = ?1').bind(memberId),
  ])
  return (logs && logs.meta && logs.meta.changes) || 0
}

// Handle change without an unlink: the logs ingested from the old handle go
// outright (it may have been a typo, or someone else's account), rather than
// staying attributed to the member under their new handle. Returns the logs
// deleted.
export async function purgeFilmLogs(db, memberId) {
  if (!memberId) return 0
  const [, logs] = await db.batch(purgeStatements(db, '?1', memberId))
  return (logs && logs.meta && logs.meta.changes) || 0
}

// Per-slug counts for the /watched strip. `memberId` (the signed-in caller,
// or null) adds `you`. Unknown slugs are simply absent from the result.
export async function filmStats(db, slugs, memberId = null, today) {
  const list = [...new Set((slugs || []).filter(s => FILM_SLUG_RE.test(s)))]
  if (!list.length) return {}
  const { results } = await db.prepare(
    `SELECT film_slug, COUNT(DISTINCT member_key) AS members, COUNT(*) AS logs,
            COUNT(DISTINCT CASE WHEN watched_date >= ?2 THEN member_key END) AS thisWeek,
            MAX(member_key = ?3) AS you
     FROM logs WHERE film_slug IN (SELECT value FROM json_each(?1))
     GROUP BY film_slug`,
  ).bind(JSON.stringify(list), centralDayCutoff(7, today), memberId || '').all()
  const out = {}
  for (const r of results || []) {
    const s = { members: r.members, logs: r.logs, thisWeek: r.thisWeek }
    if (memberId) s.you = r.you === 1
    out[r.film_slug] = s
  }
  return out
}

const HISTOGRAM_KEYS = ['0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5']

// Everything GET /films/:slug serves, or null for an unknown film. With
// `viewer` ({ id, membersById }) the result adds `you` and the watchers list:
// current members only (membersById: id -> { name, handle }); former members
// are counted but never listed.
export async function filmDetail(db, slug, { viewer = null, today } = {}) {
  if (!FILM_SLUG_RE.test(String(slug || ''))) return null
  const film = await db.prepare('SELECT slug, title, year, poster FROM films WHERE slug = ?1').bind(slug).first()
  if (!film) return null
  // Each log with its latest version. A rating cleared on Letterboxd is a
  // latest version with rating NULL, so that log stops voting.
  const { results } = await db.prepare(
    `SELECT l.id, l.member_key, l.handle, l.watched_date, l.event_id,
            lv.rating, lv.liked, lv.review
     FROM logs l
     LEFT JOIN log_versions lv ON lv.log_id = l.id
       AND lv.seen_at = (SELECT MAX(seen_at) FROM log_versions WHERE log_id = l.id)
     WHERE l.film_slug = ?1
     ORDER BY l.watched_date DESC, l.id DESC`,
  ).bind(slug).all()
  const rows = results || []
  const cutoff = centralDayCutoff(7, today)

  // Newest-first rows grouped per member, preserving order.
  const byMember = new Map()
  for (const r of rows) {
    if (!byMember.has(r.member_key)) byMember.set(r.member_key, [])
    byMember.get(r.member_key).push(r)
  }

  // One vote per person: their most recent log whose latest version is rated.
  const histogram = Object.fromEntries(HISTOGRAM_KEYS.map(k => [k, 0]))
  let sum = 0, votes = 0, liked = 0, thisWeek = 0
  for (const logs of byMember.values()) {
    if (logs.some(l => l.watched_date >= cutoff)) thisWeek++
    const vote = logs.find(l => l.rating != null)
    if (!vote) continue
    const r = Number(vote.rating)
    sum += r
    votes++
    if (vote.liked) liked++
    const key = String(r)
    if (key in histogram) histogram[key]++
  }

  const out = {
    film: { slug: film.slug, title: film.title, year: film.year, poster: film.poster },
    members: byMember.size,
    logs: rows.length,
    thisWeek,
    avg: votes ? Math.round((sum / votes) * 100) / 100 : null,
    liked,
    histogram,
    screenings: [...new Set(rows.map(r => r.event_id).filter(Boolean))],
  }

  if (viewer) {
    const members = viewer.membersById || {}
    const watchers = []
    for (const [key, logs] of byMember) {
      if (key.startsWith('former:')) continue
      const m = members[key]
      if (!m) continue
      const vote = logs.find(l => l.rating != null)
      const withReview = logs.find(l => l.review)
      watchers.push({
        name: m.name || '',
        handle: m.handle || logs[0].handle || null,
        rating: vote ? Number(vote.rating) : null,
        liked: !!logs[0].liked,
        dates: [...new Set(logs.map(l => l.watched_date))],
        review: withReview ? withReview.review : null,
      })
    }
    out.watchers = watchers
    out.you = !!(viewer.id && byMember.has(viewer.id))
  }
  return out
}
