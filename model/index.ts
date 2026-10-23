
const is_browser = typeof window == 'object'

// Resolve the Worker origin the same way ui/views.html + ui/auth.html do — the
// Worker is the live source for members + events. Node (SSG/CLI tests) skips
// the Worker entirely and reads from data/*.json on disk.
function resolveWorkerOrigin(): string | null {
  if (!is_browser) return null
  const g = globalThis as any
  if (g.JXNFC_WORKER_ORIGIN) return g.JXNFC_WORKER_ORIGIN
  const override = new URLSearchParams(location.search).get('api')
  if (override === 'local') return 'http://localhost:8787'
  if (override === 'prod')  return 'https://join.jxnfilm.club'
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'http://localhost:8787'
  return 'https://join.jxnfilm.club'
}

// House screenings are omitted from GET /events for anonymous callers, so a
// signed-in member only sees them if we present their token. Browser-only by
// construction: resolveWorkerOrigin already returns null under Node, and the
// build-time path must stay anonymous or a members-only screening would be
// baked into the static site.
function sessionToken(): string | null {
  if (!is_browser) return null
  try {
    const raw = localStorage.jxnfc_session
    return raw ? (JSON.parse(raw).token || null) : null
  } catch { return null }
}

async function fetchList(type: string): Promise<any[]> {
  // Try the live Worker first. The static JSON snapshot in data/{type}.json
  // is the fallback — it's refreshed by snapshot-{members,events}.yml every
  // 6h, so it's never more than ~6h stale when the Worker is unreachable.
  //
  // Note the fallback is the ANONYMOUS view by definition: the snapshot is
  // built from an unauthenticated read. If the Worker is unreachable a member
  // sees the public calendar rather than a stale private one, which is the
  // right way for this to fail.
  const origin = resolveWorkerOrigin()
  if (origin) {
    try {
      const token = sessionToken()
      const res = await fetch(`${origin}/${type}`,
        token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) return data
      }
    } catch { /* fall through to static */ }
  }
  const url = is_browser ? `/data/${type}.json` : `file:${process.cwd()}/data/${type}.json`
  const res = await fetch(url)
  return await res.json()
}

// Live Last Four Watched: the Worker fetches + KV-caches Letterboxd RSS
// (~15 min) so diaries stay fresh; data/watched.json (6h cron) is the
// offline fallback. Returns a handle-keyed map of diary entries.
export async function getWatched(): Promise<Record<string, any[]>> {
  const origin = resolveWorkerOrigin()
  if (origin) {
    try {
      const res = await fetch(`${origin}/watched`)
      if (res.ok) {
        const data = await res.json()
        if (data && typeof data === 'object' && !Array.isArray(data)) return data
      }
    } catch { /* fall through to static */ }
  }
  try {
    const url = is_browser ? '/data/watched.json' : `file:${process.cwd()}/data/watched.json`
    const res = await fetch(url)
    return await res.json()
  } catch { return {} }
}

// Letterboxd avatars: handle-keyed map of avatar URLs, scraped by the Worker
// from each linked member's profile og:image and KV-cached for a week. No
// static fallback — a missing entry just means the letter avatar renders.
export async function getAvatars(): Promise<Record<string, string>> {
  const origin = resolveWorkerOrigin()
  if (!origin) return {}
  try {
    const res = await fetch(`${origin}/avatars`)
    if (res.ok) {
      const data = await res.json()
      if (data && typeof data === 'object' && !Array.isArray(data)) return data
    }
  } catch { /* letter avatars cover it */ }
  return {}
}

// Custom profile photos: a member row from GET /members carries
// `avatar: '{sha256}.{ext}'` only while the photo is live (an admin flag drops
// the field), and the Worker serves it at /av/{memberId}/{file}. Under Node
// there is no Worker origin, so build-time renders use the fallbacks.
const AVATAR_FILE_RE = /^[a-f0-9]{64}[.](webp|jpg|png)$/

export function customAvatarUrl(member: any, origin: string | null = resolveWorkerOrigin()): string {
  if (!origin || !member || !member.id || typeof member.avatar !== 'string') return ''
  if (!AVATAR_FILE_RE.test(member.avatar)) return ''
  return `${origin}/av/${encodeURIComponent(member.id)}/${member.avatar}`
}

