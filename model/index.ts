
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

export async function getMembers(opts = {}) {
  return getList('members', opts)
}

export async function getEvents(opts = {}) {
  return getList('events', opts)
}

async function getList(type: string, opts: any) {
  const { start = 0, limit = 30, sort, search, venue } = opts || {}

  let items = await fetchList(type)
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
