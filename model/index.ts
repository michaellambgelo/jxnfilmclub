
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