// One id-keyed map of what each member's avatar should show: their own photo,
// else their Letterboxd avatar (the handle-keyed map from getAvatars), else
// nothing, which renders the letter avatar. Every view looks avatars up
// through this so the precedence lives in one place.
export function avatarsById(members: any[], letterboxd: Record<string, string> = {},
  origin: string | null = resolveWorkerOrigin()): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of members || []) {
    if (!m || !m.id) continue
    const src = customAvatarUrl(m, origin) || (m.handle && letterboxd && letterboxd[m.handle]) || ''
    if (src) out[m.id] = src
  }
  return out
}

// Hot takes: member review snippets scraped to data/takes.json by the 6h
// refresh-letterboxd cron. Static-only — there is no live Worker endpoint,
// matching how the home page consumes the same file.
export async function getTakes(): Promise<any[]> {
  try {
    const url = is_browser ? '/data/takes.json' : `file:${process.cwd()}/data/takes.json`
    const res = await fetch(url)
    const data = await res.json()
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

// Central-time day cutoff as a bare YYYY-MM-DD string, `days` calendar days
// back inclusive of today. Same math as admin/lib.js buildRoundupData: parse
// and reformat in one local frame so the day never shifts. Dates stay
// strings end to end — compared lexically, never as Date objects.
export function centralDayCutoff(days = 7, today?: string): string {
  const ref = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(today || ''))
    ? String(today)
    : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
  const cut = new Date(ref + 'T00:00:00')
  cut.setDate(cut.getDate() - (days - 1))
  return cut.toLocaleDateString('en-CA')
}

function starsFor(rating: any): string {
  const n = Number(rating) || 0
  let s = ''
  for (let i = 0; i < Math.floor(n); i++) s += '★'
  return n - Math.floor(n) >= 0.5 ? s + '½' : s
}

function takeSnippet(text: string, limit = 140): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const sp = cut.lastIndexOf(' ')
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[.,;:—-]+$/, '') + '…'
}

// Shape the /watched page from raw inputs: recency-ordered per-member
// sections (films enriched with precomputed stars, an optional review
// snippet, and the rewatch flag), the club-wide weekly strip (same film
// watched by several members clusters into one card, names kept — unlike
// the admin roundup, this stays on-site where activity is already
// attributed), and the count of members who have not linked Letterboxd.
export function buildWatchedPage(
  members: any[], watchedMap: Record<string, any[]>, takes: any[], opts: any = {},
) {
  const map = watchedMap || {}
  const list = members || []

  // Review lookup scoped BY HANDLE, keyed by diary link with a title|year
  // fallback. The handle scoping is load-bearing: a global title|year map
  // would attach member A's review to member B's card of the same film.
  const takesByHandle: Record<string, Record<string, string>> = {}
  for (const t of (Array.isArray(takes) ? takes : [])) {
    if (!t || !t.handle || !t.review) continue
    const bucket = takesByHandle[t.handle] || (takesByHandle[t.handle] = {})
    if (t.link) bucket['L:' + t.link] = t.review
    if (t.title) bucket['T:' + String(t.title).toLowerCase() + '|' + (t.year || '')] = t.review
  }

  const sections: any[] = []
  let handleless = 0
  for (const m of list) {
    if (!m) continue
    if (!m.handle) { handleless++; continue }
    const films = map[m.handle]
    if (!films || !films.length) continue
    const bucket = takesByHandle[m.handle] || {}
    // The map carries more history than the page name promises (the strip
    // below clusters over the full depth) — sections stay Last FOUR.
    const enriched = films.slice(0, 4).map((f: any) => {
      const out: any = { ...f, stars: starsFor(f && f.rating) }
      const take = (f && f.link && bucket['L:' + f.link])
        || (f && f.title && bucket['T:' + String(f.title).toLowerCase() + '|' + (f.year || '')])
      if (take) out.take = takeSnippet(take)
      return out
    })
    let latest = ''
    for (const f of films) {
      const d = f && f.watched_date ? String(f.watched_date) : ''
      if (d > latest) latest = d
    }
    sections.push({ ...m, films: enriched, latest })
  }
  // Most recently active member first; members with only undated entries last.
  sections.sort((a, b) => b.latest.localeCompare(a.latest))

  // Weekly strip: windowed like the admin roundup, undated entries dropped
  // (recency unverifiable), most recent first, clustered on title|year.
  const cutoff = centralDayCutoff(opts.days || 7, opts.today)
  const entries: any[] = []
  for (const m of list) {
    if (!m || !m.handle) continue
    for (const f of (map[m.handle] || [])) {
      if (f && f.title && f.watched_date && String(f.watched_date) >= cutoff) {
        entries.push({ film: f, name: m.name, handle: m.handle })
      }
    }
  }
  entries.sort((a, b) => String(b.film.watched_date).localeCompare(String(a.film.watched_date)))
  const byKey: Record<string, any> = {}
  const strip: any[] = []
  for (const e of entries) {
    const key = String(e.film.title).toLowerCase() + '|' + (e.film.year || '')
    let c = byKey[key]
    if (!c) {
      c = { key, title: e.film.title, watched_date: e.film.watched_date, watchers: [] }
      if (e.film.year) c.year = e.film.year
      if (e.film.link) c.link = e.film.link
      if (e.film.poster) c.poster = e.film.poster
      byKey[key] = c
      strip.push(c)
    }
    if (!c.watchers.some((w: any) => w.handle === e.handle)) {
      c.watchers.push({ name: e.name, handle: e.handle })
    }
  }
  for (const c of strip) {
    c.byline = 'Watched by ' + c.watchers.map((w: any) => w.name).join(', ')
  }

  return { sections, strip, handleless }
}

