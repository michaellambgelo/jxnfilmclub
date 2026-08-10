
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

async function fetchList(type: string): Promise<any[]> {
  // Try the live Worker first. The static JSON snapshot in data/{type}.json
  // is the fallback — it's refreshed by snapshot-{members,events}.yml every
  // 6h, so it's never more than ~6h stale when the Worker is unreachable.
  const origin = resolveWorkerOrigin()
  if (origin) {
    try {
      const res = await fetch(`${origin}/${type}`)
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