// AND-combine the /watched filter tokens over one member's films. Tokens are
// deliberately non-numeric strings — nuestate translate() coerces anything
// numeric-looking in the URL.
export function filterFilms(films: any[], tokens: string[]): any[] {
  const toks = tokens || []
  const all = films || []
  if (!toks.length) return all
  return all.filter((f: any) => {
    if (!f) return false
    if (toks.indexOf('liked') >= 0 && !f.liked) return false
    if (toks.indexOf('rated4') >= 0 && !(Number(f.rating) >= 4)) return false
    if (toks.indexOf('week') >= 0 && !(f.watched_date && String(f.watched_date) >= centralDayCutoff(7))) return false
    return true
  })
}

// Operator-editable site config from the Worker: GET /config returns
// { theaters, podcast, copy } where any key may be null. Views keep their
// hardcoded fallbacks, so a Worker/KV outage changes nothing — this returns
// null on any failure and callers fall back per-field. The result is cached
// module-level so every view shares one fetch per page load.
let config_promise: Promise<any> | null = null

export async function getConfig(): Promise<any> {
  if (!config_promise) config_promise = fetchConfig()
  return config_promise
}

async function fetchConfig(): Promise<any> {
  const origin = resolveWorkerOrigin()
  if (!origin) return null
  try {
    const res = await fetch(`${origin}/config`)
    if (!res.ok) return null
    const data = await res.json()
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch { return null }
}

export async function getMembers(opts = {}) {
  return getList('members', opts)
}

export async function getEvents(opts = {}) {
  return getList('events', opts)
}

// Does this event collect RSVPs, or is it a post-hoc "I was there" event?
//
// The two are mutually exclusive by construction: attendance is derived from
// the confirmed-RSVP list when RSVPs are on, so offering both would give one
// event two sources of truth. Every caller that gates an attend/RSVP
// affordance asks this, never `hostId` directly.
//
// Precedence, and why:
//  1. An explicit `rsvp` boolean wins.
//
// A `ticketUrl` used to short-circuit this to false. That is now carried by
// copy rather than structure: a venue-ticketed event can want a headcount
// while the box office sells admission. The admin portal stamps `rsvp: true` on
//     every event it creates, which is what makes "on by default" true for new
//     club events without making absence mean on.
//  2. Otherwise fall back to `hostId`. Member-hosted screenings have always
//     taken RSVPs and the 42 curated rows in data/events.json have always
//     taken attendance, and neither carries an `rsvp` field — so this branch
//     is what keeps every pre-existing row behaving exactly as it did.
//
// MIRRORED in worker/src/index.js and admin/lib.js — keep all three in
// lockstep (see docs/features/hosting.md).
export function rsvpEnabled(e: any): boolean {
  if (!e) return false
  if (typeof e.rsvp === 'boolean') return e.rsvp
  return !!e.hostId
}

async function getList(type: string, opts: any) {
  const { start = 0, limit = 30, sort, search, venue } = opts || {}

  let items = await fetchList(type)

  // Sorting by Letterboxd handle implies a Letterboxd-members-only view.
  if (type === 'members' && String(sort || '').startsWith('handle')) {
    items = items.filter((m: any) => m.handle)
  }

  const defaultSort = type === 'events' ? 'date' : 'joined'
  sortBy(sort || defaultSort, items)

  if (search) {
    const s = search.toLowerCase()
    const has = (v: any) => typeof v == 'string' && v.toLowerCase().includes(s)
    items = items.filter((el: any) =>
      has(el.name) || has(el.handle) || has(el.title) || has(el.film) || has(el.venue)
    )
  }

  if (venue) {
    items = items.filter((el: any) => el.venue === venue)
  }

  return { type, total: items.length, items: items.slice(start, start + limit) }
}

function sortBy(spec: string, arr: any[]) {
  const m = /^(.+)-(asc|desc)$/.exec(spec)
  if (m) {
    const key = m[1], desc = m[2] === 'desc'
    arr.sort((a, b) => {
      const av = a[key], bv = b[key]
      const cmp = typeof av == 'number' && typeof bv == 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''))
      return desc ? -cmp : cmp
    })
    return
  }
  arr.sort((a, b) => {
    const av = a[spec], bv = b[spec]
    if (typeof av == 'number' && typeof bv == 'number') return bv - av
    return String(av ?? '').localeCompare(String(bv ?? ''))
  })
}

// --- Attendance entries ---
//
// Attendance is keyed on member id. The stored `name` is only a fallback, for
// entries no member row can resolve: host-added guests, members who deleted
// their account, and rows that predate the id migration. Resolving names off
// the live members list means a rename shows up here the moment it is saved,
// not on the next snapshot tick.
//
// Both the Worker's live response and the data/attendance.json snapshot can
// hand back the legacy `[name]` shape — mid-deploy, or from a namespace that
// hasn't been written since the migration — so every reader normalizes first.
export interface Attendee { id: string | null; name: string }

export function normalizeAttendees(value: any): Attendee[] {
  if (!Array.isArray(value)) return []
  const out: Attendee[] = []
  for (const v of value) {
    if (typeof v === 'string') {
      if (v) out.push({ id: null, name: v })
    } else if (v && typeof v === 'object') {
      const id = typeof v.id === 'string' && v.id ? v.id : null
      const name = typeof v.name === 'string' ? v.name : ''
      if (id || name) out.push({ id, name })
    }
  }
  return out
}

export function namesById(members: any[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of members) if (m && m.id && m.name) out[m.id] = m.name
  return out
}

// Reverse index for counting rows that have no id yet — a row written before
// the backfill still belongs to whoever answers to that name today. Names
// shared by two members are dropped rather than guessed at, and a member who
// renamed before the backfill matches nothing, which is what the backfill
// script's --alias flag is for.
export function idsByName(members: any[] = []): Record<string, string> {
  const seen: Record<string, string> = {}
  const dupes = new Set<string>()
  for (const m of members) {
    if (!m || !m.id || !m.name) continue
    const k = String(m.name).trim().toLowerCase()
    if (seen[k] && seen[k] !== m.id) dupes.add(k)
    seen[k] = m.id
  }
  for (const k of dupes) delete seen[k]
  return seen
}

// Mirrors resolveAttendees() in worker/src/index.js: rename by id, then drop
// repeat ids and id-less rows whose name now duplicates an id-bearing one (a
// half-backfilled event). Two different members sharing a display name both
// survive — the id check runs first.
export function resolveAttendees(entries: Attendee[], names: Record<string, string>): Attendee[] {
  const resolved = entries.map(a => (a.id && names[a.id] ? { id: a.id, name: names[a.id] } : a))
  const identified = new Set(resolved.filter(a => a.id).map(a => a.name))
  const out: Attendee[] = []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
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

// Counting identity: the member id when there is one, else the name — so
// guests and unmatched legacy rows still each count once.
export function attendeeKey(a: Attendee): string {
  return a.id ? `id:${a.id}` : `name:${a.name}`
}

export interface AttendanceTallyRow { id: string | null; name: string; count: number }

// One pass over the whole attendance map → per-person totals. Both the
// homepage leaderboard and the account-stats rank read this, so they can't
// drift apart on how a person is identified.
export function attendanceTally(
  attendance: any, members: any[] = [],
): Map<string, AttendanceTallyRow> {
  const names = namesById(members)
  const ids = idsByName(members)
  const tally = new Map<string, AttendanceTallyRow>()
  for (const eventId of Object.keys(attendance || {})) {
    for (const a of resolveAttendees(normalizeAttendees(attendance[eventId]), names)) {
      // Fold an un-backfilled row onto the member who still answers to that
      // name, so the count is right before the backfill runs as well as after.
      const id = a.id || ids[a.name.trim().toLowerCase()] || null
      const entry = id && names[id] ? { id, name: names[id] } : a
      const key = attendeeKey(entry)
      const row = tally.get(key)
      if (row) row.count++
      else tally.set(key, { id: entry.id, name: entry.name, count: 1 })
    }
  }
  return tally
}

// --- Film stats (docs/features/film-stats.md) ---
//
// A Letterboxd diary entry link is letterboxd.com/{handle}/film/{slug}/, with
// a trailing {n}/ rewatch counter on repeat logs of the same film. The slug is
// the club's film identity. Anything else (a list, a review permalink, a
// boxd.it short link) is not a diary entry and yields null.
//
// MIRRORED in worker/src/films.js (ENTRY_URL_RE), which keys the FILMS_DB
// rows on it — keep the two rules identical, byte for byte.
const FILM_LINK_RE = /^https:\/\/letterboxd\.com\/[^/]+\/film\/([a-z0-9-]+)\/(?:[0-9]+\/)?$/

export function filmSlug(link: any): string | null {
  if (typeof link !== 'string') return null
  const m = FILM_LINK_RE.exec(link)
  return m ? m[1] : null
}

// The signed-in viewer for authed reads. jxnfcEnsureSession (ui/auth.html)
// silently renews a lapsed token from a remembered device, so prefer it; the
// raw localStorage token covers pages where it is not installed.
// Its null is a verdict (lapsed, no device token), so it is trusted rather than
// second-guessed with the stored, expired token.
async function filmSessionToken(): Promise<string | null> {
  const g = globalThis as any
  if (typeof g.jxnfcEnsureSession === 'function') {
    try {
      const s = await g.jxnfcEnsureSession()
      return s && s.token ? s.token : null
    } catch { return null }
  }
  if (!is_browser) return null
  try {
    const raw = localStorage.jxnfc_session
    const s = raw ? JSON.parse(raw) : null
    return s && s.token && s.exp > Date.now() ? s.token : null
  } catch { return null }
}

const FILM_STATS_MAX = 40
// Short: the /watched strip waits on this before its single paint.
const FILM_FETCH_TIMEOUT_MS = 3000

function filmTimeout(ms: number = FILM_FETCH_TIMEOUT_MS): AbortSignal | undefined {
  const A = (globalThis as any).AbortSignal
  return A && typeof A.timeout === 'function' ? A.timeout(Math.max(ms, 1)) : undefined
}

// The session lookup and the fetch share ONE time budget. jxnfcEnsureSession
// may POST /session/refresh (no timeout of its own) for a lapsed token, and
// that must not hold the /watched paint past the budget: when it runs out the
// read goes ahead anonymously (counts without `you`).
async function filmAuthedInit(): Promise<any> {
  const start = Date.now()
  let timer: any
  const token = await Promise.race([
    filmSessionToken(),
    new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), FILM_FETCH_TIMEOUT_MS) }),
  ])
  clearTimeout(timer)
  const init: any = { signal: filmTimeout(FILM_FETCH_TIMEOUT_MS - (Date.now() - start)) }
  if (token) init.headers = { Authorization: `Bearer ${token}` }
  return init
}

// Per-slug { members, logs, thisWeek, you? } for up to 40 slugs. Returns {}
// on ANY failure — the strip then falls back to its weekly-only byline, so a
// missing or broken FILMS_DB never costs the page more than the count line.
export async function getFilmStats(slugs: any[]): Promise<Record<string, any>> {
  const origin = resolveWorkerOrigin()
  if (!origin) return {}
  const uniq: string[] = []
  for (const s of slugs || []) {
    if (typeof s === 'string' && s && uniq.indexOf(s) < 0) uniq.push(s)
  }
  if (!uniq.length) return {}
  try {
    const init = await filmAuthedInit()
    const qs = uniq.slice(0, FILM_STATS_MAX).map(encodeURIComponent).join(',')
    const res = await fetch(`${origin}/films/stats?slugs=${qs}`, init)
    if (!res.ok) return {}
    const data = await res.json()
    const stats = data && data.stats
    return stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {}
  } catch { return {} }
}

// One film page. The status is discriminated so the view can tell a film the
// club has never logged (404) from the database being down (503) from the
// network failing (0).
export async function getFilm(slug: string): Promise<{ status: number; data?: any }> {
  const origin = resolveWorkerOrigin()
  if (!origin || !slug) return { status: 0 }
  try {
    const init = await filmAuthedInit()
    const res = await fetch(`${origin}/films/${encodeURIComponent(slug)}`, init)
    if (res.status === 404 || res.status === 503) return { status: res.status }
    if (!res.ok) return { status: 0 }
    const data = await res.json()
    if (!data || typeof data !== 'object' || !data.film) return { status: 0 }
    return { status: 200, data }
  } catch { return { status: 0 } }
}

// Who is looking, for viewer-first ordering. The handle is all the strip
// needs and does not require a live token, so this reads storage directly.
export function filmViewer(): { id?: string; handle?: string } | null {
  if (!is_browser) return null
  try {
    const raw = localStorage.jxnfc_session
    const s = raw ? JSON.parse(raw) : null
    if (!s || !(s.token || s.refresh)) return null
    return { id: s.id || undefined, handle: s.handle || undefined }
  } catch { return null }
}

// The direction A count line, shared by the strip and the film page.
// you: the viewer has a log of it. members: distinct loggers, all time.
export function filmCountLine(members: number, thisWeek: number, you: boolean) {
  const m = Math.max(0, Number(members) || 0)
  const w = Math.max(0, Number(thisWeek) || 0)
  const week = w > 0 ? ' · ' + w + ' this week' : ''
  if (you) {
    const others = Math.max(0, m - 1)
    if (!others) return { lead: '', tail: 'Only you have logged it' + week, line: 'Only you have logged it' + week, others }
    const tail = ' + ' + others + (others === 1 ? ' other' : ' others') + ' have logged it' + week
    return { lead: 'You', tail, line: 'You' + tail, others }
  }
  const tail = m + (m === 1 ? ' member has' : ' members have') + ' logged it' + week
  return { lead: '', tail, line: tail, others: m }
}

export const STRIP_NAMES_SHOWN = 6

// Shape one weekly-strip card for direction A, You + the club. card is a
// buildWatchedPage strip card, stats its GET /films/stats entry (absent when
// the endpoint is down or the film is not ingested yet), viewer the session.
//
// The names are this week's watchers from the strip, which are already public
// from RSS; the viewer leads as You. All-time names stay on the film page.
// Each name carries its own trailing separator so the template has no logic
// and a wrapped line never starts with a comma.
export function shapeStripCard(card: any, stats: any, viewer: any) {
  const vh = viewer && viewer.handle ? String(viewer.handle).toLowerCase() : ''
  const watchers: any[] = (card && Array.isArray(card.watchers)) ? card.watchers : []
  const mine = vh ? watchers.filter((w: any) => w && String(w.handle || '').toLowerCase() === vh) : []
  const rest = watchers.filter((w: any) => mine.indexOf(w) < 0)
  const ordered = mine.slice(0, 1).concat(rest)
  const names = ordered.map((w: any, i: number) => ({
    name: w.name,
    handle: w.handle,
    label: i === 0 && mine.length ? 'You' : w.name,
    you: i === 0 && mine.length > 0,
    sep: i < ordered.length - 1 ? ',' : '',
    extra: i >= STRIP_NAMES_SHOWN,
    // The last name before the fold keeps its comma only once expanded.
    cut: i === STRIP_NAMES_SHOWN - 1 && ordered.length > STRIP_NAMES_SHOWN,
  }))
  const overflow = Math.max(0, ordered.length - STRIP_NAMES_SHOWN)
  const slug = filmSlug(card && card.link)

  const has = !!(stats && typeof stats === 'object' && Number(stats.members) > 0)
  if (!has) {
    // Endpoint down or film not ingested: today's weekly-only byline.
    return { slug, fallback: true, you: false, members: 0, countLead: '', countTail: '', countLine: '', othersCount: 0, names, overflow }
  }
  // The weekly names come from the same RSS ingest reads, so a viewer named
  // here has logged it even if ingest has not caught up yet; never let the
  // count read lower than the names on the card.
  const you = stats.you === true || mine.length > 0
  const members = Math.max(Number(stats.members) || 0, watchers.length)
  const thisWeek = Math.max(Number(stats.thisWeek) || 0, watchers.length)
  const c = filmCountLine(members, thisWeek, you)
  return { slug, fallback: false, you, members, countLead: c.lead, countTail: c.tail, countLine: c.line, othersCount: c.others, names, overflow }
}

// The whole strip: each card shaped, and the most-shared film (by all-time
// members, at least two) promoted to the front as the hero. No stats, no hero.
export function shapeStrip(strip: any[], statsMap: Record<string, any>, viewer: any) {
  const map = statsMap || {}
  const cards = (strip || []).map((c: any) => {
    const slug = filmSlug(c && c.link)
    const shaped = shapeStripCard(c, slug ? map[slug] : null, viewer)
    return { ...c, ...shaped, hero: false }
  })
  let best = -1
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    if (c.fallback || c.members < 2) continue
    if (best < 0 || c.members > cards[best].members) best = i
  }
  if (best >= 0) {
    const hero = { ...cards[best], hero: true }
    cards.splice(best, 1)
    cards.unshift(hero)
  }
  return cards
}

export function ratingStars(rating: any): string {
  return starsFor(rating)
}

const FILM_HIST_KEYS = ['0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5']

function filmDate(d: any): string {
  const s = String(d || '')
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return ''
  return new Date(s + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Shape a GET /films/:slug body for the film page: count line, rating
// summary, histogram bars as a percentage of the tallest, and the members-only
// watcher rows with stars and formatted dates. events (optional, id-keyed)
// labels each club screening; ids it cannot resolve still render.
export function shapeFilmPage(data: any, events: Record<string, any> = {}) {
  const d = data || {}
  const film = d.film || {}
  const signedIn = Array.isArray(d.watchers)
  const c = filmCountLine(d.members, d.thisWeek, d.you === true)
  const hist = d.histogram && typeof d.histogram === 'object' ? d.histogram : {}
  const counts = FILM_HIST_KEYS.map(k => Math.max(0, Number(hist[k]) || 0))
  const top = Math.max(0, ...counts)
  const votes = counts.reduce((a, b) => a + b, 0)
  const bars = FILM_HIST_KEYS.map((k, i) => ({
    key: k,
    n: counts[i],
    pct: top ? Math.round((counts[i] / top) * 100) : 0,
    // Tenths of the tallest, for a height class: the dhtml compiler drops
    // inline style attributes, so bars cannot carry a percentage.
    step: counts[i] ? Math.max(1, Math.round((counts[i] / top) * 10)) : 0,
    label: starsFor(k),
  }))
  const avg = typeof d.avg === 'number' && isFinite(d.avg) ? d.avg : null
  const liked = Math.max(0, Number(d.liked) || 0)
  const screenings = (Array.isArray(d.screenings) ? d.screenings : []).map((id: any) => {
    const e = events && events[id]
    const label = e ? [e.title || e.film || 'Club screening', filmDate(e.date), e.venue].filter(Boolean).join(' · ') : 'Club screening'
    // events-view filters on ?query= across title and film, the closest
    // thing the SPA has to a per-event link.
    return { id: String(id), label, query: e ? encodeURIComponent(e.film || e.title || '') : '' }
  })
  const watchers = (signedIn ? d.watchers : []).map((w: any) => {
    const dates = (Array.isArray(w && w.dates) ? w.dates : []).map(filmDate).filter(Boolean)
    return {
      name: (w && w.name) || 'A member',
      handle: (w && w.handle) || '',
      stars: w && w.rating != null ? starsFor(w.rating) : '',
      liked: !!(w && w.liked),
      dates: dates.join(', '),
      review: (w && typeof w.review === 'string') ? w.review : '',
    }
  })
  return {
    slug: film.slug || '',
    title: film.title || '',
    year: film.year || '',
    poster: film.poster || '',
    members: Math.max(0, Number(d.members) || 0),
    logs: Math.max(0, Number(d.logs) || 0),
    you: d.you === true,
    countLead: c.lead,
    countTail: c.tail,
    countLine: c.line,
    avg: avg,
    avgLabel: avg == null ? '' : avg.toFixed(2),
    avgStars: avg == null ? '' : starsFor(Math.round(avg * 2) / 2),
    liked,
    likedLabel: liked ? liked + (liked === 1 ? ' heart' : ' hearts') : '',
    votes,
    bars,
    histLabel: 'Rating spread across ' + votes + (votes === 1 ? ' member' : ' members'),
    screenings,
    signedIn,
    watchers,
    // Former members count toward members but are never listed.
    unnamed: signedIn ? Math.max(0, (Number(d.members) || 0) - watchers.length) : 0,
  }
}
